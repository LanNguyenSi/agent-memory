// Unit tests for the cron scheduler.
//
// parseCron is not exported directly; it is exercised via:
//   - validateCronExpression (throws on invalid input)
//   - nextScheduleTick      (verifies correct set membership by computing exact
//                            next-run times)
//
// All nextScheduleTick assertions use a fixed local-clock reference date so
// that results are deterministic regardless of the host timezone.
// waitMs = cursor.getTime() – after.getTime() is pure arithmetic and
// timezone-agnostic. Date-component assertions (getDate, getMonth, …) use
// local-time methods consistent with what the scheduler itself uses.

const test = require("node:test");
const assert = require("node:assert/strict");
// Load from TypeScript source so coverage measures src/ (the suite runs under
// tsx, which resolves scheduler.ts's extensionless `require("../errors")` that
// Node's --experimental-strip-types could not).
const { validateCronExpression, nextScheduleTick } = require("../../src/memory-sync/scheduler");

// ─── parseCron (via validateCronExpression) ──────────────────────────────────

test("parseCron: wildcard '*' in all fields is valid", () => {
  assert.doesNotThrow(() => validateCronExpression("* * * * *"));
});

test("parseCron: step */15 in minute field is valid", () => {
  assert.doesNotThrow(() => validateCronExpression("*/15 * * * *"));
});

test("parseCron: range 1-5 in minute field is valid", () => {
  assert.doesNotThrow(() => validateCronExpression("1-5 * * * *"));
});

test("parseCron: list 1,3,5 in minute field is valid", () => {
  assert.doesNotThrow(() => validateCronExpression("1,3,5 * * * *"));
});

test("parseCron: fixed value in hour and minute fields is valid", () => {
  assert.doesNotThrow(() => validateCronExpression("30 12 * * *"));
});

test("parseCron: multi-field expression with range, list, step is valid", () => {
  assert.doesNotThrow(() => validateCronExpression("0 2 1-15 3,6 1-5"));
});

test("parseCron: step on range token (5-30/5) is valid", () => {
  assert.doesNotThrow(() => validateCronExpression("5-30/5 * * * *"));
});

test("parseCron: invalid — too few fields throws CliError", () => {
  assert.throws(() => validateCronExpression("* * * *"), /invalid/);
});

test("parseCron: invalid — too many fields throws CliError", () => {
  assert.throws(() => validateCronExpression("* * * * * *"), /invalid/);
});

test("parseCron: invalid — minute 60 (out of range 0-59) throws CliError", () => {
  assert.throws(() => validateCronExpression("60 * * * *"), /outside the allowed range/);
});

test("parseCron: invalid — hour 24 (out of range 0-23) throws CliError", () => {
  assert.throws(() => validateCronExpression("* 24 * * *"), /outside the allowed range/);
});

test("parseCron: invalid — dayOfMonth 0 (out of range 1-31) throws CliError", () => {
  assert.throws(() => validateCronExpression("* * 0 * *"), /outside the allowed range/);
});

test("parseCron: invalid — dayOfMonth 32 (out of range 1-31) throws CliError", () => {
  assert.throws(() => validateCronExpression("* * 32 * *"), /outside the allowed range/);
});

test("parseCron: invalid — month 0 (out of range 1-12) throws CliError", () => {
  assert.throws(() => validateCronExpression("* * * 0 *"), /outside the allowed range/);
});

test("parseCron: invalid — month 13 (out of range 1-12) throws CliError", () => {
  assert.throws(() => validateCronExpression("* * * 13 *"), /outside the allowed range/);
});

test("parseCron: invalid — dayOfWeek 7 (out of range 0-6) throws CliError", () => {
  assert.throws(() => validateCronExpression("* * * * 7"), /outside the allowed range/);
});

test("parseCron: invalid — range with start > end throws CliError", () => {
  assert.throws(() => validateCronExpression("5-3 * * * *"), /invalid/);
});

