// `restore <profile> <destination>` from a hub commit or from a local
// pre-apply snapshot (AC-007 of the 2026-09-11 wipe, agent-tasks cda5b12c,
// pandora run .ai/runs/2026-09-11-memory-sync-wipe).
//
// The older form, `restore <sha>` with --path/--yes, writes single files or
// a whole snapshot tree and is covered in watch-restore.test.ts. This file
// covers the destination-shaped form the incident needed: bring one sync
// destination back to what it was, either from a commit that still had it or
// from the copy the run that removed it took first, and leave the base
// snapshot in the state that makes the next push publish the recovered files
// rather than delete them again.
const test = require("node:test");
const assert = require("node:assert/strict");
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

function createConfig(workspaceRoot: string, remoteDir: string, extra: Record<string, unknown> = {}) {
  return {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    syncPaths: [
      { source: "MEMORY.md", destination: "MEMORY.md", kind: "file" },
      { source: "logs", destination: "logs", kind: "directory" }
    ],
    ...extra
  };
}

function seedLogFiles(workspaceRoot: string, count: number): string[] {
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = `note-${String(index).padStart(3, "0")}.md`;
    writeText(path.join(workspaceRoot, "logs", name), `entry ${index}\n`);
    names.push(path.join("logs", name));
  }
  return names;
}

function peerDeletes(remoteDir: string, root: string, label: string, names: string[]): void {
  const checkout = cloneRemote(remoteDir, root, label);
  for (const name of names) {
    fs.rmSync(path.join(checkout, "shared", name));
  }
  git(["add", "-A"], checkout);
  git(["commit", "-m", `peer removes ${names.length} file(s)`], checkout);
  git(["push", "origin", "HEAD:main"], checkout);
}

function remoteLogFileCount(remoteDir: string, root: string, label: string): number {
  const inspection = cloneRemote(remoteDir, root, label);
  const logsDir = path.join(inspection, "shared", "logs");
  return fs.existsSync(logsDir) ? fs.readdirSync(logsDir).length : 0;
}

// The escape matrix's recovery leg: the remote dropped 30 of 50 files, every
// mode is refusing at exit 7, and the operator wants the files back rather
// than gone. Restoring from the last good commit has to leave the workspace
// AND the base snapshot in a state where the very next push republishes
// them, which means the base has to move to the CURRENT remote tree, not to
// the restored one.
test("restore --from-commit brings a destination back and the next push republishes it (AC-007)", () => {
  const root = createSandbox("restore-from-commit");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, 50);
  // Bytes a re-encoding round trip would not survive unnoticed.
  writeText(path.join(workspaceRoot, seeded[0]), "entry 0\r\numlauts äöü\nno trailing newline");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const goodCheckout = cloneRemote(remoteDir, root, "good");
  const goodSha = git(["rev-parse", "HEAD"], goodCheckout).trim();
  const originalBytes = fs.readFileSync(path.join(workspaceRoot, seeded[0]));

  peerDeletes(remoteDir, root, "peer", seeded.slice(0, 30).map((p) => p.replace(/\\/g, "/")));

  // Wedged, exactly as the review measured it.
  const wedged = runCli(
    ["run", "default", "--config", configPath, "--mode", "sync", "--output", "json"],
    { expectFailure: true }
  );
  assert.equal(wedged.status, 7);

  const restored = runCli([
    "restore",
    "default",
    "logs",
    "--config",
    configPath,
    "--from-commit",
    goodSha,
    "--output",
    "json"
  ]);
  const payload = JSON.parse(restored.stdout);

  assert.equal(payload.command, "restore");
  assert.equal(payload.destination, "logs");
  assert.equal(payload.source.kind, "commit");
  assert.equal(payload.source.commit, goodSha);
  assert.equal(payload.restored.length, 50);

  // Byte for byte, including the file whose bytes are not a plain ASCII line.
  assert.deepEqual(fs.readFileSync(path.join(workspaceRoot, seeded[0])), originalBytes);
  for (let index = 1; index < 50; index += 1) {
    assert.equal(readText(path.join(workspaceRoot, seeded[index])), `entry ${index}\n`);
  }

  // The tree it replaced was copied first.
  const snapshotDir = path.join(workspaceRoot, ".agent-memory-sync", "default", "snapshots", "logs");
  assert.equal(fs.readdirSync(snapshotDir).length, 1);

  // And the next ordinary run publishes the recovered files as additions
  // rather than refusing again or deleting them a second time.
  const pushed = runCli(["run", "default", "--config", configPath, "--mode", "sync", "--output", "json"]);
  assert.equal(pushed.status, 0, `stderr: ${pushed.stderr}`);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-after-restore"), 50);

  const inspection = cloneRemote(remoteDir, root, "inspect-bytes");
  assert.deepEqual(fs.readFileSync(path.join(inspection, "shared", seeded[0])), originalBytes);
});

