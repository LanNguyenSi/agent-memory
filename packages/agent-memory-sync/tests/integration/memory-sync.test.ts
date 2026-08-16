const test = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync, chmodSync } = require("node:fs");
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

// Asserts that `notes` was produced by the actual reachability precheck
// (src/memory-sync/reachability.ts) taking the local-path-missing branch for
// exactly `offlineRemoteDir` — not merely that some note contains the word
// "unreachable". Matching on that single word alone would not distinguish
// the precheck's early-return path from the pre-existing catch-all fallback
// (which uses "unavailable", not "unreachable" — a one-word difference that
// is itself a fragile signal). This checks two independent, specific pieces
// of evidence that only reachability.ts's checkRemoteReachable() produces
// together: the wrapper phrase pull.ts/push.ts add, AND the exact
// `local remote path '<path>' does not exist` reason string, with the
// literal offline path baked in — reverting the precheck wiring (e.g.
// deleting the early-return in performPull/performPush while leaving
// reachability.ts untouched) would make this assertion fail even though a
// generic /unreachable/-only match might still accidentally pass.
function assertUnreachablePrecheckNote(notesText: string, offlineRemoteDir: string): void {
  assert.match(notesText, /remote unreachable \(/);
  assert.match(
    notesText,
    new RegExp(`local remote path '${offlineRemoteDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' does not exist`)
  );
}

function createConfig(workspaceRoot: string, remoteDir: string) {
  return {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    syncPaths: [
      { source: "MEMORY.md", destination: "MEMORY.md", kind: "file" },
      { source: "logs", destination: "logs", kind: "directory" }
    ]
  };
}

// A stub git binary that behaves exactly like real git for every subcommand
// except `push`, which it rejects with a non-fast-forward-style stderr
// message — simulating a peer having pushed to the same branch concurrently.
// Mirrors watch-mirror-delete.test.ts's writeStubGitFailingOnCommit pattern:
// a plain POSIX shell script (not a Node script — see that file's comment on
// why), `exec`-ing the real `git` for every other subcommand.
function writeStubGitRejectingPush(root: string): string {
  const stubPath = path.join(root, "stub-git-rejects-push.sh");
  writeText(
    stubPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "push" ]; then',
      '  echo "! [rejected] main -> main (non-fast-forward)" >&2',
      "  exit 1",
      "fi",
      'exec git "$@"',
      ""
    ].join("\n")
  );
  chmodSync(stubPath, 0o755);
  return stubPath;
}

// performPush's catch block (src/memory-sync/push.ts) treats a
// RemoteUnavailableError caught from anywhere inside its try as "queue
// instead of crash" — tests/unit/git-client.test.ts pins the error itself
// (GitClient.push's message/type), but no existing test drove that error
// through performPush end-to-end: every other "queued" scenario in this
// suite is queued via the reachability precheck's early return, before
// prepareWorkingCopy or `git push` ever run. This is the first test where
// the remote is genuinely reachable (a real local bare repo) and the
// rejection happens at the actual `git push` call inside the try block.
test("a real 'git push' rejection (not caught by the reachability precheck) is queued for replay, not crashed", () => {
  const root = createSandbox("push-rejected-mid-flight");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "will be queued\n");
  const stubGitBinary = writeStubGitRejectingPush(root);
  writeProjectConfig(configPath, {
    ...createConfig(workspaceRoot, remoteDir),
    gitBinary: stubGitBinary
  });

  const result = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "queued");
  assert.ok(payload.runs[0].queuedSnapshotId);
  assert.match(payload.runs[0].notes.join(" "), /remote unavailable; stored the current local snapshot/);

  // The rejected push must not have landed on the remote at all.
  const inspectionDir = cloneRemote(remoteDir, root, "post-rejected-push");
  assert.equal(fileExists(path.join(inspectionDir, "shared", "MEMORY.md")), false);
});

