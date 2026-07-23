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

function spawnWatch(args: string[], env: NodeJS.ProcessEnv) {
  return spawn(
    path.resolve(process.cwd(), "node_modules", ".bin", "tsx"),
    ["src/main.ts", ...args],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );
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
// time, force-kills `child` (SIGKILL — a deliberate last-resort tier,
// distinct from the graceful SIGINT a test's own cleanup uses once the
// child has already exited on its own) and rejects with a clear message
// instead of hanging indefinitely.
async function withTickDeadline<T>(
  child: ReturnType<typeof spawn>,
  fn: () => Promise<T>,
  timeoutMs = TICK_TIMEOUT_MS
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      reject(new Error(`watch tick did not complete within ${timeoutMs}ms — killed the child process`));
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
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT");
    }
  }
}

module.exports = {
  spawnWatch,
  waitForWatcherReady,
  withTickDeadline,
  runWatchTick
};
