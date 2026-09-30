// Coverage for the arming gate on `watch`'s ready line (agent-tasks
// 50a13ffe; mechanism and the state signal in src/commands/watch-arming.ts).
//
// chokidar's own `ready` fires while the watch for a sync path that is missing
// at start (a `logs/` directory nobody created yet) is still to be opened, and
// a write landing in that gap is never delivered. In production that gap is a
// few milliseconds wide and only bites under CPU load, which made the stall it
// causes irreproducible on demand. These tests widen the gap by construction
// instead of waiting for load: tests/helpers/arming-delay-preload.cjs delays
// the deferred step by a fixed time and logs every fs.watch() call, so the
// assertions below are about ordering (was the watch opened before the ready
// line?), not about timing luck.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSandbox, writeProjectConfig, writeText } = require("../helpers/cli.ts");
const {
  spawnWatch,
  waitForWatcherReady,
  withTickDeadline,
  stopWatchProcessGroup,
  INACTIVITY_TIMEOUT_MS
} = require("../helpers/watch-process.ts");
const {
  ARM_TIMEOUT_ENV_VAR,
  DEFAULT_ARM_TIMEOUT_MS,
  collectMissingTargets,
  isTargetArmed,
  parseArmTimeoutMs,
  waitForDeferredArming
} = require("../../src/commands/watch-arming.ts");

const PRELOAD = path.resolve(process.cwd(), "tests", "helpers", "arming-delay-preload.cjs");
// Far larger than the few milliseconds the deferred step needs on its own, so
// chokidar's `ready` reliably lands inside the gap, and small enough to keep
// the tests fast.
const ARM_DELAY_MS = 400;
const READY_LINE = /watching \d+ path\(s\) under/;

function delayedArmingEnv(delayDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const existing = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : "";
  return {
    ...process.env,
    NODE_OPTIONS: `${existing}--require "${PRELOAD}"`,
    AGENT_MEMORY_SYNC_TEST_ARM_DELAY_DIR: delayDir,
    AGENT_MEMORY_SYNC_TEST_ARM_DELAY_MS: String(ARM_DELAY_MS),
    ...extra
  };
}

// MEMORY.md exists, logs/ does not. The remote is a path that does not exist,
// so a tick queues locally and exits 0: the test needs the tick to start, not
// to publish anything.
function setupMissingLogsWorkspace(name: string) {
  const root = createSandbox(name);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeProjectConfig(configPath, {
    rootDir: workspaceRoot,
    remoteUrl: path.join(root, "missing-remote.git"),
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    reachabilityTimeoutMs: 500,
    syncPaths: [
      { source: "MEMORY.md", destination: "MEMORY.md", kind: "file" },
      { source: "logs", destination: "logs", kind: "directory" }
    ]
  });
  return { workspaceRoot, configPath };
}

function watchArgs(configPath: string): string[] {
  return ["watch", "default", "--config", configPath, "--debounce-ms", "300", "--max-runs", "1", "--verbose", "--output", "json"];
}

test("watch prints its ready line only after the deferred watch for a missing syncPath is open, so an immediate write is seen", async () => {
  const { workspaceRoot, configPath } = setupMissingLogsWorkspace("watch-ready-arming");
  const child = spawnWatch(watchArgs(configPath), delayedArmingEnv(workspaceRoot));
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await withTickDeadline(
    child,
    async () => {
      await waitForWatcherReady(() => stderr);

      // The deferred watch on the parent of the missing path must already be
      // open at the point the ready line is out. The marker and the ready line
      // share one stderr pipe, so their order in the captured text is their
      // order in the child. Checked before the write so an early ready fails
      // fast here instead of after the tick that would never come.
      const watchOpenedAt = stderr.indexOf(`arm-probe: fs.watch ${workspaceRoot}\n`);
      const readyAt = stderr.search(READY_LINE);
      assert.ok(readyAt >= 0, `no ready line. stderr: ${stderr}`);
      assert.ok(
        watchOpenedAt >= 0 && watchOpenedAt < readyAt,
        `ready line printed before the watch on ${workspaceRoot} was open. stderr: ${stderr}`
      );

      // Straight after the ready line, into the directory that was missing.
      writeText(path.join(workspaceRoot, "logs", "trigger.md"), "trigger\n");

      return new Promise<number>((resolve) => {
        child.on("exit", (code: number | null) => resolve(code ?? -1));
      });
    },
    INACTIVITY_TIMEOUT_MS,
    () => stderr
  ).finally(() => stopWatchProcessGroup(child));

  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.match(stderr, /watch tick pushing snapshot/);
});

