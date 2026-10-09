// A conflict is resolved by a person in the local file, never on the hub.
// Neither `run --mode sync`, `run --mode push` nor a watch tick publishes a
// file that carries conflict markers, and a path whose three-way merge could
// only produce markers is not published either: the hub keeps its current
// content for it, the path is reported as a conflict and named in a note, and
// the base entry stays where it was.
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const {
  cloneRemote,
  createSandbox,
  git,
  initBareRemote,
  readText,
  runCli,
  writeProjectConfig,
  writeText
} = require("../helpers/cli.ts");
const { runWatchTick } = require("../helpers/watch-process.ts");
const { StateStore } = require("../../src/memory-sync/state-store");

interface Spoke {
  name: string;
  workspace: string;
  stateDir: string;
  configPath: string;
}

function createSpoke(root: string, remoteDir: string, name: string): Spoke {
  const workspace = path.join(root, `workspace-${name}`);
  const stateDir = path.join(root, `state-${name}`);
  const configPath = path.join(root, `config-${name}.json`);
  mkdirSync(path.join(workspace, "notes"), { recursive: true });
  writeProjectConfig(configPath, {
    profile: name,
    rootDir: workspace,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: [{ source: path.join(workspace, "notes"), destination: "notes", kind: "directory" }]
  });
  return { name, workspace, stateDir, configPath };
}

function runMode(spoke: Spoke, mode: string, extra: string[] = []) {
  const result = runCli(["run", spoke.name, "--config", spoke.configPath, "--mode", mode, "--output", "json", ...extra]);
  return JSON.parse(result.stdout).runs[0];
}

function notePath(spoke: Spoke, name: string): string {
  return path.join(spoke.workspace, "notes", name);
}

function readHub(root: string, remoteDir: string, relativePath: string): string | null {
  const checkout = path.join(root, `hub-read-${Math.random().toString(16).slice(2, 8)}`);
  git(["clone", "--quiet", remoteDir, checkout], root);
  const file = path.join(checkout, "shared", relativePath);
  return existsSync(file) ? readText(file) : null;
}

function hubCommitCount(root: string, remoteDir: string): number {
  const checkout = path.join(root, `hub-count-${Math.random().toString(16).slice(2, 8)}`);
  git(["clone", "--quiet", remoteDir, checkout], root);
  return Number(git(["rev-list", "--count", "HEAD"], checkout).trim());
}

function readBase(spoke: Spoke): Record<string, string | null> {
  return new StateStore(spoke.stateDir, spoke.name).readBaseSnapshots();
}

function peerReplaces(root: string, remoteDir: string, relativePath: string, content: string) {
  const peer = cloneRemote(remoteDir, root, `peer-${Math.random().toString(16).slice(2, 8)}`);
  writeText(path.join(peer, "shared", relativePath), content);
  git(["add", "."], peer);
  git(["commit", "-m", "peer replaces"], peer);
  git(["push", "origin", "HEAD:main"], peer);
}

const MARKERED = "<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> remote\n";

test("a sync whose pull conflicts leaves the hub byte-identical and reports the conflict", () => {
  const root = createSandbox("conflict-stays-local-sync");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  assert.equal(runMode(s, "push").status, "applied");

  peerReplaces(root, remoteDir, "notes/H.md", "remote v2\n");
  writeText(notePath(s, "H.md"), "local v2\n");
  const commitsBefore = hubCommitCount(root, remoteDir);

  const result = runCli(["run", s.name, "--config", s.configPath, "--mode", "sync"], { expectFailure: true });
  assert.equal(result.status, 0, `a conflict keeps the exit code of the conflict path: ${result.stderr}`);
  assert.match(result.stdout, /conflicts=1/);
  assert.match(result.stdout, /notes=[^\n]*notes\/H\.md/, "a note must name the held-back path");

  assert.equal(readHub(root, remoteDir, "notes/H.md"), "remote v2\n", "the hub content must not change");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "no commit may reach the hub");
  const local = readText(notePath(s, "H.md"));
  assert.match(local, /<<<<<<< local/);
  assert.match(local, /local v2/);
  assert.match(local, /remote v2/);
});

