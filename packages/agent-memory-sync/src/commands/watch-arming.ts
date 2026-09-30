// Arming gate for `watch`'s "watching N path(s)" ready line (agent-tasks
// 50a13ffe).
//
// chokidar 4.0.3 emits its own `ready` event once every path handed to
// `chokidar.watch()` has been stat()ed, which is NOT the same as every path
// having an OS watch behind it. A path that does not exist at start takes the
// ENOENT branch of chokidar's `_addToNodeFs` (node_modules/chokidar/handler.js):
// that branch counts the path as ready immediately and hands the real work
// (watching the nearest existing ancestor directory for the target's name)
// to a later, asynchronous `add(dirname(path), basename(path))` step. `ready`
// therefore fires while that ancestor watch does not exist yet, and for a
// re-added target chokidar skips the initial directory read
// (`_handleDir`'s `if (!target)`), so a write landing inside that window is
// never seen afterwards: the watch tick that write should have started never
// starts. The tests that write straight after the ready line (a new file
// under a `logs/` directory that is absent at start, or an edit of a sibling
// path) hit exactly that window under CPU load, which shows up as the
// "no progress signal" stall in tests/helpers/watch-process.ts.
//
// The gate below closes it. Chokidar publishes its own bookkeeping through
// `getWatched()`: when the deferred step runs, `_handleDir` records the
// ancestor's basename in its parent's entry and opens the ancestor's
// fs.watch in the same synchronous run (verified against 4.0.3 by
// tests/integration/watch-ready-arming.test.ts, which orders the fs.watch
// call against the ready line). So "the nearest existing ancestor of the
// missing path is listed under its own parent in getWatched()" is a
// chokidar-state signal that the deferred watch exists, and it needs no
// write into the operator's memory directories (a self-test file would be
// invisible to the target-filtered ancestor watch and would have to be a
// file in the synced tree). A path chokidar tracks itself (it appeared
// between our stat and chokidar's) counts as armed too.
//
// The wait is bounded: a path that never arms (an unreadable ancestor, a
// chokidar change) must not hang startup, so after ARM_TIMEOUT_MS the caller
// warns naming the pending paths and prints the ready line anyway.
//
// Known limits (measured against chokidar 4.0.3 by writing straight after the
// ready line and counting runs in which the watch tick started; agent-tasks
// 50a13ffe). The signal proves one thing: the anchor's fs.watch exists. It is
// per anchor, not per target, and it does not make the ready line a delivery
// guarantee for every missing path:
//   (a) two missing syncPaths (`logs`, `notes`) under one anchor: the anchor is
//       listed as soon as the FIRST deferred step runs, while the second
//       target's filtered listener is not registered yet. Write into `logs`:
//       32 of 40 runs delivered at the base tree, 19 of 40 with the gate; with
//       the first deferred stat delayed 400 ms, 0 of 6 on both. Write into
//       `notes`: 4 of 10 at the base tree, 8 of 10 with the gate. The gate does
//       not close this shape, and no improvement is shown for it.
//   (b) chokidar throttles the anchor's directory read per directory
//       (handler.js `_throttle('readdir', directory, 1000)`) and re-reads with
//       the first caller's target, so of several targets sharing an anchor only
//       one is delivered reliably. Same shape as (a).
//   (c) a nested missing path (`logs/daily` with `logs` absent): chokidar
//       re-adds it under the nearest existing ancestor for the leaf name, so
//       the missing intermediate directory is never matched; 0 of 6 delivered
//       on both trees.
//   (d) a target created between chokidar's ENOENT stat and the deferred step
//       is skipped, because the re-read of the anchor is skipped when a target
//       is set; 0 of 6 delivered on both trees.
// (a) to (d) exist at the base tree too; closing them needs a per-target gate or
// a chokidar-side change, which is out of scope here (chokidar stays at 4.0.3).
// `armingLimitWarnings` below tells the operator at startup when the
// configured paths have shape (a), (b) or (c), since the ready line then does
// not guarantee delivery for them.

const fs = require("node:fs");
const path = require("node:path");

// Default bound on the wait, in milliseconds. Arming normally completes in a
// few milliseconds (two async stat/realpath calls); 5000 leaves room for a
// heavily loaded machine while keeping a stuck path from stalling startup for
// long. Overridable with AGENT_MEMORY_SYNC_WATCH_ARM_TIMEOUT_MS.
const DEFAULT_ARM_TIMEOUT_MS = 5000;
const ARM_TIMEOUT_ENV_VAR = "AGENT_MEMORY_SYNC_WATCH_ARM_TIMEOUT_MS";
const ARM_POLL_INTERVAL_MS = 5;

