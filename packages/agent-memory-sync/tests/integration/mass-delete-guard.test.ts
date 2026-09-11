// Red-test-first coverage for the 2026-09-11 memory-corpus wipe
// (agent-tasks cda5b12c, pandora run .ai/runs/2026-09-11-memory-sync-wipe).
//
// Measured incident sequence on the mini, reproduced below with a local
// bare-repo fixture and a stub git binary:
//
//   1. A periodic `run --mode sync` tick and a concurrent `watch` tick share
//      one stateDir. The watch tick's StateStore.clearTemp() removes the
//      WHOLE stateDir/tmp tree (src/memory-sync/state-store.ts), including
//      the sync tick's own freshly checked-out working copy under tmp/pull.
//   2. The sync tick's pull therefore read an EMPTY working copy while git
//      itself had reported success. Every remote path came back null, and
//      for every unmodified file local === base, so mergeText's "local ===
//      base adopts remote" fast path (src/memory-sync/merge.ts) resolved to
//      content === null and pull.ts rmSync'd the real local file. 404 local
//      memory files were deleted on disk.
//   3. The pull then threw a GENERIC git CliError (exit code 4, not a
//      RemoteUnavailableError). run.ts's executeMode treated any exit-4
//      error as "remote unavailable during pull" and retried performPush
//      ALONE. That push saw local empty and base full, so its 3-way merge
//      resolved every path to a deletion and published 406 deletions
//      (bare repo commit c6be19d). The Linux peer mirrored the deletion one
//      tick later.
//
// Each test below names the criterion it pins (AC-001 to AC-003 in the run's
// 00-goal.md). The two stub git binaries are the seam: git reports success,
// but the working copy it leaves behind is empty (the tmp-wipe race), or one
// specific subcommand fails inside the PULL working copy only (the
// generic-git-failure half). Both are plain POSIX shell scripts wrapping the
// real git, the same technique memory-sync.test.ts's writeStubGitRejectingPush
// and watch-mirror-delete.test.ts's writeStubGitFailingOnCommit already use.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  cloneRemote,
  createSandbox,
  fileExists,
  git,
  initBareRemote,
  readText,
  runCli,
  writeProjectConfig,
  writeText
} = require("../helpers/cli.ts");
const {
  spawnWatch,
  waitForWatcherReady,
  withTickDeadline,
  stopWatchProcessGroup,
  INACTIVITY_TIMEOUT_MS
} = require("../helpers/watch-process.ts");

function createConfig(
  workspaceRoot: string,
  remoteDir: string,
  extra: Record<string, unknown> = {}
) {
  return {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    syncPaths: [
      { source: "MEMORY.md", destination: "MEMORY.md", kind: "file" },
      { source: "logs", destination: "logs", kind: "directory" }
    ],
    ...extra
  };
}

// Writes `count` files under logs/ and returns their local relative paths.
function seedLogFiles(workspaceRoot: string, count: number): string[] {
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = `note-${String(index).padStart(3, "0")}.md`;
    writeText(path.join(workspaceRoot, "logs", name), `entry ${index}\n`);
    names.push(path.join("logs", name));
  }
  return names;
}

function remoteLogFileCount(remoteDir: string, root: string, name: string): number {
  const inspection = cloneRemote(remoteDir, root, name);
  const logsDir = path.join(inspection, "shared", "logs");
  if (!fs.existsSync(logsDir)) {
    return 0;
  }
  return fs.readdirSync(logsDir).length;
}

// git reports success for every subcommand, but `checkout` leaves an EMPTY
// working tree behind: the real checkout runs first, then every non-.git
// entry is removed. This is the measured tmp-wipe race (a concurrent watch
// tick's StateStore.clearTemp() removing the whole stateDir/tmp tree while
// this process holds a checked-out working copy under it), reduced to a
// deterministic, single-process seam. Everything downstream sees exactly
// what the incident saw: a non-null remote head, a successful git exit
// status, and zero files on disk.
function writeStubGitWipingWorkTree(root: string): string {
  const stubPath = path.join(root, "stub-git-wipes-worktree.sh");
  writeText(
    stubPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "checkout" ]; then',
      '  git "$@" || exit $?',
      '  for entry in "$PWD"/* "$PWD"/.[!.]*; do',
      '    [ -e "$entry" ] || continue',
      '    case "$entry" in',
      "      */.git) continue ;;",
      "    esac",
      '    rm -rf "$entry"',
      "  done",
      "  exit 0",
      "fi",
      'exec git "$@"',
      ""
    ].join("\n")
  );
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

