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
const fs = require("node:fs");
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

function preloadEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existing = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : "";
  return {
    ...process.env,
    NODE_OPTIONS: `${existing}--require "${PRELOAD}"`,
    ...extra
  };
}

function delayedArmingEnv(delayDir: string): NodeJS.ProcessEnv {
  return preloadEnv({
    AGENT_MEMORY_SYNC_TEST_ARM_DELAY_DIR: delayDir,
    AGENT_MEMORY_SYNC_TEST_ARM_DELAY_MS: String(ARM_DELAY_MS)
  });
}

// MEMORY.md exists, and so does the workspace root; the directories named in
// `missingDirs` (relative to the root, possibly nested) and the files named in
// `missingFiles` do not.
function setupWorkspace(name: string, missingDirs: string[], missingFiles: string[] = []) {
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
      ...missingDirs.map((dir) => ({ source: dir, destination: dir, kind: "directory" })),
      ...missingFiles.map((file) => ({ source: file, destination: file, kind: "file" }))
    ]
  });
  return { workspaceRoot, configPath };
}

function watchArgs(configPath: string, maxRuns: number): string[] {
  return [
    "watch",
    "default",
    "--config",
    configPath,
    "--debounce-ms",
    "300",
    "--max-runs",
    String(maxRuns),
    "--verbose",
    "--output",
    "json"
  ];
}

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

// Resolves once `pattern` matches `getStderr()` at least `atLeast` times;
// rejects when the child ends first, so a child killed by withTickDeadline's
// inactivity budget fails the wait instead of leaving it polling.
function waitForCount(
  child: ReturnType<typeof spawn>,
  getStderr: () => string,
  pattern: RegExp,
  atLeast: number
): Promise<void> {
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
  scenario: (ctx: { workspaceRoot: string; child: ReturnType<typeof spawn>; stderr: () => string }) => Promise<void>,
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
  const { exitCode, stderr } = await runWatch(
    "watch-arming-shared",
    ["logs", "notes"],
    2,
    async ({ workspaceRoot, child, stderr }) => {
      await waitForWatcherReady(stderr);
      await writeAndAwaitTick(child, stderr, path.join(workspaceRoot, "logs", "a.md"), 1);
      await writeAndAwaitTick(child, stderr, path.join(workspaceRoot, "notes", "b.md"), 2);
    }
  );
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.equal(count(stderr, TICK_STARTED), 2);
});

// The same shape with the second path written first, so the result does not
// depend on which path comes first in the configuration.
test("watch delivers two missing syncPaths in either order of appearance", async () => {
  const { exitCode, stderr } = await runWatch(
    "watch-arming-shared-reversed",
    ["logs", "notes"],
    2,
    async ({ workspaceRoot, child, stderr }) => {
      await waitForWatcherReady(stderr);
      await writeAndAwaitTick(child, stderr, path.join(workspaceRoot, "notes", "b.md"), 1);
      await writeAndAwaitTick(child, stderr, path.join(workspaceRoot, "logs", "a.md"), 2);
    }
  );
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.equal(count(stderr, TICK_STARTED), 2);
});

// Shape (b). `logs` is missing as well, so chokidar 4.0.3 re-added the target
// for its leaf name under the workspace root and never matched it.
test("watch delivers a nested missing syncPath whose parent directory is missing too", async () => {
  const { exitCode, stderr } = await runWatch(
    "watch-arming-nested",
    [path.join("logs", "daily")],
    1,
    async ({ workspaceRoot, stderr }) => {
      await waitForWatcherReady(stderr);
      writeText(path.join(workspaceRoot, "logs", "daily", "a.md"), "daily\n");
    }
  );
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.equal(count(stderr, TICK_STARTED), 1);
});

test("watch delivers a nested missing syncPath that is created one directory level at a time", async () => {
  const { exitCode, stderr } = await runWatch(
    "watch-arming-nested-steps",
    [path.join("logs", "daily")],
    1,
    async ({ workspaceRoot, stderr }) => {
      await waitForWatcherReady(stderr);
      writeText(path.join(workspaceRoot, "logs", "unrelated.md"), "outside the syncPath\n");
      // Several poll intervals pass with `logs` present and `logs/daily` absent.
      await new Promise((resolve) => setTimeout(resolve, 800));
      writeText(path.join(workspaceRoot, "logs", "daily", "a.md"), "daily\n");
    }
  );
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.equal(count(stderr, TICK_STARTED), 1);
});

