const test = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync } = require("node:fs");
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
  assert.match(payload.runs[0].notes.join(" "), /unreachable/);
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
  assert.match(firstPayload.runs[0].notes.join(" "), /unreachable/);

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
  assert.match(payload.runs[0].notes.join(" "), /unreachable/);

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
  assert.match(payload.runs[0].notes.join(" "), /unreachable/);
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "sync me\n");
});
