// Per-target arming for the syncPaths `watch` finds missing at start
// (agent-tasks 50a13ffe, d09a0d3a).
//
// Why chokidar is not handed a missing path. chokidar 4.0.3 takes the ENOENT
// branch of `_addToNodeFs` (node_modules/chokidar/handler.js) for a path that
// does not exist: it counts the path as ready at once and defers the real work
// to a later `add(dirname(path), basename(path))` that watches the nearest
// existing ancestor for the target's name. Measured in that code, on base and
// head of the earlier ready-line gate alike, that deferral loses three shapes:
//   (a) two or more missing syncPaths under one existing directory
//       (`logs`, `notes`): their deferred steps share the ancestor's single
//       fs.watch. `setFsWatchListener` adds each later target's listener to the
//       existing instance and `fsWatchBroadcast` calls the listeners in
//       registration order; the first listener's `_handleRead` takes the
//       ancestor's `_throttle('readdir', directory, 1000)`, the later ones are
//       throttled, and the closing re-read reuses the first caller's target,
//       the only name `item === target` then matches. Only the first target
//       is delivered.
//   (b) a nested missing path (`logs/daily` with `logs` absent): the deferred
//       step re-adds the ancestor with the leaf name (`_origAdd`), so the
//       missing intermediate directory is never matched.
//   (c) a target created between chokidar's ENOENT stat and the deferred step:
//       `_handleDir` skips the initial read when a target is set, so what is
//       already inside is never reported.
// chokidar can also emit `ready` before the deferred ancestor watch exists, and
// twice when a syncPath is missing, which made the "watching N path(s)" line an
// unreliable signal.
//
// What `watch` does instead. Only syncPaths that exist at start go to the main
// chokidar watcher, so its `ready` means exactly what the ready line claims.
// Every missing syncPath gets its own tracker (`trackMissingPaths`): an
// independent poll of that one path, so no target depends on another's
// listener, and a nested path needs nothing special because the poll asks
// whether the target itself exists, not whether its parent does. The tracker is
// armed synchronously when it starts, before the ready line is printed. When a
// path appears, `watch` gives it its own chokidar watcher, waits for that
// watcher's `ready` (the OS watch on the path and everything inside it is open
// by then) and then re-reads the path with `listFilesUnder`, reporting every
// file found as a change. The re-read is what delivers a path that was created
// together with its files before any watch could be opened (c), and it also
// covers a write that lands in the first moments after an fs.watch is opened,
// which Node on macOS can miss (nodejs/node#52601). A file that shows up both
// in the re-read and as a chokidar event is one pending change, because the
// pending set is keyed by path.
//
// Polling, not fs.watch on an ancestor, is deliberate: it needs no state of
// chokidar's, behaves the same on every platform, and costs one stat per
// missing path per interval. The latency it adds (at most one interval, 250 ms
// by default) is far below the debounce window of the tick it feeds.
//
// The ready line also waits for the OS watch to be live (`confirmWatchLive`).
// chokidar's own `ready` follows the stat of each existing path, and the
// fs.watch of an existing file is opened just before it; on macOS a freshly
// opened fs.watch (libuv's FSEvents stream) can miss a write for a while after
// it returned (nodejs/node#52601), and under CPU load that while is long
// enough for a write right after the ready line to be lost, which is the
// "no progress signal" stall of tests/helpers/watch-process.ts. Before this
// change the gate on a missing path happened to add a few milliseconds there,
// and `watch` with a missing path lost such a write far less often than one
// without. The probe watches a scratch directory in the OS temp directory
// (nothing is written into the operator's directories) from after chokidar's
// `ready` and writes into it until the event arrives: libuv serves every
// fs.watch of a process from one stream that it recreates when a path is added,
// so an event for the later scratch watch shows that the stream that includes
// the sync paths is live. It is bounded, like the poll above.
//
// Not covered: a syncPath that is removed and created again after it appeared
// is not re-armed, the same as a syncPath that existed at start.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// How often a missing syncPath is checked for existence, in milliseconds.
const DEFAULT_MISSING_POLL_MS = 250;
// Default bound on the wait for the OS watch to be live, in milliseconds. The
// event normally arrives within a few milliseconds; 5000 leaves room for a
// heavily loaded machine while keeping a watch that never reports from stalling
// startup. Overridable with AGENT_MEMORY_SYNC_WATCH_ARM_TIMEOUT_MS.
const DEFAULT_ARM_TIMEOUT_MS = 5000;
const ARM_TIMEOUT_ENV_VAR = "AGENT_MEMORY_SYNC_WATCH_ARM_TIMEOUT_MS";
const ARM_WRITE_INTERVAL_MS = 20;
const ARM_PROBE_DIR_PREFIX = "agent-memory-sync-arm-";

interface PartitionedSyncPaths {
  // Paths that exist right now, in the order given.
  existing: string[];
  // Paths that do not, deduplicated by resolved path, in the order given.
  missing: string[];
}

interface TrackOptions {
  pollMs?: number;
  // Resolves when `target` exists (any file type), rejects when it does not.
  // Injectable for tests; defaults to fs.promises.stat.
  stat?: (target: string) => Promise<unknown>;
  // Called when a poll or the appearance handler throws.
  onError?: (target: string, error: unknown) => void;
}