// The path appears empty and `watch` reports it armed, which is printed after
// the one re-read of the path. A file written after that line is not found by
// any re-read, so it reaches the tick only through the watcher `watch` started
// for that path.
test("watch delivers a file written into a missing syncPath after the path appeared and was armed", async () => {
  const { exitCode, stderr } = await runWatch(
    "watch-arming-after-appeared",
    ["logs"],
    1,
    async ({ workspaceRoot, child, stderr }) => {
      await waitForWatcherReady(stderr);
      fs.mkdirSync(path.join(workspaceRoot, "logs"));
      await waitForCount(child, stderr, /syncPath .*logs is armed \(0 existing file\(s\) reported\)/g, 1);
      writeText(path.join(workspaceRoot, "logs", "late.md"), "late\n");
    }
  );
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.equal(count(stderr, TICK_STARTED), 1);
});

// A missing syncPath of kind file: the path appears with its content, which
// the re-read after the watcher is ready reports, and a later write to the
// file reaches a tick through the watcher `watch` started for that file.
test("watch delivers a missing syncPath of kind file that appears later, and a later write to it", async () => {
  const { workspaceRoot, configPath } = setupWorkspace("watch-arming-file-kind", [], ["notes.md"]);
  const child = spawnWatch(watchArgs(configPath, 2), process.env);
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
        const file = path.join(workspaceRoot, "notes.md");
        await writeAndAwaitTick(child, () => stderr, file, 1);
        await waitForCount(child, () => stderr, /syncPath .*notes\.md is armed/g, 1);
        await writeAndAwaitTick(child, () => stderr, file, 2);
        return exited;
      },
      INACTIVITY_TIMEOUT_MS,
      () => stderr
    );
    assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  } finally {
    await stopWatchProcessGroup(child);
  }
  assert.equal(count(stderr, TICK_STARTED), 2);
  assert.match(stderr, /syncPath .*notes\.md appeared, watching it/);
});

