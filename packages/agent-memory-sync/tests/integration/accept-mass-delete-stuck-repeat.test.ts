// An --accept-mass-delete push that keeps stopping on the same lost path (one
// the sync never collects, so no snapshot can hold it) must stop before it
// writes a snapshot. Every repeat or scheduled tick would otherwise write one
// more generation and rotate an older one away while failing at the same
// place.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { StateStore } = require("../../src/memory-sync/state-store");
const { writePreApplySnapshot } = require("../../src/memory-sync/pre-apply-snapshot");
const { createSandbox, initBareRemote, runCli, writeProjectConfig, writeText } = require("../helpers/cli.ts");

const GENERATIONS = 2;

function createSpoke(root: string, remoteDir: string, name: string) {
  const workspace = path.join(root, `workspace-${name}`);
  const spoke = {
    name,
    workspace,
    stateDir: path.join(root, `state-${name}`),
    configPath: path.join(root, `config-${name}.json`)
  };
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  writeProjectConfig(spoke.configPath, {
    profile: name,
    rootDir: workspace,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: spoke.stateDir,
    snapshotGenerations: GENERATIONS,
    conflictStrategy: "inline-markers",
    syncPaths: [{ source: path.join(workspace, "notes"), destination: "notes", kind: "directory" }]
  });
  return spoke;
}

function run(spoke: { name: string; configPath: string }, extra: string[], expectFailure = false) {
  return runCli(["run", spoke.name, "--config", spoke.configPath, "--mode", "push", "--output", "json", ...extra], {
    expectFailure
  });
}

// A hub that dropped half of a destination this spoke still holds, and a lost
// path on this spoke that is a symlink (which the sync does not collect).
function stuckSetup(name: string) {
  const root = createSandbox(name);
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  const peer = createSpoke(root, remoteDir, "spoke-peer");
  for (let index = 0; index < 10; index += 1) {
    writeText(path.join(s.workspace, "notes", `T${index}.md`), `t${index}\n`);
  }
  run(s, []);
  runCli(["run", peer.name, "--config", peer.configPath, "--mode", "pull", "--output", "json"]);
  for (let index = 0; index < 5; index += 1) {
    fs.rmSync(path.join(peer.workspace, "notes", `T${index}.md`));
  }
  run(peer, ["--allow-mass-delete"]);

  // One generation that is already there, as an earlier pull would have left it.
  const seeded = writePreApplySnapshot({
    stateDir: s.stateDir,
    destination: "notes",
    files: [{ remoteRelativePath: "notes/T9.md", absolutePath: path.join(s.workspace, "notes", "T9.md") }],
    generations: GENERATIONS
  });

  return { s, seededId: seeded.id as string };
}

test("accept-mass-delete: a lost path the sync does not collect stops N+1 runs before any snapshot", (t: {
  skip: (reason: string) => void;
}) => {
  const { s, seededId } = stuckSetup("accept-stuck-repeat");
  const stuck = path.join(s.workspace, "notes", "T0.md");
  const outside = path.join(path.dirname(s.workspace), "outside-target.md");
  writeText(outside, "precious\n");
  fs.rmSync(stuck);
  try {
    fs.symlinkSync(outside, stuck);
  } catch {
    t.skip("symlinks are not available on this platform");
    return;
  }
  const snapshotDir = path.join(s.stateDir, "snapshots", "notes");
  const baseBefore = new StateStore(s.stateDir, s.name).readBaseSnapshots();

  // snapshotGenerations is 2: a third run that wrote its snapshot first would
  // have rotated the seeded generation away.
  for (let attempt = 0; attempt < GENERATIONS + 1; attempt += 1) {
    const result = run(s, ["--accept-mass-delete"], true);
    assert.equal(result.status, 12, `attempt ${attempt}: ${result.stderr}`);
    assert.match(
      result.stderr,
      /--accept-mass-delete stopped: notes\/T0\.md exists on disk but is not a regular file the sync collects/
    );
    assert.match(
      result.stderr,
      /No local file was removed, no snapshot was written and the base snapshot was not moved/
    );
    assert.match(
      result.stderr,
      /run the push again first\. Only if it stops again at the same path, move notes\/T0\.md aside/
    );
  }

  assert.deepEqual(
    fs.readdirSync(snapshotDir),
    [seededId],
    "the seeded generation is the only one, no snapshot was written"
  );
  assert.equal(fs.lstatSync(stuck).isSymbolicLink(), true, "the symlink is still there");
  assert.equal(fs.readFileSync(outside, "utf8"), "precious\n", "the symlink target is unchanged");
  for (let index = 1; index < 10; index += 1) {
    assert.equal(fs.existsSync(path.join(s.workspace, "notes", `T${index}.md`)), true, `T${index}.md is still on disk`);
  }
  assert.deepEqual(
    new StateStore(s.stateDir, s.name).readBaseSnapshots(),
    baseBefore,
    "the base snapshot did not move"
  );

  // Control: with the obstacle moved aside, the same flag adopts the deletion.
  fs.rmSync(stuck);
  const adopted = run(s, ["--accept-mass-delete"]);
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.equal(fs.existsSync(path.join(s.workspace, "notes", "T1.md")), false, "T1.md was removed by the adoption");
  assert.equal(fs.existsSync(path.join(s.workspace, "notes", "T5.md")), true, "T5.md, still on the hub, is kept");
});

test("accept-mass-delete: a dangling symlink at a lost path also stops before any snapshot", (t: {
  skip: (reason: string) => void;
}) => {
  const { s, seededId } = stuckSetup("accept-stuck-dangling");
  const stuck = path.join(s.workspace, "notes", "T0.md");
  fs.rmSync(stuck);
  try {
    fs.symlinkSync(path.join(path.dirname(s.workspace), "does-not-exist.md"), stuck);
  } catch {
    t.skip("symlinks are not available on this platform");
    return;
  }
  const snapshotDir = path.join(s.stateDir, "snapshots", "notes");

  for (let attempt = 0; attempt < GENERATIONS + 1; attempt += 1) {
    const result = run(s, ["--accept-mass-delete"], true);
    assert.equal(result.status, 12, `attempt ${attempt}: ${result.stderr}`);
    assert.match(
      result.stderr,
      /--accept-mass-delete stopped: notes\/T0\.md exists on disk but is not a regular file the sync collects/
    );
  }

  assert.deepEqual(fs.readdirSync(snapshotDir), [seededId], "no snapshot was written");
  assert.equal(fs.lstatSync(stuck).isSymbolicLink(), true, "the symlink is still there");
});