test("restore --from-snapshot reproduces the tree the accepting run copied (AC-007)", () => {
  const root = createSandbox("restore-from-snapshot");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, 50);
  writeText(path.join(workspaceRoot, seeded[0]), "entry 0\r\numlauts äöü\nno trailing newline");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const originalBytes = fs.readFileSync(path.join(workspaceRoot, seeded[0]));
  peerDeletes(remoteDir, root, "peer-snap", seeded.slice(0, 30).map((p) => p.replace(/\\/g, "/")));

  // The operator accepts the deletion, then finds out it was not what they
  // wanted after all. This is the case the snapshot exists for.
  runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "sync",
    "--accept-mass-delete",
    "--output",
    "json"
  ]);
  assert.equal(fileExists(path.join(workspaceRoot, seeded[0])), false);

  const restored = runCli([
    "restore",
    "default",
    "logs",
    "--config",
    configPath,
    "--from-snapshot",
    "latest",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(restored.stdout);

  assert.equal(payload.source.kind, "snapshot");
  assert.equal(payload.restored.length, 50);
  assert.deepEqual(fs.readFileSync(path.join(workspaceRoot, seeded[0])), originalBytes);
  for (let index = 1; index < 50; index += 1) {
    assert.equal(readText(path.join(workspaceRoot, seeded[index])), `entry ${index}\n`);
  }

  // The base snapshot is untouched by a snapshot restore, which is what
  // makes the recovered files local-only additions on the next push.
  const pushed = runCli(["run", "default", "--config", configPath, "--mode", "sync", "--output", "json"]);
  assert.equal(pushed.status, 0, `stderr: ${pushed.stderr}`);
  assert.equal(remoteLogFileCount(remoteDir, root, "inspect-after-snapshot-restore"), 50);
});

test("restore --from-snapshot takes an explicit generation id (AC-007)", () => {
  const root = createSandbox("restore-snapshot-id");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  const seeded = seedLogFiles(workspaceRoot, 6);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  peerDeletes(remoteDir, root, "peer-id-1", [seeded[0].replace(/\\/g, "/")]);
  runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const firstId = fs
    .readdirSync(path.join(workspaceRoot, ".agent-memory-sync", "default", "snapshots", "logs"))
    .sort()[0];

  peerDeletes(remoteDir, root, "peer-id-2", [seeded[1].replace(/\\/g, "/")]);
  runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);

  // The older generation still holds both files; the newer one does not.
  const restored = runCli([
    "restore",
    "default",
    "logs",
    "--config",
    configPath,
    "--from-snapshot",
    firstId,
    "--output",
    "json"
  ]);
  assert.equal(JSON.parse(restored.stdout).source.snapshot, firstId);
  assert.equal(readText(path.join(workspaceRoot, seeded[0])), "entry 0\n");
  assert.equal(readText(path.join(workspaceRoot, seeded[1])), "entry 1\n");
});

test("restore replaces the destination rather than merging into it (AC-007)", () => {
  const root = createSandbox("restore-exact");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  seedLogFiles(workspaceRoot, 3);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const inspection = cloneRemote(remoteDir, root, "sha");
  const sha = git(["rev-parse", "HEAD"], inspection).trim();

  // Local state that the commit does not have: a file added since, and an
  // edit to one it does have.
  writeText(path.join(workspaceRoot, "logs", "added-since.md"), "added since\n");
  writeText(path.join(workspaceRoot, "logs", "note-000.md"), "edited since\n");
  // A file in ANOTHER destination, which this restore must not touch.
  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root edited\n");

  const restored = runCli([
    "restore",
    "default",
    "logs",
    "--config",
    configPath,
    "--from-commit",
    sha,
    "--output",
    "json"
  ]);
  const payload = JSON.parse(restored.stdout);

  assert.deepEqual(payload.removed, ["logs/added-since.md"]);
  assert.equal(fileExists(path.join(workspaceRoot, "logs", "added-since.md")), false);
  assert.equal(readText(path.join(workspaceRoot, "logs", "note-000.md")), "entry 0\n");
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "memory root edited\n");

  // Everything it replaced is in the snapshot it took first, including the
  // file it removed.
  const snapshotDir = path.join(workspaceRoot, ".agent-memory-sync", "default", "snapshots", "logs");
  const generation = fs.readdirSync(snapshotDir)[0];
  const files = path.join(snapshotDir, generation, "files", "logs");
  assert.equal(readText(path.join(files, "added-since.md")), "added since\n");
  assert.equal(readText(path.join(files, "note-000.md")), "edited since\n");
});

test("restore rejects a destination no syncPaths entry configures", () => {
  const root = createSandbox("restore-unknown-destination");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  seedLogFiles(workspaceRoot, 2);
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const inspection = cloneRemote(remoteDir, root, "sha-unknown");
  const sha = git(["rev-parse", "HEAD"], inspection).trim();

  const result = runCli(
    ["restore", "default", "elsewhere", "--config", configPath, "--from-commit", sha, "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(result.status, 3, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /elsewhere/);
  assert.match(result.stderr, /logs/);
});

test("restore rejects both sources at once and a missing destination", () => {
  const root = createSandbox("restore-usage");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  const both = runCli(
    [
      "restore",
      "default",
      "logs",
      "--config",
      configPath,
      "--from-commit",
      "abc1234",
      "--from-snapshot",
      "latest"
    ],
    { expectFailure: true }
  );
  assert.equal(both.status, 2, `stderr: ${both.stderr}`);

  const noDestination = runCli(
    ["restore", "default", "--config", configPath, "--from-snapshot", "latest"],
    { expectFailure: true }
  );
  assert.equal(noDestination.status, 2, `stderr: ${noDestination.stderr}`);
  assert.match(noDestination.stderr, /destination/);
});
