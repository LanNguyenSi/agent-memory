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
