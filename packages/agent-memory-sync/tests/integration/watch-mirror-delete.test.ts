// Red-test-first coverage for the watch mirror-delete/blind-overwrite hazard:
// `watch`'s push used to go through `commitAndPushSnapshot`
// (src/memory-sync/snapshot.ts), a whole-subtree MIRROR of this machine's
// local tree. That mirror (a) deleted any remote path under
// `repositorySubdir` missing locally — including a peer machine's file this
// workspace has simply never pulled yet — and (b) blindly overwrote any
// differing remote file with the local version, with no 3-way merge/conflict
// handling. See docs/machine-setup.md's former mirror-delete warnings
// (rolled back by this change) and
// .ai/runs/2026-07-23-watch-mirror-delete/01-plan.md.
//
// The fix routes watch's push through the same base-snapshot-aware
// `performPush` (src/memory-sync/push.ts) that `run --mode sync/push`
// already uses, so watch now gets the same 3-way merge over
// localFiles ∪ baseFiles: a remote-only path (never in this workspace's
// local files or its last-known base snapshot) is never touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  cloneRemote,
  createSandbox,
  fileExists,
  git,
  initBareRemote,
  readText,
  runCli,
  writeProjectConfig,
  writeText
} = require("../helpers/cli.ts");

function createConfig(workspaceRoot: string, remoteDir: string) {
  return {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    syncPaths: [
      { source: "MEMORY.md", destination: "MEMORY.md", kind: "file" },
      { source: "logs", destination: "logs", kind: "directory" }
    ]
  };
}

function spawnWatch(args: string[], env: NodeJS.ProcessEnv) {
  return spawn(
    path.resolve(process.cwd(), "node_modules", ".bin", "tsx"),
    ["src/main.ts", ...args],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );
}

// Matches watch.ts's "watching N path(s) under ..." line, which it now
// prints from chokidar's 'ready' event instead of unconditionally right
// after chokidar.watch() (see src/commands/watch.ts). --verbose is required
// for this line to print at all: writeInfo (src/output.ts) is a no-op
// unless verbose is set — every spawnWatch call in this file passes
// --verbose for that reason, not just for debugging.
const WATCH_READY_PATTERN = /watching \d+ path\(s\) under/;
const READY_TIMEOUT_MS = 10000;
const TICK_TIMEOUT_MS = 20000;

// Polls `getStderr()` until it matches WATCH_READY_PATTERN. Waiting for the
// real "watch is now armed" signal instead of a fixed sleep() before the
// edit that is meant to trigger a tick closes a real race on inotify-backed
// watchers (Linux CI, and CI generally under load): chokidar's initial
// recursive scan of the watched paths is not instantaneous there (unlike
// fsevents on macOS, where local development happens), and a filesystem
// write issued before that scan completes can be silently lost — chokidar
// has not finished wiring up the inotify watch descriptors yet, so the edit
// never produces an 'add'/'change' event, `watch` never ticks, and
// `--max-runs 1` never terminates: the child process — and the `await` on
// its exit below — hangs indefinitely. That is exactly the CI failure this
// helper (plus withTickDeadline below) closes: previously this file relied
// on the same fixed-sleep pattern the pre-existing watch-restore.test.ts
// tests use, which is not immune to this race either — it simply had not
// been observed failing there, which is a matter of luck/load, not a
// structural guarantee, so it was not copied here as-is.
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

// Bounds `fn` (expected to await a spawned watch child reaching some
// end state) to `timeoutMs`: if it has not settled in time, force-kills
// `child` (SIGKILL — this tier exists specifically as a last-resort
// guarantee, not a graceful shutdown) and rejects with a clear message
// instead of hanging. Without this, a watcher-ready race (or any future
// regression with the same shape: a tick that never completes) hangs not
// just this test but the whole CI job — that is exactly what happened here:
// "ci (agent-memory-sync)" ran for ~10 minutes past the last passing
// subtest before being cancelled, orphaning the node/esbuild/watch child
// processes. With this guard the same failure mode is a normal failing
// assertion in well under a minute.
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