test("watch still prints its ready line, with a warning naming the path, when the deferred watch is not confirmed in time", async () => {
  const { workspaceRoot, configPath } = setupMissingLogsWorkspace("watch-ready-arming-bound");
  // The delayed arming (400ms) outlasts this 50ms bound.
  const child = spawnWatch(watchArgs(configPath), delayedArmingEnv(workspaceRoot, { [ARM_TIMEOUT_ENV_VAR]: "50" }));
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await withTickDeadline(
      child,
      async () => {
        await waitForWatcherReady(() => stderr);
      },
      INACTIVITY_TIMEOUT_MS,
      () => stderr
    );
  } finally {
    await stopWatchProcessGroup(child);
  }

  const missingLogs = path.join(workspaceRoot, "logs");
  assert.match(stderr, new RegExp(`warning: could not confirm the watch on ${missingLogs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} within 50ms`));
  const warningAt = stderr.indexOf("could not confirm the watch");
  assert.ok(warningAt < stderr.search(READY_LINE), `the warning must precede the ready line. stderr: ${stderr}`);
});

test("against real chokidar, the gate resolves only once the watch on the missing path's parent has been opened", async () => {
  const chokidar = require("chokidar");
  const root = createSandbox("watch-ready-arming-chokidar");
  const workspaceRoot = path.join(root, "workspace");
  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  const watchedPaths = [path.join(workspaceRoot, "MEMORY.md"), path.join(workspaceRoot, "logs")];

  const opened: string[] = [];
  const realWatch = fs.watch;
  fs.watch = function watch(target: string, ...rest: unknown[]) {
    opened.push(target);
    return realWatch.call(this, target, ...rest);
  };
  const missing = collectMissingTargets(watchedPaths);
  const watcher = chokidar.watch(watchedPaths, { ignoreInitial: true });
  try {
    const result = await waitForDeferredArming(watcher, missing, { timeoutMs: 5000 });
    assert.deepEqual(result, { armed: true, pending: [] });
    assert.ok(opened.includes(workspaceRoot), `expected an fs.watch on ${workspaceRoot}, saw: ${opened.join(", ")}`);
  } finally {
    fs.watch = realWatch;
    await watcher.close();
  }
});

test("collectMissingTargets pairs each missing path with its nearest existing ancestor and skips existing paths", () => {
  const existing = new Set(["/ws", "/ws/MEMORY.md", "/ws/a"]);
  const exists = (candidate: string) => existing.has(candidate);
  assert.deepEqual(collectMissingTargets(["/ws/MEMORY.md", "/ws/logs", "/ws/a/b/c"], exists), [
    { target: "/ws/logs", anchor: "/ws" },
    { target: "/ws/a/b/c", anchor: "/ws/a" }
  ]);
  assert.deepEqual(collectMissingTargets(["/ws/MEMORY.md"], exists), []);
});