test("parseCron: invalid — step */0 is rejected (guards the infinite-loop hang)", () => {
  // Regression guard. Formerly '*/0' passed parseInteger for min=0 fields
  // (minute/hour/dayOfWeek), then fillRange(result, min, max, 0) looped forever
  // (cursor += 0), hanging the sync daemon on a typo'd cron string. The step is
  // now validated as an integer >= 1, independent of the field range. If the
  // guard is removed this assertion never returns — the call hangs (bounded only
  // by the CI job timeout), which still fails the run rather than passing.
  assert.throws(() => validateCronExpression("*/0 * * * *"), /must be a positive integer/);
});

test("parseCron: step larger than the field range is valid (step is range-independent)", () => {
  // '*/90' on minutes: the step exceeds max=59, so only minute 0 matches — this
  // is valid, not an error. Formerly parseInteger(stepToken, 0, 59) rejected any
  // step > 59; the fix decouples the step from the field's min/max on purpose.
  assert.doesNotThrow(() => validateCronExpression("*/90 * * * *"));
});

test("parseCron: single-value step form 'a/n' (e.g. 5/2) is valid — treated as a-max/n", () => {
  // Standard (Vixie) cron reads 5/2 on minutes as 5-59/2: start at 5, step by 2
  // through the rest of the field's range. Formerly the lone range token fell
  // through to parseRange, whose missing end token failed parseInteger with a
  // misleading "'undefined' … outside range" error.
  assert.doesNotThrow(() => validateCronExpression("5/2 * * * *"));
});

test("parseCron: single-value step form '5/2' on minutes yields {5,7,9,…,59}", () => {
  // cursor starts at :06 (after minute+1 from :05); next match in {5,7,9,…,59} is 7.
  const ref = new Date(2026, 0, 15, 10, 5, 0, 0);
  const tick = nextScheduleTick("5/2 * * * *", ref);
  const runAt = new Date(tick.runAt);
  assert.equal(runAt.getMinutes(), 7);
});

test("parseCron: single-value step form '20/10' on hours yields only {20} (step exceeds field max)", () => {
  // Hour field range is 0-23; 20/10 yields {20} only, since 20+10=30 exceeds max=23.
  const ref = new Date(2026, 0, 15, 10, 0, 0, 0);
  const tick = nextScheduleTick("0 20/10 * * *", ref);
  const runAt = new Date(tick.runAt);
  assert.equal(runAt.getHours(), 20);
  assert.equal(runAt.getMinutes(), 0);
});

test("parseCron: invalid — non-numeric field value throws CliError", () => {
  assert.throws(() => validateCronExpression("* * * * abc"), /outside the allowed range/);
});

// ─── nextScheduleTick ────────────────────────────────────────────────────────
//
// Reference date: Thursday, 2026-01-15, 10:30:00 local time.
// January 15, 2026 is a Thursday (getDay() === 4).

const REF = () => new Date(2026, 0, 15, 10, 30, 0, 0);

test("nextScheduleTick: wildcard '* * * * *' fires 1 minute after reference", () => {
  const tick = nextScheduleTick("* * * * *", REF());
  assert.equal(tick.waitMs, 60_000, "should wait exactly 1 minute");
  const runAt = new Date(tick.runAt);
  assert.equal(runAt.getMinutes(), 31);
  assert.equal(runAt.getHours(), 10);
});

test("nextScheduleTick: step */15 from :30 fires at :45 — 15 minutes away", () => {
  // minutes in set: {0, 15, 30, 45}. cursor starts at :31, next match = :45
  const tick = nextScheduleTick("*/15 * * * *", REF());
  assert.equal(tick.waitMs, 15 * 60_000, "should wait 15 minutes");
  const runAt = new Date(tick.runAt);
  assert.equal(runAt.getMinutes(), 45);
  assert.equal(runAt.getHours(), 10);
});

test("nextScheduleTick: step */15 from :00 fires at :15 — 15 minutes away", () => {
  // cursor starts at :01 (after minute+1), walks to :15
  const ref = new Date(2026, 0, 15, 10, 0, 0, 0);
  const tick = nextScheduleTick("*/15 * * * *", ref);
  assert.equal(tick.waitMs, 15 * 60_000);
  const runAt = new Date(tick.runAt);
  assert.equal(runAt.getMinutes(), 15);
  assert.equal(runAt.getHours(), 10);
});

