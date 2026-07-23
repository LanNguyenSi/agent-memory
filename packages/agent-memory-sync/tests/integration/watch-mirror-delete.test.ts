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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Spawns `watch --max-runs 1`, waits for it to settle, applies the local
// filesystem edit(s) via `triggerEdit`, then waits for the single tick to
// complete and the process to exit.
async function runWatchTick(
  configPath: string,
  triggerEdit: () => void
): Promise<{ exitCode: number; stderr: string }> {
  const child = spawnWatch(
    ["watch", "default", "--config", configPath, "--debounce-ms", "300", "--max-runs", "1", "--output", "json"],
    process.env
  );

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await sleep(500);
    triggerEdit();

    const exitCode: number = await new Promise((resolve) => {
      child.on("exit", (code: number | null) => resolve(code ?? -1));
    });
    return { exitCode, stderr };
  } finally {
    if (child.exitCode === null) {
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

  // --verbose is required to see the queued-locally note at all: writeInfo
  // (src/output.ts) is a no-op unless verbose is set.
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

  await sleep(500);
  writeText(path.join(workspaceRoot, "MEMORY.md"), "queued change\n");

  const offlineExitCode: number = await new Promise((resolve) => {
    offlineChild.on("exit", (code: number | null) => resolve(code ?? -1));
  });
  if (offlineChild.exitCode === null) {
    offlineChild.kill("SIGINT");
  }

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

  await sleep(500);
  writeText(path.join(workspaceRoot, "logs", "trigger.md"), "trigger\n");

  const onlineExitCode: number = await new Promise((resolve) => {
    onlineChild.on("exit", (code: number | null) => resolve(code ?? -1));
  });
  if (onlineChild.exitCode === null) {
    onlineChild.kill("SIGINT");
  }

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
