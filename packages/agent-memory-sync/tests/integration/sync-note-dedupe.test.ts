// `run --mode sync` combines the pull and push notes and drops the push-side
// note for a path whose hub copy carries conflict markers, because the pull
// side already named it. The filter is only for that one note: a push note for
// any other held-back path (here a merge conflict) must still be reported.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
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

const THREE_MARKERS =
  "<<<<<<< local\nmine\n=======\n<<<<<<< local\ntheirs\n=======\n<<<<<<< local\nolder\n=======\nold\n>>>>>>> remote\n>>>>>>> remote\n>>>>>>> remote\n";

test("a sync keeps the not-published note of a merge-conflict path and names a pull-refused markered hub path once", () => {
  const root = createSandbox("sync-note-dedupe");
  const remoteDir = initBareRemote(root);
  const workspace = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  mkdirSync(path.join(workspace, "notes"), { recursive: true });
  writeProjectConfig(configPath, {
    profile: "spoke",
    rootDir: workspace,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: path.join(root, "state"),
    conflictStrategy: "inline-markers",
    syncPaths: [
      {
        source: path.join(workspace, "notes"),
        destination: "notes",
        kind: "directory",
      },
    ],
  });
  const runSync = () => {
    const result = runCli([
      "run",
      "spoke",
      "--config",
      configPath,
      "--mode",
      "sync",
      "--output",
      "json",
    ]);
    return JSON.parse(result.stdout).runs[0];
  };

  writeText(path.join(workspace, "notes", "H.md"), "base\n");
  writeText(path.join(workspace, "notes", "C.md"), "base\n");
  assert.equal(runSync().status, "applied");

  // The hub copy of H carries markers; the hub and this machine both edit C.
  const peer = cloneRemote(remoteDir, root, "peer-sync-dedupe");
  writeText(path.join(peer, "shared", "notes", "H.md"), THREE_MARKERS);
  writeText(path.join(peer, "shared", "notes", "C.md"), "hub edit\n");
  git(["add", "."], peer);
  git(["commit", "-m", "hub edits"], peer);
  git(["push", "origin", "HEAD:main"], peer);
  writeText(path.join(workspace, "notes", "C.md"), "local edit\n");

  const run = runSync();
  assert.ok(
    run.conflictFiles.includes("notes/H.md"),
    JSON.stringify(run.conflictFiles),
  );
  assert.ok(
    run.conflictFiles.includes("notes/C.md"),
    JSON.stringify(run.conflictFiles),
  );

  const hubPathNotes = run.notes.filter((note: string) =>
    note.includes("notes/H.md"),
  );
  assert.equal(hubPathNotes.length, 1, JSON.stringify(run.notes));
  assert.ok(
    hubPathNotes[0].startsWith("not pulled: notes/H.md"),
    hubPathNotes[0],
  );

  const conflictNotes = run.notes.filter((note: string) =>
    note.startsWith("not published: notes/C.md"),
  );
  assert.equal(conflictNotes.length, 1, JSON.stringify(run.notes));
});
