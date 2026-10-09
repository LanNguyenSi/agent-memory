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
  root: string;
  strategy: "inline-markers" | "local-wins" | "remote-wins";
  workspace: string;
  stateDir: string;
  configPath: string;
}

function spokeConfig(spoke: Spoke, remoteUrl: string) {
  return {
    profile: spoke.name,
    rootDir: spoke.workspace,
    remoteUrl,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: spoke.stateDir,
    conflictStrategy: spoke.strategy,
    syncPaths: [{ source: path.join(spoke.workspace, "notes"), destination: "notes", kind: "directory" }]
  };
}

function createSpoke(
  root: string,
  remoteDir: string,
  name: string,
  conflictStrategy: "inline-markers" | "local-wins" | "remote-wins" = "inline-markers"
): Spoke {
  const workspace = path.join(root, `workspace-${name}`);
  const spoke: Spoke = {
    name,
    root,
    strategy: conflictStrategy,
    workspace,
    stateDir: path.join(root, `state-${name}`),
    configPath: path.join(root, `config-${name}.json`)
  };
  mkdirSync(path.join(workspace, "notes"), { recursive: true });
  writeProjectConfig(spoke.configPath, spokeConfig(spoke, remoteDir));
  return spoke;
}

// A remote that does not exist: push queues its snapshot instead of publishing.
function goOffline(spoke: Spoke) {
  writeProjectConfig(spoke.configPath, spokeConfig(spoke, path.join(spoke.root, "missing.git")));
}

function goOnline(spoke: Spoke, remoteDir: string) {
  writeProjectConfig(spoke.configPath, spokeConfig(spoke, remoteDir));
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

  // The same sync again, as JSON: the path is named by exactly one note, the
  // pull side's, not once more by the push side that skips it too.
  const again = runMode(s, "sync");
  assert.deepEqual(again.conflictFiles, ["notes/H.md"]);
  const pathNotes = again.notes.filter((note: string) => note.includes("notes/H.md"));
  assert.equal(pathNotes.length, 1, JSON.stringify(again.notes));
  assert.ok(pathNotes[0].startsWith("not pulled: notes/H.md"), pathNotes[0]);
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
  assert.ok(
    push.notes.some((note: string) => note.includes("notes/H.md")),
    JSON.stringify(push.notes)
  );
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

const MARKERED = "<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> remote\n";

function countOpeners(content: string | null): number {
  return (content || "").split("\n").filter((line) => line.startsWith("<<<<<<< ")).length;
}

// A spoke whose local copy already equals the markered hub copy is exempt from
// the pull refusal (there is nothing local to protect), so the markers sit in
// both places. A local resolution of such a file is held back by push because
// the hub copy still carries markers, so the stale-marker note must send the
// operator to the hub copy rather than say only "edit the file".
test("a local copy equal to the markered hub copy: no nesting, a hub-repair note, a local resolution is held back, convergence after the hub repair", () => {
  const root = createSandbox("markered-hub-equal-local");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  const t = createSpoke(root, remoteDir, "spoke-t");
  writeText(notePath(s, "K.md"), "k\n");
  assert.equal(runMode(s, "push").status, "applied");
  hubWrites(root, remoteDir, { "notes/H.md": MARKERED });
  writeText(notePath(s, "H.md"), MARKERED);
  writeText(notePath(t, "H.md"), MARKERED);

  const first = runMode(s, "sync");
  const second = runMode(s, "sync");
  runMode(t, "sync");
  assert.equal(readText(notePath(s, "H.md")), MARKERED, "no nesting on further syncs");
  assert.equal(readHub(root, remoteDir, "notes/H.md"), MARKERED, "the hub copy is untouched");
  assert.equal(readBase(s)["notes/H.md"], MARKERED);
  for (const run of [first, second]) {
    const staleNotes = run.notes.filter((note: string) => note.includes("stale conflict markers in notes/H.md"));
    assert.equal(staleNotes.length, 1, JSON.stringify(run.notes));
    assert.ok(/hub copy/.test(staleNotes[0]) && /repair/.test(staleNotes[0]), `hub-repair wording: ${staleNotes[0]}`);
    assert.ok(
      /local resolution alone is not published/.test(staleNotes[0]),
      `says a local resolution alone is not published: ${staleNotes[0]}`
    );
    assert.equal(staleNotes[0].includes("resolve by editing the file"), false, staleNotes[0]);
  }

  // A local resolution is held back by push and the hub keeps its markers.
  writeText(notePath(t, "H.md"), "resolved by t\n");
  const commitsBefore = hubCommitCount(root, remoteDir);
  const resolved = runMode(t, "sync");
  assert.ok(resolved.conflictFiles.includes("notes/H.md"), JSON.stringify(resolved.conflictFiles));
  assert.equal(readHub(root, remoteDir, "notes/H.md"), MARKERED, "the hub keeps its markers until repaired");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore);
  assert.equal(readText(notePath(t, "H.md")), "resolved by t\n", "the local resolution stays local");

  // After the hub repair both spokes converge, and the hub stays clean.
  hubWrites(root, remoteDir, { "notes/H.md": "clean\n" });
  runMode(s, "sync");
  assert.equal(readText(notePath(s, "H.md")), "clean\n");
  assert.equal(readBase(s)["notes/H.md"], "clean\n");
  runMode(t, "sync");
  assert.ok(countOpeners(readText(notePath(t, "H.md"))) <= 1, "at most one marker level locally");
  assert.equal(readHub(root, remoteDir, "notes/H.md"), "clean\n", "the hub stays clean");
});

// The queued snapshot saw the hub copy clean; the hub became markered while
// the spoke was offline. Replay must still not write over the markered copy,
// whatever local-wins would otherwise decide.
test("a queued edit replayed against a hub copy that turned markered while offline is skipped under local-wins", () => {
  const root = createSandbox("markered-hub-queued-replay");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s", "local-wins");
  writeText(notePath(s, "H.md"), "b0\n");
  assert.equal(runMode(s, "push").status, "applied");

  goOffline(s);
  writeText(notePath(s, "H.md"), "offline edit\n");
  assert.equal(runMode(s, "push").status, "queued");
  hubWrites(root, remoteDir, { "notes/H.md": MARKERED });
  goOnline(s, remoteDir);

  const commitsBefore = hubCommitCount(root, remoteDir);
  const preview = runMode(s, "push", ["--dry-run"]);
  assert.deepEqual(preview.conflictFiles, ["notes/H.md"], "the dry run reports the same skip");
  assert.equal(new StateStore(s.stateDir, s.name).listQueuedSnapshots().length, 1, "a dry run drains nothing");

  const replay = runMode(s, "push");
  assert.deepEqual(replay.conflictFiles, ["notes/H.md"]);
  assert.equal(replay.appliedFiles.includes("notes/H.md"), false);
  assert.equal(readHub(root, remoteDir, "notes/H.md"), MARKERED, "the hub copy is untouched");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "no commit may reach the hub");
  assert.equal(readBase(s)["notes/H.md"], "b0\n", "the base entry stays");
  assert.equal(new StateStore(s.stateDir, s.name).listQueuedSnapshots().length, 0, "the queue drained");
  assert.equal(readText(notePath(s, "H.md")), "offline edit\n", "the local edit is kept");

  const again = runMode(s, "push");
  assert.deepEqual(again.conflictFiles, ["notes/H.md"], "reported again, never requeued");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore);
  assert.equal(new StateStore(s.stateDir, s.name).listQueuedSnapshots().length, 0);
});
