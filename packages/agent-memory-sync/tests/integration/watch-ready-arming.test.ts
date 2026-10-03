// Coverage for `watch`'s handling of syncPaths that do not exist at start
// (agent-tasks 50a13ffe, d09a0d3a; mechanism in src/commands/watch-arming.ts).
//
// chokidar 4.0.3 loses three shapes of missing syncPath: (a) two or more
// missing paths under one existing directory (only the first target's deferred
// listener is delivered), (b) a nested missing path whose parent is missing as
// well (never matches), (c) a path created before chokidar's deferred step ran
// (what it already holds is never read). `watch` therefore tracks each missing
// path itself and gives it its own watcher once it appears. Each test below
// writes into the path the way an operator's agent does, straight after the
// ready line or before it, and then needs a tick to start for that write; the
// tick count is the delivery signal (a tick runs whole-tree, so one delivered
// path would otherwise hide a lost one: every path under test gets its own
// tick, one after the other).
//
// tests/helpers/arming-delay-preload.cjs widens the gap in chokidar's deferred
// step by construction, so the (c) test fails on the pre-change code without
// depending on CPU load.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createSandbox, writeProjectConfig, writeText } = require("../helpers/cli.ts");
const {
  spawnWatch,
  trackWatchProcessGroup,
  waitForWatcherReady,
  withTickDeadline,
  stopWatchProcessGroup,
  INACTIVITY_TIMEOUT_MS
} = require("../helpers/watch-process.ts");

const PRELOAD = path.resolve(process.cwd(), "tests", "helpers", "arming-delay-preload.cjs");
// Far larger than the few milliseconds chokidar's deferred step needs on its
// own, so a path created right after the first fs.watch lands inside it.
const ARM_DELAY_MS = 400;
const READY_LINE = /watching \d+ path\(s\) under/;
const TICK_STARTED = /watch tick pushing snapshot/g;
// The line that ends a tick. The remote of these workspaces does not exist, so
// a tick queues locally and the process keeps running until --max-runs.
const TICK_ENDED = /watch tick (queued locally|produced no remote changes|pushed snapshot)/g;

function delayedArmingEnv(delayDir: string): NodeJS.ProcessEnv {
  const existing = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : "";
  return {
    ...process.env,
    NODE_OPTIONS: `${existing}--require "${PRELOAD}"`,
    AGENT_MEMORY_SYNC_TEST_ARM_DELAY_DIR: delayDir,
    AGENT_MEMORY_SYNC_TEST_ARM_DELAY_MS: String(ARM_DELAY_MS)
  };
}

// MEMORY.md exists, and so does the workspace root; the directories named in
// `missingDirs` (relative to the root, possibly nested) do not.
function setupWorkspace(name: string, missingDirs: string[]) {
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
      ...missingDirs.map((dir) => ({ source: dir, destination: dir, kind: "directory" }))
    ]
  });
  return { workspaceRoot, configPath };
}

function watchArgs(configPath: string, maxRuns: number): string[] {
  return ["watch", "default", "--config", configPath, "--debounce-ms", "300", "--max-runs", String(maxRuns), "--verbose", "--output", "json"];
}

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

// Resolves once `pattern` matches `getStderr()` at least `atLeast` times;
// rejects when the child ends first, so a child killed by withTickDeadline's
// inactivity budget fails the wait instead of leaving it polling.
function waitForCount(child: ReturnType<typeof spawn>, getStderr: () => string, pattern: RegExp, atLeast: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (count(getStderr(), pattern) >= atLeast) {
        resolve();
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error(`watch ended before ${pattern} matched ${atLeast} time(s). stderr: ${getStderr()}`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

// Runs `watch` over a workspace, lets `scenario` write into it, and returns the
// exit code and stderr once the child has exited by itself (--max-runs reached).
async function runWatch(
  name: string,
  missingDirs: string[],
  maxRuns: number,
  scenario: (ctx: {
    workspaceRoot: string;
    child: ReturnType<typeof spawn>;
    stderr: () => string;
  }) => Promise<void>,
  env: (workspaceRoot: string) => NodeJS.ProcessEnv = () => process.env
): Promise<{ exitCode: number; stderr: string }> {
  const { workspaceRoot, configPath } = setupWorkspace(name, missingDirs);
  const child = spawnWatch(watchArgs(configPath, maxRuns), env(workspaceRoot));
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code: number | null) => resolve(code ?? -1));
  });
  try {
    const exitCode = await withTickDeadline(
      child,
      async () => {
        await scenario({ workspaceRoot, child, stderr: () => stderr });
        return exited;
      },
      INACTIVITY_TIMEOUT_MS,
      () => stderr
    );
    return { exitCode, stderr };
  } finally {
    await stopWatchProcessGroup(child);
  }
}