test("push uploads local memory files to the remote repository", () => {
  const root = createSandbox("push");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "local memory\n");
  writeText(path.join(workspaceRoot, "logs", "2026-03-26.md"), "entry one\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  const result = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runs[0].kind, "push");
  assert.equal(payload.runs[0].status, "applied");

  const inspectionDir = cloneRemote(remoteDir, root, "inspection");
  assert.equal(readText(path.join(inspectionDir, "shared", "MEMORY.md")), "local memory\n");
  assert.equal(readText(path.join(inspectionDir, "shared", "logs", "2026-03-26.md")), "entry one\n");
});

// applySnapshotToWorkingCopy's `if (mergeResult.status === "unchanged") {
// continue; }` guard (src/memory-sync/push.ts) skips a file whose local
// content already matches the remote — every other push test in this suite
// changes at least one file, so a second, immediately-repeated push with no
// local changes in between was untested.
test("pushing twice in a row with no local changes in between is an idempotent no-op on the second push", () => {
  const root = createSandbox("push-noop-repeat");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "steady state\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  const firstRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const firstPayload = JSON.parse(firstRun.stdout);
  assert.equal(firstPayload.runs[0].status, "applied");
  assert.deepEqual(firstPayload.runs[0].appliedFiles, ["MEMORY.md"]);

  const secondRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const secondPayload = JSON.parse(secondRun.stdout);
  assert.equal(secondPayload.runs[0].status, "applied");
  assert.deepEqual(secondPayload.runs[0].appliedFiles, []);
  assert.deepEqual(secondPayload.runs[0].mergedFiles, []);
  assert.deepEqual(secondPayload.runs[0].conflictFiles, []);

  const inspectionDir = cloneRemote(remoteDir, root, "post-noop");
  assert.equal(readText(path.join(inspectionDir, "shared", "MEMORY.md")), "steady state\n");
});

test("pull merges concurrent append-only updates without conflict markers", () => {
  const root = createSandbox("pull-merge");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\nlocal\n");

  const remoteCheckout = cloneRemote(remoteDir, root, "remote-update");
  writeText(path.join(remoteCheckout, "shared", "MEMORY.md"), "base\nremote\n");
  git(["add", "."], remoteCheckout);
  git(["commit", "-m", "remote update"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].kind, "pull");
  assert.deepEqual(payload.runs[0].conflictFiles, []);
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "base\nremote\nlocal\n");
});

test("dry-run previews changes without mutating the remote repository", () => {
  const root = createSandbox("dry-run");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "before\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  writeText(path.join(workspaceRoot, "MEMORY.md"), "before\nafter\n");

  const result = runCli(["run", "default", "--config", configPath, "--mode", "push", "--dry-run", "--output", "json"]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runs[0].status, "dry-run");

  const inspectionDir = cloneRemote(remoteDir, root, "post-dry-run");
  assert.equal(readText(path.join(inspectionDir, "shared", "MEMORY.md")), "before\n");
});

test("offline push queues a snapshot and replays it after the remote returns", () => {
  const root = createSandbox("queue");
  const actualRemoteDir = initBareRemote(root);
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "queued change\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, offlineRemoteDir));

  const queuedRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const queuedPayload = JSON.parse(queuedRun.stdout);
  assert.equal(queuedPayload.runs[0].status, "queued");
  assert.ok(queuedPayload.runs[0].queuedSnapshotId);
  assert.equal(
    fileExists(path.join(workspaceRoot, ".agent-memory-sync", "default", "queue")),
    true
  );

  writeProjectConfig(configPath, createConfig(workspaceRoot, actualRemoteDir));
  const replayRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const replayPayload = JSON.parse(replayRun.stdout);
  assert.equal(replayPayload.runs[0].status, "applied");
  assert.match(replayPayload.runs[0].notes.join(" "), /replayed 1 queued snapshot/);

  const inspectionDir = cloneRemote(actualRemoteDir, root, "replayed");
  assert.equal(readText(path.join(inspectionDir, "shared", "MEMORY.md")), "queued change\n");
});

