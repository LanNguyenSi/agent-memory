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
}

function writeSpokeConfig(spoke: Spoke, remoteUrl: string) {
  writeProjectConfig(spoke.configPath, {
    profile: spoke.name,
    rootDir: spoke.workspace,
    remoteUrl,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: spoke.stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: [{ source: path.join(spoke.workspace, "notes"), destination: "notes", kind: "directory" }]
  });
}

function createSpoke(root: string, remoteDir: string, name: string): Spoke {
  const workspace = path.join(root, `workspace-${name}`);
  const stateDir = path.join(root, `state-${name}`);
  const configPath = path.join(root, `config-${name}.json`);
  mkdirSync(path.join(workspace, "notes"), { recursive: true });
  const spoke = { name, workspace, stateDir, configPath, root };
  writeSpokeConfig(spoke, remoteDir);
  return spoke;
}

function runMode(spoke: Spoke, mode: "push" | "pull") {
  const result = runCli(["run", spoke.name, "--config", spoke.configPath, "--mode", mode, "--output", "json"]);
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

test("a genuine local edit of F against a newer hub version still goes through the three-way rule", () => {
  const root = createSandbox("push-base-negative-control");
  const remoteDir = initBareRemote(root);
  const { b } = seedDivergedHub(root, remoteDir);

  // B edits F while its base is the older version and the hub is newer.
  writeText(notePath(b, "F.md"), "f v1\nedit from b\n");
  const result = runMode(b, "push");
  assert.equal(result.status, "applied");

  const hubF = readHub(root, remoteDir, "notes/F.md");
  assert.notEqual(hubF, null);
  assert.notEqual(hubF, "f v1\nedit from b\n", "the peer's version must not be silently overwritten");
  assert.notEqual(hubF, "f v2 from a\n", "B's edit must not be silently dropped");
  assert.ok((hubF as string).includes("f v2 from a"), `peer content missing from hub F: ${hubF}`);
  assert.ok((hubF as string).includes("edit from b"), `local edit missing from hub F: ${hubF}`);

  // A second push with no pull in between must still keep both contributions
  // on the hub. (Whether a repeated push of an unresolved conflict leaves the
  // markers byte-identical is a separate matter, pinned by the todo test
  // below.)
  assert.equal(runMode(b, "push").status, "applied");
  const hubAgain = readHub(root, remoteDir, "notes/F.md") as string;
  assert.ok(hubAgain.includes("f v2 from a"), `peer content missing after the second push: ${hubAgain}`);
  assert.ok(hubAgain.includes("edit from b"), `local edit missing after the second push: ${hubAgain}`);
});

// Known gap, not part of the base-advance rule: the unresolved conflict
// markers are published as the hub content, the base stays at the older
// version, and a repeated push merges the local edit against the markers
// again, nesting a second marker block. Marked todo until the marker handling
// is addressed.
test("a repeated push of an unresolved conflict leaves the hub markers byte-identical", { todo: true }, () => {
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