test("a held-back path keeps its base entry and stays held back on every later push", () => {
  const root = createSandbox("conflict-stays-local-base");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  assert.equal(runMode(s, "push").status, "applied");
  peerReplaces(root, remoteDir, "notes/H.md", "remote v2\n");
  writeText(notePath(s, "H.md"), "local v2\n");
  runMode(s, "pull");
  const baseAfterPull = readBase(s)["notes/H.md"];

  const commitsBefore = hubCommitCount(root, remoteDir);
  for (let round = 0; round < 2; round += 1) {
    const push = runMode(s, "push");
    assert.deepEqual(push.conflictFiles, ["notes/H.md"]);
    assert.equal(push.appliedFiles.includes("notes/H.md"), false);
    assert.ok(push.notes.some((note: string) => note.includes("notes/H.md")), JSON.stringify(push.notes));
    assert.equal(readBase(s)["notes/H.md"], baseAfterPull, "the base entry must not move");
    assert.equal(readHub(root, remoteDir, "notes/H.md"), "remote v2\n");
  }
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore);
});

test("a local file that carries markers is not published by push, and a clean edit publishes again", () => {
  const root = createSandbox("conflict-stays-local-markered");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  writeText(notePath(s, "K.md"), "k0\n");
  assert.equal(runMode(s, "push").status, "applied");

  writeText(notePath(s, "H.md"), MARKERED);
  writeText(notePath(s, "K.md"), "k1\n");
  const held = runMode(s, "push");
  assert.equal(held.status, "applied");
  assert.deepEqual(held.conflictFiles, ["notes/H.md"]);
  assert.ok(held.notes.some((note: string) => note.includes("notes/H.md")));
  assert.equal(readHub(root, remoteDir, "notes/H.md"), "base\n");
  assert.equal(readHub(root, remoteDir, "notes/K.md"), "k1\n", "an unrelated clean file still publishes");
  assert.equal(readBase(s)["notes/H.md"], "base\n");

  writeText(notePath(s, "H.md"), "resolved\n");
  const released = runMode(s, "push");
  assert.deepEqual(released.conflictFiles, []);
  assert.equal(readHub(root, remoteDir, "notes/H.md"), "resolved\n");
  assert.equal(readBase(s)["notes/H.md"], "resolved\n");
});

test("a dry-run reports the held-back path and publishes nothing", () => {
  const root = createSandbox("conflict-stays-local-dry-run");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  assert.equal(runMode(s, "push").status, "applied");
  writeText(notePath(s, "H.md"), MARKERED);

  const preview = runMode(s, "push", ["--dry-run"]);
  assert.equal(preview.status, "dry-run");
  assert.deepEqual(preview.conflictFiles, ["notes/H.md"]);
  assert.equal(preview.appliedFiles.includes("notes/H.md"), false);
  assert.ok(preview.notes.some((note: string) => note.includes("notes/H.md")));
  assert.equal(readHub(root, remoteDir, "notes/H.md"), "base\n");
});

test("a queued snapshot whose file carries markers stays held back on replay", () => {
  const root = createSandbox("conflict-stays-local-replay");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  assert.equal(runMode(s, "push").status, "applied");

  const config = JSON.parse(readText(s.configPath));
  const online = { ...config };
  writeProjectConfig(s.configPath, { ...config, remoteUrl: path.join(root, "missing-remote.git") });
  writeText(notePath(s, "H.md"), MARKERED);
  assert.equal(runMode(s, "push").status, "queued");

  writeProjectConfig(s.configPath, online);
  const replay = runMode(s, "push");
  assert.equal(replay.status, "applied");
  assert.deepEqual(replay.conflictFiles, ["notes/H.md"]);
  assert.equal(readHub(root, remoteDir, "notes/H.md"), "base\n");
});

function createWatchConfig(workspaceRoot: string, remoteDir: string) {
  return {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    syncPaths: [{ source: "MEMORY.md", destination: "MEMORY.md", kind: "file" }]
  };
}

test("a watch tick does not publish a file that carries markers, and a later clean edit publishes", async () => {
  const root = createSandbox("conflict-stays-local-watch");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
  writeProjectConfig(configPath, createWatchConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const held = await runWatchTick(configPath, () => {
    writeText(path.join(workspaceRoot, "MEMORY.md"), MARKERED);
  });
  assert.equal(held.exitCode, 0, `watch exited non-zero. stderr: ${held.stderr}`);
  assert.equal(readHub(root, remoteDir, "MEMORY.md"), "base\n");

  const released = await runWatchTick(configPath, () => {
    writeText(path.join(workspaceRoot, "MEMORY.md"), "resolved\n");
  });
  assert.equal(released.exitCode, 0, `watch exited non-zero. stderr: ${released.stderr}`);
  assert.equal(readHub(root, remoteDir, "MEMORY.md"), "resolved\n");
});