test("pull skips cleanly (exit 0) when the remote is unreachable, leaving local files untouched", () => {
  const root = createSandbox("pull-unreachable");
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "untouched\n");
  writeProjectConfig(configPath, {
    ...createConfig(workspaceRoot, offlineRemoteDir),
    // Keep the precheck itself fast in CI regardless of the default; this
    // remote is a local path though, so reachability is a plain fs check
    // (no spawn, no real timeout wait either way).
    reachabilityTimeoutMs: 500
  });

  // runCli() throws on a non-zero exit unless expectFailure is set — a plain
  // successful call here is itself the exit-0 assertion.
  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].kind, "pull");
  assert.equal(payload.runs[0].status, "skipped");
  assert.deepEqual(payload.runs[0].appliedFiles, []);
  assertUnreachablePrecheckNote(payload.runs[0].notes.join(" "), offlineRemoteDir);
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "untouched\n");
});

test("push queues repeatedly while the remote stays unreachable, keeping earlier queued snapshots", () => {
  const root = createSandbox("push-repeat-unreachable");
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "first\n");
  writeProjectConfig(configPath, {
    ...createConfig(workspaceRoot, offlineRemoteDir),
    reachabilityTimeoutMs: 500
  });

  const firstRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const firstPayload = JSON.parse(firstRun.stdout);
  assert.equal(firstPayload.runs[0].status, "queued");
  assertUnreachablePrecheckNote(firstPayload.runs[0].notes.join(" "), offlineRemoteDir);

  writeText(path.join(workspaceRoot, "MEMORY.md"), "second\n");
  const secondRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const secondPayload = JSON.parse(secondRun.stdout);
  assert.equal(secondPayload.runs[0].status, "queued");
  assert.notEqual(secondPayload.runs[0].queuedSnapshotId, firstPayload.runs[0].queuedSnapshotId);

  const queueDir = path.join(workspaceRoot, ".agent-memory-sync", "default", "queue");
  const queuedEntries = readdirSync(queueDir);
  assert.equal(queuedEntries.length, 2, `expected both queued snapshots to persist, found: ${queuedEntries.join(", ")}`);
});

test("dry-run push previews an unreachable remote without hanging or touching the queue", () => {
  const root = createSandbox("push-dry-run-unreachable");
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "preview me\n");
  writeProjectConfig(configPath, {
    ...createConfig(workspaceRoot, offlineRemoteDir),
    reachabilityTimeoutMs: 500
  });

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
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "dry-run");
  assertUnreachablePrecheckNote(payload.runs[0].notes.join(" "), offlineRemoteDir);

  // stateStore.ensure() always creates the queue directory, but a dry-run
  // must not enqueue anything into it.
  const queueDir = path.join(workspaceRoot, ".agent-memory-sync", "default", "queue");
  assert.deepEqual(readdirSync(queueDir), []);
});

test("default sync mode against an unreachable remote skips the pull and queues the push, cleanly", () => {
  const root = createSandbox("sync-unreachable");
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "sync me\n");
  writeProjectConfig(configPath, {
    ...createConfig(workspaceRoot, offlineRemoteDir),
    reachabilityTimeoutMs: 500
  });

  // No --mode flag: exercises the default "sync" mode (pull then push).
  const result = runCli(["run", "default", "--config", configPath, "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.mode, "sync");
  assert.equal(payload.runs[0].kind, "sync");
  assert.equal(payload.runs[0].status, "queued");
  assert.ok(payload.runs[0].queuedSnapshotId);
  assertUnreachablePrecheckNote(payload.runs[0].notes.join(" "), offlineRemoteDir);
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "sync me\n");
});

