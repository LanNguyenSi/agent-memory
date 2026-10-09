// A hub file that itself carries conflict markers is never merged into, on
// either side. Pull leaves the local file byte-identical, reports the path
// and does not advance its base entry; push skips the path, leaves the hub
// as it is, reports it, and does not advance its base entry either. The rest
// of the run proceeds. The markers stay a problem to repair at the hub.
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

function hubWrites(root: string, remoteDir: string, files: Record<string, string>) {
  const peer = cloneRemote(remoteDir, root, `peer-${Math.random().toString(16).slice(2, 8)}`);
  for (const [relativePath, content] of Object.entries(files)) {
    writeText(path.join(peer, "shared", relativePath), content);
  }
  git(["add", "."], peer);
  git(["commit", "-m", "hub edit"], peer);
  git(["push", "origin", "HEAD:main"], peer);
}

// Three opener lines, as a hub file damaged by nested earlier conflicts has.
const THREE_MARKERS =
  "<<<<<<< local\nmine\n=======\n<<<<<<< local\ntheirs\n=======\n<<<<<<< local\nolder\n=======\nold\n>>>>>>> remote\n>>>>>>> remote\n>>>>>>> remote\n";

test("pull refuses a markered hub file: the local file is byte-identical, the path is reported, the base entry stays, the rest pulls", () => {
  const root = createSandbox("markered-hub-pull");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  writeText(notePath(s, "K.md"), "k0\n");
  assert.equal(runMode(s, "push").status, "applied");
  const baseBefore = readBase(s);

  hubWrites(root, remoteDir, { "notes/H.md": THREE_MARKERS, "notes/K.md": "k1 from hub\n" });
  const commitsBefore = hubCommitCount(root, remoteDir);

  const result = runCli(["run", s.name, "--config", s.configPath, "--mode", "sync"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /conflicts=1/);
  assert.match(result.stdout, /notes=[^\n]*notes\/H\.md/, "a note must name the refused path");

  assert.equal(readText(notePath(s, "H.md")), "base\n", "the local file must be byte-identical");
  assert.equal(readBase(s)["notes/H.md"], baseBefore["notes/H.md"], "the base entry must not advance");
  assert.equal(readHub(root, remoteDir, "notes/H.md"), THREE_MARKERS, "the hub file must be unchanged");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "no commit may reach the hub");

  assert.equal(readText(notePath(s, "K.md")), "k1 from hub\n", "the rest of the pull proceeds");
  assert.equal(readBase(s)["notes/K.md"], "k1 from hub\n", "the base of the rest advances");
});

test("pull reports the refusal in conflictFiles and a note, and writes no pre-apply snapshot for it", () => {
  const root = createSandbox("markered-hub-pull-report");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  assert.equal(runMode(s, "push").status, "applied");
  hubWrites(root, remoteDir, { "notes/H.md": THREE_MARKERS });

  const pull = runMode(s, "pull");
  assert.deepEqual(pull.conflictFiles, ["notes/H.md"]);
  assert.equal(pull.appliedFiles.includes("notes/H.md"), false);
  assert.deepEqual(pull.snapshots, [], "nothing is written, so nothing is snapshotted");
  assert.ok(
    pull.notes.some((note: string) => note.includes("notes/H.md") && /hub copy carries conflict markers/.test(note)),
    JSON.stringify(pull.notes)
  );
  assert.equal(readText(notePath(s, "H.md")), "base\n");

  const again = runMode(s, "pull");
  assert.deepEqual(again.conflictFiles, ["notes/H.md"], "the same refusal on every later pull");
  assert.equal(readText(notePath(s, "H.md")), "base\n");
});

test("a markered hub file this machine has no copy of is not created locally and gets no base entry", () => {
  const root = createSandbox("markered-hub-new");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "K.md"), "k0\n");
  assert.equal(runMode(s, "push").status, "applied");
  hubWrites(root, remoteDir, { "notes/H.md": THREE_MARKERS });

  const pull = runMode(s, "pull");
  assert.deepEqual(pull.conflictFiles, ["notes/H.md"]);
  assert.equal(existsSync(notePath(s, "H.md")), false);
  assert.equal(Object.prototype.hasOwnProperty.call(readBase(s), "notes/H.md"), false);

  const sync = runMode(s, "sync");
  assert.equal(existsSync(notePath(s, "H.md")), false, "a sync does not create it either");
  assert.equal(readHub(root, remoteDir, "notes/H.md"), THREE_MARKERS);
  assert.equal(Object.prototype.hasOwnProperty.call(readBase(s), "notes/H.md"), false);
  assert.ok(sync.conflictFiles.includes("notes/H.md"));

  hubWrites(root, remoteDir, { "notes/H.md": "clean H\n" });
  runMode(s, "sync");
  assert.equal(readText(notePath(s, "H.md")), "clean H\n", "the path converges once the hub copy is repaired");
  assert.equal(readBase(s)["notes/H.md"], "clean H\n");
});

