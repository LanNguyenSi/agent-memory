// Shared helpers for integration tests that spawn `agent-memory-sync watch`
// as a child process (tests/integration/watch-restore.test.ts and
// tests/integration/watch-mirror-delete.test.ts).
//
// Background — the race this file exists to close: `watch` prints its
// "watching N path(s) under ..." line from chokidar's own 'ready' event
// (see src/commands/watch.ts) once its initial recursive scan of the
// watched paths completes, rather than unconditionally right after
// chokidar.watch() returns. On an inotify-backed watcher (Linux, including
// CI) that scan is not instantaneous, and a filesystem write issued before
// it completes can be silently lost — chokidar has not finished wiring up
// the inotify watch descriptors for the (possibly nested) watched paths
// yet, so the edit never produces an 'add'/'change' event, `watch` never
// ticks, `--max-runs 1` never terminates, and a test's `await` on the
// child's exit hangs forever. This does not reproduce reliably on
// fsevents (macOS, local development), and got measurably worse under
// higher aggregate CI load (a 2-core runner, multiple test files spawning
// watch children concurrently) — a fixed sleep()-then-edit, however
// generous, is not a structural fix, only a smaller window. waitForReady()
// below waits for the real signal instead; withTickDeadline() is a second,
// independent safety net so that any other stuck-child failure mode (not
// just this one) fails a single test in seconds instead of hanging the
// whole CI job for minutes and orphaning child processes.
const { spawn } = require("node:child_process");
const path = require("node:path");

// Matches watch.ts's "watching N path(s) under ..." ready line. --verbose is
// required for it to print at all: writeInfo (src/output.ts) is a no-op
// unless verbose is set, which is why every watch invocation through this
// helper passes --verbose.
const WATCH_READY_PATTERN = /watching \d+ path\(s\) under/;
const READY_TIMEOUT_MS = 10000;
const TICK_TIMEOUT_MS = 20000;

// How long to wait for a graceful SIGINT/SIGTERM to a watch process group to
// take effect before escalating to SIGKILL — see stopWatchProcessGroup below.
const GROUP_KILL_GRACE_MS = 2000;
const GROUP_KILL_POLL_INTERVAL_MS = 25;

// spawnWatch's `child` is the `tsx` launcher process, NOT the real node
// process that ends up running src/main.ts: tsx's own CLI (node_modules/tsx/
// dist/cli.mjs) always spawns a second, genuine node child (with
// `--import`/`--loader` pointed at its loader) to actually execute the file,
// passing it `stdio: ["inherit","inherit","inherit"]` so that grandchild
// writes directly into the SAME stdout/stderr pipe fds this helper's own
// spawn() call below opened. `detached: true` puts the tsx launcher (and,
// because child processes stay in their parent's process group unless they
// explicitly opt out, its node grandchild too) into a process group whose id
// equals the launcher's own pid — letting cleanup target the whole group
// with a single process.kill(-pid, signal) call instead of only the
// launcher. Killing only the launcher with SIGKILL (e.g. a bare
// child.kill("SIGKILL")) leaves the grandchild running: SIGKILL specifically
// cannot be caught or relayed, so the launcher dies before it can forward
// anything, and the grandchild is reparented to pid 1 and keeps the
// inherited pipe's write end open, so nothing reading that pipe (this
// helper's own child.stdout/stderr, and transitively whatever spawned this
// whole test file) ever sees the stream close — measured directly: a stuck
// grandchild here is what stalls test-file teardown and the wider suite run
// long after every test in the file has already gone green. SIGINT/SIGTERM
// to just the launcher happen to be relayed to the grandchild by tsx today
// (and src/commands/watch.ts installs its own handlers for both), measured
// to leave 0 survivors — but that relaying is tsx's implementation detail,
// not a guarantee this helper should rely on, hence targeting the whole
// group unconditionally below instead of trusting any one signal to
// propagate on its own.
function spawnWatch(args: string[], env: NodeJS.ProcessEnv) {
  registerLastResortGroupKillHandlers();
  const child = spawn(
    path.resolve(process.cwd(), "node_modules", ".bin", "tsx"),
    ["src/main.ts", ...args],
    { env, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  if (typeof child.pid === "number") {
    liveGroupPids.add(child.pid);
  }
  return child;
}

// Every process group spawnWatch() has started and not yet torn down via
// stopWatchProcessGroup, keyed by the group's leader pid (== the tsx
// launcher's own pid, see spawnWatch's `detached: true` comment). Populated
// in spawnWatch, pruned in stopWatchProcessGroup's `finally` below — see
// registerLastResortGroupKillHandlers for what still reads it once a test
// itself can no longer reach the group.
const liveGroupPids = new Set<number>();

// `detached: true` (spawnWatch's comment) traded away a free cleanup
// pre-change code had for nothing: back when the launcher and grandchild
// stayed in the RUNNER's own process group, a Ctrl-C on `npm test` (a group
// SIGINT to the runner's pgid) reached and killed them too, for free, with
// zero survivors. Once they moved into their own group, that stops working
// — any path that ends the test-file process without ever reaching a test's
// own `finally`/stopWatchProcessGroup call (Ctrl-C, a node:test file-level
// abort, an exception thrown between a bare spawnWatch() call and the
// `.finally()` that would tear it down — see watch-mirror-delete.test.ts's
// two `spawnWatch` call sites, or a hard process.exit()) now leaks a group
// nothing can reach any more. This function registers the deliberate
// last-resort replacement — a synchronous, best-effort SIGKILL of every
// still-tracked group — on "exit" and on SIGINT/SIGTERM (re-raised
// afterwards so the process still actually terminates on the signal), and
// is idempotent so calling it from every spawnWatch() invocation never
// accumulates duplicate listeners. Zero effect on the green path: by the
// time a passing test file's process actually exits, every group it spawned
// has already been removed from liveGroupPids by stopWatchProcessGroup, so
// these handlers iterate an empty set and do nothing.
let lastResortHandlersRegistered = false;
function registerLastResortGroupKillHandlers(): void {
  if (lastResortHandlersRegistered) {
    return;
  }
  lastResortHandlersRegistered = true;

  const killAllLiveGroups = () => {
    for (const pid of liveGroupPids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // ESRCH (already gone) or EPERM (not ours any more, e.g. the pid was
        // reused) — either way, nothing more this last resort can do for it.
      }
    }
  };

  process.once("exit", killAllLiveGroups);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    // `once` self-unregisters before invoking the listener (Node's
    // EventEmitter semantics), so re-sending the signal to ourselves from
    // inside the handler falls through to Node's default disposition
    // (terminate) instead of looping back into this same handler.
    process.once(signal, () => {
      killAllLiveGroups();
      process.kill(process.pid, signal);
    });
  }
}