// A syncPath that is gone again when `watch` is about to open its watcher goes
// back to its tracker instead of being handed to chokidar as a missing path.
// The preload removes the directory right after the tracker's first successful
// stat; the test then creates it again with a file in it.
test("watch waits again for a syncPath that disappeared right after it appeared, and delivers it when it returns", async () => {
  const { workspaceRoot, configPath } = setupWorkspace("watch-arming-disappeared", ["logs"]);
  const logsDir = path.join(workspaceRoot, "logs");
  const child = spawnWatch(
    watchArgs(configPath, 1),
    preloadEnv({ AGENT_MEMORY_SYNC_TEST_REMOVE_AFTER_STAT_DIR: logsDir })
  );
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
        fs.mkdirSync(logsDir);
        await waitForCount(child, () => stderr, /syncPath .*logs disappeared again before it could be watched/g, 1);
        writeText(path.join(logsDir, "back.md"), "back\n");
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
  assert.match(stderr, /syncPath .*logs appeared, watching it/);
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

test("watch says which syncPaths it is waiting for and announces each one that appears", async () => {
  const { exitCode, stderr } = await runWatch(
    "watch-arming-info",
    ["logs", "notes"],
    1,
    async ({ workspaceRoot, stderr }) => {
      await waitForWatcherReady(stderr);
      writeText(path.join(workspaceRoot, "notes", "b.md"), "b\n");
    }
  );
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  assert.match(stderr, /2 syncPath\(s\) do not exist yet and are checked every \d+ms: .*logs, .*notes/);
  assert.ok(
    stderr.search(/syncPath\(s\) do not exist yet/) < stderr.search(READY_LINE),
    `the waiting line must precede the ready line. stderr: ${stderr}`
  );
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
    await withTickDeadline(
      child,
      async () => waitForWatcherReady(() => stderr),
      INACTIVITY_TIMEOUT_MS,
      () => stderr
    );
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

// Pins the order the ready line is printed in: the OS watch is confirmed live
// by a scratch watch opened after chokidar's `ready`, and only then does the
// ready line follow. The preload logs every fs.watch call on the same pipe as
// the ready line.
test("watch prints its ready line only after the scratch watch that confirms the OS watch is live", async () => {
  const { configPath, workspaceRoot } = setupWorkspace("watch-arming-live-order", ["logs"]);
  const child = spawnWatch(watchArgs(configPath, 1), delayedArmingEnv(workspaceRoot));
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    await withTickDeadline(
      child,
      async () => waitForWatcherReady(() => stderr),
      INACTIVITY_TIMEOUT_MS,
      () => stderr
    );
  } finally {
    await stopWatchProcessGroup(child);
  }
  const memoryWatchAt = stderr.indexOf(`arm-probe: fs.watch ${path.join(workspaceRoot, "MEMORY.md")}\n`);
  const scratchWatchAt = stderr.search(/arm-probe: fs\.watch \S*agent-memory-sync-arm-\S*\n/);
  const readyAt = stderr.search(READY_LINE);
  assert.ok(memoryWatchAt >= 0, `no fs.watch on MEMORY.md. stderr: ${stderr}`);
  assert.ok(
    scratchWatchAt > memoryWatchAt,
    `the scratch watch must come after the watch on MEMORY.md. stderr: ${stderr}`
  );
  assert.ok(readyAt > scratchWatchAt, `the ready line must come after the scratch watch. stderr: ${stderr}`);
  assert.doesNotMatch(stderr, /could not confirm within/);
});

// A bound of 0 ends the confirmation at its first check, before any event can
// arrive, so the warning and the ready line are deterministic.
test("watch warns, and still prints its ready line, when the OS watch is not confirmed within the bound", async () => {
  const { configPath } = setupWorkspace("watch-arming-live-bound", ["logs"]);
  const child = spawnWatch(watchArgs(configPath, 1), { ...process.env, AGENT_MEMORY_SYNC_WATCH_ARM_TIMEOUT_MS: "0" });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    await withTickDeadline(
      child,
      async () => waitForWatcherReady(() => stderr),
      INACTIVITY_TIMEOUT_MS,
      () => stderr
    );
  } finally {
    await stopWatchProcessGroup(child);
  }
  assert.match(stderr, /warning: could not confirm within 0ms that the operating system file watch is live/);
  assert.ok(
    stderr.search(/could not confirm within/) < stderr.search(READY_LINE),
    `the warning must precede the ready line. stderr: ${stderr}`
  );
  assert.equal(count(stderr, new RegExp(READY_LINE.source, "g")), 1);
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

// Starts `watch` without the launcher, the way the shutdown tests need it, with
// the test preload and `extraEnv`, and collects its stderr.
function startPreloadedWatch(configPath: string, extraEnv: NodeJS.ProcessEnv) {
  const child = spawnWatchWithoutLauncher(watchArgs(configPath, 1), preloadEnv(extraEnv));
  const output = { stderr: "" };
  child.stderr.on("data", (chunk: Buffer) => {
    output.stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code: number | null) => resolve(code ?? -1));
  });
  return { child, output, exited };
}

async function waitForStderr(child: ReturnType<typeof spawn>, getStderr: () => string, pattern: RegExp): Promise<void> {
  const startedWaitingAt = Date.now();
  while (!pattern.test(getStderr())) {
    assert.ok(Date.now() - startedWaitingAt < 20000, `${pattern} never appeared. stderr: ${getStderr()}`);
    assert.ok(child.exitCode === null, `watch ended early. stderr: ${getStderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sigtermAndTimeExit(
  child: ReturnType<typeof spawn>,
  exited: Promise<number>
): Promise<{ exitCode: number; elapsed: number }> {
  const signalledAt = Date.now();
  process.kill(child.pid, "SIGTERM");
  const exitCode = await Promise.race([
    exited,
    new Promise<number>((resolve) => setTimeout(() => resolve(Number.NaN), 6000))
  ]);
  return { exitCode, elapsed: Date.now() - signalledAt };
}

// The scratch watch that confirms the OS watch never reports an event (the
// preload suppresses its listener), so the confirmation is still waiting for
// it, bounded at 8 s, when SIGTERM arrives. The shutdown must end that wait at
// once, exit 0 well inside the bound, and must not announce a watch that is no
// longer there: no ready line and no could-not-confirm warning after (or
// without) the shutdown.
test(
  "a shutdown while the OS watch is still being confirmed ends the wait and prints neither the ready line nor a warning",
  { timeout: 40000 },
  async () => {
    const { configPath } = setupWorkspace("watch-arming-shutdown-confirming", ["logs"]);
    const { child, output, exited } = startPreloadedWatch(configPath, {
      AGENT_MEMORY_SYNC_TEST_SUPPRESS_SCRATCH_EVENTS: "1",
      AGENT_MEMORY_SYNC_WATCH_ARM_TIMEOUT_MS: "8000"
    });
    try {
      await waitForStderr(child, () => output.stderr, /arm-probe: fs\.watch \S*agent-memory-sync-arm-/);
      // Let the confirmation write into the scratch directory a few times first.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const { exitCode, elapsed } = await sigtermAndTimeExit(child, exited);
      assert.equal(
        exitCode,
        0,
        `watch did not exit with 0 within 6 s of SIGTERM (got ${exitCode}). stderr: ${output.stderr}`
      );
      assert.ok(
        elapsed < 3000,
        `the 8 s confirmation bound must not delay the shutdown, took ${elapsed}ms. stderr: ${output.stderr}`
      );
      assert.match(output.stderr, /received SIGTERM/);
      assert.doesNotMatch(output.stderr, READY_LINE, "no ready line for a watch that is shutting down");
      assert.doesNotMatch(output.stderr, /could not (confirm|check)/, "no could-not-confirm warning after a shutdown");
    } finally {
      await stopWatchProcessGroup(child);
    }
  }
);

// A syncPath appeared and its watcher never becomes ready (the preload leaves
// the later stats of the path unsettled), so `watch` is waiting for it under a
// 5 s bound when SIGTERM arrives. That bound must not keep the process alive.
test(
  "a shutdown while an appeared syncPath's watcher is not ready yet exits promptly",
  { timeout: 40000 },
  async () => {
    const { configPath, workspaceRoot } = setupWorkspace("watch-arming-shutdown-appeared", ["logs"]);
    const logsDir = path.join(workspaceRoot, "logs");
    const { child, output, exited } = startPreloadedWatch(configPath, {
      AGENT_MEMORY_SYNC_TEST_HANG_STAT_AFTER_EXISTS_DIR: logsDir
    });
    try {
      await waitForWatcherReady(() => output.stderr);
      fs.mkdirSync(logsDir);
      await waitForStderr(child, () => output.stderr, /syncPath .*logs appeared, watching it/);
      const { exitCode, elapsed } = await sigtermAndTimeExit(child, exited);
      assert.equal(
        exitCode,
        0,
        `watch did not exit with 0 within 6 s of SIGTERM (got ${exitCode}). stderr: ${output.stderr}`
      );
      assert.ok(
        elapsed < 2500,
        `the wait for the appeared path's watcher must not delay the shutdown, took ${elapsed}ms. stderr: ${output.stderr}`
      );
      assert.doesNotMatch(output.stderr, /is armed/);
    } finally {
      await stopWatchProcessGroup(child);
    }
  }
);

// The probe directory cannot be created (the preload makes mkdtemp of it
// throw), which is a failure to set the probe up and not a timeout: the warning says
// so and names the cause, and the ready line still follows.
test("watch warns with the cause, and still prints its ready line, when the OS watch probe cannot be set up", async () => {
  const { configPath } = setupWorkspace("watch-arming-probe-setup", ["logs"]);
  const { child, output } = startPreloadedWatch(configPath, { AGENT_MEMORY_SYNC_TEST_FAIL_SCRATCH_SETUP: "1" });
  try {
    await withTickDeadline(
      child,
      async () => waitForWatcherReady(() => output.stderr),
      INACTIVITY_TIMEOUT_MS,
      () => output.stderr
    );
  } finally {
    await stopWatchProcessGroup(child);
  }
  assert.match(
    output.stderr,
    /warning: could not check that the operating system file watch is live \(EACCES: scratch directory refused by the test preload\)/
  );
  assert.doesNotMatch(output.stderr, /could not confirm within/);
  assert.ok(
    output.stderr.search(/could not check that/) < output.stderr.search(READY_LINE),
    `the warning must precede the ready line. stderr: ${output.stderr}`
  );
});
