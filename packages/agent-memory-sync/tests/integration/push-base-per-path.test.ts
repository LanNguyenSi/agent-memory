// A push must advance the base snapshot of a path to the hub content only
// when this spoke's local copy of that path equals the hub content. Push
// never writes hub-won or merged content back into the local files, so a
// base that jumped to the hub tree for every path made a stale local copy
// look like "local unchanged against base" to the next push's three-way
// merge: the stale copy was republished over a peer's newer version, and a
// hub-only file this spoke never pulled was deleted from the hub.
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync } = require("node:fs");
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
