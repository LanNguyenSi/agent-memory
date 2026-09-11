// Advisory lock over a stateDir, so two agent-memory-sync processes never
// work on one state directory at the same time.
//
// Origin: the 2026-09-11 memory-corpus wipe (agent-tasks cda5b12c, pandora
// run .ai/runs/2026-09-11-memory-sync-wipe). The periodic `run --mode sync`
// job and the `watch` job share a stateDir, and nothing serialised them: one
// job's working copy under stateDir/tmp was removed by the other job while
// git had already reported a successful checkout, and the pull that read
// that empty copy deleted the local corpus. The guards in ./guards.ts refuse
// the damaged state after the fact; this lock stops the two jobs from
// producing it in the first place.
//
// Advisory, not mandatory: it is a file both jobs agree to check, not
// anything the filesystem enforces. That is enough here, because both
// participants are this same binary. Its exclusivity comes from the
// filesystem's own atomic "create this file only if it does not exist"
// (O_EXCL), so two processes racing the same stateDir cannot both win.
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { hostname } = require("node:os");
const path = require("node:path");
const { StateDirLockedError } = require("../errors");

// How long a lock file may sit before a later run takes it over. Overridable
// per profile with the `lockStaleMs` config key (src/config/loader.ts).
//
// The lock is released on a normal exit, on a thrown error and on
// SIGINT/SIGTERM, so a surviving lock file means the holder died in a way
// none of those cover (SIGKILL, a power cut, an OOM kill). Sized against the
// jobs that take it: the committed periodic tick interval is 15 minutes
// (docs/launchd/com.agent-memory-sync.sync.plist.template's StartInterval and
// the systemd OnUnitActiveSec equivalent), so a single tick that is merely
// slow, or one retrying a wedged network operation, stays well inside this
// window, while an abandoned lock costs at most one skipped tick cycle
// before the next run takes it over on its own. A holder this process can
// prove is gone (same host, pid no longer in the process table) is taken
// over immediately, without waiting this out.
const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;

interface LockRecord {
  pid: number;
  host: string;
  command: string;
  acquiredAt: string;
}

function lockFilePath(stateDir: string): string {
  return path.join(stateDir, "lock.json");
}

// Locks held by THIS process, released by the exit/signal handlers below.
const heldLocks = new Set<{ release: () => void }>();
let processHandlersInstalled = false;

class StateDirLock {
  stateDir: string;
  filePath: string;
  record: LockRecord;
  released: boolean;

  constructor(stateDir: string, record: LockRecord) {
    this.stateDir = stateDir;
    this.filePath = lockFilePath(stateDir);
    this.record = record;
    this.released = false;
  }

  // Removes the lock file, but only while it still carries this holder's own
  // record. A lock this process already lost (taken over as stale by a later
  // run, or removed by an operator) must not be removed from under whoever
  // holds it now, and a second release() is a no-op rather than an error:
  // both the caller's own finally and the process-exit handler below call
  // this, in that order.
  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    heldLocks.delete(this);

    const current = readLockRecord(this.filePath);
    if (!current || current.pid !== this.record.pid || current.acquiredAt !== this.record.acquiredAt) {
      return;
    }

    rmSync(this.filePath, { force: true });
  }
}

function readLockRecord(filePath: string): LockRecord | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<LockRecord>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.host !== "string" ||
      typeof parsed.acquiredAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.acquiredAt))
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      host: parsed.host,
      command: typeof parsed.command === "string" ? parsed.command : "unknown",
      acquiredAt: parsed.acquiredAt
    };
  } catch {
    // An unreadable or truncated lock file (a crash mid-write) carries no
    // holder this run could wait for. Treated as stale rather than as a
    // permanent block: the alternative is a state directory nothing can ever
    // use again without manual intervention.
    return null;
  }
}

