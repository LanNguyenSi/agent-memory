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
  // A removed path is reported as a deletion, not as an applied file (R1
  // medium): a mass deletion used to arrive as status=applied with the
  // deleted paths listed under appliedFiles and deletedFiles empty, which
  // reads as a successful sync of exactly the files that were destroyed.
  assert.equal(
    payload.runs[0].appliedFiles.includes("logs/note-000.md"),
    false,
    `a deleted path must not be reported as applied: ${JSON.stringify(payload.runs[0].appliedFiles)}`
  );
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

// git reports success for every subcommand, but `checkout` leaves a
// PARTIALLY populated working tree behind: the real checkout runs first,
// then every non-.git file except `keepRepoRelativePath` is removed.
//
// R1 critical (D-006): this is the same race writeStubGitWipingWorkTree
// above models, one file short of total. The original guards saw nothing
// wrong with it. The checkout check fired only on a destination holding
// EXACTLY zero files, and the deletion plan built from such a tree reports
// no deletions at all (every missing path merges to "delete" but the
// working copy has nothing to delete), so `git add -A` inside commitAll
// published the whole tree as removed while the payload reported a clean
// apply. A wipe that leaves one file behind is not a milder incident than
// one that leaves none.
function writeStubGitLeavingOneFile(root: string, keepRepoRelativePath: string, label: string): string {
  const stubPath = path.join(root, `stub-git-partial-wipe-${label}.sh`);
  writeText(
    stubPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "checkout" ]; then',
      '  git "$@" || exit $?',
      `  keep="$PWD/${keepRepoRelativePath}"`,
      '  find "$PWD" -name .git -prune -o -type f -print | while IFS= read -r entry; do',
      '    if [ "$entry" != "$keep" ]; then',
      '      rm -f "$entry"',
      "    fi",
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

// git behaves normally until the moment the push stages its working copy,
// and empties the tree immediately BEFORE that `git add -A` runs.
//
// This is the seam for the other half of D-006: everything the push reads
// (the remote tree it compares against, the merge plan it builds) is read
// before any staging, so both the checkout check and a plan-derived deletion
// count see a perfectly healthy run. Only the index knows what the commit
// would really carry. A guard whose numerator is the merge plan cannot see
// this at all; a guard whose numerator is the staged deletion set stops it.
function writeStubGitWipingWorkTreeOnStage(root: string): string {
  const stubPath = path.join(root, "stub-git-wipes-on-stage.sh");
  writeText(
    stubPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "add" ]; then',
      '  find "$PWD" -name .git -prune -o -type f -print | while IFS= read -r entry; do',
      '    rm -f "$entry"',
      "  done",
      "fi",
      'exec git "$@"',
      ""
    ].join("\n")
  );
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

// Seeds a workspace and a remote holding `count` log files plus MEMORY.md,
// then returns a config whose git binary leaves a working copy holding only
// logs/note-000.md. Shared by the partial-wipe tests below.
function preparePartialWipe(label: string, count: number) {
  const root = createSandbox(`partial-wipe-${label}`);
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stubConfigPath = path.join(root, "config-stub-git.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, count);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  writeProjectConfig(stubConfigPath, {
    ...createConfig(workspaceRoot, remoteDir),
    gitBinary: writeStubGitLeavingOneFile(root, "shared/logs/note-000.md", label)
  });

  return { root, remoteDir, workspaceRoot, configPath, stubConfigPath, seeded };
}

