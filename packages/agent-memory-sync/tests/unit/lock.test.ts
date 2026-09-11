// Unit coverage for the stateDir advisory lock (src/memory-sync/lock.ts).
//
// Origin: the 2026-09-11 memory-corpus wipe (agent-tasks cda5b12c, pandora
// run .ai/runs/2026-09-11-memory-sync-wipe). The periodic sync job and the
// watch job shared one stateDir with nothing serialising them, and the wipe
// began when one job removed the other's working copy underneath it. This
// file pins the lock's own arithmetic (acquire, refusal, staleness,
// takeover, release); tests/integration/lock.test.ts drives it through the
// CLI.
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { hostname } = require("node:os");
const path = require("node:path");
const {
  DEFAULT_LOCK_STALE_MS,
  acquireStateDirLock,
  lockFilePath
} = require("../../src/memory-sync/lock");

function sandbox(name: string): string {
  const root = path.join(
    require("node:os").tmpdir(),
    `agent-memory-sync-lock-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  mkdirSync(root, { recursive: true });
  return root;
}

function writeLockFile(stateDir: string, record: Record<string, unknown>): string {
  const filePath = lockFilePath(stateDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return filePath;
}

test("the documented staleness default is 30 minutes", () => {
  assert.equal(DEFAULT_LOCK_STALE_MS, 30 * 60 * 1000);
});

test("acquire writes a lock file naming the holder, and release removes it", () => {
  const stateDir = path.join(sandbox("acquire"), "state");

  const lock = acquireStateDirLock({ stateDir, command: "run --mode sync" });
  const record = JSON.parse(readFileSync(lockFilePath(stateDir), "utf8"));

  assert.equal(record.pid, process.pid);
  assert.equal(record.host, hostname());
  assert.equal(record.command, "run --mode sync");
  assert.ok(Number.isFinite(Date.parse(record.acquiredAt)), `acquiredAt is not an ISO timestamp: ${record.acquiredAt}`);

  lock.release();
  assert.equal(existsSync(lockFilePath(stateDir)), false);
});

test("a live lock is refused with the documented exit code and the holder pid", () => {
  const stateDir = path.join(sandbox("refuse"), "state");
  // This process is alive by construction, so the holder cannot be read as
  // a dead one, and the timestamp is fresh, so it cannot be read as stale.
  writeLockFile(stateDir, {
    pid: process.pid,
    host: hostname(),
    command: "watch",
    acquiredAt: new Date().toISOString()
  });

  assert.throws(
    () => acquireStateDirLock({ stateDir, command: "run --mode sync" }),
    (error: Error & { exitCode?: number }) => {
      assert.equal(error.name, "StateDirLockedError");
      assert.equal(error.exitCode, 8);
      assert.match(error.message, new RegExp(`pid ${process.pid}`));
      assert.match(error.message, /watch/);
      assert.match(error.message, /Nothing was read or written/);
      return true;
    }
  );
});

test("a lock older than the staleness age is taken over", () => {
  const stateDir = path.join(sandbox("stale"), "state");
  writeLockFile(stateDir, {
    pid: process.pid,
    host: hostname(),
    command: "watch",
    acquiredAt: new Date(Date.now() - 2 * DEFAULT_LOCK_STALE_MS).toISOString()
  });

  const lock = acquireStateDirLock({ stateDir, command: "run --mode sync" });
  const record = JSON.parse(readFileSync(lockFilePath(stateDir), "utf8"));
  assert.equal(record.command, "run --mode sync");
  lock.release();
});

test("staleness is configurable, and a lock inside the configured age still holds", () => {
  const stateDir = path.join(sandbox("stale-config"), "state");
  writeLockFile(stateDir, {
    pid: process.pid,
    host: hostname(),
    command: "watch",
    acquiredAt: new Date(Date.now() - 5000).toISOString()
  });

  // 5s old: stale under a 1s policy, live under a 60s one.
  assert.throws(
    () => acquireStateDirLock({ stateDir, command: "run", staleMs: 60000 }),
    /StateDirLockedError|holds the lock/
  );
  const lock = acquireStateDirLock({ stateDir, command: "run", staleMs: 1000 });
  lock.release();
});

test("a lock whose holder is gone on this host is taken over", () => {
  const stateDir = path.join(sandbox("dead-holder"), "state");
  // Never a live pid: the kernel rejects it outright, so `process.kill(pid, 0)`
  // cannot be fooled by pid reuse here.
  writeLockFile(stateDir, {
    pid: -12345,
    host: hostname(),
    command: "watch",
    acquiredAt: new Date().toISOString()
  });

  const lock = acquireStateDirLock({ stateDir, command: "run --mode sync" });
  assert.equal(JSON.parse(readFileSync(lockFilePath(stateDir), "utf8")).command, "run --mode sync");
  lock.release();
});

test("a lock claimed by another host is never judged by this host's process table", () => {
  const stateDir = path.join(sandbox("foreign-host"), "state");
  writeLockFile(stateDir, {
    pid: -12345,
    host: `${hostname()}-somewhere-else`,
    command: "watch",
    acquiredAt: new Date().toISOString()
  });

  assert.throws(
    () => acquireStateDirLock({ stateDir, command: "run --mode sync" }),
    (error: Error & { exitCode?: number }) => {
      assert.equal(error.exitCode, 8);
      return true;
    }
  );
});

test("an unreadable lock file is taken over rather than wedging the run forever", () => {
  const stateDir = path.join(sandbox("corrupt"), "state");
  const filePath = lockFilePath(stateDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "{not json", "utf8");

  const lock = acquireStateDirLock({ stateDir, command: "run --mode sync" });
  assert.equal(JSON.parse(readFileSync(filePath, "utf8")).command, "run --mode sync");
  lock.release();
});

test("release is idempotent and never removes a lock this caller no longer owns", () => {
  const stateDir = path.join(sandbox("release"), "state");

  const lock = acquireStateDirLock({ stateDir, command: "run --mode sync" });
  lock.release();
  lock.release();

  // A later holder's lock file must survive an earlier holder's late release.
  writeLockFile(stateDir, {
    pid: process.pid,
    host: hostname(),
    command: "watch",
    acquiredAt: new Date().toISOString()
  });
  lock.release();
  assert.equal(JSON.parse(readFileSync(lockFilePath(stateDir), "utf8")).command, "watch");
});

test("acquiring creates the state directory but nothing else in it", () => {
  const stateDir = path.join(sandbox("no-tmp"), "state");

  const lock = acquireStateDirLock({ stateDir, command: "run --mode sync" });
  assert.deepEqual(require("node:fs").readdirSync(stateDir), ["lock.json"]);
  lock.release();
});