interface ArmingTarget {
  // The sync path that does not exist yet.
  target: string;
  // The nearest ancestor of `target` that exists; chokidar ends up watching
  // this directory for the target's name.
  anchor: string;
}

interface WatchedState {
  getWatched(): Record<string, string[]>;
}

interface ArmingResult {
  armed: boolean;
  // Targets still not confirmed armed when the wait ended (empty when armed).
  pending: string[];
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

// The sync paths that do not exist right now, each with its nearest existing
// ancestor. Call it before chokidar.watch() so it reflects what chokidar's own
// first stat() will see.
function collectMissingTargets(
  watchedPaths: string[],
  exists: (candidate: string) => boolean = fs.existsSync
): ArmingTarget[] {
  const targets: ArmingTarget[] = [];
  for (const target of watchedPaths) {
    if (exists(target)) {
      continue;
    }
    let anchor = path.dirname(target);
    while (!exists(anchor) && path.dirname(anchor) !== anchor) {
      anchor = path.dirname(anchor);
    }
    targets.push({ target, anchor });
  }
  return targets;
}

// One-line startup warnings for the shapes in the known-limits comment above
// that the operator's own configuration can be checked for: two or more missing
// syncPaths sharing one anchor (a, b), and a missing path whose parent is also
// missing (c). Empty when neither applies, in particular for a single missing
// path directly under an existing directory, the shape the gate does cover.
function armingLimitWarnings(targets: ArmingTarget[]): string[] {
  const warnings: string[] = [];
  const byAnchor = new Map<string, string[]>();
  for (const { target, anchor } of targets) {
    byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), target]);
  }
  for (const [anchor, sharing] of byAnchor) {
    if (sharing.length >= 2) {
      warnings.push(
        `${sharing.length} missing syncPaths share the existing directory ${anchor} (${sharing.join(", ")}); ` +
          "the ready line does not guarantee that a change to them right after it is seen, only one of them may be delivered until watch is restarted"
      );
    }
  }
  const nested = targets.filter(({ target, anchor }) => path.dirname(target) !== anchor).map(({ target }) => target);
  if (nested.length > 0) {
    warnings.push(
      `the parent directory of ${nested.join(", ")} is missing as well; ` +
        "the ready line does not guarantee that a change there is seen until watch is restarted after the directories exist"
    );
  }
  return warnings;
}

function listedUnder(watched: Record<string, string[]>, child: string): boolean {
  const entry = watched[path.dirname(child)];
  return Array.isArray(entry) && entry.includes(path.basename(child));
}

function isTargetArmed(watched: Record<string, string[]>, { target, anchor }: ArmingTarget): boolean {
  if (listedUnder(watched, target)) {
    return true;
  }
  if (path.dirname(anchor) === anchor) {
    // Filesystem root: it has no parent entry to be listed under.
    return Object.prototype.hasOwnProperty.call(watched, anchor);
  }
  return listedUnder(watched, anchor);
}

function pendingTargets(watcher: WatchedState, targets: ArmingTarget[]): ArmingTarget[] {
  const watched = watcher.getWatched();
  return targets.filter((entry) => !isTargetArmed(watched, entry));
}

// Resolves once every target reads as armed in `watcher.getWatched()`, or with
// the still-pending targets when `timeoutMs` elapses first or `signal` aborts
// (watch shutting down). Never rejects.
function waitForDeferredArming(
  watcher: WatchedState,
  targets: ArmingTarget[],
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}
): Promise<ArmingResult> {
  const timeoutMs = options.timeoutMs ?? resolveArmTimeoutMs();
  const pollMs = options.pollMs ?? ARM_POLL_INTERVAL_MS;
  const start = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      let pending: ArmingTarget[];
      try {
        pending = pendingTargets(watcher, targets);
      } catch {
        // A watcher that cannot report its state is treated as not armed;
        // the bound below still ends the wait.
        pending = targets;
      }
      if (pending.length === 0) {
        resolve({ armed: true, pending: [] });
        return;
      }
      if (options.signal?.aborted || Date.now() - start >= timeoutMs) {
        resolve({ armed: false, pending: pending.map((entry) => entry.target) });
        return;
      }
      setTimeout(check, pollMs);
    };
    check();
  });
}

module.exports = {
  armingLimitWarnings,
  ARM_POLL_INTERVAL_MS,
  ARM_TIMEOUT_ENV_VAR,
  DEFAULT_ARM_TIMEOUT_MS,
  collectMissingTargets,
  isTargetArmed,
  parseArmTimeoutMs,
  resolveArmTimeoutMs,
  waitForDeferredArming
};