// git behaves normally everywhere EXCEPT inside the pull phase's own working
// copy (stateDir/tmp/pull), where `<subcommand>` fails with a non-zero exit
// status. GitClient.run raises a plain CliError with exitCode 4 for that
// ("git command failed: ..."), which is precisely the error class run.ts
// used to mistake for "the remote is unavailable". Every invocation is
// appended to `logPath` as "<cwd> <subcommand>", so a test can assert which
// working copies git was asked to touch at all.
function writeStubGitFailingInPullWorkingCopy(
  root: string,
  subcommand: string,
  logPath: string
): string {
  const stubPath = path.join(root, `stub-git-fails-pull-${subcommand}.sh`);
  writeText(
    stubPath,
    [
      "#!/bin/sh",
      `echo "$PWD $1" >> ${JSON.stringify(logPath)}`,
      'case "$PWD" in',
      "  */tmp/pull)",
      `    if [ "$1" = ${JSON.stringify(subcommand)} ]; then`,
      `      echo "fatal: simulated ${subcommand} failure in the pull working copy" >&2`,
      "      exit 128",
      "    fi",
      "    ;;",
      "esac",
      'exec git "$@"',
      ""
    ].join("\n")
  );
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

// AC-001 (a): the pull half of the incident. Remote at a full tree, base
// snapshots present and equal to local, but the working copy the pull reads
// comes back empty. Pre-fix this deleted every local file; the fix must
// delete nothing and report the anomaly instead.
test("pull: a working copy that comes back empty never deletes local files (AC-001)", () => {
  const root = createSandbox("wipe-repro-pull");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stubConfigPath = path.join(root, "config-stub-git.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, 5);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  // Seed the remote and the base snapshots with real git: after this push
  // local === base === remote for every path.
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  writeProjectConfig(stubConfigPath, {
    ...createConfig(workspaceRoot, remoteDir),
    gitBinary: writeStubGitWipingWorkTree(root)
  });

  const result = runCli(
    ["run", "default", "--config", stubConfigPath, "--mode", "pull", "--output", "json"],
    { expectFailure: true }
  );

  // Not a silent success and not a generic crash: a named, non-zero refusal.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unreliable checkout/);
  assert.match(result.stderr, /no files/);

  // The whole point: every local file survives.
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "memory root\n");
  for (const relativePath of seeded) {
    assert.equal(fileExists(path.join(workspaceRoot, relativePath)), true, `${relativePath} was deleted`);
  }

  // The base snapshot store must not have been overwritten with the empty
  // tree either: that write is what made the follow-up push publish the
  // deletions in the incident.
  const baseLogsDir = path.join(workspaceRoot, ".agent-memory-sync", "default", "base", "logs");
  assert.equal(fs.existsSync(baseLogsDir), true);
  assert.ok(fs.readdirSync(baseLogsDir).length > 0);
});

// AC-001 (b): the push half. Local full, base full, but the push's own
// working copy comes back empty, so every path reads as "deleted on the
// remote" and the 3-way merge resolves to a deletion commit. Pre-fix this
// published a mass deletion; the fix must refuse before anything is
// committed or pushed.
test("push: a working copy that comes back empty never publishes mass deletions (AC-001)", () => {
  const root = createSandbox("wipe-repro-push");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stubConfigPath = path.join(root, "config-stub-git.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  seedLogFiles(workspaceRoot, 5);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  writeProjectConfig(stubConfigPath, {
    ...createConfig(workspaceRoot, remoteDir),
    gitBinary: writeStubGitWipingWorkTree(root)
  });

  // One genuine local edit, so the push has real work to do.
  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\nedited\n");

  const result = runCli(
    ["run", "default", "--config", stubConfigPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unreliable checkout/);

  // Nothing reached the remote: all five log files and MEMORY.md are intact.
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-empty-checkout-push"), 5);
  const inspection = cloneRemote(remoteDir, root, "inspect-empty-checkout-push-memory");
  assert.equal(fileExists(path.join(inspection, "shared", "MEMORY.md")), true);
});

// AC-001 (c): run.ts's executeMode must not answer a generic git failure
// with a push-only retry. Pre-fix ANY error carrying exitCode 4 took that
// branch, including GitClient.run's generic "git command failed" CliError,
// which is how the incident's push ran at all.
test("sync: a generic git failure in the pull phase does not fall back to a push-only retry (AC-001)", () => {
  const root = createSandbox("wipe-repro-exit4");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stubConfigPath = path.join(root, "config-stub-git.json");
  const gitLogPath = path.join(root, "git-invocations.log");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  seedLogFiles(workspaceRoot, 3);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  writeProjectConfig(stubConfigPath, {
    ...createConfig(workspaceRoot, remoteDir),
    gitBinary: writeStubGitFailingInPullWorkingCopy(root, "checkout", gitLogPath)
  });

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\nedited\n");
  const result = runCli(
    ["run", "default", "--config", stubConfigPath, "--mode", "sync", "--output", "json"],
    { expectFailure: true }
  );

  // Fails loudly with the git error, rather than reporting a clean push.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git command failed/);
  assert.doesNotMatch(result.stdout, /"kind": "push"/);

  // The direct evidence that no push-only retry ran: git was never invoked
  // inside the push phase's own working copy.
  const invocations = readText(gitLogPath);
  assert.ok(invocations.includes(path.join("tmp", "pull")), "the pull working copy was never used");
  assert.equal(
    invocations.includes(path.join("tmp", "push")),
    false,
    "a push-only retry ran after a generic git failure in the pull phase"
  );
});

// AC-001 (c), second half: the "remote unavailable during pull" diagnostic
// was written through writeInfo, which is silent unless --verbose is set.
// The launchd/systemd jobs run without --verbose, so the one line that
// explains a degraded sync tick was invisible exactly where it mattered.
test("sync: the remote-unavailable-during-pull diagnostic is written without --verbose (AC-001)", () => {
  const root = createSandbox("wipe-repro-diagnostic");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stubConfigPath = path.join(root, "config-stub-git.json");
  const gitLogPath = path.join(root, "git-invocations.log");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // ls-remote is the one subcommand GitClient runs with allowFailure=true,
  // so a failure there raises a genuine RemoteUnavailableError: the case the
  // push-only retry is legitimately for.
  writeProjectConfig(stubConfigPath, {
    ...createConfig(workspaceRoot, remoteDir),
    gitBinary: writeStubGitFailingInPullWorkingCopy(root, "ls-remote", gitLogPath)
  });

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\nedited\n");
  const result = runCli([
    "run",
    "default",
    "--config",
    stubConfigPath,
    "--mode",
    "sync",
    "--output",
    "json"
  ]);

  assert.match(result.stderr, /remote unavailable during pull/);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runs[0].kind, "push");
  assert.match((payload.runs[0].notes || []).join(" "), /remote unavailable during pull/);
});

