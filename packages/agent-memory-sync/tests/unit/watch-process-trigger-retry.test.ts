// Unit-level pin for applyTriggerWithRetry (tests/helpers/watch-process.ts),
// the test-side mitigation for the macOS fs.watch arming race documented in
// that file's "ROOT CAUSE" comment (agent-tasks f876dff6): a trigger edit's
// filesystem event can be silently and permanently lost if issued too soon
// after the watch is reported armed, with no larger deadline able to recover
// it, so the only working mitigation is a FRESH re-applied edit once a short
// confirm window shows no progress signal, repeated until a total retry
// budget is exhausted. Exercised here against a fake stderr feed and a
// counting triggerEdit, with small confirmMs/retryBudgetMs/pollIntervalMs
// passed explicitly — no chokidar arming, spawn, or real timing needed to
// pin the retry/give-up branches (that end-to-end evidence lives in this
// task's final report and in watch-process.ts's own comment, not in this
// automated suite).
const test = require("node:test");
const assert = require("node:assert/strict");
const { applyTriggerWithRetry } = require("../helpers/watch-process.ts");

// Matches PROGRESS_SIGNAL_PATTERN's push-start alternative
// (WATCH_TICK_PUSH_START_PATTERN in watch-process.ts) — any real
// progress-signal shape works equally; reused here for a self-contained
// fixture line.
const PUSH_START_LINE = "watch tick pushing snapshot\n";
// Matches PROGRESS_SIGNAL_PATTERN's ready-line alternative
// (WATCH_READY_PATTERN) — used below to model the ready line that is always
// already present in getStderr() by the time applyTriggerWithRetry is
// called in real usage (waitForWatcherReady has already resolved).
const READY_LINE = "watching 1 path(s) under /tmp/fixture\n";

test("applyTriggerWithRetry: applies the edit once and returns without retrying when a progress signal appears within the confirm window", async () => {
  let stderr = "";
  let callCount = 0;
  await applyTriggerWithRetry(
    () => stderr,
    () => {
      callCount += 1;
      stderr += PUSH_START_LINE;
    },
    1000, // confirmMs
    5000, // retryBudgetMs
    10, // pollIntervalMs
  );
  assert.equal(
    callCount,
    1,
    "a trigger edit that is immediately observed must not be retried",
  );
});

test("applyTriggerWithRetry: retries the edit once no progress signal appears within the confirm window, then stops once one does", async () => {
  let stderr = "";
  let callCount = 0;
  await applyTriggerWithRetry(
    () => stderr,
    () => {
      callCount += 1;
      // First attempt's edit is silently lost (no stderr change) — models
      // the arming race. Second attempt's edit IS observed.
      if (callCount >= 2) {
        stderr += PUSH_START_LINE;
      }
    },
    150, // confirmMs: short so the first attempt's stall is detected quickly
    5000, // retryBudgetMs: comfortably larger than one confirmMs round
    10, // pollIntervalMs
  );
  assert.equal(
    callCount,
    2,
    "a trigger edit whose first attempt produces no signal must be re-applied exactly once before confirming",
  );
});

test("applyTriggerWithRetry: keeps retrying (more than once) while the retry budget lasts, and returns without throwing once it is exhausted", async () => {
  let stderr = "";
  let callCount = 0;
  await applyTriggerWithRetry(
    () => stderr,
    () => {
      callCount += 1;
      // Never produces a progress signal — models a genuinely stuck tick
      // (not just a lost arming event), which withTickDeadline's own
      // inactivity budget — unmodified by this helper — remains responsible
      // for eventually failing.
    },
    30, // confirmMs
    150, // retryBudgetMs: small, deliberately allows only a handful of rounds
    5, // pollIntervalMs
  );
  assert.ok(
    callCount >= 2,
    `must retry more than once within a budget spanning several confirm windows (got ${callCount} call(s))`,
  );
});

test("applyTriggerWithRetry: a pre-existing signal already in stderr before the first attempt does not by itself count as confirming that attempt", async () => {
  // Guards against a regression where the confirm check treats ANY signal
  // being present (count > 0) as confirmation, instead of requiring growth
  // beyond the count captured fresh right before THIS attempt's own edit.
  // In real usage getStderr() already contains the ready line (count=1)
  // before applyTriggerWithRetry is ever called, since waitForWatcherReady
  // has already resolved by then — a naive `count > 0` check would
  // incorrectly "confirm" the very first attempt without it ever actually
  // producing anything.
  let stderr = READY_LINE;
  let callCount = 0;
  await applyTriggerWithRetry(
    () => stderr,
    () => {
      callCount += 1;
      // Only the SECOND attempt's edit actually adds a new signal.
      if (callCount >= 2) {
        stderr += PUSH_START_LINE;
      }
    },
    150, // confirmMs
    5000, // retryBudgetMs
    10, // pollIntervalMs
  );
  assert.equal(
    callCount,
    2,
    "a pre-existing signal already present in stderr must not be mistaken for confirmation of the first attempt's own edit",
  );
});