// AC-001/AC-003 (D-006), the reviewer's critical shape, at both corpus sizes
// the run's evidence names. Pre-fix: rc 0, the remote tree reduced to a
// single file, the payload reporting a successful apply with an empty
// deletedFiles list.
for (const count of [50, 400]) {
  for (const mode of ["push", "sync"]) {
    test(`${mode}: a working copy holding 1 of ${count} files never publishes the loss (AC-001, AC-003)`, () => {
      const scenario = preparePartialWipe(`${mode}-${count}`, count);

      // One genuine local edit, so the run has real work to do and cannot
      // be a no-op for reasons unrelated to the guard.
      writeText(path.join(scenario.workspaceRoot, "MEMORY.md"), "memory root\nedited\n");

      const result = runCli(
        ["run", "default", "--config", scenario.stubConfigPath, "--mode", mode, "--output", "json"],
        { expectFailure: true }
      );

      assert.notEqual(result.status, 0, `a partial wipe must not exit 0. stdout: ${result.stdout}`);
      assert.match(result.stderr, /unreliable checkout/);
      // The count, not just the fact: an operator reading a launchd log has
      // to be able to tell a 1-file loss from a corpus-wide one.
      assert.match(result.stderr, new RegExp(`missing ${count - 1} of the ${count} file\\(s\\)`));
      assert.match(result.stderr, /1 still present/);

      // Nothing was published: the remote still holds every log file.
      assert.equal(
        remoteLogFileCount(scenario.remoteDir, scenario.root, `inspect-${mode}-${count}`),
        count
      );

      // And nothing was removed locally either, which is the half `--mode
      // sync` reaches through pull's own rmSync loop.
      for (const relativePath of scenario.seeded) {
        assert.equal(
          fileExists(path.join(scenario.workspaceRoot, relativePath)),
          true,
          `${relativePath} was deleted locally`
        );
      }
    });
  }
}

// D-004/D-008: --allow-mass-delete is the operator's answer to "yes, delete
// these files". It is not an answer to "the working copy this run fetched is
// not the remote", and it used to bypass that check too - on a wiped working
// copy, the one flag an operator would reach for after a refusal was the one
// that published the wipe.
test("push: --allow-mass-delete does not bypass the unreliable-checkout refusal (AC-003)", () => {
  const root = createSandbox("mass-delete-flag-checkout");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stubConfigPath = path.join(root, "config-stub-git.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  seedLogFiles(workspaceRoot, 8);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  writeProjectConfig(stubConfigPath, {
    ...createConfig(workspaceRoot, remoteDir),
    gitBinary: writeStubGitWipingWorkTree(root)
  });

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\nedited\n");

  const result = runCli(
    [
      "run",
      "default",
      "--config",
      stubConfigPath,
      "--mode",
      "push",
      "--allow-mass-delete",
      "--output",
      "json"
    ],
    { expectFailure: true }
  );

  assert.equal(result.status, 7, `expected the checkout refusal's exit code. stderr: ${result.stderr}`);
  assert.match(result.stderr, /unreliable checkout/);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-flag-checkout"), 8);
});

