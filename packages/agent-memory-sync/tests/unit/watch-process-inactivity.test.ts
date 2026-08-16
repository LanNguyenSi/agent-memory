// Unit-level pin for withTickDeadline's inactivity mode
// (tests/helpers/watch-process.ts): the deadline must bound the GAP since
// the last observed progress signal, not the tick's total duration. Exercises
// the mechanism directly against a fake stderr feed instead of a real
// spawned `watch` child end to end, so it stays fast and deterministic — no
// chokidar arming, git I/O, or CI load needed to observe the semantics
// under test (that end-to-end evidence lives in this task's final report,
// not in this automated suite: a SIGSTOP'd real child and a 10-run load
// scenario against tests/integration/{watch-restore,watch-mirror-delete,
// watch-teardown-guard}.test.ts).
//
// Positive control for this task's mutation probe: removing the "reset the
// deadline on a new progress signal" branch inside withTickDeadline
// collapses it back to a fixed-total-duration budget. Under that mutation,
// "resolves a tick that outlives one inactivity budget window but keeps
// producing progress signals inside it" below goes red (the
// slow-but-progressing tick gets killed even though it kept signaling),
// while "rejects a tick that shows zero progress signal for the full
// budget" stays green either way (a child that never signals behaves
// identically under both models). Together they pin that the reset branch
// specifically — not just the presence of some deadline — is what this
// file's structural fix depends on.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { withTickDeadline } = require("../helpers/watch-process.ts");

// A real, detached, short-lived-but-outlives-the-test process purely so
// withTickDeadline's SIGKILL-on-timeout path (signalProcessGroup) has an
// actual pid/process group it can safely signal — mirrors spawnWatch's own
// `detached: true` shape (see watch-process.ts) without paying for tsx,
// chokidar, or a real config/workspace.
function spawnDummyGroup(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    stdio: "ignore",
    detached: true
  });
}

function killDummyGroup(child: ReturnType<typeof spawn>): void {
  try {
    process.kill(-(child.pid as number), "SIGKILL");
  } catch {
    // Already gone — e.g. withTickDeadline's own timeout handler beat us to it.
  }
}

test("withTickDeadline (inactivity mode): resolves a tick that outlives one budget window but keeps producing progress signals inside it", async () => {
  const child = spawnDummyGroup();
  try {
    let stderr = "";
    const BUDGET_MS = 400;
    const GAP_MS = 150;
    const ITERATIONS = 4;
    // Each individual gap (GAP_MS) stays comfortably under BUDGET_MS, but
    // the tick's total duration (ITERATIONS * GAP_MS = 600ms) exceeds it —
    // a fixed whole-duration budget of BUDGET_MS would have killed this
    // before it could finish.
    const result = await withTickDeadline(
      child,
      async () => {
        for (let i = 0; i < ITERATIONS; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, GAP_MS));
          // Matches WATCH_READY_PATTERN (/watching \d+ path\(s\) under/) in
          // watch-process.ts — any real progress-signal shape works equally;
          // this one is reused for a self-contained fixture line.
          stderr += "watching 1 path(s) under /tmp/fixture\n";
        }
        return "done";
      },
      BUDGET_MS,
      () => stderr
    );
    assert.equal(result, "done", "a slow-but-progressing tick must not be killed by the inactivity deadline");
  } finally {
    killDummyGroup(child);
  }
});

test("withTickDeadline (inactivity mode): rejects a tick that shows zero progress signal for the full budget", async () => {
  const child = spawnDummyGroup();
  try {
    const BUDGET_MS = 400;
    await assert.rejects(
      () =>
        withTickDeadline(
          child,
          () => new Promise(() => {}), // never settles on its own
          BUDGET_MS,
          () => "" // stderr never grows — no progress signal is ever observed
        ),
      /no progress signal/,
      "a tick with zero progress signals must still be killed once the inactivity budget elapses"
    );
  } finally {
    killDummyGroup(child);
  }
});