interface MissingPathTracker {
  // Stops every poll. Safe to call more than once.
  close(): void;
  // The targets that have not appeared yet.
  pending(): string[];
}

// Splits the configured sync paths by whether they exist right now. Call it
// before chokidar.watch(): a path created after this point is either picked up
// by chokidar's own first stat (when it is in `existing`) or by the first poll
// of its tracker (when it is in `missing`), so no moment of creation falls
// between the two. A path configured twice is one target.
function partitionSyncPaths(
  watchedPaths: string[],
  exists: (candidate: string) => boolean = fs.existsSync
): PartitionedSyncPaths {
  const existing: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const candidate of watchedPaths) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    if (exists(candidate)) {
      existing.push(candidate);
    } else {
      missing.push(candidate);
    }
  }
  return { existing, missing };
}

function resolveStat(options: TrackOptions): (target: string) => Promise<unknown> {
  return options.stat ?? ((target: string) => fs.promises.stat(target));
}

// One independent poll per target. `onAppeared(target)` runs once, when the
// target first exists; its promise is awaited only to report a rejection
// through `onError`. The first check starts before this function returns, the
// next one `pollMs` after the previous check finished, so checks of one target
// never overlap.
function trackMissingPaths(
  targets: string[],
  onAppeared: (target: string) => void | Promise<void>,
  options: TrackOptions = {}
): MissingPathTracker {
  const pollMs = options.pollMs ?? DEFAULT_MISSING_POLL_MS;
  const stat = resolveStat(options);
  const waiting = new Set<string>(targets);
  const timers = new Set<NodeJS.Timeout>();
  let closed = false;

  const check = async (target: string): Promise<void> => {
    let present = false;
    try {
      await stat(target);
      present = true;
    } catch {
      // Not there yet (ENOENT, or a parent that is a file): keep waiting.
    }
    if (closed) {
      return;
    }
    if (!present) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        void check(target);
      }, pollMs);
      timers.add(timer);
      return;
    }
    waiting.delete(target);
    try {
      await onAppeared(target);
    } catch (error) {
      options.onError?.(target, error);
    }
  };

  for (const target of targets) {
    void check(target);
  }

  return {
    close() {
      closed = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    },
    pending() {
      return [...waiting];
    }
  };
}

// Every regular file under `target` (the target itself when it is a file), as
// absolute paths. Symlinks to files count, symlinked directories are not
// followed, and an entry that vanishes while it is read is skipped.
async function listFilesUnder(target: string): Promise<string[]> {
  let stats;
  try {
    stats = await fs.promises.stat(target);
  } catch {
    return [];
  }
  if (!stats.isDirectory()) {
    return stats.isFile() ? [target] : [];
  }
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      } else if (entry.isSymbolicLink()) {
        try {
          if ((await fs.promises.stat(full)).isFile()) {
            files.push(full);
          }
        } catch {
          // Dangling link: nothing to report.
        }
      }
    }
  };
  await walk(target);
  return files;
}

function parseArmTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return DEFAULT_ARM_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_ARM_TIMEOUT_MS;
  }
  return parsed;
}

function resolveArmTimeoutMs(): number {
  return parseArmTimeoutMs(process.env[ARM_TIMEOUT_ENV_VAR]);
}

interface ConfirmOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  // Directory the scratch directory is created in; the OS temp directory by
  // default.
  scratchRoot?: string;
}

// Resolves true once an fs.watch opened now has delivered an event for a write
// made after it was opened, false when `timeoutMs` elapses first, `signal`
// aborts, or the scratch directory cannot be used. Writes into a scratch
// directory of its own, never into a sync path, and removes it before it
// resolves. Never rejects.
function confirmWatchLive(options: ConfirmOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? resolveArmTimeoutMs();
  const start = Date.now();
  let scratch: string;
  let watcher: { close(): void; on(event: string, listener: () => void): unknown };
  let live = false;
  try {
    scratch = fs.mkdtempSync(path.join(options.scratchRoot ?? os.tmpdir(), ARM_PROBE_DIR_PREFIX));
    watcher = fs.watch(scratch, () => {
      live = true;
    });
    watcher.on("error", () => undefined);
  } catch {
    return Promise.resolve(false);
  }
  const cleanup = () => {
    try {
      watcher.close();
    } catch {
      // Already closed.
    }
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      // Best effort: it is an empty directory in the temp directory.
    }
  };
  return new Promise((resolve) => {
    let writes = 0;
    const step = () => {
      if (live) {
        cleanup();
        resolve(true);
        return;
      }
      if (options.signal?.aborted || Date.now() - start >= timeoutMs) {
        cleanup();
        resolve(false);
        return;
      }
      try {
        fs.writeFileSync(path.join(scratch, "probe"), String(writes++));
      } catch {
        cleanup();
        resolve(false);
        return;
      }
      setTimeout(step, ARM_WRITE_INTERVAL_MS);
    };
    step();
  });
}

module.exports = {
  ARM_PROBE_DIR_PREFIX,
  ARM_TIMEOUT_ENV_VAR,
  DEFAULT_ARM_TIMEOUT_MS,
  DEFAULT_MISSING_POLL_MS,
  confirmWatchLive,
  parseArmTimeoutMs,
  resolveArmTimeoutMs,
  listFilesUnder,
  partitionSyncPaths,
  trackMissingPaths
};
