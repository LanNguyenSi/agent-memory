// Regression guard for the MEDIUM review finding on
// ../helpers/watch-process.ts's `detached: true` + negated-pid
// process.kill(-pid, sig) group-kill (task c71de504, review round 2):
// reverting either half silently — `detached: true` alone, or the
// negated-pid kill alone — leaves every other existing test green, because
// process.kill(-pid, sig) then throws ESRCH (no such process group), which
// signalProcessGroup already swallows as "success". A silently no-op
// teardown is worse than the pre-change code it replaced (which at least
// got a free kill from the runner's own process-group SIGINT on Ctrl-C).
//
// The observable that actually distinguishes "the group died" from "it
// didn't": tsx's node grandchild inherits this helper's own child.stdout/
// child.stderr pipe fds (see spawnWatch's comment) and holds their write
// end open for as long as it is alive, whether or not the immediate tsx
// launcher is still around. So the parent-side pipe closing is a direct,
// cheap proxy for "the grandchild is actually dead", not just "the
// launcher exited" — which is exactly the gap the pre-fix code got wrong.
//
// Mutation-tested outside this repo (not part of this automated suite —
// see this task's final report): reverting `detached: true` alone, and
// reverting only the negated-pid kill in signalProcessGroup, each made this
// test fail (stderr never closed within the deadline, and/or
// process.kill(-pid, 0) did not throw ESRCH). Both arms pass on the
// unmutated code below.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createSandbox, initBareRemote, runCli, writeProjectConfig, writeText } = require("../helpers/cli.ts");
const { spawnWatch, withTickDeadline, stopWatchProcessGroup } = require("../helpers/watch-process.ts");

test("stopWatchProcessGroup actually kills the whole watch process group, not just the tsx launcher", async () => {
  const root = createSandbox("watch-teardown-guard");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeProjectConfig(configPath, {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    syncPaths: [{ source: "MEMORY.md", destination: "MEMORY.md", kind: "file" }]
  });
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // A watch that will never tick: no trigger edit is ever applied, so the
  // child just sits armed (or still arming) until we force it down below.
  const child = spawnWatch(
    ["watch", "default", "--config", configPath, "--debounce-ms", "300", "--max-runs", "1", "--verbose", "--output", "json"],
    process.env
  );

  // Force the deadline path (500ms) rather than waiting out
  // INACTIVITY_TIMEOUT_MS; `fn` never settles on its own, so this always
  // times out and SIGKILLs the group. No stderr source is passed, so this
  // stays on withTickDeadline's original fixed-wall-clock path (see
  // watch-process.ts) rather than its newer inactivity mode — this test has
  // no progress signal to poll in the first place, and is pinning
  // group-kill behavior, not tick timing semantics. The rejection is
  // expected and irrelevant to this test.
  await withTickDeadline(child, () => new Promise(() => {}), 500).catch(() => {});

  // Idempotent on top of the deadline path's own kill — exercises the same
  // teardown callers actually use (runWatchTick's finally).
  await stopWatchProcessGroup(child);

  const stderrClosed = await new Promise((resolve) => {
    if (child.stderr.destroyed || child.stderr.closed) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), 1000);
    child.stderr.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.equal(
    stderrClosed,
    true,
    "parent-side stderr pipe never closed within 1s after teardown — the grandchild is likely still alive and orphaned"
  );

  assert.throws(
    () => process.kill(-(child.pid as number), 0),
    (err: NodeJS.ErrnoException) => err.code === "ESRCH",
    "expected the whole process group to be gone (ESRCH) after teardown"
  );
});