// AC-002: a local file with no base snapshot is local-only. It is a push
// candidate, never a pull deletion, and the run reports how many files that
// rule protected.
test("pull: a local file with no base snapshot is kept and counted as protected (AC-002)", () => {
  const root = createSandbox("protected-missing-base");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  writeText(path.join(workspaceRoot, "logs", "shared.md"), "shared\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // Created after the push, so it has no base snapshot and the remote has
  // never seen it.
  writeText(path.join(workspaceRoot, "logs", "local-only.md"), "local only\n");

  const result = runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(result.stdout);

  assert.deepEqual(payload.runs[0].protectedFiles, ["logs/local-only.md"]);
  assert.deepEqual(payload.runs[0].deletedFiles, []);
  assert.equal(readText(path.join(workspaceRoot, "logs", "local-only.md")), "local only\n");
});

// AC-002, second half: the same rule when the base snapshot directory for a
// destination is missing entirely (the state the mini was left in after the
// incident's replaceBaseSnapshots wrote the empty tree).
test("pull: a missing base directory protects every local file under it (AC-002)", () => {
  const root = createSandbox("protected-missing-base-dir");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, 4);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // Drop the same files from the remote and drop the base snapshots for the
  // logs destination, so the 3-way merge sees base=null/remote=null for
  // every one of them while the local files are still there.
  const remoteCheckout = cloneRemote(remoteDir, root, "remote-drop-logs");
  git(["rm", "-r", path.join("shared", "logs")], remoteCheckout);
  git(["commit", "-m", "drop logs"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);
  fs.rmSync(path.join(workspaceRoot, ".agent-memory-sync", "default", "base", "logs"), {
    recursive: true,
    force: true
  });

  const result = runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(result.stdout);

  assert.deepEqual(
    payload.runs[0].protectedFiles,
    seeded.map((relativePath) => relativePath.split(path.sep).join("/")).sort()
  );
  assert.deepEqual(payload.runs[0].deletedFiles, []);
  for (const relativePath of seeded) {
    assert.equal(fileExists(path.join(workspaceRoot, relativePath)), true);
  }
});

// AC-003, absolute rule: more than 20 deleted files is refused even when the
// proportion is small (21 of 250 is 8.4 percent, under the 10 percent ratio).
test("push: a plan deleting more than 20 files is refused (AC-003)", () => {
  const root = createSandbox("mass-delete-absolute");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, 250);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  for (const relativePath of seeded.slice(0, 21)) {
    fs.rmSync(path.join(workspaceRoot, relativePath));
  }

  const result = runCli(
    ["run", "default", "--config", configPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /21 file\(s\)/);
  assert.match(result.stderr, /--allow-mass-delete/);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-absolute"), 250);
});

// AC-003, proportional rule: 3 of 12 is 25 percent, over the 10 percent
// threshold, while staying well under the absolute limit of 20.
test("push: a plan deleting more than 10 percent of a destination is refused (AC-003)", () => {
  const root = createSandbox("mass-delete-ratio");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, 12);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  for (const relativePath of seeded.slice(0, 3)) {
    fs.rmSync(path.join(workspaceRoot, relativePath));
  }

  const result = runCli(
    ["run", "default", "--config", configPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /3 of 12/);
  assert.match(result.stderr, /logs/);
  assert.match(result.stderr, /--allow-mass-delete/);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-ratio"), 12);
});

// AC-003, the documented escape hatch.
test("push: --allow-mass-delete applies a refused plan (AC-003)", () => {
  const root = createSandbox("mass-delete-flag");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, 12);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  for (const relativePath of seeded.slice(0, 3)) {
    fs.rmSync(path.join(workspaceRoot, relativePath));
  }

  const result = runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "push",
    "--allow-mass-delete",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "applied");
  assert.deepEqual(payload.runs[0].deletedFiles, [
    "logs/note-000.md",
    "logs/note-001.md",
    "logs/note-002.md"
  ]);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-flagged"), 9);
});

