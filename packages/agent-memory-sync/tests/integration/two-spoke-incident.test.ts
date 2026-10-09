// The incident chain, replayed with two spokes and one bare hub: a spoke
// that pulled a stale copy and later conflicted must never lose the other
// spoke's content on the hub, and no hub file may ever carry a conflict
// marker line because of the sync itself. A markered file seeded straight
// into the hub is the one marker-bearing hub file allowed, and it is left
// untouched by both spokes until the hub copy is repaired.
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, readdirSync, statSync } = require("node:fs");
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

function runMode(spoke: Spoke, mode: string) {
  const result = runCli(["run", spoke.name, "--config", spoke.configPath, "--mode", mode, "--output", "json"]);
  return JSON.parse(result.stdout).runs[0];
}

function notePath(spoke: Spoke, name: string): string {
  return path.join(spoke.workspace, "notes", name);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") {
      continue;
    }
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

// Every hub file under shared/, keyed by its path relative to shared/.
function readHubTree(root: string, remoteDir: string): Record<string, string> {
  const checkout = path.join(root, `hub-tree-${Math.random().toString(16).slice(2, 8)}`);
  git(["clone", "--quiet", remoteDir, checkout], root);
  const base = path.join(checkout, "shared");
  const tree: Record<string, string> = {};
  if (existsSync(base)) {
    for (const file of walk(base)) {
      tree[path.relative(base, file).split(path.sep).join("/")] = readText(file);
    }
  }
  return tree;
}

function markerLine(content: string): boolean {
  return content.split("\n").some((line) => line.startsWith("<<<<<<< "));
}

// The invariant after every step: no hub file carries a marker line, except
// the paths a step seeded on purpose, and F equals spoke A's latest version.
function assertHub(root: string, remoteDir: string, step: string, expectedF: string, seeded: string[] = []) {
  const tree = readHubTree(root, remoteDir);
  for (const [file, content] of Object.entries(tree)) {
    if (seeded.includes(file)) {
      continue;
    }
    assert.equal(markerLine(content), false, `${step}: hub file ${file} carries a marker line`);
  }
  assert.equal(tree["notes/F.md"], expectedF, `${step}: the hub must hold spoke A's latest F`);
  return tree;
}

function seedHub(root: string, remoteDir: string, relativePath: string, content: string) {
  const scratch = cloneRemote(remoteDir, root, `seed-${Math.random().toString(16).slice(2, 8)}`);
  writeText(path.join(scratch, "shared", relativePath), content);
  git(["add", "."], scratch);
  git(["commit", "-m", "seed hub file"], scratch);
  git(["push", "origin", "HEAD:main"], scratch);
}

const F_V1 = "line one\nline two\n";
const F_V2 = `${F_V1}A adds a line\n`;
const F_V3 = `${F_V2}A adds a small edit\n`;
const MARKERED_H = "<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> remote\n";

test("two-spoke incident chain: the hub keeps spoke A's content and never holds a marker", () => {
  const root = createSandbox("two-spoke-incident");
  const remoteDir = initBareRemote(root);
  const a = createSpoke(root, remoteDir, "spoke-a");
  const b = createSpoke(root, remoteDir, "spoke-b");

  // Setup: both spokes hold F v1.
  writeText(notePath(a, "F.md"), F_V1);
  assert.equal(runMode(a, "push").status, "applied");
  runMode(b, "pull");
  assert.equal(readText(notePath(b, "F.md")), F_V1);

  // 1. A pushes F v2.
  writeText(notePath(a, "F.md"), F_V2);
  assert.equal(runMode(a, "push").status, "applied");
  assertHub(root, remoteDir, "step 1", F_V2);

  // 2. B pushes with no local change, then with a change to an unrelated G.
  const idle = runMode(b, "push");
  assert.equal(idle.status, "applied");
  assertHub(root, remoteDir, "step 2a", F_V2);
  writeText(notePath(b, "G.md"), "g from B\n");
  assert.equal(runMode(b, "push").status, "applied");
  const afterG = assertHub(root, remoteDir, "step 2b", F_V2);
  assert.equal(afterG["notes/G.md"], "g from B\n");

  // 3. A syncs and receives G.
  runMode(a, "sync");
  assert.equal(readText(notePath(a, "G.md")), "g from B\n");
  assertHub(root, remoteDir, "step 3", F_V2);

  // 4. B edits F in a way that conflicts with v2 and syncs: the markers land
  // in B's local file only, the hub keeps v2, B reports the conflict.
  writeText(notePath(b, "F.md"), "line one changed by B\nline two\n");
  const step4 = runMode(b, "sync");
  assert.deepEqual(step4.conflictFiles, ["notes/F.md"]);
  assert.equal(markerLine(readText(notePath(b, "F.md"))), true, "the markers are written to B's local file");
  assertHub(root, remoteDir, "step 4", F_V2);

  // 5. B syncs again with the local file still markered.
  const markeredLocal = readText(notePath(b, "F.md"));
  const step5 = runMode(b, "sync");
  assert.deepEqual(step5.conflictFiles, ["notes/F.md"], "F is reported again");
  assert.equal(readText(notePath(b, "F.md")), markeredLocal);
  assertHub(root, remoteDir, "step 5", F_V2);

  // 6. A publishes a small append-compatible edit to F.
  writeText(notePath(a, "F.md"), F_V3);
  assert.equal(runMode(a, "push").status, "applied");
  assertHub(root, remoteDir, "step 6", F_V3);

  // 7. A markered file is seeded straight into the hub. Neither spoke merges
  // into it or creates it locally, and the hub copy is not touched.
  seedHub(root, remoteDir, "notes/H.md", MARKERED_H);
  for (const spoke of [a, b]) {
    const result = runMode(spoke, "sync");
    assert.ok(result.conflictFiles.includes("notes/H.md"), `${spoke.name} reports H`);
    assert.equal(existsSync(notePath(spoke, "H.md")), false, `${spoke.name} does not create H locally`);
    const tree = assertHub(root, remoteDir, `step 7 ${spoke.name}`, F_V3, ["notes/H.md"]);
    assert.equal(tree["notes/H.md"], MARKERED_H, "the hub copy of H is unchanged");
  }

  // Once the hub copy is repaired, H converges on both spokes.
  seedHub(root, remoteDir, "notes/H.md", "clean H\n");
  for (const spoke of [a, b]) {
    runMode(spoke, "sync");
    assert.equal(readText(notePath(spoke, "H.md")), "clean H\n", `${spoke.name} converges on H`);
    const tree = assertHub(root, remoteDir, `step 7 repaired ${spoke.name}`, F_V3);
    assert.equal(tree["notes/H.md"], "clean H\n");
  }
});
