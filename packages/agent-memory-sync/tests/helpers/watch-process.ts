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
// Matches watch.ts's "watch tick pushing snapshot" line (src/commands/
// watch.ts, pushSnapshot()), printed the instant a tick actually starts
// performPush — i.e. the git fetch/merge/commit/push work — not once that
// work has finished. Literal text, no interpolated per-run data, so this
// pattern can never accidentally match noise.
const WATCH_TICK_PUSH_START_PATTERN = /watch tick pushing snapshot/;
// Every phase-transition signal withTickDeadline's inactivity mode (below)
// polls for. Together with process exit — which resolves runWatchTick's/the
// direct offline/online callers' own `fn()` promise independently of this
// polling, so it needs no pattern of its own here — these are every point in
// a tick where the child demonstrably did something between spawn and exit.
const PROGRESS_SIGNAL_PATTERN = new RegExp(
  `${WATCH_READY_PATTERN.source}|${WATCH_TICK_PUSH_START_PATTERN.source}`,
  "g"
);
const READY_TIMEOUT_MS = 10000;
// History (kept for context; superseded below): the 2026-08-14 CI failure
// (run 31775406978, attempt 1, "watch tick queues locally when the remote is
// unreachable, then replays the queue once the remote is reachable again")
// was a fixed 20000ms whole-tick budget in withTickDeadline, not a genuine
// hang. A whole tick (process spawn, chokidar arming, the edit's fs-event
// latency, and, when reached, git fetch/commit/push) is CPU-bound
// throughout, so it inflates under the same CI contention this file's other
// comments already document for watcher arming (concurrent watch-spawning
// test files sharing a 2-core runner). Reproduced locally (agent-tasks
// 90388c75) by racing the unmodified suite against `yes >/dev/null` CPU
// hogs sharing this machine's cores with the test run, at a load level sized
// to this machine's core count (12 extra `yes` workers on a 12-logical-core
// Mac — roughly the same per-core oversubscription a 2-core CI runner sees
// from this file's own concurrent watch-spawning test files). At this load
// level a fixed WHOLE-TICK budget is not just tight, it is structurally the
// wrong mechanism: the unmodified 20000ms budget failed 1/8 runs (single
// failure at 20900ms, 900ms over) and, when the budget was first raised 3x
// to 60000ms as a trial, a 10-run rerun at the SAME load still failed 1/10
// (60878ms, 878ms over) — the same ~900ms straggler recurring just past
// whatever cutoff was in force, regardless of its size. No fixed
// whole-duration number can categorically rule this class of straggler out;
// PR #102 raised the budget to 90000ms (agent-tasks 90388c75-3cbc-...) as an
// honestly-documented MARGIN, not a guarantee, and left the structural fix —
// a mid-tick progress signal a deadline could poll instead of bounding the
// whole tick — for a follow-up (this task, agent-tasks eb798875-6355-...).
//
// That follow-up: src/commands/watch.ts's pushSnapshot() now writes
// WATCH_TICK_PUSH_START_PATTERN's line the instant it calls performPush,
// splitting a tick into two independently-bounded phases (ready -> push
// start, push start -> exit) instead of one. withTickDeadline's inactivity
// mode (see below) resets its clock on either phase-transition signal, so a
// straggler only has to fit inside ONE gap, not accumulate across the whole
// tick.
//
// That structural split does NOT mean the per-gap number could safely
// shrink much below the old whole-tick 90000ms, and an attempt to size it
// smaller (45000ms) was measured, not assumed, to be wrong: it failed on the
// very first ordinary `npm test` run of this package's FULL suite (no
// synthetic load at all — just this repo's own other subprocess-spawning
// integration tests running concurrently, which node:test already does by
// default), with "watch tick updates the local base snapshot to the
// post-merge remote content" killed after 45006ms of silence between the
// ready line and the push-start line — i.e. the ready -> push-start gap
// alone, driven by chokidar's fs-event latency and the debounce timer both
// being event-loop-scheduled and therefore just as CPU-contention-sensitive
// as the git work in the other gap, not a smaller or safer one. Splitting
// the tick into two gaps does not shrink the worst case either gap can see
// under this repo's own ambient concurrency, only how much of the tick a
// single stall can hide inside.
//
// INACTIVITY_TIMEOUT_MS is kept at the SAME value as the old whole-tick
// TICK_TIMEOUT_MS, 90000ms, after a calibration attempt at implementation
// time that specifically tried to raise it and measured that doing so does
// NOT reliably help, which is itself the load-bearing finding here. Four
// independent 10-run passes of the PR #102-documented load scenario (10
// concurrent `yes >/dev/null` workers racing this file's 3 watch
// integration test files x10) were run back to back on the same machine:
// three at 90000ms (27/30 total, each trial's single failure landing at
// 90016ms/90041ms/~90000ms of TRUE zero-progress inactivity — the tick
// showed no ready-adjacent or push-start signal at all for the full
// budget, not a small overshoot past a much larger number — with the
// failing run's position varying: run 1, run 1 again, run 10, ruling out a
// load-generator warm-up artifact, which was tested directly by adding
// then removing a settle delay before the first measured run and seeing
// only which run was unlucky change, not the ~1-in-10 rate) and one at
// 150000ms, raised specifically to try to clear that ~90000ms zero-progress
// window with margin the same way PR #102 raised its own budget until
// stragglers cleared. That attempt made the pass rate WORSE, not better:
// 8/10, with two failures landing at ~164s/~166s — again almost exactly at
// the new, larger budget, not comfortably inside it. A budget that keeps
// failing near whatever value it is set to, regardless of that value's
// size, is not evidence the value is too small; it is the signature of an
// externally-driven condition that a bigger number cannot buy margin
// against.
//
// A later fix-round review measured this properly with a matched control
// instead of the single-session `uptime`/`git stash` read this comment
// previously cited, and the corrected finding replaces that paragraph here:
// at idle load (1.71), a 10-run pass of the PR #102 load scenario against
// this branch scored 6/10, and the SAME scenario against the unmodified
// merge-base (pre-dating this task's changes entirely) scored 7/10 — i.e.
// roughly a 30-40% failure rate on BOTH, not something this task's change
// introduced or worsened. Every one of the branch's failing runs stalled in
// the ready-to-push-start gap with ONLY the ready line present in stderr:
// the trigger edit's filesystem event was never delivered to chokidar at
// all, not merely delayed past a budget. That is a chokidar/fs-event
// delivery failure under CPU contention, pre-existing at the merge base
// under the OLD fixed whole-tick budget — no inactivity-budget size and no
// additional progress signal can fix it, because the signal this task added
// never gets a chance to fire when the edit itself is never observed. This
// failure class is therefore out of this task's scope; a follow-up task to
// investigate chokidar's fs-event delivery under load will be filed by the
// orchestrator. A SIGSTOP'd child (this file's original reason for
// existing, see the module comment above) still fails reliably at this
// budget and well under this package's CI job's 10-minute timeout: no
// further progress signal is possible once the process itself is frozen, so
// inactivity accumulates exactly as it did under the old whole-tick model.
const INACTIVITY_TIMEOUT_MS = 90000;
// Poll cadence for withTickDeadline's inactivity mode — cheap enough (a
// regex match count over an in-memory string) to run this often without
// measurably perturbing tick timing.
const INACTIVITY_POLL_INTERVAL_MS = 50;
// Multiplier applied to a withTickDeadline call's `timeoutMs` to get the
// absolute whole-tick cap in inactivity mode (see withTickDeadline's own
// comment for why this second, independent timer exists alongside the
// inactivity poll). 2.5x gives a signaling-but-genuinely-slow tick real
// headroom beyond a single inactivity window before the cap treats it as a
// runaway, while still landing well inside this package's CI job's 10-minute
// timeout at the default INACTIVITY_TIMEOUT_MS (2.5 * 90000ms = 225000ms).
const ABSOLUTE_CAP_MULTIPLIER = 2.5;