test("a dry-run pull reports the markered hub file and writes nothing", () => {
  const root = createSandbox("markered-hub-dry-run");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  assert.equal(runMode(s, "push").status, "applied");
  hubWrites(root, remoteDir, { "notes/H.md": THREE_MARKERS });

  const preview = runMode(s, "pull", ["--dry-run"]);
  assert.equal(preview.status, "dry-run");
  assert.deepEqual(preview.conflictFiles, ["notes/H.md"]);
  assert.equal(preview.appliedFiles.includes("notes/H.md"), false);
  assert.equal(readText(notePath(s, "H.md")), "base\n");
});

test("push skips a markered hub path whose local copy changed: the hub stays, the path is reported, the base stays", () => {
  const root = createSandbox("markered-hub-push");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  writeText(notePath(s, "K.md"), "k0\n");
  assert.equal(runMode(s, "push").status, "applied");
  hubWrites(root, remoteDir, { "notes/H.md": THREE_MARKERS });
  const baseBefore = readBase(s);

  writeText(notePath(s, "H.md"), "base\nlocal append\n");
  writeText(notePath(s, "K.md"), "k1\n");
  const commitsBefore = hubCommitCount(root, remoteDir);
  const push = runMode(s, "push");
  assert.equal(push.status, "applied");
  assert.deepEqual(push.conflictFiles, ["notes/H.md"]);
  assert.equal(push.appliedFiles.includes("notes/H.md"), false);
  assert.ok(push.notes.some((note: string) => note.includes("notes/H.md")), JSON.stringify(push.notes));
  assert.equal(readHub(root, remoteDir, "notes/H.md"), THREE_MARKERS, "the hub file must be unchanged");
  assert.equal(readText(notePath(s, "H.md")), "base\nlocal append\n", "the local file must be untouched");
  assert.equal(readBase(s)["notes/H.md"], baseBefore["notes/H.md"], "the base entry must not move");
  assert.equal(readHub(root, remoteDir, "notes/K.md"), "k1\n", "an unrelated clean file still publishes");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore + 1);
});

test("under local-wins a clean local edit is still not written over a markered hub file", () => {
  const root = createSandbox("markered-hub-push-local-wins");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s", "local-wins");
  writeText(notePath(s, "H.md"), "base\n");
  assert.equal(runMode(s, "push").status, "applied");
  hubWrites(root, remoteDir, { "notes/H.md": THREE_MARKERS });
  const baseBefore = readBase(s);

  writeText(notePath(s, "H.md"), "local clean\n");
  const commitsBefore = hubCommitCount(root, remoteDir);
  const push = runMode(s, "push");
  assert.deepEqual(push.conflictFiles, ["notes/H.md"]);
  assert.equal(push.appliedFiles.includes("notes/H.md"), false);
  assert.equal(readHub(root, remoteDir, "notes/H.md"), THREE_MARKERS);
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "no commit may reach the hub");
  assert.equal(readBase(s)["notes/H.md"], baseBefore["notes/H.md"]);
});

test("push skips a markered hub path whose local copy was deleted", () => {
  const root = createSandbox("markered-hub-push-deleted");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  writeText(notePath(s, "H.md"), "base\n");
  writeText(notePath(s, "K.md"), "k0\n");
  assert.equal(runMode(s, "push").status, "applied");
  hubWrites(root, remoteDir, { "notes/H.md": THREE_MARKERS });
  const baseBefore = readBase(s);

  require("node:fs").rmSync(notePath(s, "H.md"));
  const commitsBefore = hubCommitCount(root, remoteDir);
  const push = runMode(s, "push");
  assert.deepEqual(push.conflictFiles, ["notes/H.md"]);
  assert.equal(readHub(root, remoteDir, "notes/H.md"), THREE_MARKERS);
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore);
  assert.equal(readBase(s)["notes/H.md"], baseBefore["notes/H.md"]);
});