// True if any process in child's process group (see spawnWatch's
// `detached: true` comment) is still alive. Uses signal 0, which only checks
// for existence/permission — it never actually signals anything. EPERM
// (refused for permission reasons — e.g. this pid was reused by an
// unrelated process this test runner has no standing to signal) is treated
// the same as ESRCH: either way, this is no longer a process group cleanup
// can find or safely act on.
function isProcessGroupAlive(child: ReturnType<typeof spawn>): boolean {
  if (typeof child.pid !== "number") {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH" || code === "EPERM") {
      return false;
    }
    throw err;
  }
}

// Best-effort signal delivery to every process in child's group (the tsx
// launcher AND the real node process it spawns internally — see spawnWatch),
// not just `child` itself. A process-group-scoped kill(2) via the negated
// pid, not a name/pattern-based pkill: it can only ever reach descendants of
// this specific spawnWatch() call. ESRCH (nothing left to signal) and EPERM
// (no longer ours to signal, e.g. pid reuse) are both treated as success,
// not an error — retrying or rethrowing here cannot fix either, and letting
// either surface would risk an uncaught exception out of a timer/finally
// callback (see withTickDeadline and runWatchTick) instead of just leaving
// cleanup a no-op for a group that is not reachable any more.
function signalProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (typeof child.pid !== "number") {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw err;
    }
  }
}

// Deterministic teardown for a spawnWatch()'d child: sends `signal`
// (graceful by default) to its whole process group, waits up to
// GROUP_KILL_GRACE_MS for the group to actually exit, then SIGKILLs
// whatever remains. Centralizing this here — rather than each test/helper
// separately checking `child.exitCode`/`signalCode` on the launcher alone —
// means cleanup always attempts the group kill, not only when the immediate
// child looks unfinished: `child` having already reported exit says nothing
// about whether its node grandchild is still alive (see spawnWatch's
// comment). The leak that originally motivated group-wide kills was
// measured via withTickDeadline's SIGKILL-on-timeout path (see its
// comment), not through this function's own graceful-signal path — the
// common case here (both processes already gone on their own) returns
// immediately, since isProcessGroupAlive's first check is false, so this
// adds no measurable latency to a normal passing tick. Always prunes
// `child`'s pid from liveGroupPids on the way out, whether or not the group
// actually died — see registerLastResortGroupKillHandlers for who else
// reads that set.
async function stopWatchProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals = "SIGINT"
): Promise<void> {
  try {
    if (!isProcessGroupAlive(child)) {
      return;
    }
    signalProcessGroup(child, signal);

    const deadline = Date.now() + GROUP_KILL_GRACE_MS;
    while (Date.now() < deadline && isProcessGroupAlive(child)) {
      await new Promise((resolve) => setTimeout(resolve, GROUP_KILL_POLL_INTERVAL_MS));
    }

    if (isProcessGroupAlive(child)) {
      signalProcessGroup(child, "SIGKILL");
    }
  } finally {
    if (typeof child.pid === "number") {
      liveGroupPids.delete(child.pid);
    }
  }
}