test("nextScheduleTick: range 1-5 from :00 fires at :01 — 1 minute away", () => {
  const ref = new Date(2026, 0, 15, 10, 0, 0, 0);
  const tick = nextScheduleTick("1-5 * * * *", ref);
  assert.equal(tick.waitMs, 60_000);
  const runAt = new Date(tick.runAt);
  assert.equal(runAt.getMinutes(), 1);
});

test("nextScheduleTick: list 1,3,5 from :02 fires at :03 — 1 minute away", () => {
  const ref = new Date(2026, 0, 15, 10, 2, 0, 0);
  const tick = nextScheduleTick("1,3,5 * * * *", ref);
  assert.equal(tick.waitMs, 60_000);
  const runAt = new Date(tick.runAt);
  assert.equal(runAt.getMinutes(), 3);
});

test("nextScheduleTick: fixed hour '0 11 * * *' from 10:30 fires at 11:00", () => {
  // 30 minutes to reach 11:00
  const tick = nextScheduleTick("0 11 * * *", REF());
  assert.equal(tick.waitMs, 30 * 60_000, "should wait 30 minutes for 11:00");
  const runAt = new Date(tick.runAt);
  assert.equal(runAt.getHours(), 11);
  assert.equal(runAt.getMinutes(), 0);
  assert.equal(runAt.getDate(), 15);
});

test("nextScheduleTick: day-of-week constraint — next Monday noon from Thursday", () => {
  // REF is Thursday Jan 15; next Monday is Jan 19.
  // "0 12 * * 1" = noon on Monday
  const tick = nextScheduleTick("0 12 * * 1", REF());
  const runAt = new Date(tick.runAt);
  assert.equal(runAt.getDay(), 1, "must land on a Monday");
  assert.equal(runAt.getHours(), 12);
  assert.equal(runAt.getMinutes(), 0);
  assert.equal(runAt.getDate(), 19, "next Monday is Jan 19");
  assert.equal(runAt.getMonth(), 0, "still in January");
});

test("nextScheduleTick: month rollover — '0 0 1 * *' from Jan 31 midnight fires Feb 1", () => {
  // Start at end of January; first-of-month midnight requires crossing to Feb.
  const ref = new Date(2026, 0, 31, 0, 0, 0, 0);
  const tick = nextScheduleTick("0 0 1 * *", ref);
  // 24 hours from Jan 31 00:00 to Feb 1 00:00 (no DST between Jan and Feb)
  assert.equal(tick.waitMs, 24 * 60 * 60_000, "should wait exactly 24 hours");
  const runAt = new Date(tick.runAt);
  assert.equal(runAt.getDate(), 1);
  assert.equal(runAt.getMonth(), 1, "February = month index 1");
  assert.equal(runAt.getFullYear(), 2026);
  assert.equal(runAt.getHours(), 0);
  assert.equal(runAt.getMinutes(), 0);
});

test("nextScheduleTick: year-end rollover — '0 0 1 1 *' from Dec 31 midnight fires Jan 1 next year", () => {
  const ref = new Date(2026, 11, 31, 0, 0, 0, 0);
  const tick = nextScheduleTick("0 0 1 1 *", ref);
  // 24 hours from Dec 31 00:00 to Jan 1 00:00
  assert.equal(tick.waitMs, 24 * 60 * 60_000);
  const runAt = new Date(tick.runAt);
  assert.equal(runAt.getDate(), 1);
  assert.equal(runAt.getMonth(), 0, "January = month index 0");
  assert.equal(runAt.getFullYear(), 2027);
  assert.equal(runAt.getHours(), 0);
  assert.equal(runAt.getMinutes(), 0);
});

test("nextScheduleTick: iteration cap — impossible date '0 0 30 2 *' throws after 525600 iterations", { timeout: 10_000 }, () => {
  // February never has 30 days; the loop exhausts 525600 iterations and throws.
  assert.throws(
    () => nextScheduleTick("0 0 30 2 *", new Date(2026, 0, 1, 0, 0, 0, 0)),
    (err: Error) => err.message.includes("could not compute next run")
  );
});
