// With --accept-mass-delete adopting the hub's deletions in two destinations
// of one profile, a queued offline edit of a path that the hub deleted is held
// back with a note that names the pre-apply snapshot of the destination that
// holds the path, not the snapshot of another destination the same run took.
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
  writeText,
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
      { source: "beta", destination: "beta", kind: "directory" },
    ],
  };
}

function snapshotDirs(workspaceRoot: string, destination: string): string[] {
  const dir = path.join(
    workspaceRoot,
    ".agent-memory-sync",
    "default",
    "snapshots",
    destination,
  );
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
      writeText(
        path.join(workspaceRoot, destination, name),
        `${destination} ${name}\n`,
      );
    }
  }
  writeProjectConfig(configPath, profileConfig(workspaceRoot, remoteDir));
  writeProjectConfig(
    offlineConfigPath,
    profileConfig(workspaceRoot, path.join(root, "missing.git")),
  );
  runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "push",
    "--output",
    "json",
  ]);

  // An offline edit of a beta file is queued, not published.
  const edited = "note-005.md";
  writeText(path.join(workspaceRoot, "beta", edited), "offline edit\n");
  const queued = runCli([
    "run",
    "default",
    "--config",
    offlineConfigPath,
    "--mode",
    "push",
    "--output",
    "json",
  ]);
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
    "json",
  ]);
  const run = JSON.parse(accepted.stdout).runs[0];

  // Both destinations were adopted, each with its own pre-apply snapshot.
  const alphaIds = snapshotDirs(workspaceRoot, "alpha");
  const betaIds = snapshotDirs(workspaceRoot, "beta");
  assert.equal(alphaIds.length, 1);
  assert.equal(betaIds.length, 1);
  assert.notEqual(alphaIds[0], betaIds[0]);
  assert.equal(run.snapshots.length, 2, JSON.stringify(run.snapshots));

  const heldPath = `beta/${edited}`;
  const heldNotes = run.notes.filter((note: string) =>
    note.includes(`not published: ${heldPath}`),
  );
  assert.equal(heldNotes.length, 1, JSON.stringify(run.notes));
  const note: string = heldNotes[0];
  assert.ok(note.includes(`pre-apply snapshot ${betaIds[0]}`), note);
  assert.ok(!note.includes(alphaIds[0]), note);

  const snapshotFile = path.join(
    workspaceRoot,
    ".agent-memory-sync",
    "default",
    "snapshots",
    "beta",
    betaIds[0],
    "files",
    "beta",
    edited,
  );
  assert.ok(note.includes(snapshotFile), note);
  assert.equal(fs.existsSync(snapshotFile), true);
});
