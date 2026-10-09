// A conflict is resolved by a person in the local file, never on the hub.
// Neither `run --mode sync`, `run --mode push` nor a watch tick publishes a
// file that carries conflict markers, and a path whose three-way merge could
// only produce markers is not published either: the hub keeps its current
// content for it, the path is reported as a conflict and named in a note, and
// the base entry stays where it was.
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, rmSync } = require("node:fs");
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

function createSpoke(
  root: string,
  remoteDir: string,
  name: string,
  conflictStrategy: "inline-markers" | "local-wins" | "remote-wins" = "inline-markers"
): Spoke {
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
    conflictStrategy,
    syncPaths: [{ source: path.join(workspace, "notes"), destination: "notes", kind: "directory" }]
  });
  return { name, workspace, stateDir, configPath };
}

function runMode(spoke: Spoke, mode: string, extra: string[] = []) {
  const result = runCli([
    "run",
    spoke.name,
    "--config",
    spoke.configPath,
    "--mode",
    mode,
    "--output",
    "json",
    ...extra
  ]);
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
    assert.ok(
      push.notes.some((note: string) => note.includes("notes/H.md")),
      JSON.stringify(push.notes)
    );
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
  assert.match(
    held.stderr,
    /watch tick produced no remote changes; 1 conflict\(s\) held back: MEMORY\.md/,
    "the tick line names the held-back count and path"
  );

  const released = await runWatchTick(configPath, () => {
    writeText(path.join(workspaceRoot, "MEMORY.md"), "resolved\n");
  });
  assert.doesNotMatch(released.stderr, /held back/, "a tick that holds nothing back says nothing about it");
  assert.equal(released.exitCode, 0, `watch exited non-zero. stderr: ${released.stderr}`);
  assert.equal(readHub(root, remoteDir, "MEMORY.md"), "resolved\n");
});

// The hold-back note says what to do, and the step differs by reason. A
// push-only run never writes the hub version into the local file, so telling
// the operator to "resolve the local file" is wrong for a merge conflict whose
// local file is clean, for a hub copy that carries the markers, and for a
// local deletion.
const RECOVERY_A =
  "pull or sync to bring the hub version into the local file, resolve the conflict markers it writes, then push again";
const RECOVERY_B = "Resolve the conflict markers in the local file, then push again";
const RECOVERY_C = "Repair the hub copy (commit a clean version to the hub), then sync again";
const RECOVERY_D =
  "The local deletion was not published because the hub version changed; pull to see the hub version, then delete again or keep it";
const KEEPS = "the hub keeps its current content";

function heldNote(run: { notes: string[] }, relativePath: string): string {
  const notes = run.notes.filter((note: string) => note.includes(relativePath));
  assert.equal(notes.length, 1, `exactly one note names ${relativePath}: ${JSON.stringify(run.notes)}`);
  return notes[0];
}

function assertOnlyRecovery(note: string, expected: string) {
  for (const recovery of [RECOVERY_A, RECOVERY_B, RECOVERY_C, RECOVERY_D]) {
    assert.equal(note.includes(recovery), recovery === expected, `${JSON.stringify(note)} vs ${recovery}`);
  }
  assert.ok(note.includes(KEEPS), note);
}

test("note (a): a push-only merge conflict with a clean local file says to pull or sync first", () => {
  const root = createSandbox("conflict-note-a");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  assert.equal(runMode(s, "push").status, "applied");
  peerReplaces(root, remoteDir, "notes/H.md", "remote v2\n");
  writeText(notePath(s, "H.md"), "local v2\n");

  const push = runMode(s, "push");
  assert.deepEqual(push.conflictFiles, ["notes/H.md"]);
  assertOnlyRecovery(heldNote(push, "notes/H.md"), RECOVERY_A);
  assert.equal(readText(notePath(s, "H.md")), "local v2\n", "push never touches the local file");
});

test("note (b): a local file that carries markers says to resolve the local file", () => {
  const root = createSandbox("conflict-note-b");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  assert.equal(runMode(s, "push").status, "applied");
  writeText(notePath(s, "H.md"), MARKERED);

  const push = runMode(s, "push");
  assert.deepEqual(push.conflictFiles, ["notes/H.md"]);
  assertOnlyRecovery(heldNote(push, "notes/H.md"), RECOVERY_B);
});