// `run --mode pull --dry-run` was not exercised anywhere in the existing
// suite (every prior pull test omits --dry-run; the only existing --dry-run
// coverage is for push). performPull's `if (options.dryRun)` branch — and,
// within it, both the "would update" and "would delete" sub-paths — were
// therefore untested.
test("dry-run pull previews a remote update without writing it to the local workspace", () => {
  const root = createSandbox("pull-dry-run-update");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "before\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const remoteCheckout = cloneRemote(remoteDir, root, "remote-update");
  writeText(path.join(remoteCheckout, "shared", "MEMORY.md"), "before\nremote-change\n");
  git(["add", "."], remoteCheckout);
  git(["commit", "-m", "remote update"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--dry-run", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "dry-run");
  assert.deepEqual(payload.runs[0].appliedFiles, ["MEMORY.md"]);
  assert.deepEqual(payload.runs[0].deletedFiles, []);
  // A dry-run must preview only — the local workspace file is untouched.
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "before\n");
});

test("dry-run pull previews a remote deletion without removing the local file", () => {
  const root = createSandbox("pull-dry-run-delete");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "shared content\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const remoteCheckout = cloneRemote(remoteDir, root, "remote-delete");
  git(["rm", path.join("shared", "MEMORY.md")], remoteCheckout);
  git(["commit", "-m", "remote delete"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--dry-run", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "dry-run");
  assert.deepEqual(payload.runs[0].deletedFiles, ["MEMORY.md"]);
  // A dry-run must preview only — the local file must still exist on disk.
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "shared content\n");
});

// GitClient.listFiles (src/memory-sync/git-client.ts) short-circuits to []
// when repositorySubdir does not exist in the working copy yet — the case
// for a genuinely fresh remote (no commits ever pushed to it). Every other
// pull test in this suite pulls AFTER a prior push already created that
// subdir, so this "pull is the very first sync operation" scenario, and
// pull.ts's own `workingCopy.remoteHead ? ... : null` fallback for
// remoteHeadAfter, were unexercised.
test("pull from a freshly initialized remote with no prior commits is a safe no-op", () => {
  const root = createSandbox("pull-fresh-remote");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "not yet pushed\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].kind, "pull");
  assert.equal(payload.runs[0].status, "applied");
  assert.equal(payload.runs[0].remoteHeadBefore, null);
  assert.equal(payload.runs[0].remoteHeadAfter, null);
  assert.deepEqual(payload.runs[0].appliedFiles, []);
  // A pre-existing local-only file (never pushed) must be untouched by a
  // pull against an empty remote.
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "not yet pushed\n");
});

// mapRemotePathToLocalAbsolute (src/memory-sync/config.ts) returns null for
// a remote path that no configured syncPaths entry maps to a local
// destination — pull.ts's `if (!localAbsolutePath) { continue; }` guard
// exists for exactly this. Not exercised by any existing test, since every
// prior pull scenario only ever populates the remote with files this
// package's own push put there (which by construction always map back to a
// local path). Here a file is committed directly to the remote's
// repositorySubdir, outside of any push from this CLI, with a name that
// createConfig's syncPaths (MEMORY.md, logs/) does not cover.
// KNOWN REPORTING-HONESTY DISCREPANCY, characterized here, not endorsed:
// pull.ts adds the remote path to changedFiles (surfaced as appliedFiles)
// BEFORE the `if (!localAbsolutePath) continue;` guard skips the write, so
// the payload claims "applied" for a file that was never written. A follow-up
// task exists to either exclude unmapped paths from appliedFiles or surface
// them separately (skippedFiles). If that fix lands, flip this test's
// appliedFiles assertion accordingly.
test("pull reports (but does not write) a remote file that no configured syncPath maps to a local path", () => {
  const root = createSandbox("pull-unmapped");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const remoteCheckout = cloneRemote(remoteDir, root, "remote-extra");
  writeText(path.join(remoteCheckout, "shared", "unmapped-notes.md"), "orphan content\n");
  git(["add", "."], remoteCheckout);
  git(["commit", "-m", "add a file outside configured syncPaths"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "applied");
  assert.ok(
    payload.runs[0].appliedFiles.includes("unmapped-notes.md"),
    `expected the unmapped remote file to be reported as applied: ${JSON.stringify(payload.runs[0].appliedFiles)}`
  );
  assert.equal(
    fileExists(path.join(workspaceRoot, "unmapped-notes.md")),
    false,
    "must not write a file for a remote path with no configured local mapping"
  );
});
