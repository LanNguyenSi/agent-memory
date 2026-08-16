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
const { StateStore } = require("../../src/memory-sync/state-store");

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
// FLIPPED (agent-tasks e4b5552a): this test used to characterize a
// reporting-honesty discrepancy — pull.ts added the remote path to
// changedFiles (surfaced as appliedFiles) BEFORE the
// `if (!localAbsolutePath) continue;` guard skipped the write, so the
// payload claimed "applied" for a file that was never written. pull.ts now
// checks the mapping first and records an unmapped path in skippedFiles
// instead of changedFiles, so appliedFiles only ever lists files this run
// actually wrote or deleted. This test pins that fix: the unmapped remote
// file must never appear in appliedFiles, and must appear in skippedFiles.
test("pull reports an unmapped remote file as skipped, not applied, and does not write it", () => {
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
    !payload.runs[0].appliedFiles.includes("unmapped-notes.md"),
    `unmapped remote file must never be reported as applied: ${JSON.stringify(payload.runs[0].appliedFiles)}`
  );
  assert.ok(
    payload.runs[0].skippedFiles.includes("unmapped-notes.md"),
    `expected the unmapped remote file to be reported as skipped: ${JSON.stringify(payload.runs[0].skippedFiles)}`
  );
  assert.equal(
    fileExists(path.join(workspaceRoot, "unmapped-notes.md")),
    false,
    "must not write a file for a remote path with no configured local mapping"
  );
});

// Fix-round finding (agent-tasks e4b5552a, MEDIUM #1, reshaped by agent-tasks
// 65380570-fix MEDIUM #4): a remote path with no configured syncPaths
// mapping used to get recorded into the base snapshot store by ANY prior
// pull (replaceBaseSnapshots stored every remote file, mapped or not — see
// pull.ts's collectRemoteFiles). A later remote edit to that same unmapped
// path then merged as base=v1/local=null/remote=v2, which mergeText resolves
// to a "conflict" (no clean fast path and no append-only-suffix relationship
// applies) before pull.ts's mapping guard ever ran. The guard used to sit
// AFTER the merged/conflict pushes, so this path landed in conflictFiles
// even though no local file was ever written for it to hold conflict markers
// in — reviewer-reproduced as `conflicts=1 skipped=1` for a file the run
// never touched. The guard now runs first, so an unmapped path is classified
// exactly once, as skipped, and never enters mergedFiles/conflictFiles.
//
// RESHAPED (agent-tasks 65380570-fix, MEDIUM #4): this test used to
// establish the base=v1 entry via a real `pull` run, on the theory that
// pull's own (pre-existing) base-snapshot write would still record an
// unmapped path. Since agent-tasks 65380570 shipped, pull's write already
// filters unmapped paths out (pull.ts's own stateStore.replaceBaseSnapshots
// call), and this same fix-round closed push's matching write-side gap too
// (push.ts), so neither pull nor push can produce this base=v1 shape
// through their own normal operation anymore, and the original setup no
// longer reaches the conflict branch this test exists to guard. The
// contamination is instead seeded directly into the on-disk base snapshot
// store via StateStore's own public API, simulating a store inherited from a
// machine that has not yet upgraded past the pre-fix version, exactly the
// class of store filterUnmappedBaseMap's read-side filter (push.ts) and this
// guard-ordering fix (pull.ts) both exist to defend against.
test("pull records a second remote change to an already-tracked unmapped file as skipped only, never merged or conflicted", () => {
  const root = createSandbox("pull-unmapped-second-change");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(workspaceRoot, ".agent-memory-sync", "default");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // Seed the base snapshot store directly with a pre-fix-style contaminated
  // entry (base=v1 for the unmapped path), preserving the MEMORY.md entry
  // the push above already wrote.
  const stateStore = new StateStore(stateDir, "default");
  const seededBase = stateStore.readBaseSnapshots();
  stateStore.replaceBaseSnapshots({ ...seededBase, "unmapped-notes.md": "v1\n" });

  const remoteCheckoutV2 = cloneRemote(remoteDir, root, "remote-unmapped-v2");
  writeText(path.join(remoteCheckoutV2, "shared", "unmapped-notes.md"), "v2\n");
  git(["add", "."], remoteCheckoutV2);
  git(["commit", "-m", "change the unmapped file again"], remoteCheckoutV2);
  git(["push", "origin", "HEAD:main"], remoteCheckoutV2);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.ok(
    payload.runs[0].skippedFiles.includes("unmapped-notes.md"),
    `expected the unmapped remote file to be reported as skipped: ${JSON.stringify(payload.runs[0].skippedFiles)}`
  );
  assert.ok(
    !payload.runs[0].conflictFiles.includes("unmapped-notes.md"),
    `unmapped remote file must never be reported as a conflict: ${JSON.stringify(payload.runs[0].conflictFiles)}`
  );
  assert.ok(
    !payload.runs[0].mergedFiles.includes("unmapped-notes.md"),
    `unmapped remote file must never be reported as merged: ${JSON.stringify(payload.runs[0].mergedFiles)}`
  );
  assert.equal(
    fileExists(path.join(workspaceRoot, "unmapped-notes.md")),
    false,
    "must not write a file for a remote path with no configured local mapping"
  );
});

