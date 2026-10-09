// With --accept-mass-delete adopting the hub's deletions in two destinations
// of one profile, a queued offline edit of a path that the hub deleted is held
// back with a note that names the pre-apply snapshot of the destination that
// holds the path, not the snapshot of another destination the same run took,
// whichever of the destinations was snapshotted first or last.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  cloneRemote,
  createSandbox,
  git,
  initBareRemote,
  runCli,
  writeProjectConfig,
  writeText
} = require("../helpers/cli.ts");

function profileConfig(workspaceRoot: string, remoteUrl: string) {
  return {
    rootDir: workspaceRoot,
    remoteUrl,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    syncPaths: [
      { source: "alpha", destination: "alpha", kind: "directory" },
      { source: "beta", destination: "beta", kind: "directory" }
    ]
  };
}

function snapshotDirs(workspaceRoot: string, destination: string): string[] {
  const dir = path.join(workspaceRoot, ".agent-memory-sync", "default", "snapshots", destination);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

test("the hold-back note names the snapshot of the destination that holds the path", () => {
  const root = createSandbox("adoption-multi-destination");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const offlineConfigPath = path.join(root, "config-offline.json");

  const names: string[] = [];
  for (let index = 0; index < 50; index += 1) {
    names.push(`note-${String(index).padStart(3, "0")}.md`);
  }
  for (const destination of ["alpha", "beta"]) {
    for (const name of names) {
      writeText(path.join(workspaceRoot, destination, name), `${destination} ${name}\n`);
    }
  }
  writeProjectConfig(configPath, profileConfig(workspaceRoot, remoteDir));
  writeProjectConfig(offlineConfigPath, profileConfig(workspaceRoot, path.join(root, "missing.git")));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // Offline edits of one alpha file and one beta file are queued, not published.
  const edited = "note-005.md";
  for (const destination of ["alpha", "beta"]) {
    writeText(path.join(workspaceRoot, destination, edited), "offline edit\n");
  }
  const queued = runCli(["run", "default", "--config", offlineConfigPath, "--mode", "push", "--output", "json"]);
  assert.equal(JSON.parse(queued.stdout).runs[0].status, "queued");

  // The hub drops 30 files in each destination, including the edited one.
  const peer = cloneRemote(remoteDir, root, "peer-multi-destination");
  for (const destination of ["alpha", "beta"]) {
    for (const name of names.slice(0, 30)) {
      fs.rmSync(path.join(peer, "shared", destination, name));
    }
  }
  git(["add", "-A"], peer);
  git(["commit", "-m", "peer drops files"], peer);
  git(["push", "origin", "HEAD:main"], peer);

  const accepted = runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "push",
    "--accept-mass-delete",
    "--output",
    "json"
  ]);
  const run = JSON.parse(accepted.stdout).runs[0];

  // Both destinations were adopted, each with its own pre-apply snapshot.
  const idsByDestination: Record<string, string[]> = {
    alpha: snapshotDirs(workspaceRoot, "alpha"),
    beta: snapshotDirs(workspaceRoot, "beta")
  };
  assert.equal(idsByDestination.alpha.length, 1);
  assert.equal(idsByDestination.beta.length, 1);
  assert.equal(run.snapshots.length, 2, JSON.stringify(run.snapshots));

  // Each held-back path names the snapshot of its own destination: the snapshot
  // taken first for alpha and the one taken last for beta. Ids can share a
  // millisecond across destinations, so the destination is told apart by the
  // snapshot path segment, not by the id.
  for (const [destination, other] of [
    ["alpha", "beta"],
    ["beta", "alpha"]
  ]) {
    const id = idsByDestination[destination][0];
    const heldPath = `${destination}/${edited}`;
    const heldNotes = run.notes.filter((note: string) => note.includes(`not published: ${heldPath}`));
    assert.equal(heldNotes.length, 1, JSON.stringify(run.notes));
    const note: string = heldNotes[0];
    assert.ok(note.includes(`pre-apply snapshot ${id}`), note);

    const snapshotsRoot = path.join(workspaceRoot, ".agent-memory-sync", "default", "snapshots");
    const snapshotFile = path.join(snapshotsRoot, destination, id, "files", destination, edited);
    assert.ok(note.includes(snapshotFile), note);
    assert.ok(!note.includes(path.join(snapshotsRoot, other)), note);
    assert.equal(fs.existsSync(snapshotFile), true);
  }
});
