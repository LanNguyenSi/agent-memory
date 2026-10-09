// A push must advance the base snapshot of a path to the hub content only
// when this spoke's local copy of that path equals the hub content. Push
// never writes hub-won or merged content back into the local files, so a
// base that jumped to the hub tree for every path made a stale local copy
// look like "local unchanged against base" to the next push's three-way
// merge: the stale copy was republished over a peer's newer version, and a
// hub-only file this spoke never pulled was deleted from the hub.
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");
const {
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
  root: string;
  conflictStrategy?: "inline-markers" | "local-wins" | "remote-wins";
}

function writeSpokeConfig(spoke: Spoke, remoteUrl: string) {
  writeProjectConfig(spoke.configPath, {
    profile: spoke.name,
    rootDir: spoke.workspace,
    remoteUrl,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: spoke.stateDir,
    conflictStrategy: spoke.conflictStrategy || "inline-markers",
    syncPaths: [{ source: path.join(spoke.workspace, "notes"), destination: "notes", kind: "directory" }]
  });
}

function createSpoke(
  root: string,
  remoteDir: string,
  name: string,
  conflictStrategy?: Spoke["conflictStrategy"]
): Spoke {
  const workspace = path.join(root, `workspace-${name}`);
  const stateDir = path.join(root, `state-${name}`);
  const configPath = path.join(root, `config-${name}.json`);
  mkdirSync(path.join(workspace, "notes"), { recursive: true });
  const spoke = { name, workspace, stateDir, configPath, root, conflictStrategy };
  writeSpokeConfig(spoke, remoteDir);
  return spoke;
}