// Counts PROGRESS_SIGNAL_PATTERN matches in `text`. String#match with a
// global-flagged RegExp does not mutate the RegExp's own `lastIndex` (unlike
// `RegExp#exec`/`RegExp#test` with the `g` flag), so this is safe to call
// repeatedly against the same shared pattern without stateful surprises
// across polls.
function countProgressSignals(text: string): number {
  return (text.match(PROGRESS_SIGNAL_PATTERN) || []).length;
}

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
//
// Two modes, selected by whether `getStderr` is passed:
//
// - No `getStderr` (e.g. watch-teardown-guard.test.ts's deliberately
//   never-resolving `fn`): the original fixed-wall-clock deadline. There is
//   no progress source to poll in that test in the first place — it exists
//   to pin process-group-kill behavior, not tick timing — so this path is
//   unchanged from before this task.
// - `getStderr` passed (runWatchTick, and the offline/online direct calls in
//   watch-mirror-delete.test.ts): inactivity mode. The deadline resets every
//   time PROGRESS_SIGNAL_PATTERN's match count in `getStderr()` increases —
//   i.e. every time watch prints its ready line or its "watch tick pushing
//   snapshot" line (src/commands/watch.ts) — so `timeoutMs` bounds the GAP
//   since the last observed signal, not the tick's total duration. See
//   INACTIVITY_TIMEOUT_MS's comment above for why this needs less margin
//   than the old whole-tick budget did, and for the load-scenario evidence
//   that validated the chosen value.
//
//   Inactivity mode also arms a SECOND, independent timer: an absolute cap
//   on the tick's total wall-clock time, at ABSOLUTE_CAP_MULTIPLIER times
//   `timeoutMs`. Resetting the deadline on every progress signal (the whole
//   point of inactivity mode) means a tick that keeps signaling — whether a
//   genuinely long tick or a runaway that emits a fresh line just inside
//   every window — has no ceiling from the inactivity check alone: gaps can
//   stack indefinitely, each one individually under budget. This package's
//   `test`/`test:coverage` scripts (package.json) pass no `--test-timeout`
//   flag to `node --test`, and that flag's own default when unspecified is
//   Infinity (Node's test-runner docs), so node:test itself places no ceiling
//   on this case either; only this package's CI job timeout (10 minutes)
//   would eventually stop it, taking the whole run down with it instead of
//   failing one test. The absolute timer fires independently of the
//   inactivity poll and fails with a DISTINCT message (see `fail` below) so
//   a red run tells the two failure modes apart:
//   genuinely stuck (no signal for `timeoutMs`) versus alive-but-runaway
//   (signaling forever, never finishing within `timeoutMs *
//   ABSOLUTE_CAP_MULTIPLIER`).
async function withTickDeadline<T>(
  child: ReturnType<typeof spawn>,
  fn: () => Promise<T>,
  timeoutMs = INACTIVITY_TIMEOUT_MS,
  getStderr?: () => string
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let absoluteCapTimer: NodeJS.Timeout | null = null;

  const timeout = new Promise<never>((_, reject) => {
    const fail = (detail: string) => {
      // Reject FIRST: that rejection is what actually fails the test, so it
      // must run even if signaling the process group below throws for some
      // reason signalProcessGroup doesn't already swallow (it treats ESRCH/
      // EPERM as success) — otherwise an uncaught exception here would kill
      // the whole test-file process instead of just failing this one tick,
      // and this rejection would never fire at all.
      reject(new Error(detail));
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
    };

    if (!getStderr) {
      timer = setTimeout(() => {
        fail(`watch tick did not complete within ${timeoutMs}ms — killed the child process`);
      }, timeoutMs);
      return;
    }

    let lastProgressAt = Date.now();
    let lastSignalCount = countProgressSignals(getStderr());
    pollTimer = setInterval(() => {
      const stderr = getStderr();
      const signalCount = countProgressSignals(stderr);
      if (signalCount > lastSignalCount) {
        lastSignalCount = signalCount;
        lastProgressAt = Date.now();
        return;
      }
      const inactiveMs = Date.now() - lastProgressAt;
      if (inactiveMs >= timeoutMs) {
        fail(
          `watch tick showed no progress signal for ${inactiveMs}ms (budget ${timeoutMs}ms) — killed the ` +
            `child process. stderr so far: ${stderr || "(empty)"}`
        );
      }
    }, INACTIVITY_POLL_INTERVAL_MS);

    // Absolute whole-tick cap, independent of the inactivity poll above —
    // see withTickDeadline's own comment for why inactivity mode needs this
    // second timer. Deliberately not reset by progress signals: that is the
    // entire point, a tick that keeps signaling forever must still lose
    // eventually. Distinct failure message from the inactivity-poll `fail`
    // call above so a red run tells the two failure modes apart.
    const absoluteCapMs = timeoutMs * ABSOLUTE_CAP_MULTIPLIER;
    absoluteCapTimer = setTimeout(() => {
      fail(
        `watch tick exceeded the absolute ${absoluteCapMs}ms whole-tick cap despite ongoing progress ` +
          `signals — killed the child process. stderr so far: ${getStderr() || "(empty)"}`
      );
    }, absoluteCapMs);
  });

  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    if (absoluteCapTimer) {
      clearTimeout(absoluteCapTimer);
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
    return await withTickDeadline(
      child,
      async () => {
        await waitForWatcherReady(() => stderr);
        await triggerEdit();

        const exitCode: number = await new Promise((resolve) => {
          child.on("exit", (code: number | null) => resolve(code ?? -1));
        });
        return { exitCode, stderr };
      },
      INACTIVITY_TIMEOUT_MS,
      () => stderr
    );
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
  stopWatchProcessGroup,
  INACTIVITY_TIMEOUT_MS,
  ABSOLUTE_CAP_MULTIPLIER
};