// One write, one tick: waits for the tick the write must cause to start and
// to end, so the next write cannot be merged into it by the debounce window.
async function writeAndAwaitTick(
  child: ReturnType<typeof spawn>,
  stderr: () => string,
  filePath: string,
  tickNumber: number
): Promise<void> {
  writeText(filePath, `change ${tickNumber}\n`);
  await waitForCount(child, stderr, TICK_STARTED, tickNumber);
  await waitForCount(child, stderr, TICK_ENDED, tickNumber);
}

test("watch delivers a write into a missing syncPath straight after the ready line", async () => {
  const { exitCode, stderr } = await runWatch("watch-arming-single", ["logs"], 1, async ({ workspaceRoot, stderr }) => {
    await waitForWatcherReady(stderr);
    writeText(path.join(workspaceRoot, "logs", "trigger.md"), "trigger\n");
  });
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.equal(count(stderr, TICK_STARTED), 1);
  assert.doesNotMatch(stderr, /could not (confirm|start)/);
  assert.doesNotMatch(stderr, /warning: .*share the existing directory/);
});

// Shape (a). The two paths are missing under the same existing directory, so
// chokidar 4.0.3 delivered only one of them, whichever deferred listener
// registered first. Both writes need their own tick.
test("watch delivers each of two missing syncPaths that share an existing directory", async () => {
  const { exitCode, stderr } = await runWatch("watch-arming-shared", ["logs", "notes"], 2, async ({ workspaceRoot, child, stderr }) => {
    await waitForWatcherReady(stderr);
    await writeAndAwaitTick(child, stderr, path.join(workspaceRoot, "logs", "a.md"), 1);
    await writeAndAwaitTick(child, stderr, path.join(workspaceRoot, "notes", "b.md"), 2);
  });
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.equal(count(stderr, TICK_STARTED), 2);
});

// The same shape with the second path written first, so the result does not
// depend on which path comes first in the configuration.
test("watch delivers two missing syncPaths in either order of appearance", async () => {
  const { exitCode, stderr } = await runWatch("watch-arming-shared-reversed", ["logs", "notes"], 2, async ({ workspaceRoot, child, stderr }) => {
    await waitForWatcherReady(stderr);
    await writeAndAwaitTick(child, stderr, path.join(workspaceRoot, "notes", "b.md"), 1);
    await writeAndAwaitTick(child, stderr, path.join(workspaceRoot, "logs", "a.md"), 2);
  });
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.equal(count(stderr, TICK_STARTED), 2);
});

// Shape (b). `logs` is missing as well, so chokidar 4.0.3 re-added the target
// for its leaf name under the workspace root and never matched it.
test("watch delivers a nested missing syncPath whose parent directory is missing too", async () => {
  const { exitCode, stderr } = await runWatch("watch-arming-nested", [path.join("logs", "daily")], 1, async ({ workspaceRoot, stderr }) => {
    await waitForWatcherReady(stderr);
    writeText(path.join(workspaceRoot, "logs", "daily", "a.md"), "daily\n");
  });
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.equal(count(stderr, TICK_STARTED), 1);
});

test("watch delivers a nested missing syncPath that is created one directory level at a time", async () => {
  const { exitCode, stderr } = await runWatch("watch-arming-nested-steps", [path.join("logs", "daily")], 1, async ({ workspaceRoot, stderr }) => {
    await waitForWatcherReady(stderr);
    writeText(path.join(workspaceRoot, "logs", "unrelated.md"), "outside the syncPath\n");
    // Several poll intervals pass with `logs` present and `logs/daily` absent.
    await new Promise((resolve) => setTimeout(resolve, 800));
    writeText(path.join(workspaceRoot, "logs", "daily", "a.md"), "daily\n");
  });
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.equal(count(stderr, TICK_STARTED), 1);
});

