// The stateDir lock through the CLI (AC-004 of the 2026-09-11 wipe,
// agent-tasks cda5b12c, pandora run .ai/runs/2026-09-11-memory-sync-wipe).
//
// The incident's mechanism was two processes on one stateDir: a periodic
// `run --mode sync` tick and a `watch` tick, with nothing serialising them,
// one removing the other's working copy mid-run. These tests drive the
// refusal and the takeover through the real binary; the arithmetic itself is
// pinned in tests/unit/lock.test.ts.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { hostname } = require("node:os");
const path = require("node:path");
const {
  cloneRemote,
  createSandbox,
  git,
  initBareRemote,
  readText,
  runCli,
  writeProjectConfig,
  writeText
} = require("../helpers/cli.ts");
const { lockFilePath } = require("../../src/memory-sync/lock.ts");

function createConfig(workspaceRoot: string, remoteDir: string, extra: Record<string, unknown> = {}) {
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

// Seeds the remote without running the CLI, so the state directory does not
// exist yet when the locked run below starts: what the run touches is then
// exactly what it created.
function seedRemote(root: string, remoteDir: string, name: string): void {
  const checkout = cloneRemote(remoteDir, root, name);
  writeText(path.join(checkout, "shared", "MEMORY.md"), "remote seed\n");
  git(["add", "."], checkout);
  git(["commit", "-m", "seed"], checkout);
  git(["push", "origin", "HEAD:main"], checkout);
}

function writeLock(stateDir: string, record: Record<string, unknown>): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(lockFilePath(stateDir), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

test("run: a held lock stops the run with the documented code, before anything is touched", () => {
  const root = createSandbox("lock-held");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(workspaceRoot, ".agent-memory-sync", "default");

  seedRemote(root, remoteDir, "seed-held");
  writeText(path.join(workspaceRoot, "MEMORY.md"), "local only\n");
  writeText(path.join(workspaceRoot, "logs", "mine.md"), "mine\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  // This test process is alive, so the holder is neither stale by age nor
  // gone from the process table.
  writeLock(stateDir, {
    pid: process.pid,
    host: hostname(),
    command: "watch",
    acquiredAt: new Date().toISOString()
  });

  const result = runCli(
    ["run", "default", "--config", configPath, "--mode", "sync", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(result.status, 8, `expected the lock refusal's exit code. stderr: ${result.stderr}`);
  assert.match(result.stderr, new RegExp(`pid ${process.pid}`));
  assert.match(result.stderr, /watch/);

  // Nothing in the workspace moved, in either direction: the local file the
  // remote does not have is still local, the remote's seed was not pulled,
  // and the state directory holds nothing but the lock (no tmp working
  // copy, no base snapshots, no queue).
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "local only\n");
  assert.equal(readText(path.join(workspaceRoot, "logs", "mine.md")), "mine\n");
  assert.deepEqual(fs.readdirSync(stateDir), ["lock.json"]);

  const inspection = cloneRemote(remoteDir, root, "inspect-held");
  assert.equal(readText(path.join(inspection, "shared", "MEMORY.md")), "remote seed\n");
  assert.equal(fs.existsSync(path.join(inspection, "shared", "logs")), false);
});

test("run: a lock left behind by a dead run is taken over", () => {
  const root = createSandbox("lock-stale");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(workspaceRoot, ".agent-memory-sync", "default");

  seedRemote(root, remoteDir, "seed-stale");
  writeText(path.join(workspaceRoot, "logs", "mine.md"), "mine\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  writeLock(stateDir, {
    pid: process.pid,
    host: hostname(),
    command: "watch",
    acquiredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  });

  const result = runCli(["run", "default", "--config", configPath, "--mode", "sync", "--output", "json"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const inspection = cloneRemote(remoteDir, root, "inspect-stale");
  assert.equal(readText(path.join(inspection, "shared", "logs", "mine.md")), "mine\n");

  // And the run released what it took over.
  assert.equal(fs.existsSync(lockFilePath(stateDir)), false);
});

test("run: the lock is released again on a clean run and on a refused one", () => {
  const root = createSandbox("lock-release");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const badConfigPath = path.join(root, "config-missing-required.json");
  const stateDir = path.join(workspaceRoot, ".agent-memory-sync", "default");

  seedRemote(root, remoteDir, "seed-release");
  writeText(path.join(workspaceRoot, "MEMORY.md"), "mine\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  writeProjectConfig(
    badConfigPath,
    createConfig(workspaceRoot, remoteDir, {
      syncPaths: [{ source: "absent.md", destination: "absent.md", kind: "file", required: true }]
    })
  );

  runCli(["run", "default", "--config", configPath, "--mode", "sync", "--output", "json"]);
  assert.equal(fs.existsSync(lockFilePath(stateDir)), false);

  // A run that throws on its way through must not leave the lock behind
  // either: the next tick would find a lock nobody holds and wait out the
  // whole staleness window for it.
  const failed = runCli(
    ["run", "default", "--config", badConfigPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );
  assert.notEqual(failed.status, 0);
  assert.equal(fs.existsSync(lockFilePath(stateDir)), false);
});

test("restore: a held lock stops the restore with the documented code", () => {
  const root = createSandbox("lock-restore");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(workspaceRoot, ".agent-memory-sync", "default");

  seedRemote(root, remoteDir, "seed-restore");
  writeText(path.join(workspaceRoot, "MEMORY.md"), "local\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  const inspection = cloneRemote(remoteDir, root, "inspect-restore");
  const sha = git(["rev-parse", "HEAD"], inspection).trim();

  writeLock(stateDir, {
    pid: process.pid,
    host: hostname(),
    command: "run --mode sync",
    acquiredAt: new Date().toISOString()
  });

  const result = runCli(
    ["restore", sha, "--config", configPath, "--yes", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(result.status, 8, `expected the lock refusal's exit code. stderr: ${result.stderr}`);
  assert.match(result.stderr, new RegExp(`pid ${process.pid}`));
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "local\n");
});
