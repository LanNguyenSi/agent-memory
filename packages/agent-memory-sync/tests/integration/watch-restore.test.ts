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

test("watch debounces N rapid changes into a single commit", async () => {
  const root = createSandbox("watch-debounce");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const inspectionBefore = cloneRemote(remoteDir, root, "before");
  const headBefore = git(["rev-parse", "HEAD"], inspectionBefore).trim();

  const child = spawnWatch(
    [
      "watch",
      "default",
      "--config",
      configPath,
      "--debounce-ms",
      "400",
      "--max-runs",
      "1",
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
    await sleep(600);

    for (let i = 0; i < 7; i += 1) {
      writeText(path.join(workspaceRoot, "MEMORY.md"), `change ${i}\n`);
      await sleep(20);
    }

    const exitCode: number = await new Promise((resolve) => {
      child.on("exit", (code: number | null) => resolve(code ?? -1));
    });
    assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGINT");
    }
  }

  const inspectionAfter = cloneRemote(remoteDir, root, "after");
  const log = git(["log", "--oneline", `${headBefore}..HEAD`], inspectionAfter).trim();
  const commitCount = log.length === 0 ? 0 : log.split("\n").length;
  assert.equal(commitCount, 1, `expected exactly 1 new commit, got ${commitCount}:\n${log}`);
  assert.equal(readText(path.join(inspectionAfter, "shared", "MEMORY.md")), "change 6\n");
});

test("watch produces a single-file commit message when only one path changed", async () => {
  const root = createSandbox("watch-msg-single");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

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
      "--output",
      "json"
    ],
    process.env
  );

  try {
    await sleep(500);
    writeText(path.join(workspaceRoot, "MEMORY.md"), "updated\n");

    const exitCode: number = await new Promise((resolve) => {
      child.on("exit", (code: number | null) => resolve(code ?? -1));
    });
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGINT");
    }
  }

  const inspection = cloneRemote(remoteDir, root, "msg-single");
  const subject = git(["log", "-1", "--format=%s"], inspection).trim();
  assert.equal(subject, "update MEMORY.md");
});

test("watch produces an aggregated commit message for multiple file changes", async () => {
  const root = createSandbox("watch-msg-multi");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeText(path.join(workspaceRoot, "logs", "2026-05-01.md"), "log 1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const child = spawnWatch(
    [
      "watch",
      "default",
      "--config",
      configPath,
      "--debounce-ms",
      "400",
      "--max-runs",
      "1",
      "--output",
      "json"
    ],
    process.env
  );

  try {
    await sleep(600);
    writeText(path.join(workspaceRoot, "MEMORY.md"), "updated\n");
    writeText(path.join(workspaceRoot, "logs", "2026-05-01.md"), "log 1 v2\n");
    writeText(path.join(workspaceRoot, "logs", "2026-05-02.md"), "log 2\n");

    const exitCode: number = await new Promise((resolve) => {
      child.on("exit", (code: number | null) => resolve(code ?? -1));
    });
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGINT");
    }
  }

  const inspection = cloneRemote(remoteDir, root, "msg-multi");
  const subject = git(["log", "-1", "--format=%s"], inspection).trim();
  const body = git(["log", "-1", "--format=%b"], inspection).trim();
  assert.match(subject, /^update 3 memories$/);
  assert.match(body, /- update MEMORY\.md/);
  assert.match(body, /- update logs\/2026-05-01\.md/);
  assert.match(body, /- update logs\/2026-05-02\.md/);
});

test("watch records deletions as remove entries", async () => {
  const root = createSandbox("watch-delete");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeText(path.join(workspaceRoot, "logs", "2026-05-01.md"), "log 1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

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
      "--output",
      "json"
    ],
    process.env
  );

  try {
    await sleep(500);
    fs.rmSync(path.join(workspaceRoot, "logs", "2026-05-01.md"));

    const exitCode: number = await new Promise((resolve) => {
      child.on("exit", (code: number | null) => resolve(code ?? -1));
    });
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGINT");
    }
  }

  const inspection = cloneRemote(remoteDir, root, "delete");
  const subject = git(["log", "-1", "--format=%s"], inspection).trim();
  assert.equal(subject, "remove logs/2026-05-01.md");
  assert.equal(fileExists(path.join(inspection, "shared", "logs", "2026-05-01.md")), false);
});

test("restore --path writes a single file byte-identical from a snapshot SHA", () => {
  const root = createSandbox("restore-single");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "snapshot 1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const snapshot1Sha = git(["rev-parse", "HEAD"], cloneRemote(remoteDir, root, "rev1")).trim();

  writeText(path.join(workspaceRoot, "MEMORY.md"), "snapshot 2\n");
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "snapshot 2\n");

  const result = runCli([
    "restore",
    snapshot1Sha,
    "--config",
    configPath,
    "--path",
    "MEMORY.md",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "restore");
  assert.equal(payload.sha, snapshot1Sha);
  assert.equal(payload.restored.length, 1);
  assert.equal(payload.restored[0].remoteRelativePath, "MEMORY.md");

  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "snapshot 1\n");
});

test("restore --yes restores the full snapshot tree", () => {
  const root = createSandbox("restore-full");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v1\n");
  writeText(path.join(workspaceRoot, "logs", "2026-05-01.md"), "log v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const snapshot1Sha = git(["rev-parse", "HEAD"], cloneRemote(remoteDir, root, "rev1")).trim();

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v2\n");
  writeText(path.join(workspaceRoot, "logs", "2026-05-01.md"), "log v2\n");
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const result = runCli([
    "restore",
    snapshot1Sha,
    "--config",
    configPath,
    "--yes",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.restored.length, 2);

  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "v1\n");
  assert.equal(readText(path.join(workspaceRoot, "logs", "2026-05-01.md")), "log v1\n");
});

test("restore without --yes/--path/--dry-run is rejected", () => {
  const root = createSandbox("restore-guard");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const snapshotSha = git(["rev-parse", "HEAD"], cloneRemote(remoteDir, root, "rev1")).trim();

  const result = runCli(
    ["restore", snapshotSha, "--config", configPath, "--output", "json"],
    { expectFailure: true }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --yes/);
});

test("restore --dry-run lists targets without writing", () => {
  const root = createSandbox("restore-dry");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const snapshotSha = git(["rev-parse", "HEAD"], cloneRemote(remoteDir, root, "rev1")).trim();

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v2\n");
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const result = runCli([
    "restore",
    snapshotSha,
    "--config",
    configPath,
    "--dry-run",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.restored.length, 1);

  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "v2\n");
});

test("restore --path rejects path-traversal payloads", () => {
  const root = createSandbox("restore-traversal");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "logs", "2026-05-01.md"), "v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const snapshotSha = git(["rev-parse", "HEAD"], cloneRemote(remoteDir, root, "rev1")).trim();

  for (const payload of ["logs/../../etc/passwd", "../escape.md", "logs//double"]) {
    const result = runCli(
      [
        "restore",
        snapshotSha,
        "--config",
        configPath,
        "--path",
        payload,
        "--output",
        "json"
      ],
      { expectFailure: true }
    );
    assert.notEqual(result.status, 0, `payload '${payload}' should be rejected`);
    assert.match(result.stderr, /invalid|cannot map/i);
  }
});

test("restore rejects an unknown sha with a loud non-zero exit", () => {
  const root = createSandbox("restore-bad-sha");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const result = runCli(
    ["restore", "deadbeef", "--config", configPath, "--yes", "--output", "json"],
    { expectFailure: true }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fetch|deadbeef|not.+exist/i);
});