test("note (c): a hub copy that carries markers says to repair the hub copy", () => {
  const root = createSandbox("conflict-note-c");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  assert.equal(runMode(s, "push").status, "applied");
  peerReplaces(root, remoteDir, "notes/H.md", MARKERED);
  writeText(notePath(s, "H.md"), "base\nlocal append\n");

  const push = runMode(s, "push");
  assert.deepEqual(push.conflictFiles, ["notes/H.md"]);
  assertOnlyRecovery(heldNote(push, "notes/H.md"), RECOVERY_C);
  assert.equal(readHub(root, remoteDir, "notes/H.md"), MARKERED);
});

test("note (d): a local deletion against a hub edit says the deletion was not published", () => {
  const root = createSandbox("conflict-note-d");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  writeText(notePath(s, "K.md"), "k0\n");
  assert.equal(runMode(s, "push").status, "applied");
  peerReplaces(root, remoteDir, "notes/H.md", "remote v2\n");
  rmSync(notePath(s, "H.md"));
  const commitsBefore = hubCommitCount(root, remoteDir);

  const push = runMode(s, "push");
  assert.deepEqual(push.conflictFiles, ["notes/H.md"]);
  assertOnlyRecovery(heldNote(push, "notes/H.md"), RECOVERY_D);
  assert.equal(readHub(root, remoteDir, "notes/H.md"), "remote v2\n");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore);
});

test("a dry-run carries the same per-case wording", () => {
  const root = createSandbox("conflict-note-dry-run");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  assert.equal(runMode(s, "push").status, "applied");
  peerReplaces(root, remoteDir, "notes/H.md", "remote v2\n");
  writeText(notePath(s, "H.md"), "local v2\n");

  const preview = runMode(s, "push", ["--dry-run"]);
  assert.deepEqual(preview.conflictFiles, ["notes/H.md"]);
  assertOnlyRecovery(heldNote(preview, "notes/H.md"), RECOVERY_A);
});

test("under remote-wins a local file that carries markers is held back with the local-file wording", () => {
  const root = createSandbox("conflict-remote-wins-markered");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s", "remote-wins");
  writeText(notePath(s, "H.md"), "base\n");
  assert.equal(runMode(s, "push").status, "applied");
  peerReplaces(root, remoteDir, "notes/H.md", "remote v2\n");
  writeText(notePath(s, "H.md"), MARKERED);
  const commitsBefore = hubCommitCount(root, remoteDir);

  const push = runMode(s, "push");
  assert.deepEqual(push.conflictFiles, ["notes/H.md"]);
  assertOnlyRecovery(heldNote(push, "notes/H.md"), RECOVERY_B);
  assert.equal(readHub(root, remoteDir, "notes/H.md"), "remote v2\n");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "no commit may reach the hub");
});

test("a queued clean edit whose replay conflicts with a newer hub version is held back, drains, and publishes nothing later", () => {
  const root = createSandbox("conflict-queued-replay");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  writeText(notePath(s, "K.md"), "k0\n");
  assert.equal(runMode(s, "push").status, "applied");

  const config = JSON.parse(readText(s.configPath));
  const online = { ...config };
  writeProjectConfig(s.configPath, { ...config, remoteUrl: path.join(root, "missing-remote.git") });
  writeText(notePath(s, "H.md"), "offline edit\n");
  assert.equal(runMode(s, "push").status, "queued");
  writeText(notePath(s, "K.md"), "k1\n");
  assert.equal(runMode(s, "push").status, "queued");
  peerReplaces(root, remoteDir, "notes/H.md", "remote v2\n");
  writeProjectConfig(s.configPath, online);

  const replay = runMode(s, "push");
  assert.equal(replay.status, "applied");
  assert.deepEqual(replay.conflictFiles, ["notes/H.md"]);
  assertOnlyRecovery(heldNote(replay, "notes/H.md"), RECOVERY_A);
  assert.equal(readHub(root, remoteDir, "notes/H.md"), "remote v2\n");
  assert.equal(readHub(root, remoteDir, "notes/K.md"), "k1\n", "the unrelated edit still publishes");
  assert.equal(readBase(s)["notes/H.md"], "base\n", "the base entry stays");
  assert.equal(new StateStore(s.stateDir, s.name).listQueuedSnapshots().length, 0, "the queue drained");

  const commitsBefore = hubCommitCount(root, remoteDir);
  const next = runMode(s, "push");
  assert.equal(next.status, "applied");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "the next push makes no commit");
  assert.equal(readHub(root, remoteDir, "notes/H.md"), "remote v2\n");
});