// Polls `getStderr()` until it matches WATCH_READY_PATTERN, i.e. until the
// watcher has actually finished arming — see the module comment above for
// why this replaces a fixed sleep() before a test's trigger edit.
function waitForWatcherReady(getStderr: () => string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (WATCH_READY_PATTERN.test(getStderr())) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for watch to report ready. stderr so far: ${getStderr() || "(empty)"}`
          )
        );
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

// Bounds `fn` (expected to await a spawned watch child reaching some end
// state — typically process exit) to `timeoutMs`: if it has not settled in
// time, force-kills `child`'s whole process group (SIGKILL — a deliberate
// last-resort tier, distinct from the graceful SIGINT stopWatchProcessGroup
// uses once a tick has already completed on its own) and rejects with a
// clear message instead of hanging indefinitely.
async function withTickDeadline<T>(
  child: ReturnType<typeof spawn>,
  fn: () => Promise<T>,
  timeoutMs = TICK_TIMEOUT_MS
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject FIRST: that rejection is what actually fails the test, so it
      // must run even if signaling the process group below throws for some
      // reason signalProcessGroup doesn't already swallow (it treats ESRCH/
      // EPERM as success) — otherwise an uncaught exception here would kill
      // the whole test-file process instead of just failing this one tick,
      // and this rejection would never fire at all.
      reject(new Error(`watch tick did not complete within ${timeoutMs}ms — killed the child process`));
      try {
        // Already past the deadline, so there is no grace period left to
        // spend on a graceful signal: SIGKILL the whole process group
        // immediately (see spawnWatch's `detached: true` comment) instead of
        // just `child` — SIGKILL specifically cannot be caught or relayed,
        // so a bare child.kill("SIGKILL") here would only ever reach the tsx
        // launcher, orphaning its real node grandchild (reparented to pid 1)
        // to keep running and hold the inherited stdout/stderr pipe open.
        signalProcessGroup(child, "SIGKILL");
      } catch {
        // Best-effort: the rejection above has already failed the test —
        // don't let a further error here replace it with an uncaught
        // exception instead.
      }
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// Spawns `watch --max-runs 1 --verbose`, waits for its ready line, applies
// the local filesystem edit(s) via `triggerEdit` (sync or async — e.g. a
// loop of several writes with sleeps in between to exercise debouncing),
// then waits for the single tick to complete and the process to exit — the
// whole sequence bounded by withTickDeadline. Covers every watch-spawning
// test that just needs one config, one edit (or edit sequence), and one
// exit code; tests that need finer control over multiple children (e.g.
// reconfiguring the remote mid-test) use spawnWatch/waitForWatcherReady/
// withTickDeadline directly instead.
async function runWatchTick(
  configPath: string,
  triggerEdit: () => void | Promise<void>,
  options: { debounceMs?: number; extraArgs?: string[] } = {}
): Promise<{ exitCode: number; stderr: string }> {
  const { debounceMs = 300, extraArgs = [] } = options;
  const child = spawnWatch(
    [
      "watch",
      "default",
      "--config",
      configPath,
      "--debounce-ms",
      String(debounceMs),
      "--max-runs",
      "1",
      "--verbose",
      "--output",
      "json",
      ...extraArgs
    ],
    process.env
  );

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    return await withTickDeadline(child, async () => {
      await waitForWatcherReady(() => stderr);
      await triggerEdit();

      const exitCode: number = await new Promise((resolve) => {
        child.on("exit", (code: number | null) => resolve(code ?? -1));
      });
      return { exitCode, stderr };
    });
  } finally {
    // Always attempt teardown, not just when the launcher itself looks
    // unfinished — see stopWatchProcessGroup's comment for why `child`
    // having already exited says nothing about its node grandchild.
    await stopWatchProcessGroup(child);
  }
}

module.exports = {
  spawnWatch,
  waitForWatcherReady,
  withTickDeadline,
  runWatchTick,
  stopWatchProcessGroup
};