// AC-003, thresholds configurable per profile. 3 of 40 passes both defaults
// (3 is under 20, and 7.5 percent is under 10 percent), so a refusal here can
// only come from the profile's own massDeleteGuard.
test("push: massDeleteGuard thresholds are read from the profile (AC-003)", () => {
  const root = createSandbox("mass-delete-config");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, 40);
  writeProjectConfig(
    configPath,
    createConfig(workspaceRoot, remoteDir, {
      massDeleteGuard: { maxRatio: 1, maxFiles: 2 }
    })
  );

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  for (const relativePath of seeded.slice(0, 3)) {
    fs.rmSync(path.join(workspaceRoot, relativePath));
  }

  const result = runCli(
    ["run", "default", "--config", configPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /limit of 2 file\(s\)/);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-configured"), 40);
});

// Negative control for the proportional rule: a single deleted file is never
// refused proportionally, however small the destination is. Deleting one of
// five files is 20 percent, over the ratio, and must still go through. This
// is the "genuine gradual deletion below the thresholds" AC-003's negative
// space protects, and it is what keeps ordinary single-file housekeeping
// (and watch-mirror-delete.test.ts's own negative control) working.
test("push: a single-file deletion is never refused by the proportional rule (AC-003)", () => {
  const root = createSandbox("mass-delete-single");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, 5);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  fs.rmSync(path.join(workspaceRoot, seeded[0]));

  const result = runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "push",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "applied");
  assert.deepEqual(payload.runs[0].deletedFiles, ["logs/note-000.md"]);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-single"), 4);
});

// AC-003, watcher half: the snapshot push obeys the same guard, logs the
// refusal, and the watch loop survives it. The second tick (no deletions
// left in the plan) still pushes, which is the evidence that the loop kept
// watching rather than shutting down on the refusal.
test("watch: a refused mass delete is logged and the watcher keeps watching (AC-003)", async () => {
  const root = createSandbox("mass-delete-watch");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, 12);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const child = spawnWatch(
    [
      "watch",
      "default",
      "--config",
      configPath,
      "--debounce-ms",
      "300",
      "--max-runs",
      "2",
      "--verbose",
      "--output",
      "json"
    ],
    process.env
  );

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  function waitForStderr(pattern: RegExp, timeoutMs = 30000): Promise<void> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        if (pattern.test(stderr)) {
          clearInterval(poll);
          resolve();
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(poll);
          reject(new Error(`stderr never matched ${pattern}. stderr so far: ${stderr}`));
        }
      }, 50);
    });
  }

  try {
    const exitCode = await withTickDeadline(
      child,
      async () => {
        await waitForWatcherReady(() => stderr);

        // Tick 1: a mass deletion the guard must refuse.
        const removed = seeded.slice(0, 4);
        for (const relativePath of removed) {
          fs.rmSync(path.join(workspaceRoot, relativePath));
        }
        await waitForStderr(/--allow-mass-delete/);

        // Tick 2: put the files back and add a new one, so this tick's plan
        // holds no deletions at all and must push normally.
        for (const relativePath of removed) {
          writeText(path.join(workspaceRoot, relativePath), `${path.basename(relativePath)} restored\n`);
        }
        writeText(path.join(workspaceRoot, "logs", "after-refusal.md"), "after refusal\n");

        return await new Promise<number>((resolve) => {
          child.on("exit", (code: number | null) => resolve(code ?? -1));
        });
      },
      INACTIVITY_TIMEOUT_MS,
      () => stderr
    );

    assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
    assert.match(stderr, /mass-delete/);
  } finally {
    await stopWatchProcessGroup(child);
  }

  // Nothing was deleted on the remote, and the second tick's new file landed.
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-watch"), 13);
});