// Shape (c). The path and a file in it are created in the window where
// chokidar's own deferred step has not run yet (the preload delays it by
// ARM_DELAY_MS after the first fs.watch). chokidar 4.0.3 then skipped the
// directory's initial read and never reported the file. The file exists before
// any watch on `logs` can have been opened, so only a read of the path after
// its watch is open can deliver it.
test("watch delivers a file that was created together with a missing syncPath before its watch could be opened", async () => {
  const { exitCode, stderr } = await runWatch(
    "watch-arming-created-early",
    ["logs"],
    1,
    async ({ workspaceRoot, child, stderr }) => {
      const firstWatch = `arm-probe: fs.watch ${path.join(workspaceRoot, "MEMORY.md")}\n`;
      const startedWaitingAt = Date.now();
      while (!stderr().includes(firstWatch)) {
        assert.ok(Date.now() - startedWaitingAt < 20000, `watch never opened its first fs.watch. stderr: ${stderr()}`);
        assert.ok(child.exitCode === null, `watch ended early. stderr: ${stderr()}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      writeText(path.join(workspaceRoot, "logs", "early.md"), "written before the watch\n");
    },
    delayedArmingEnv
  );
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.equal(count(stderr, TICK_STARTED), 1);
});

test("watch says which syncPaths it is waiting for and announces each one that appears, before and after its ready line", async () => {
  const { exitCode, stderr } = await runWatch("watch-arming-info", ["logs", "notes"], 1, async ({ workspaceRoot, stderr }) => {
    await waitForWatcherReady(stderr);
    writeText(path.join(workspaceRoot, "notes", "b.md"), "b\n");
  });
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.match(stderr, /2 syncPath\(s\) do not exist yet and are checked every \d+ms: .*logs, .*notes/);
  assert.ok(stderr.search(/syncPath\(s\) do not exist yet/) < stderr.search(READY_LINE), `the waiting line must precede the ready line. stderr: ${stderr}`);
  assert.match(stderr, /syncPath .*notes appeared, watching it/);
  assert.doesNotMatch(stderr, /syncPath .*logs appeared/);
});

// chokidar 4.0.3 emitted its own `ready` twice when two syncPaths were missing
// at start; the main watcher is no longer handed missing paths, and the ready
// line must stay a single line.
test("watch prints its ready line once with two missing syncPaths", async () => {
  const { workspaceRoot, configPath } = setupWorkspace("watch-arming-once", ["logs", "notes"]);
  const child = spawnWatch(watchArgs(configPath, 1), process.env);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    await withTickDeadline(child, async () => waitForWatcherReady(() => stderr), INACTIVITY_TIMEOUT_MS, () => stderr);
    // A second `ready` would follow the first within milliseconds; 1 s is far
    // beyond that.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } finally {
    await stopWatchProcessGroup(child);
  }
  assert.equal(count(stderr, new RegExp(READY_LINE.source, "g")), 1, `expected one ready line. stderr: ${stderr}`);
  assert.ok(stderr.includes(workspaceRoot), "ready line names the workspace");
});

// A workspace whose every syncPath is missing: chokidar has nothing to scan
// and never emits `ready`, so the line must come from the trackers.
test("watch prints its ready line when every syncPath is missing, and delivers a write into one of them", async () => {
  const root = createSandbox("watch-arming-all-missing");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  writeProjectConfig(configPath, {
    rootDir: workspaceRoot,
    remoteUrl: path.join(root, "missing-remote.git"),
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    reachabilityTimeoutMs: 500,
    syncPaths: [{ source: "logs", destination: "logs", kind: "directory" }]
  });
  writeText(path.join(workspaceRoot, ".keep"), "");
  const child = spawnWatch(watchArgs(configPath, 1), process.env);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code: number | null) => resolve(code ?? -1));
  });
  try {
    const exitCode = await withTickDeadline(
      child,
      async () => {
        await waitForWatcherReady(() => stderr);
        writeText(path.join(workspaceRoot, "logs", "a.md"), "a\n");
        return exited;
      },
      INACTIVITY_TIMEOUT_MS,
      () => stderr
    );
    assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  } finally {
    await stopWatchProcessGroup(child);
  }
  assert.equal(count(stderr, TICK_STARTED), 1);
});

// Runs src/main.ts in a single node process (`node --import tsx`) instead of
// through the tsx CLI launcher spawnWatch uses. That launcher relays SIGTERM to
// its child and, when the child does not acknowledge the signal within its
// short relay window (tsx 4.22.4 `relaySignalToChild`), SIGKILLs it and exits
// 143 itself, which would decide the exit code and the exit time asserted
// below instead of watch's own shutdown. `detached: true` keeps the process in
// its own group so stopWatchProcessGroup can clean it up.
function spawnWatchWithoutLauncher(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", ...args], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true
  });
  trackWatchProcessGroup(child);
  return child;
}

// The trackers poll on timers that would keep the process alive: a shutdown
// must stop them. The missing path never appears, so a tracker that is not
// closed on shutdown leaves the process running until the test gives up.
test("a shutdown while syncPaths are still missing exits promptly with status 0", { timeout: 30000 }, async () => {
  const { configPath } = setupWorkspace("watch-arming-shutdown", ["logs", path.join("deep", "er")]);
  const child = spawnWatchWithoutLauncher(watchArgs(configPath, 1), process.env);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code: number | null) => resolve(code ?? -1));
  });
  try {
    await waitForWatcherReady(() => stderr);
    const signalledAt = Date.now();
    process.kill(child.pid, "SIGTERM");
    const exitCode = await Promise.race([
      exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(Number.NaN), 5000))
    ]);
    const elapsed = Date.now() - signalledAt;
    assert.equal(exitCode, 0, `watch did not exit with 0 within 5 s of SIGTERM (got ${exitCode}). stderr: ${stderr}`);
    assert.ok(elapsed < 2500, `expected a prompt exit after SIGTERM, took ${elapsed}ms. stderr: ${stderr}`);
    assert.match(stderr, /received SIGTERM/);
  } finally {
    await stopWatchProcessGroup(child);
  }
});