function runMode(spoke: Spoke, mode: "push" | "pull", extra: string[] = []) {
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

// Hub holds F at its older version (pushed by A, pulled by B), then A
// publishes a newer F. B's local F and base F are still the older version.
function seedDivergedHub(root: string, remoteDir: string) {
  const a = createSpoke(root, remoteDir, "spoke-a");
  const b = createSpoke(root, remoteDir, "spoke-b");
  writeText(notePath(a, "F.md"), "f v1\n");
  assert.equal(runMode(a, "push").status, "applied");
  runMode(b, "pull");
  assert.equal(readText(notePath(b, "F.md")), "f v1\n");
  writeText(notePath(a, "F.md"), "f v2 from a\n");
  assert.equal(runMode(a, "push").status, "applied");
  return { a, b };
}

test("a push with no local change followed by a push of an unrelated file keeps the peer's newer version on the hub", () => {
  const root = createSandbox("push-base-stale-republish");
  const remoteDir = initBareRemote(root);
  const { b } = seedDivergedHub(root, remoteDir);

  // No local change on B: the hub keeps A's F and B's local F stays older.
  const idle = runMode(b, "push");
  assert.equal(idle.status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/F.md"), "f v2 from a\n");
  assert.equal(readText(notePath(b, "F.md")), "f v1\n");

  writeText(notePath(b, "G.md"), "g from b\n");
  const second = runMode(b, "push");
  assert.equal(second.status, "applied");

  assert.equal(readHub(root, remoteDir, "notes/F.md"), "f v2 from a\n");
  assert.equal(readHub(root, remoteDir, "notes/G.md"), "g from b\n");
});

test("a hub-only file this spoke never pulled survives two consecutive pushes", () => {
  const root = createSandbox("push-base-hub-only");
  const remoteDir = initBareRemote(root);
  const { a, b } = seedDivergedHub(root, remoteDir);
  writeText(notePath(a, "P.md"), "hub only\n");
  assert.equal(runMode(a, "push").status, "applied");
  assert.equal(existsSync(notePath(b, "P.md")), false);

  writeText(notePath(b, "G.md"), "g one\n");
  assert.equal(runMode(b, "push").status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/P.md"), "hub only\n");

  writeText(notePath(b, "G.md"), "g two\n");
  assert.equal(runMode(b, "push").status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/P.md"), "hub only\n");
  assert.equal(readHub(root, remoteDir, "notes/G.md"), "g two\n");
  assert.equal(readBase(b)["notes/P.md"], undefined);
});

// The local edit and the hub's newer version are not append-compatible (the
// hub's "f v2 from a" does not extend the base "f v1"), so the three-way rule
// reaches a conflict. A conflict is not published: the hub keeps the peer's
// version, the local edit stays local, and the base entry stays at the older
// version.
test("a genuine local edit of F against a newer hub version is held back and never overwrites the peer", () => {
  const root = createSandbox("push-base-negative-control");
  const remoteDir = initBareRemote(root);
  const { b } = seedDivergedHub(root, remoteDir);

  // B edits F while its base is the older version and the hub is newer.
  writeText(notePath(b, "F.md"), "f v1\nedit from b\n");
  const result = runMode(b, "push");
  assert.equal(result.status, "applied");
  assert.deepEqual(result.conflictFiles, ["notes/F.md"]);
  assert.ok(result.notes.some((note: string) => note.includes("notes/F.md")), JSON.stringify(result.notes));

  assert.equal(readHub(root, remoteDir, "notes/F.md"), "f v2 from a\n", "the peer's version must stay on the hub");
  assert.equal(readText(notePath(b, "F.md")), "f v1\nedit from b\n", "the local edit stays local");
  assert.equal(readBase(b)["notes/F.md"], "f v1\n");

  const commitsBefore = hubCommitCount(root, remoteDir);
  const again = runMode(b, "push");
  assert.equal(again.status, "applied");
  assert.deepEqual(again.conflictFiles, ["notes/F.md"]);
  assert.equal(readHub(root, remoteDir, "notes/F.md"), "f v2 from a\n");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "the second push must change nothing");
});

// An append-compatible pair of edits is still merged by the three-way rule
// and published, so the hold-back is limited to real conflicts.
test("an append-compatible local edit against a newer hub version is still merged and published", () => {
  const root = createSandbox("push-base-append-merge");
  const remoteDir = initBareRemote(root);
  const a = createSpoke(root, remoteDir, "spoke-a");
  const b = createSpoke(root, remoteDir, "spoke-b");
  writeText(notePath(a, "F.md"), "f v1\n");
  assert.equal(runMode(a, "push").status, "applied");
  runMode(b, "pull");
  writeText(notePath(a, "F.md"), "f v1\nfrom a\n");
  assert.equal(runMode(a, "push").status, "applied");

  writeText(notePath(b, "F.md"), "f v1\nfrom b\n");
  const result = runMode(b, "push");
  assert.deepEqual(result.conflictFiles, []);
  assert.deepEqual(result.mergedFiles, ["notes/F.md"]);
  const hubF = readHub(root, remoteDir, "notes/F.md") as string;
  assert.ok(hubF.includes("from a") && hubF.includes("from b"), hubF);
});

test("a second push of an unresolved conflicting edit leaves the hub byte-identical and adds no commit", () => {
  const root = createSandbox("push-base-marker-idempotent");
  const remoteDir = initBareRemote(root);
  const { b } = seedDivergedHub(root, remoteDir);

  writeText(notePath(b, "F.md"), "f v1\nedit from b\n");
  assert.equal(runMode(b, "push").status, "applied");
  const hubF = readHub(root, remoteDir, "notes/F.md");
  const commitsBefore = hubCommitCount(root, remoteDir);
  assert.equal(runMode(b, "push").status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/F.md"), hubF);
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore);
});

test("a locally deleted path that propagated to the hub has no base entry afterwards", () => {
  const root = createSandbox("push-base-deleted-path");
  const remoteDir = initBareRemote(root);
  const { b } = seedDivergedHub(root, remoteDir);

  writeText(notePath(b, "G.md"), "g from b\n");
  assert.equal(runMode(b, "push").status, "applied");
  assert.equal(readBase(b)["notes/G.md"], "g from b\n");

  rmSync(notePath(b, "G.md"));
  assert.equal(runMode(b, "push").status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/G.md"), null);
  assert.equal(Object.prototype.hasOwnProperty.call(readBase(b), "notes/G.md"), false);
});

test("the written base advances only where local equals the hub, and never records an unmapped path", () => {
  const root = createSandbox("push-base-store");
  const remoteDir = initBareRemote(root);
  const { b } = seedDivergedHub(root, remoteDir);

  // A hub path outside every syncPaths mapping, and a base store that was
  // contaminated with that same path by something other than push.
  const peer = path.join(root, "peer-unmapped");
  git(["clone", "--quiet", remoteDir, peer], root);
  git(["config", "user.name", "peer"], peer);
  git(["config", "user.email", "peer@example.invalid"], peer);
  writeText(path.join(peer, "shared", "elsewhere", "stray.md"), "stray\n");
  git(["add", "."], peer);
  git(["commit", "--quiet", "-m", "peer adds unmapped path"], peer);
  git(["push", "--quiet", "origin", "HEAD:main"], peer);
  writeText(path.join(b.stateDir, "base", "elsewhere", "stray.md"), "stray\n");

  writeText(notePath(b, "G.md"), "g from b\n");
  assert.equal(runMode(b, "push").status, "applied");

  const base = readBase(b);
  // Converged: local G equals the hub G, so the base follows the hub.
  assert.equal(base["notes/G.md"], "g from b\n");
  // Not converged: local F is older than the hub F, so the base keeps the
  // older version.
  assert.equal(base["notes/F.md"], "f v1\n");
  assert.equal(readHub(root, remoteDir, "notes/F.md"), "f v2 from a\n");
  assert.equal(Object.prototype.hasOwnProperty.call(base, "elsewhere/stray.md"), false);
});

// Queued snapshots are replayed before the current one, each merged against
// the base captured when it was enqueued. The base has to move forward across
// the replays: after a replay publishes content, a later snapshot (including
// the current one) that reverts that content must see the published content
// as its base, or the revert is read as "unchanged" and never published.
function goOffline(spoke: Spoke) {
  writeSpokeConfig(spoke, path.join(spoke.root, "missing-remote.git"));
}

function goOnline(spoke: Spoke, remoteDir: string) {
  writeSpokeConfig(spoke, remoteDir);
}

function seedConvergedSpoke(root: string, remoteDir: string) {
  const s = createSpoke(root, remoteDir, "spoke-q");
  writeText(notePath(s, "G.md"), "g0\n");
  assert.equal(runMode(s, "push").status, "applied");
  return s;
}

test("an offline edit that is reverted before reconnecting leaves the hub and local at the reverted state", () => {
  const root = createSandbox("push-queue-chain-revert");
  const remoteDir = initBareRemote(root);
  const s = seedConvergedSpoke(root, remoteDir);

  goOffline(s);
  writeText(notePath(s, "G.md"), "g1\n");
  assert.equal(runMode(s, "push").status, "queued");
  writeText(notePath(s, "G.md"), "g0\n");

  goOnline(s, remoteDir);
  const first = runMode(s, "push");
  assert.equal(first.status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/G.md"), "g0\n");

  const commitsBefore = hubCommitCount(root, remoteDir);
  const second = runMode(s, "push");
  assert.equal(second.status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/G.md"), "g0\n");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "the second push must change nothing");

  runMode(s, "pull");
  assert.equal(readText(notePath(s, "G.md")), "g0\n");
});

test("a file created and deleted again while offline does not reach the hub or come back from it", () => {
  const root = createSandbox("push-queue-chain-create-delete");
  const remoteDir = initBareRemote(root);
  const s = seedConvergedSpoke(root, remoteDir);

  goOffline(s);
  writeText(notePath(s, "P.md"), "created offline\n");
  assert.equal(runMode(s, "push").status, "queued");
  rmSync(notePath(s, "P.md"));

  goOnline(s, remoteDir);
  const first = runMode(s, "push");
  assert.equal(first.status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/P.md"), null);
  assert.equal(readHub(root, remoteDir, "notes/G.md"), "g0\n");

  const commitsBefore = hubCommitCount(root, remoteDir);
  assert.equal(runMode(s, "push").status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/P.md"), null);
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "the second push must change nothing");

  runMode(s, "pull");
  assert.equal(existsSync(notePath(s, "P.md")), false);
  assert.equal(readText(notePath(s, "G.md")), "g0\n");
});

test("a dry-run preview after an offline create and delete plans the deletion of the replayed file", () => {
  const root = createSandbox("push-queue-chain-preview");
  const remoteDir = initBareRemote(root);
  const s = seedConvergedSpoke(root, remoteDir);

  goOffline(s);
  writeText(notePath(s, "P.md"), "created offline\n");
  assert.equal(runMode(s, "push").status, "queued");
  rmSync(notePath(s, "P.md"));

  goOnline(s, remoteDir);
  const preview = JSON.parse(
    runCli(["run", s.name, "--config", s.configPath, "--mode", "push", "--dry-run", "--output", "json"]).stdout
  ).runs[0];
  assert.equal(preview.status, "dry-run");
  assert.deepEqual(preview.deletedFiles, ["notes/P.md"]);
  assert.equal(readHub(root, remoteDir, "notes/P.md"), null, "a dry-run must not publish anything");
});

// The mass-delete guard measures net deletions against the hub as the run
// found it. A file created by one queued snapshot and removed by a later one
// is not a deletion from the hub's tracked corpus.
test("files created and deleted again while offline do not trip the mass-delete guard in a small destination", () => {
  const root = createSandbox("push-queue-guard-net-deletions");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-q");
  for (let index = 0; index < 19; index += 1) {
    writeText(notePath(s, `T${index}.md`), `t${index}\n`);
  }
  assert.equal(runMode(s, "push").status, "applied");

  goOffline(s);
  writeText(notePath(s, "P1.md"), "p1\n");
  writeText(notePath(s, "P2.md"), "p2\n");
  assert.equal(runMode(s, "push").status, "queued");
  rmSync(notePath(s, "P1.md"));
  rmSync(notePath(s, "P2.md"));

  goOnline(s, remoteDir);
  const first = runMode(s, "push");
  assert.equal(first.status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/P1.md"), null);
  assert.equal(readHub(root, remoteDir, "notes/P2.md"), null);

  const commitsBefore = hubCommitCount(root, remoteDir);
  assert.equal(runMode(s, "push").status, "applied");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "the second push must change nothing");

  runMode(s, "pull");
  assert.equal(existsSync(notePath(s, "P1.md")), false);
  assert.equal(existsSync(notePath(s, "P2.md")), false);
  assert.equal(readText(notePath(s, "T0.md")), "t0\n");
});

test("a queued snapshot that deletes a file followed by one that recreates it ends at the recreated content", () => {
  const root = createSandbox("push-queue-delete-then-recreate");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-q");
  writeText(notePath(s, "G.md"), "g0\n");
  writeText(notePath(s, "D.md"), "d0\n");
  assert.equal(runMode(s, "push").status, "applied");

  goOffline(s);
  writeText(notePath(s, "G.md"), "g1\n");
  rmSync(notePath(s, "D.md"));
  assert.equal(runMode(s, "push").status, "queued");
  writeText(notePath(s, "G.md"), "g2\n");
  writeText(notePath(s, "P.md"), "p2\n");
  writeText(notePath(s, "D.md"), "d2\n");
  assert.equal(runMode(s, "push").status, "queued");
  writeText(notePath(s, "G.md"), "g0\n");
  rmSync(notePath(s, "P.md"));

  goOnline(s, remoteDir);
  const pick = (result: any) => ({
    applied: result.appliedFiles,
    deleted: result.deletedFiles,
    conflicts: result.conflictFiles,
    merged: result.mergedFiles
  });
  const preview = runMode(s, "push", ["--dry-run"]);
  const real = runMode(s, "push");
  assert.equal(real.status, "applied");
  assert.deepEqual(pick(preview), pick(real), "the dry-run plan matches the real run");
  assert.equal(readHub(root, remoteDir, "notes/G.md"), "g0\n");
  assert.equal(readHub(root, remoteDir, "notes/P.md"), null);
  assert.equal(readHub(root, remoteDir, "notes/D.md"), "d2\n");
  assert.deepEqual(readBase(s), { "notes/G.md": "g0\n", "notes/D.md": "d2\n" });

  const commitsBefore = hubCommitCount(root, remoteDir);
  assert.equal(runMode(s, "push").status, "applied");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "the second push must change nothing");
  runMode(s, "pull");
  assert.equal(readText(notePath(s, "G.md")), "g0\n");
  assert.equal(existsSync(notePath(s, "P.md")), false);
  assert.equal(readText(notePath(s, "D.md")), "d2\n");
});

test("a pull between enqueue and replay moves another path's base and the replay keeps it", () => {
  const root = createSandbox("push-queue-pull-between");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-q");
  const peer = createSpoke(root, remoteDir, "spoke-peer");
  writeText(notePath(s, "G.md"), "g0\n");
  writeText(notePath(s, "Q.md"), "q0\n");
  assert.equal(runMode(s, "push").status, "applied");
  runMode(peer, "pull");

  goOffline(s);
  writeText(notePath(s, "G.md"), "g1\n");
  writeText(notePath(s, "P.md"), "p1\n");
  assert.equal(runMode(s, "push").status, "queued");

  writeText(notePath(peer, "Q.md"), "q1 from peer\n");
  assert.equal(runMode(peer, "push").status, "applied");

  goOnline(s, remoteDir);
  runMode(s, "pull");
  assert.equal(readText(notePath(s, "Q.md")), "q1 from peer\n");

  assert.equal(runMode(s, "push").status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/G.md"), "g1\n");
  assert.equal(readHub(root, remoteDir, "notes/P.md"), "p1\n");
  assert.equal(readHub(root, remoteDir, "notes/Q.md"), "q1 from peer\n");
  const base = readBase(s);
  assert.equal(base["notes/Q.md"], "q1 from peer\n", "the pulled base entry survives the replay");
  assert.equal(base["notes/G.md"], "g1\n");
  assert.equal(base["notes/P.md"], "p1\n");

  const commitsBefore = hubCommitCount(root, remoteDir);
  assert.equal(runMode(s, "push").status, "applied");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "the second push must change nothing");
  runMode(s, "pull");
  assert.equal(readText(notePath(s, "G.md")), "g1\n");
  assert.equal(readText(notePath(s, "Q.md")), "q1 from peer\n");
});

// Under local-wins a replayed offline edit of a path the peer has since
// deleted is republished. An adopted deletion (--accept-mass-delete) removes
// the local copy and the base entry; the final base write must not record the
// replayed edit for that path, or the next plain push reads "no local copy,
// base equals hub" and deletes the republished edit from the hub. The edit is
// kept: it was made after the deletion's base and the strategy says local wins.
test("under local-wins a replayed edit of an adopted-deleted path survives the next plain push", () => {
  const root = createSandbox("push-adopted-replay-local-wins");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-q", "local-wins");
  const peer = createSpoke(root, remoteDir, "spoke-peer");
  for (let index = 0; index < 10; index += 1) {
    writeText(notePath(s, `T${index}.md`), `t${index}\n`);
  }
  assert.equal(runMode(s, "push").status, "applied");
  runMode(peer, "pull");

  goOffline(s);
  writeText(notePath(s, "T0.md"), "t0 edited offline\n");
  assert.equal(runMode(s, "push").status, "queued");

  for (let index = 0; index < 5; index += 1) {
    rmSync(notePath(peer, `T${index}.md`));
  }
  assert.equal(runMode(peer, "push", ["--allow-mass-delete"]).status, "applied");

  goOnline(s, remoteDir);
  assert.equal(runMode(s, "push", ["--accept-mass-delete"]).status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/T0.md"), "t0 edited offline\n");
  assert.equal(readHub(root, remoteDir, "notes/T1.md"), null);
  assert.equal(
    Object.prototype.hasOwnProperty.call(readBase(s), "notes/T0.md"),
    false,
    "an adopted path has no base entry after the run"
  );

  const commitsBefore = hubCommitCount(root, remoteDir);
  assert.equal(runMode(s, "push").status, "applied");
  assert.equal(readHub(root, remoteDir, "notes/T0.md"), "t0 edited offline\n", "the replayed edit stays on the hub");
  assert.equal(hubCommitCount(root, remoteDir), commitsBefore, "the plain push must change nothing");
});