// Whether the recorded holder still exists, asked only when the record
// claims this same host: a pid is meaningless across machines, and a shared
// (network) state directory would otherwise have one machine declare
// another's live lock dead. Signal 0 performs the permission and existence
// checks without delivering anything; EPERM means the process exists but is
// not ours to signal, which is still alive.
//
// Pid reuse can make a dead holder look alive; that only costs a wait for
// the staleness age, never a wrongly taken lock.
function isHolderAlive(record: LockRecord): boolean {
  if (record.host !== hostname()) {
    return true;
  }

  if (!Number.isInteger(record.pid) || record.pid <= 0) {
    return false;
  }

  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

function installProcessHandlers(): void {
  if (processHandlersInstalled) {
    return;
  }
  processHandlersInstalled = true;

  process.on("exit", () => {
    for (const lock of Array.from(heldLocks)) {
      lock.release();
    }
  });

  // A signal only reaches the 'exit' handler above if something stops the
  // default disposition from killing the process outright, so the lock has
  // to install its own handler for the commands that have none. A command
  // that already handles the signal itself (watch's flush-then-exit) keeps
  // owning the shutdown: this handler then releases nothing and exits
  // nothing, and the lock is released by the tick's own finally and by the
  // exit handler above.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const hadOtherListeners = process.listenerCount(signal) > 0;
    if (hadOtherListeners) {
      continue;
    }

    const handler = () => {
      for (const lock of Array.from(heldLocks)) {
        lock.release();
      }
      // Re-raise with the default disposition restored, so the process still
      // dies the way it would have without this handler (exit status
      // 128+signal, not a plain 0).
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }
}

function formatDurationMs(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const totalMinutes = totalSeconds / 60;
  if (totalMinutes < 60) {
    return `${totalMinutes.toFixed(1)}m`;
  }
  return `${(totalMinutes / 60).toFixed(1)}h`;
}

// Takes the lock or throws StateDirLockedError (exit code 8).
//
// Call this BEFORE anything reads or writes rootDir, the base snapshots, the
// queue or stateDir/tmp: a run that cannot have the lock must leave every
// one of them exactly as it found them. The state directory itself is
// created here, since the lock file has to live somewhere.
function acquireStateDirLock(input: {
  stateDir: string;
  command: string;
  staleMs?: number | null;
}): InstanceType<typeof StateDirLock> {
  const staleMs = typeof input.staleMs === "number" && input.staleMs > 0 ? input.staleMs : DEFAULT_LOCK_STALE_MS;
  const filePath = lockFilePath(input.stateDir);
  mkdirSync(input.stateDir, { recursive: true });

  const record: LockRecord = {
    pid: process.pid,
    host: hostname(),
    command: input.command,
    acquiredAt: new Date().toISOString()
  };
  const payload = `${JSON.stringify(record, null, 2)}\n`;

  // Two attempts, not a loop: the first can lose to an existing lock file,
  // and the second only runs once this process has decided that file was
  // abandoned and removed it. Losing the second attempt too means another
  // process won the same race in between, which is a real holder, not a
  // stale file.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // "wx": create exclusively, fail if the path exists. The atomicity
      // this lock rests on.
      writeFileSync(filePath, payload, { encoding: "utf8", flag: "wx" });
      const lock = new StateDirLock(input.stateDir, record);
      heldLocks.add(lock);
      installProcessHandlers();
      return lock;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") {
        throw error;
      }
    }

    const current = readLockRecord(filePath);
    const ageMs = current ? Date.now() - Date.parse(current.acquiredAt) : Number.POSITIVE_INFINITY;
    const stale = !current || ageMs > staleMs || !isHolderAlive(current);

    if (!stale || attempt > 0) {
      throw new StateDirLockedError(describeHeldLock(input.stateDir, filePath, current, ageMs, staleMs));
    }

    rmSync(filePath, { force: true });
  }

  // Unreachable: the loop above either returns a lock or throws.
  throw new StateDirLockedError(describeHeldLock(input.stateDir, filePath, null, 0, staleMs));
}

function describeHeldLock(
  stateDir: string,
  filePath: string,
  record: LockRecord | null,
  ageMs: number,
  staleMs: number
): string {
  const holder = record
    ? `pid ${record.pid} on ${record.host}, running '${record.command}', since ${record.acquiredAt} ` +
      `(${formatDurationMs(ageMs)} ago)`
    : "an unreadable lock record";

  return (
    `another agent-memory-sync process holds the lock on '${stateDir}': ${holder}. Nothing was read or ` +
    `written: the local workspace, the base snapshots and the working copies under stateDir/tmp are ` +
    `untouched. Wait for that run to finish and re-run; a lock older than ${formatDurationMs(staleMs)} ` +
    `(config key 'lockStaleMs'), or one whose process is gone on this host, is taken over automatically. ` +
    `If neither applies and the holder is really gone, remove '${filePath}'.`
  );
}

module.exports = {
  DEFAULT_LOCK_STALE_MS,
  acquireStateDirLock,
  lockFilePath
};