test("isTargetArmed reads the ancestor's own listing under its parent, or the target itself", () => {
  const target = { target: "/ws/logs", anchor: "/ws" };
  assert.equal(isTargetArmed({ "/ws": ["MEMORY.md"] }, target), false, "sibling file watched, ancestor watch not yet open");
  assert.equal(isTargetArmed({ "/ws": ["MEMORY.md"], "/": ["ws"] }, target), true, "ancestor listed under its parent");
  assert.equal(isTargetArmed({ "/ws": ["MEMORY.md", "logs"] }, target), true, "target appeared and is tracked itself");
  assert.equal(isTargetArmed({}, { target: "/x", anchor: "/" }), false);
  assert.equal(isTargetArmed({ "/": [] }, { target: "/x", anchor: "/" }), true);
});

test("waitForDeferredArming does not resolve while the state reads unarmed, and resolves once it flips", async () => {
  const state: Record<string, string[]> = { "/ws": ["MEMORY.md"] };
  const fake = { getWatched: () => state };
  const targets = [{ target: "/ws/logs", anchor: "/ws" }];

  let resolved = false;
  const waiting = waitForDeferredArming(fake, targets, { timeoutMs: 5000, pollMs: 2 }).then((result: unknown) => {
    resolved = true;
    return result;
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(resolved, false, "resolved while the deferred watch was still not open");

  state["/"] = ["ws"];
  assert.deepEqual(await waiting, { armed: true, pending: [] });
});

// The explicit timeout turns a wait that never ends (the bound removed) into a
// failure instead of a hang.
test("waitForDeferredArming gives up after the bound and names the paths still pending", { timeout: 5000 }, async (t: { after: (fn: () => void) => void }) => {
  const stop = new AbortController();
  // Ends the wait if this test already failed on its timeout (the bound
  // removed), so the failed run does not keep polling and hang the process.
  t.after(() => stop.abort());
  const fake = { getWatched: () => ({ "/ws": ["MEMORY.md"] }) };
  const targets = [
    { target: "/ws/logs", anchor: "/ws" },
    { target: "/ws/MEMORY.md", anchor: "/ws" }
  ];
  const started = Date.now();
  const result = await waitForDeferredArming(fake, targets, { timeoutMs: 80, pollMs: 2, signal: stop.signal });
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { armed: false, pending: ["/ws/logs"] });
  assert.ok(elapsed >= 80 && elapsed < 2000, `expected to give up shortly after the 80ms bound, took ${elapsed}ms`);
});

test("waitForDeferredArming ends at once when its signal aborts, without waiting for the bound", async () => {
  const stop = new AbortController();
  const fake = { getWatched: () => ({ "/ws": ["MEMORY.md"] }) };
  const waiting = waitForDeferredArming(fake, [{ target: "/ws/logs", anchor: "/ws" }], {
    timeoutMs: 60000,
    pollMs: 2,
    signal: stop.signal
  });
  stop.abort();
  assert.deepEqual(await waiting, { armed: false, pending: ["/ws/logs"] });
});

test("waitForDeferredArming treats a watcher that cannot report its state as unarmed and still ends at the bound", { timeout: 5000 }, async (t: { after: (fn: () => void) => void }) => {
  const stop = new AbortController();
  t.after(() => stop.abort());
  const fake = {
    getWatched: () => {
      throw new Error("closed");
    }
  };
  const result = await waitForDeferredArming(fake, [{ target: "/ws/logs", anchor: "/ws" }], { timeoutMs: 30, pollMs: 2, signal: stop.signal });
  assert.deepEqual(result, { armed: false, pending: ["/ws/logs"] });
});

test("parseArmTimeoutMs takes a non-negative number and falls back to the default otherwise", () => {
  assert.equal(parseArmTimeoutMs(undefined), DEFAULT_ARM_TIMEOUT_MS);
  assert.equal(parseArmTimeoutMs(""), DEFAULT_ARM_TIMEOUT_MS);
  assert.equal(parseArmTimeoutMs("250"), 250);
  assert.equal(parseArmTimeoutMs("0"), 0);
  assert.equal(parseArmTimeoutMs("-5"), DEFAULT_ARM_TIMEOUT_MS);
  assert.equal(parseArmTimeoutMs("soon"), DEFAULT_ARM_TIMEOUT_MS);
});