// D-006, the other half: the guard's numerator must be the deletions the
// commit carries, not the deletions the merge plan intended. Here the
// working copy is healthy for every read the push performs and is emptied
// only at staging time, so the checkout check and any plan-derived count
// both see a clean run.
test("push: a working copy emptied between the merge and the commit is refused (AC-003)", () => {
  const root = createSandbox("staged-deletion-gate");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stubConfigPath = path.join(root, "config-stub-git.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  seedLogFiles(workspaceRoot, 30);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  writeProjectConfig(stubConfigPath, {
    ...createConfig(workspaceRoot, remoteDir),
    gitBinary: writeStubGitWipingWorkTreeOnStage(root)
  });

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\nedited\n");

  const result = runCli(
    ["run", "default", "--config", stubConfigPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(result.status, 5, `expected the mass-delete refusal's exit code. stderr: ${result.stderr}`);
  assert.match(result.stderr, /30 file\(s\) under 'logs'/);
  assert.match(result.stderr, /Nothing was pushed/);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-staged-gate"), 30);
});

// AC-002 through the mode the periodic job actually runs. The AC-002 tests
// above drive `--mode pull` directly, so run.ts's own merge of pull's
// protectedFiles into the combined sync result was unpinned: dropping it
// left every one of them green while real `--mode sync` output lost its
// protected= count entirely.
test("sync: a protected local file is counted in both the JSON and the text summary (AC-002)", () => {
  const root = createSandbox("protected-sync-mode");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  writeText(path.join(workspaceRoot, "logs", "shared.md"), "shared\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // Created after the push, so it has no base snapshot and the remote has
  // never seen it: local-only, a push candidate, never a pull deletion.
  writeText(path.join(workspaceRoot, "logs", "local-only.md"), "local only\n");

  const jsonResult = runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "sync",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(jsonResult.stdout);

  assert.equal(payload.runs[0].kind, "sync");
  assert.deepEqual(payload.runs[0].protectedFiles, ["logs/local-only.md"]);
  assert.equal(readText(path.join(workspaceRoot, "logs", "local-only.md")), "local only\n");

  // The previous sync pushed local-only.md, so it now has a base snapshot.
  // A second brand-new file reproduces the same state for the text run.
  writeText(path.join(workspaceRoot, "logs", "local-only-two.md"), "local only two\n");

  const textResult = runCli(["run", "default", "--config", configPath, "--mode", "sync"]);

  assert.match(textResult.stdout, /operation=sync/);
  assert.match(textResult.stdout, /protected=1/);
});

// RM8 (R1 low): removing assertNoMassDelete from previewPush left the whole
// suite green, because no test drove an over-threshold plan through
// --dry-run. --dry-run is exactly how an operator inspects a plan before
// running it, so a dry-run that previews a plan the real run would refuse
// is worse than useless.
test("push --dry-run: an over-threshold plan is refused rather than previewed (AC-003)", () => {
  const root = createSandbox("mass-delete-dry-run");
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
    ["run", "default", "--config", configPath, "--mode", "push", "--dry-run", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(result.status, 5, `expected the mass-delete refusal's exit code. stderr: ${result.stderr}`);
  assert.match(result.stderr, /3 of 12/);
  assert.doesNotMatch(result.stdout, /"status": "dry-run"/);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-dry-run"), 12);

  // The preview's throwaway working copy is removed on the refusal path
  // too, not only when the preview completes (R2 low).
  assert.equal(
    fileExists(path.join(workspaceRoot, ".agent-memory-sync", "default", "tmp", "push-preview")),
    false
  );
});

// R1 medium, the reporting half: once a run really does remove paths, the
// payload has to say so. Same seam as the staged-gate test above (the
// working copy is emptied at staging time, so the merge plan reports no
// deletions at all) plus the documented override, so the push goes through
// and its payload can be inspected. deletedFiles must name what was
// published as removed, whether or not the plan asked for it.
test("push: deletedFiles reports what the commit removed, not what the plan intended (AC-003)", () => {
  const root = createSandbox("staged-deletion-reporting");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stubConfigPath = path.join(root, "config-stub-git.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  seedLogFiles(workspaceRoot, 30);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  writeProjectConfig(stubConfigPath, {
    ...createConfig(workspaceRoot, remoteDir),
    gitBinary: writeStubGitWipingWorkTreeOnStage(root)
  });

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\nedited\n");

  const result = runCli([
    "run",
    "default",
    "--config",
    stubConfigPath,
    "--mode",
    "push",
    "--allow-mass-delete",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "applied");
  // 30 log files plus MEMORY.md: every path the commit removed, none of
  // which the merge plan classified as a deletion.
  assert.equal(payload.runs[0].deletedFiles.length, 31);
  assert.ok(payload.runs[0].deletedFiles.includes("MEMORY.md"));
  assert.ok(payload.runs[0].deletedFiles.includes("logs/note-000.md"));
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-staged-reporting"), 0);
});

// git reports success for every subcommand, but `checkout` leaves the
// working copy without the paths OUTSIDE the configured repositorySubdir.
// That is the shape a shared remote has when a second tool (or a second
// profile) keeps its own subtree next to this one: nothing the sync
// destinations claim is missing, and `git add -A` still publishes every one
// of those paths as a deletion.
function writeStubGitWipingSiblingSubtree(root: string, siblingDir: string): string {
  const stubPath = path.join(root, `stub-git-wipes-${siblingDir}.sh`);
  writeText(
    stubPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "checkout" ]; then',
      '  git "$@" || exit $?',
      `  rm -rf "$PWD/${siblingDir}"`,
      "  exit 0",
      "fi",
      'exec git "$@"',
      ""
    ].join("\n")
  );
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

// A path no configured destination claims has no base denominator, so
// neither per-destination rule can see it. Pre-fix the push dropped it from
// the count entirely and published the whole sibling subtree's removal at
// exit 0, silently.
test("push: staged deletions outside the repository subdir are counted and refused (AC-003)", () => {
  const root = createSandbox("outside-subdir-deletions");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stubConfigPath = path.join(root, "config-stub-git.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  seedLogFiles(workspaceRoot, 5);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // 50 files in a sibling subtree of 'shared/', owned by nothing this
  // profile syncs.
  const peerCheckout = cloneRemote(remoteDir, root, "peer-outside");
  for (let index = 0; index < 50; index += 1) {
    writeText(path.join(peerCheckout, "other", `file-${String(index).padStart(3, "0")}.md`), `other ${index}\n`);
  }
  git(["add", "."], peerCheckout);
  git(["commit", "-m", "sibling subtree"], peerCheckout);
  git(["push", "origin", "HEAD:main"], peerCheckout);

  writeProjectConfig(stubConfigPath, {
    ...createConfig(workspaceRoot, remoteDir),
    gitBinary: writeStubGitWipingSiblingSubtree(root, "other")
  });

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\nedited\n");

  const result = runCli(
    ["run", "default", "--config", stubConfigPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(result.status, 5, `expected the mass-delete refusal's exit code. stderr: ${result.stderr}`);
  assert.match(result.stderr, /50 file\(s\)/);
  assert.match(result.stderr, /50 outside 'shared\/'/);

  // Nothing was published: the sibling subtree is still there, and so is
  // the edit this run would otherwise have pushed.
  const inspection = cloneRemote(remoteDir, root, "inspect-outside");
  assert.equal(fs.readdirSync(path.join(inspection, "other")).length, 50);
  assert.equal(readText(path.join(inspection, "shared", "MEMORY.md")), "memory root\n");
});

// R2 medium (docs): the flag overrides the PLAN guard. It has never been an
// answer to "the working copy this run fetched is not the remote", and the
// help text said it was.
test("run and watch help: --allow-mass-delete does not promise to merge an unreliable working copy", () => {
  for (const command of ["run", "watch"]) {
    const result = runCli([command, "--help"]);
    const flattened = result.stdout.replace(/\s+/g, " ");

    assert.match(flattened, /--allow-mass-delete/);
    assert.doesNotMatch(flattened, /merge a working copy/);
    assert.match(flattened, /does not override an unreliable checkout/);
  }
});

// R3 medium (D-019): `watch --accept-mass-delete` was standing consent for
// every future tick. Measured: a wiped checkout on a later tick deleted every
// local file the remote still held, with the watcher exiting 0. The escape is
// a one-shot `run`; `watch` does not take the flag at all.
test("watch does not accept --accept-mass-delete; run does (AC-007)", () => {
  const runHelp = runCli(["run", "--help"]).stdout.replace(/\s+/g, " ");
  assert.match(runHelp, /--accept-mass-delete/);

  const watchHelp = runCli(["watch", "--help"]).stdout.replace(/\s+/g, " ");
  assert.doesNotMatch(watchHelp, /--accept-mass-delete/);

  const root = createSandbox("watch-no-accept-flag");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  const rejected = runCli(
    ["watch", "default", "--config", configPath, "--accept-mass-delete", "--max-runs", "1"],
    { expectFailure: true }
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unknown option '--accept-mass-delete'/);
});

// git behaves normally except that the SECOND `git add` it is asked to run
// empties the working tree immediately before staging. Every invocation of
// `add` is counted in `counterPath`.
//
// R3 medium (D-017): the push used to stage twice, once to measure the
// deletions the commit would carry (the guard's numerator) and once more
// inside commitAll on the way to the commit. A wipe landing between the two
// was invisible to the measurement and published by the second stage: rc 0,
// the whole remote tree deleted, deletedFiles empty. The lock excludes other
// processes from stateDir, not this in-process window. The fix commits the
// index as measured, so there is no second stage for a wipe to reach.
function writeStubGitWipingWorkTreeOnSecondAdd(root: string, counterPath: string): string {
  const stubPath = path.join(root, "stub-git-wipes-on-second-add.sh");
  writeText(
    stubPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "add" ]; then',
      `  counter=${JSON.stringify(counterPath)}`,
      '  count=$(cat "$counter" 2>/dev/null || echo 0)',
      "  count=$((count + 1))",
      '  echo "$count" > "$counter"',
      '  if [ "$count" -eq 2 ]; then',
      '    find "$PWD" -name .git -prune -o -type f -print | while IFS= read -r entry; do',
      '      rm -f "$entry"',
      "    done",
      "  fi",
      "fi",
      'exec git "$@"',
      ""
    ].join("\n")
  );
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

// The observed outcome with the fix is that the wipe is irrelevant: the push
// stages exactly once, the commit carries the index as measured, and the
// stub's second-add trigger never fires, so the run completes as an ordinary
// healthy push of the one local edit. Pre-fix (measured at df78fb3): two
// `git add` invocations, rc 0, the remote's log tree 30 to 0.
for (const mode of ["push", "sync"]) {
  test(`${mode}: a working copy wiped after the measured stage cannot reach the commit (AC-003)`, () => {
    const root = createSandbox(`second-add-wipe-${mode}`);
    const remoteDir = initBareRemote(root);
    const workspaceRoot = path.join(root, "workspace");
    const configPath = path.join(root, "config.json");
    const stubConfigPath = path.join(root, "config-stub-git.json");
    const counterPath = path.join(root, "git-add-count.txt");

    writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
    seedLogFiles(workspaceRoot, 30);
    writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

    runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

    writeProjectConfig(stubConfigPath, {
      ...createConfig(workspaceRoot, remoteDir),
      gitBinary: writeStubGitWipingWorkTreeOnSecondAdd(root, counterPath)
    });

    writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\nedited\n");

    const result = runCli(
      ["run", "default", "--config", stubConfigPath, "--mode", mode, "--output", "json"],
      { expectFailure: true }
    );

    // The remote still holds every log file, whatever the exit code: a wipe
    // after the measurement must not be publishable.
    assert.equal(
      remoteLogFileCount(remoteDir, root, `inspect-second-add-${mode}`),
      30,
      `stderr: ${result.stderr}\nstdout: ${result.stdout}`
    );

    // One stage per snapshot: the commit takes the index as measured, so
    // there is no second `git add` for a wipe to land between.
    assert.equal(readText(counterPath).trim(), "1");

    // And with nothing wiped, the run is an ordinary push of the one edit.
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const inspection = cloneRemote(remoteDir, root, `inspect-second-add-${mode}-memory`);
    assert.equal(readText(path.join(inspection, "shared", "MEMORY.md")), "memory root\nedited\n");

    // The preview commits into its throwaway copy the same way: once per
    // snapshot, from the measured index, so its arithmetic matches the real
    // run's and the same seam cannot make a dry run disagree with it.
    fs.rmSync(counterPath, { force: true });
    writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\nedited twice\n");
    const previewed = runCli(
      ["run", "default", "--config", stubConfigPath, "--mode", mode, "--dry-run", "--output", "json"],
      { expectFailure: true }
    );
    assert.equal(previewed.status, 0, `stderr: ${previewed.stderr}`);
    assert.equal(JSON.parse(previewed.stdout).runs[0].status, "dry-run");
    assert.equal(readText(counterPath).trim(), "1");
  });
}

// R3 medium (D-018), the reporting half: after --accept-mass-delete adopted
// a loss, the base snapshot no longer tracks the adopted paths, and a refusal
// raised in the same run read "(50 of 0 tracked)". The share a plan removes
// is measured against what the run started with.
test("push: a refusal after an accepted adoption counts what the run started with (AC-003, AC-007)", () => {
  const root = createSandbox("post-accept-denominator");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stubConfigPath = path.join(root, "config-stub-git.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  seedLogFiles(workspaceRoot, 50);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  writeProjectConfig(stubConfigPath, {
    ...createConfig(workspaceRoot, remoteDir),
    gitBinary: writeStubGitWipingWorkTree(root)
  });

  // The preview first (R4 low, D-023): previewPush measures the adopted
  // plan against the same denominator the real run uses (guardBaseFiles,
  // the base the run started with), not against the base map the adoption
  // just emptied. A dry run of the acceptance refuses with the same count
  // and changes nothing.
  const previewed = runCli(
    [
      "run",
      "default",
      "--config",
      stubConfigPath,
      "--mode",
      "push",
      "--dry-run",
      "--accept-mass-delete",
      "--output",
      "json"
    ],
    { expectFailure: true }
  );
  assert.equal(previewed.status, 5, `expected the preview's mass-delete refusal. stderr: ${previewed.stderr}`);
  assert.match(previewed.stderr, /50 file\(s\) under 'logs' \(50 of 50 tracked\)/);
  assert.doesNotMatch(previewed.stderr, /of 0 tracked/);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-post-accept-preview"), 50);

  // The wiped working copy is adopted by consent (the local copies go, with
  // a snapshot taken first), and the staged deletions of everything HEAD
  // holds are then refused by the plan guard, which --accept-mass-delete
  // does not override.
  const result = runCli(
    [
      "run",
      "default",
      "--config",
      stubConfigPath,
      "--mode",
      "push",
      "--accept-mass-delete",
      "--output",
      "json"
    ],
    { expectFailure: true }
  );

  assert.equal(result.status, 5, `expected the mass-delete refusal's exit code. stderr: ${result.stderr}`);
  assert.match(result.stderr, /50 file\(s\) under 'logs' \(50 of 50 tracked\)/);
  assert.doesNotMatch(result.stderr, /of 0 tracked/);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-post-accept"), 50);
});

// RV7 (R2 low): previewPush commits each snapshot into its throwaway working
// copy, so snapshot N is measured against a HEAD that already carries
// snapshot N-1. Without that commit the preview re-counts the earlier
// snapshot's deletions and refuses a plan the real push accepts, which is
// exactly backwards for the command an operator uses to check a plan first.
test("push --dry-run: queued snapshots are measured one commit at a time (AC-003)", () => {
  const root = createSandbox("dry-run-queued-replay");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const offlineConfigPath = path.join(root, "config-offline.json");

  // maxRatio 1 switches the proportional rule off for this fixture, so the
  // arithmetic under test is the absolute rule alone.
  const guarded = { massDeleteGuard: { maxFiles: 20, maxRatio: 1 } };
  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, 100);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir, guarded));
  writeProjectConfig(
    offlineConfigPath,
    createConfig(workspaceRoot, path.join(root, "absent-remote.git"), guarded)
  );

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // Snapshot A: 12 deletions, queued because the remote is unreachable.
  for (const relativePath of seeded.slice(0, 12)) {
    fs.rmSync(path.join(workspaceRoot, relativePath));
  }
  const queuedA = runCli(
    ["run", "default", "--config", offlineConfigPath, "--mode", "push", "--output", "json"]
  );
  assert.equal(JSON.parse(queuedA.stdout).runs[0].status, "queued");

  // Snapshot B: the first batch is back byte-identical, a disjoint batch of
  // 11 is gone instead.
  for (let index = 0; index < 12; index += 1) {
    writeText(path.join(workspaceRoot, seeded[index]), `entry ${index}\n`);
  }
  for (const relativePath of seeded.slice(12, 23)) {
    fs.rmSync(path.join(workspaceRoot, relativePath));
  }
  const queuedB = runCli(
    ["run", "default", "--config", offlineConfigPath, "--mode", "push", "--output", "json"]
  );
  assert.equal(JSON.parse(queuedB.stdout).runs[0].status, "queued");
  assert.equal(fs.readdirSync(path.join(workspaceRoot, ".agent-memory-sync", "default", "queue")).length, 2);

  // 12 and 11 are each under the limit of 20; 23 is not. The preview must
  // measure them the way the real push does.
  const result = runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "push",
    "--dry-run",
    "--output",
    "json"
  ]);

  assert.equal(result.status, 0, `expected a clean preview. stderr: ${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).runs[0].status, "dry-run");

  // A preview publishes nothing and leaves no working copy behind.
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-dry-run-queued"), 100);
  assert.equal(
    fileExists(path.join(workspaceRoot, ".agent-memory-sync", "default", "tmp", "push-preview")),
    false
  );
});

// The preview measures the index for the same reason the real push does, and
// nothing pinned that half of it: a plan whose deletions only appear once the
// working copy is staged reads as an empty plan right up to the moment it is
// committed. A dry run that previewed such a plan as clean would be telling
// an operator the opposite of what the real run is about to do.
test("push --dry-run: a plan whose deletions appear only at staging time is refused (AC-003)", () => {
  const root = createSandbox("dry-run-staged-gate");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stubConfigPath = path.join(root, "config-stub-git.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  seedLogFiles(workspaceRoot, 30);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  writeProjectConfig(stubConfigPath, {
    ...createConfig(workspaceRoot, remoteDir),
    gitBinary: writeStubGitWipingWorkTreeOnStage(root)
  });

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\nedited\n");

  const result = runCli(
    ["run", "default", "--config", stubConfigPath, "--mode", "push", "--dry-run", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(result.status, 5, `expected the mass-delete refusal's exit code. stderr: ${result.stderr}`);
  assert.match(result.stderr, /30 file\(s\) under 'logs'/);
  assert.doesNotMatch(result.stdout, /"status": "dry-run"/);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-dry-run-staged"), 30);
});