// Repro test for the push-side half of the unmapped-path defect (agent-tasks
// 65380570), reproduced by the reviewer of PR #101 against both
// origin/master and this fix branch: a pull that records an unmapped remote
// path into the base snapshot store (readBaseSnapshots) then feeds the NEXT
// push's 3-way merge (applySnapshotToWorkingCopy in push.ts) a
// base=<content>/local=null pair for that path — collectLocalSyncFiles never
// produces an entry for a path with no syncPaths mapping, so "local" is
// always null for it. With the remote itself unchanged since that pull,
// mergeText's remote===base fast path resolved to "local wins" with
// content=null, silently DELETING a peer's file this machine never had a
// local copy of, and reporting it under appliedFiles as if legitimately
// applied — a data-loss-class bug: some OTHER peer's file disappears from
// the shared remote because THIS machine happened to run pull then push.
// Fixed by config.ts's filterUnmappedBaseMap, called from both pull.ts's
// base-snapshot write and push.ts's base-snapshot read (see those call
// sites' comments for the full design-decision writeup). Repro recipe from
// the bug report: commit a file directly into the bare remote's
// repositorySubdir (never touched by this CLI, simulating another peer's
// push), pull (records it into base snapshots as skippedFiles), then push.
test("push never deletes an unmapped peer file the previous pull only recorded into base snapshots", () => {
  const root = createSandbox("push-unmapped-peer-delete");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const remoteCheckout = cloneRemote(remoteDir, root, "remote-push-unmapped");
  writeText(path.join(remoteCheckout, "shared", "unmapped-notes.md"), "peer content\n");
  git(["add", "."], remoteCheckout);
  git(["commit", "-m", "add a peer file outside configured syncPaths"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  const beforePullPush = cloneRemote(remoteDir, root, "remote-push-unmapped-before");
  assert.equal(
    fileExists(path.join(beforePullPush, "shared", "unmapped-notes.md")),
    true,
    "sanity check: the peer file exists on the remote before pull+push"
  );

  const pullResult = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const pullPayload = JSON.parse(pullResult.stdout);
  assert.ok(
    pullPayload.runs[0].skippedFiles.includes("unmapped-notes.md"),
    `expected pull to skip the unmapped peer file: ${JSON.stringify(pullPayload.runs[0].skippedFiles)}`
  );

  const pushResult = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const pushPayload = JSON.parse(pushResult.stdout);

  assert.ok(
    !pushPayload.runs[0].appliedFiles.includes("unmapped-notes.md"),
    `push must never report an unmapped peer file as applied: ${JSON.stringify(pushPayload.runs[0].appliedFiles)}`
  );

  const afterPullPush = cloneRemote(remoteDir, root, "remote-push-unmapped-after");
  assert.equal(
    fileExists(path.join(afterPullPush, "shared", "unmapped-notes.md")),
    true,
    "push must not delete an unmapped peer file it never had a local copy of"
  );
});

// Fix-round finding (agent-tasks 65380570-fix, HIGH #1/#2a): the test above
// reproduces the ORIGINAL pull-then-push cascade, but the reviewer found a
// second, push-only path to the same data loss: push rebuilds its OWN base
// snapshot after every successful push from a fresh read of the entire
// remote repositorySubdir tree (collectRemoteFiles in push.ts), unmapped
// paths included, regardless of what that particular push touched. Left
// unfiltered at that write (the fix this round adds at push.ts's
// stateStore.replaceBaseSnapshots(finalRemoteFiles) call), a machine that
// never once calls `pull` can still delete a peer's unmapped file, purely
// through its own repeated pushes.
//
// DEVIATION from the reviewer's literal recipe ("seed via push, peer commits,
// push, push again", asserting red with the READ-side filter removed):
// empirically, once pull's pre-existing write filter and this round's new
// push write filter (finding #1) are both in place, that exact push/push/push
// sequence produces a base store that is ALREADY clean by construction. Pull
// is never called, and push's own write filters the peer path out of the
// base on every push, so the read-side filter (push's currentBaseMap) never
// gets exercised no matter how many times this specific sequence repeats.
// Measured directly: with ONLY the read-side filter removed (write filters
// intact), that literal recipe stayed green; the same is true of the
// pre-existing "push never deletes an unmapped peer file the previous pull
// only recorded into base snapshots" test above, since pull's own write
// filter already keeps that path out of the base before push ever reads it.
// The read-side filter's own defended scenario is a store contaminated by
// something OTHER than pull/push's own filtered writes (see its comment in
// push.ts and config.ts), so this test seeds that directly instead, the
// same technique the MEDIUM #4 test above uses for pull.ts's guard ordering.
// Verified red with the read-side filter (push.ts's currentBaseMap filter)
// removed, quoted in the fix-round report; the write-filter-only build above
// stays green under the same mutation.
test("push never deletes an unmapped peer file recorded in a legacy-contaminated base store, even with no pull involved", () => {
  const root = createSandbox("push-only-unmapped-peer-delete");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(workspaceRoot, ".agent-memory-sync", "default");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  // Seed via push: establishes this machine's own base snapshot. This
  // machine never runs pull anywhere in this test.
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // Peer commits an unmapped file directly into the remote's
  // repositorySubdir, outside any push from this CLI.
  const remoteCheckout = cloneRemote(remoteDir, root, "remote-push-only-unmapped");
  writeText(path.join(remoteCheckout, "shared", "unmapped-notes.md"), "peer content\n");
  git(["add", "."], remoteCheckout);
  git(["commit", "-m", "add a peer file outside configured syncPaths"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  // Seed the base store directly with a legacy-contaminated entry whose
  // content matches what is currently on the remote, simulating a store
  // carried over from a machine that ran a pre-fix version of this CLI (or
  // restored from an old backup), which recorded this unmapped path via an
  // old, unfiltered write. Neither pull nor push can produce this shape
  // themselves anymore now that both of their own writes are filtered.
  const stateStore = new StateStore(stateDir, "default");
  const seededBase = stateStore.readBaseSnapshots();
  stateStore.replaceBaseSnapshots({ ...seededBase, "unmapped-notes.md": "peer content\n" });

  const pushResult = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const pushPayload = JSON.parse(pushResult.stdout);

  assert.ok(
    !pushPayload.runs[0].appliedFiles.includes("unmapped-notes.md"),
    `push must never report an unmapped peer file as applied: ${JSON.stringify(pushPayload.runs[0].appliedFiles)}`
  );

  const afterPush = cloneRemote(remoteDir, root, "remote-push-only-unmapped-after");
  assert.equal(
    fileExists(path.join(afterPush, "shared", "unmapped-notes.md")),
    true,
    "push must never delete an unmapped peer file recorded in a legacy-contaminated base store, with no pull involved"
  );
});

// Fix-round finding (agent-tasks 65380570-fix, HIGH #2b): a mutation probe
// for pull.ts's own base-snapshot write filter, inspecting the on-disk base
// snapshot store directly rather than only pull's own appliedFiles/
// skippedFiles report, a stronger pin than a reporting-only assertion,
// since it is the base STORE'S content, not the report, that later feeds
// push's 3-way merge and can silently delete a peer's file. Verified red
// with pull.ts's filterUnmappedBaseMap call (at its
// stateStore.replaceBaseSnapshots call) removed.
test("pull never records an unmapped remote file into the base snapshot store", () => {
  const root = createSandbox("pull-unmapped-base-store");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(workspaceRoot, ".agent-memory-sync", "default");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const remoteCheckout = cloneRemote(remoteDir, root, "remote-pull-base-store");
  writeText(path.join(remoteCheckout, "shared", "unmapped-notes.md"), "orphan content\n");
  git(["add", "."], remoteCheckout);
  git(["commit", "-m", "add a file outside configured syncPaths"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);

  const stateStore = new StateStore(stateDir, "default");
  const baseSnapshots = stateStore.readBaseSnapshots();
  assert.ok(
    !Object.prototype.hasOwnProperty.call(baseSnapshots, "unmapped-notes.md"),
    `base snapshot store must never record an unmapped remote path after pull: ${JSON.stringify(Object.keys(baseSnapshots))}`
  );
});

// Fix-round finding (agent-tasks 65380570-fix, HIGH #1/#2c): the same
// on-disk assertion as the pull test above, but for push's own base write,
// this is the direct mutation probe for THIS round's fix (push.ts's
// stateStore.replaceBaseSnapshots(finalRemoteFiles) call). Verified red with
// that filterUnmappedBaseMap call removed (reverting to the unfiltered
// finalRemoteFiles write this fix-round closes).
test("push never records an unmapped remote file into the base snapshot store", () => {
  const root = createSandbox("push-unmapped-base-store");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(workspaceRoot, ".agent-memory-sync", "default");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const remoteCheckout = cloneRemote(remoteDir, root, "remote-push-base-store");
  writeText(path.join(remoteCheckout, "shared", "unmapped-notes.md"), "peer content\n");
  git(["add", "."], remoteCheckout);
  git(["commit", "-m", "add a peer file outside configured syncPaths"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const stateStore = new StateStore(stateDir, "default");
  const baseSnapshots = stateStore.readBaseSnapshots();
  assert.ok(
    !Object.prototype.hasOwnProperty.call(baseSnapshots, "unmapped-notes.md"),
    `base snapshot store must never record an unmapped remote path after push: ${JSON.stringify(Object.keys(baseSnapshots))}`
  );
});

// Fix-round finding (agent-tasks 65380570-fix, HIGH #2d): queued-snapshot
// replay coverage for push.ts's filter on a QUEUED snapshot's stored
// baseFiles (distinct from the "current" snapshot's currentBaseMap filtered
// above). Directly enqueues a stale snapshot carrying the unmapped peer path
// in its stored baseFiles, simulating one queued by a pre-fix/pre-deploy
// version of this CLI while the remote was unreachable, the only way to
// reproduce that shape deterministically, mirroring
// owner-scoped-push.test.ts's own StateStore-seeding pattern for the
// equivalent ownerScoped case. Verified red with that filterUnmappedBaseMap
// call (on the queued snapshot's baseFiles) removed.
test("push replay strips an unmapped path out of a queued snapshot's stored baseFiles too, so draining the queue never deletes it", () => {
  const root = createSandbox("push-unmapped-queued-base-leak");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(workspaceRoot, ".agent-memory-sync", "default");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  // Peer's unmapped file already exists on the remote before this machine
  // ever runs.
  const remoteCheckout = cloneRemote(remoteDir, root, "remote-queued-unmapped");
  writeText(path.join(remoteCheckout, "shared", "unmapped-notes.md"), "peer content\n");
  git(["add", "."], remoteCheckout);
  git(["commit", "-m", "add a peer file outside configured syncPaths"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  // Directly enqueue a stale snapshot carrying the unmapped peer path in its
  // stored baseFiles.
  const stateStore = new StateStore(stateDir, "default");
  stateStore.enqueueSnapshot({
    localFiles: {},
    baseFiles: { "unmapped-notes.md": "peer content\n" }
  });

  const result = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const payload = JSON.parse(result.stdout).runs[0];

  assert.equal(payload.status, "applied");
  assert.match((payload.notes || []).join(" "), /replayed 1 queued snapshot/);
  assert.ok(
    !payload.appliedFiles.includes("unmapped-notes.md"),
    `queued replay must never report the unmapped peer file as applied: ${JSON.stringify(payload.appliedFiles)}`
  );

  const inspection = cloneRemote(remoteDir, root, "inspect-queued-unmapped");
  assert.equal(
    fileExists(path.join(inspection, "shared", "unmapped-notes.md")),
    true,
    "draining a queued snapshot must not delete an unmapped peer file via its stale baseFiles entry"
  );
});

// Fix-round finding (agent-tasks 65380570-fix, LOW #6c): a malformed key
// (one that fails normalizeRemoteRelativePath's own validation outright,
// e.g. a leading "..") seeded directly into the on-disk base snapshot store
// must not crash a push. mapRemotePathToLocalAbsolute catches the thrown
// CliError and treats the key as unmapped instead of propagating it. See
// tests/unit/config.test.ts for the same guard exercised as a pure
// function, without a real git remote.
test("push does not crash on a malformed key in the base snapshot store, and drops it as unmapped", () => {
  const root = createSandbox("push-malformed-base-key");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(workspaceRoot, ".agent-memory-sync", "default");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const stateStore = new StateStore(stateDir, "default");
  const seededBase = stateStore.readBaseSnapshots();
  stateStore.replaceBaseSnapshots({ ...seededBase, "../escape": "malformed key content\n" });

  const result = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const payload = JSON.parse(result.stdout).runs[0];

  assert.equal(payload.status, "applied");
  assert.ok(
    !payload.appliedFiles.includes("../escape"),
    `a malformed base-store key must never be reported as applied: ${JSON.stringify(payload.appliedFiles)}`
  );
});

// Fix-round finding (agent-tasks 65380570-fix, MEDIUM #5): removing a
// syncPaths mapping (a config shrink, an operator drops an entry that used
// to be tracked) turns that path unmapped from this run's point of view.
// filterUnmappedBaseMap then excludes it from the shrunk config's own base
// write, and applySnapshotToWorkingCopy never visits it (it is in neither
// this config's local nor base map), so the file already on the remote from
// before the shrink is left untouched rather than deleted, the safer of
// the two possible semantics, and the one this fix-round makes deliberate
// (previously undocumented, reviewer-measured against master). Pinned here:
// mapping removed -> the remote file survives and is not reported as
// applied.
test("removing a syncPaths mapping (a config shrink) leaves the previously-tracked remote file in place, not deleted", () => {
  const root = createSandbox("config-shrink-survives");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeText(path.join(workspaceRoot, "extra.md"), "extra content\n");

  const configWithExtra = {
    ...createConfig(workspaceRoot, remoteDir),
    syncPaths: [
      { source: "MEMORY.md", destination: "MEMORY.md", kind: "file" },
      { source: "extra.md", destination: "extra.md", kind: "file" }
    ]
  };
  writeProjectConfig(configPath, configWithExtra);

  const firstPush = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.ok(JSON.parse(firstPush.stdout).runs[0].appliedFiles.includes("extra.md"));

  const beforeShrink = cloneRemote(remoteDir, root, "config-shrink-before");
  assert.equal(fileExists(path.join(beforeShrink, "shared", "extra.md")), true, "sanity check");

  // Config shrink: extra.md's mapping is removed entirely, leaving
  // MEMORY.md as the only configured syncPaths entry. Same
  // rootDir/stateDir/remote as before, only syncPaths changed.
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  const shrinkPush = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const shrinkPayload = JSON.parse(shrinkPush.stdout).runs[0];
  assert.ok(
    !shrinkPayload.appliedFiles.includes("extra.md"),
    `a config shrink must not report extra.md as applied/deleted: ${JSON.stringify(shrinkPayload.appliedFiles)}`
  );

  const afterShrink = cloneRemote(remoteDir, root, "config-shrink-after");
  assert.equal(
    fileExists(path.join(afterShrink, "shared", "extra.md")),
    true,
    "removing a syncPaths mapping must leave the previously-tracked remote file in place, not delete it"
  );
});

// Fix-round finding (agent-tasks e4b5552a, MEDIUM #3): run.ts's default
// "sync" mode merges pull's and push's skippedFiles into the combined
// result (`skippedFiles: unique([...pullResult.skippedFiles, ...])`), but no
// existing test drove an unmapped remote path through `--mode sync` — every
// prior skippedFiles test used `--mode pull` directly. Mutation-tested: with
// that merge line deleted, this test goes red (see fix-round report).
test("run --mode sync reports an unmapped remote file as skipped in the combined result", () => {
  const root = createSandbox("sync-unmapped");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const remoteCheckout = cloneRemote(remoteDir, root, "remote-sync-extra");
  writeText(path.join(remoteCheckout, "shared", "unmapped-notes.md"), "orphan content\n");
  git(["add", "."], remoteCheckout);
  git(["commit", "-m", "add a file outside configured syncPaths"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "sync", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].kind, "sync");
  assert.ok(
    Array.isArray(payload.runs[0].skippedFiles) && payload.runs[0].skippedFiles.includes("unmapped-notes.md"),
    `expected the combined sync result to report the unmapped file as skipped: ${JSON.stringify(payload.runs[0].skippedFiles)}`
  );
  // FLIPPED (agent-tasks 65380570): this test used to NOT assert
  // appliedFiles here, with a comment documenting the push-side half of the
  // same defect as a separate, out-of-scope behavior — pull's own
  // base-snapshot recording of the unmapped path (replaceBaseSnapshots
  // stored every remote file, mapped or not) fed push's own remote===base
  // fast path, which independently resolved to "local wins" with
  // content=null and DELETED the unmapped peer file from the remote,
  // reporting it under appliedFiles. pull.ts now strips unmapped paths out
  // of what it records into the base snapshot store
  // (config.ts's filterUnmappedBaseMap), so push never sees a base entry for
  // a path it never had a local file for, and never treats that path's
  // absence locally as a delete. This test now pins the fixed behavior: the
  // unmapped peer file survives the combined sync and is never reported as
  // applied.
  assert.ok(
    !payload.runs[0].appliedFiles.includes("unmapped-notes.md"),
    `unmapped peer file must never be reported as applied by push: ${JSON.stringify(payload.runs[0].appliedFiles)}`
  );
  assert.equal(
    fileExists(path.join(workspaceRoot, "unmapped-notes.md")),
    false,
    "must not write a file for a remote path with no configured local mapping"
  );

  const postSyncRemote = cloneRemote(remoteDir, root, "sync-unmapped-post");
  assert.equal(
    fileExists(path.join(postSyncRemote, "shared", "unmapped-notes.md")),
    true,
    "sync's push half must not delete an unmapped peer file from the remote"
  );
});

// Fix-round finding (agent-tasks e4b5552a, LOW #4): the dry-run pull branch
// (performPull's `if (options.dryRun)`) shares the same mapping guard as the
// real-write branch, but no existing dry-run test exercised an unmapped
// remote path — the existing dry-run coverage only pins the "would update" /
// "would delete" mapped-path cases.
test("dry-run pull previews an unmapped remote file as skipped, not applied, and does not write it", () => {
  const root = createSandbox("pull-dry-run-unmapped");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const remoteCheckout = cloneRemote(remoteDir, root, "remote-dry-run-unmapped");
  writeText(path.join(remoteCheckout, "shared", "unmapped-notes.md"), "orphan content\n");
  git(["add", "."], remoteCheckout);
  git(["commit", "-m", "add a file outside configured syncPaths"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--dry-run", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "dry-run");
  assert.deepEqual(payload.runs[0].appliedFiles, []);
  assert.ok(
    payload.runs[0].skippedFiles.includes("unmapped-notes.md"),
    `expected the unmapped remote file to be reported as skipped: ${JSON.stringify(payload.runs[0].skippedFiles)}`
  );
  assert.equal(
    fileExists(path.join(workspaceRoot, "unmapped-notes.md")),
    false,
    "a dry-run must not write a file for a remote path with no configured local mapping"
  );
});

// Fix-round finding (agent-tasks e4b5552a, LOW #4): pins skippedFiles as a
// present, empty array (not undefined/absent) on a pull that has nothing to
// skip — the flip side of the "present and non-empty" coverage above.
test("pull with only a mapped change reports an empty skippedFiles array, not undefined", () => {
  const root = createSandbox("pull-no-skips");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "before\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const remoteCheckout = cloneRemote(remoteDir, root, "remote-no-skips");
  writeText(path.join(remoteCheckout, "shared", "MEMORY.md"), "before\nremote-change\n");
  git(["add", "."], remoteCheckout);
  git(["commit", "-m", "remote update"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "applied");
  assert.deepEqual(payload.runs[0].appliedFiles, ["MEMORY.md"]);
  assert.ok(Array.isArray(payload.runs[0].skippedFiles), "skippedFiles must be a present array, not undefined");
  assert.deepEqual(payload.runs[0].skippedFiles, []);
});