// Spawns `watch --max-runs 1`, waits for its "watching ..." ready line,
// applies the local filesystem edit(s) via `triggerEdit`, then waits for the
// single tick to complete and the process to exit — the whole sequence
// bounded by withTickDeadline.
async function runWatchTick(
  configPath: string,
  triggerEdit: () => void
): Promise<{ exitCode: number; stderr: string }> {
  const child = spawnWatch(
    [
      "watch",
      "default",
      "--config",
      configPath,
      "--debounce-ms",
      "300",
      "--max-runs",
      "1",
      "--verbose",
      "--output",
      "json"
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
      triggerEdit();

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

test("watch tick does not delete a peer file that was pushed to the remote but never pulled locally", async () => {
  const root = createSandbox("watch-mirror-delete-peer");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // Simulate a peer machine that pushed a file this workspace has never
  // pulled (workspaceRoot has no `logs/` directory locally at all yet).
  const peerCheckout = cloneRemote(remoteDir, root, "peer");
  writeText(path.join(peerCheckout, "shared", "logs", "peer-only.md"), "peer note\n");
  git(["add", "."], peerCheckout);
  git(["commit", "-m", "peer note"], peerCheckout);
  git(["push", "origin", "HEAD:main"], peerCheckout);

  const { exitCode, stderr } = await runWatchTick(configPath, () => {
    writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\nlocal edit\n");
  });
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);

  const inspection = cloneRemote(remoteDir, root, "inspect-peer-survives");
  assert.equal(
    fileExists(path.join(inspection, "shared", "logs", "peer-only.md")),
    true,
    "watch tick deleted a peer file this workspace never pulled"
  );
  assert.equal(readText(path.join(inspection, "shared", "logs", "peer-only.md")), "peer note\n");
  assert.equal(readText(path.join(inspection, "shared", "MEMORY.md")), "seed\nlocal edit\n");
});

test("watch tick applies inline conflict markers instead of blindly overwriting a concurrently-changed remote file", async () => {
  const root = createSandbox("watch-mirror-blind-overwrite");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // A concurrent, non-append remote edit (full replace, so it cannot merge
  // as a clean append-only union) from a peer machine.
  const remoteCheckout = cloneRemote(remoteDir, root, "concurrent-remote");
  writeText(path.join(remoteCheckout, "shared", "MEMORY.md"), "remote replaced\n");
  git(["add", "."], remoteCheckout);
  git(["commit", "-m", "remote replaced"], remoteCheckout);
  git(["push", "origin", "HEAD:main"], remoteCheckout);

  const { exitCode, stderr } = await runWatchTick(configPath, () => {
    writeText(path.join(workspaceRoot, "MEMORY.md"), "local replaced\n");
  });
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);

  const inspection = cloneRemote(remoteDir, root, "inspect-conflict");
  const content = readText(path.join(inspection, "shared", "MEMORY.md"));
  assert.match(content, /<<<<<<< local/);
  assert.match(content, /local replaced/);
  assert.match(content, /=======/);
  assert.match(content, /remote replaced/);
  assert.match(content, />>>>>>> remote/);
});

test("watch tick still deletes locally-removed files and pushes local edits, without touching an unrelated peer file", async () => {
  const root = createSandbox("watch-mirror-negative-control");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeText(path.join(workspaceRoot, "logs", "mine.md"), "mine v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const peerCheckout = cloneRemote(remoteDir, root, "peer-nc");
  writeText(path.join(peerCheckout, "shared", "logs", "peer.md"), "peer note\n");
  git(["add", "."], peerCheckout);
  git(["commit", "-m", "peer note"], peerCheckout);
  git(["push", "origin", "HEAD:main"], peerCheckout);

  const { exitCode, stderr } = await runWatchTick(configPath, () => {
    writeText(path.join(workspaceRoot, "MEMORY.md"), "base\nupdated\n");
    fs.rmSync(path.join(workspaceRoot, "logs", "mine.md"));
  });
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);

  const inspection = cloneRemote(remoteDir, root, "inspect-negative-control");
  assert.equal(readText(path.join(inspection, "shared", "MEMORY.md")), "base\nupdated\n");
  assert.equal(fileExists(path.join(inspection, "shared", "logs", "mine.md")), false);
  assert.equal(fileExists(path.join(inspection, "shared", "logs", "peer.md")), true);
  assert.equal(readText(path.join(inspection, "shared", "logs", "peer.md")), "peer note\n");
});

// Rework finding (MEDIUM, review of this task): the queued-instead-of-fail-loud
// path (performPush's reachability precheck / offline queue, now shared by
// watch — see the "pushSnapshot" comment in src/commands/watch.ts) had no
// direct coverage. This pins the whole lifecycle through `watch` itself: an
// unreachable remote is a clean, non-throwing, --verbose-logged queue (exit
// 0, stateDir/queue non-empty), and a later tick against a reachable remote
// replays that queued snapshot before applying its own new local change.
test("watch tick queues locally when the remote is unreachable, then replays the queue once the remote is reachable again", async () => {
  const root = createSandbox("watch-queue-replay");
  const actualRemoteDir = initBareRemote(root);
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const queueDir = path.join(workspaceRoot, ".agent-memory-sync", "default", "queue");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeProjectConfig(configPath, {
    ...createConfig(workspaceRoot, offlineRemoteDir),
    // offlineRemoteDir is a local path, so reachability is a plain fs check
    // either way; keep the precheck timeout small regardless.
    reachabilityTimeoutMs: 500
  });

  // --verbose is required to see the queued-locally note (and the ready
  // line below) at all: writeInfo (src/output.ts) is a no-op unless verbose
  // is set.
  const offlineChild = spawnWatch(
    [
      "watch",
      "default",
      "--config",
      configPath,
      "--debounce-ms",
      "300",
      "--max-runs",
      "1",
      "--verbose",
      "--output",
      "json"
    ],
    process.env
  );
  let offlineStderr = "";
  offlineChild.stderr.on("data", (chunk: Buffer) => {
    offlineStderr += chunk.toString("utf8");
  });

  const offlineExitCode = await withTickDeadline(offlineChild, async () => {
    await waitForWatcherReady(() => offlineStderr);
    writeText(path.join(workspaceRoot, "MEMORY.md"), "queued change\n");

    return new Promise<number>((resolve) => {
      offlineChild.on("exit", (code: number | null) => resolve(code ?? -1));
    });
  }).finally(() => {
    if (offlineChild.exitCode === null && offlineChild.signalCode === null) {
      offlineChild.kill("SIGINT");
    }
  });

  assert.equal(offlineExitCode, 0, `watch exited non-zero while offline. stderr: ${offlineStderr}`);
  assert.match(offlineStderr, /queued locally/);
  assert.ok(fs.existsSync(queueDir), "expected stateDir/queue to exist after an offline tick");
  const queuedAfterOffline = fs.readdirSync(queueDir);
  assert.equal(
    queuedAfterOffline.length,
    1,
    `expected exactly one queued snapshot, found: ${queuedAfterOffline.join(", ")}`
  );

  // Point the same profile/stateDir at the real remote, then fire a second
  // tick via a NEW local edit — watch never ticks on its own, and this edit
  // targets a different file than the queued one so this tick's own
  // "current" snapshot cannot collide with the just-replayed queued content.
  writeProjectConfig(configPath, createConfig(workspaceRoot, actualRemoteDir));

  const onlineChild = spawnWatch(
    [
      "watch",
      "default",
      "--config",
      configPath,
      "--debounce-ms",
      "300",
      "--max-runs",
      "1",
      "--verbose",
      "--output",
      "json"
    ],
    process.env
  );
  let onlineStderr = "";
  onlineChild.stderr.on("data", (chunk: Buffer) => {
    onlineStderr += chunk.toString("utf8");
  });

  const onlineExitCode = await withTickDeadline(onlineChild, async () => {
    await waitForWatcherReady(() => onlineStderr);
    writeText(path.join(workspaceRoot, "logs", "trigger.md"), "trigger\n");

    return new Promise<number>((resolve) => {
      onlineChild.on("exit", (code: number | null) => resolve(code ?? -1));
    });
  }).finally(() => {
    if (onlineChild.exitCode === null && onlineChild.signalCode === null) {
      onlineChild.kill("SIGINT");
    }
  });

  assert.equal(onlineExitCode, 0, `watch exited non-zero while replaying. stderr: ${onlineStderr}`);
  assert.deepEqual(fs.readdirSync(queueDir), [], "expected the queue to be empty after a successful replay");

  const inspection = cloneRemote(actualRemoteDir, root, "inspect-replay");
  assert.equal(
    readText(path.join(inspection, "shared", "MEMORY.md")),
    "queued change\n",
    "the queued snapshot did not land on the remote after the replay tick"
  );
  assert.equal(readText(path.join(inspection, "shared", "logs", "trigger.md")), "trigger\n");
});

// Rework finding (LOW, review of this task): pins that a successful tick
// updates stateDir/base to the post-merge remote state — the input the next
// tick's 3-way merge relies on to correctly leave an unpulled peer file
// alone (see the first test in this file) and to detect real conflicts
// rather than either false-positive or false-negative them.
test("watch tick updates the local base snapshot to the post-merge remote content", async () => {
  const root = createSandbox("watch-base-snapshot-update");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  const { exitCode, stderr } = await runWatchTick(configPath, () => {
    writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\nupdated\n");
  });
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);

  const baseFile = path.join(workspaceRoot, ".agent-memory-sync", "default", "base", "MEMORY.md");
  const baseMeta = JSON.parse(readText(`${baseFile}.meta.json`));
  assert.equal(readText(baseFile), "seed\nupdated\n");
  assert.equal(baseMeta.deleted, false);
});
