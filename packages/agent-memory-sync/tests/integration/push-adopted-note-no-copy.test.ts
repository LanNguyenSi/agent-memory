// A queued offline edit of a path that is held back after --accept-mass-delete
// is recoverable from the adoption's pre-apply snapshot only when that
// snapshot holds the path. When the path had no local copy as the adoption ran
// (it was deleted locally after the edit was queued), the snapshot holds no
// copy, and the note must say so instead of naming a snapshot file that does
// not exist.
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");
const {
  createSandbox,
  initBareRemote,
  runCli,
  writeProjectConfig,
  writeText,
} = require("../helpers/cli.ts");

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
    syncPaths: [
      {
        source: path.join(spoke.workspace, "notes"),
        destination: "notes",
        kind: "directory",
      },
    ],
  });
}

function createSpoke(root: string, remoteDir: string, name: string): Spoke {
  const workspace = path.join(root, `workspace-${name}`);
  const spoke = {
    name,
    workspace,
    stateDir: path.join(root, `state-${name}`),
    configPath: path.join(root, `config-${name}.json`),
    root,
  };
  mkdirSync(path.join(workspace, "notes"), { recursive: true });
  writeSpokeConfig(spoke, remoteDir);
  return spoke;
}

function runPush(spoke: Spoke, extra: string[] = []) {
  const result = runCli([
    "run",
    spoke.name,
    "--config",
    spoke.configPath,
    "--mode",
    "push",
    "--output",
    "json",
    ...extra,
  ]);
  return JSON.parse(result.stdout).runs[0];
}

function runPull(spoke: Spoke) {
  runCli([
    "run",
    spoke.name,
    "--config",
    spoke.configPath,
    "--mode",
    "pull",
    "--output",
    "json",
  ]);
}

function notePath(spoke: Spoke, name: string): string {
  return path.join(spoke.workspace, "notes", name);
}

test("an adopted held-back path the adoption snapshot holds no copy of says so and names no copy step", () => {
  const root = createSandbox("push-adopted-note-no-copy");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-q");
  const peer = createSpoke(root, remoteDir, "spoke-peer");
  for (let index = 0; index < 10; index += 1) {
    writeText(notePath(s, `T${index}.md`), `t${index}\n`);
  }
  assert.equal(runPush(s).status, "applied");
  runPull(peer);

  writeSpokeConfig(s, path.join(root, "missing-remote.git"));
  writeText(notePath(s, "T0.md"), "t0 edited offline\n");
  assert.equal(runPush(s).status, "queued");
  // The path has no local copy by the time the adoption runs.
  rmSync(notePath(s, "T0.md"));

  for (let index = 0; index < 5; index += 1) {
    rmSync(notePath(peer, `T${index}.md`));
  }
  assert.equal(runPush(peer, ["--allow-mass-delete"]).status, "applied");

  writeSpokeConfig(s, remoteDir);
  const accepted = runPush(s, ["--accept-mass-delete"]);
  assert.equal(accepted.status, "applied");
  assert.equal(
    accepted.snapshots.length,
    1,
    "one pre-apply snapshot was taken",
  );
  assert.equal(
    existsSync(
      path.join(
        s.stateDir,
        "snapshots",
        "notes",
        accepted.snapshots[0],
        "files",
        "notes",
        "T0.md",
      ),
    ),
    false,
  );

  const note = accepted.notes.find((entry: string) =>
    entry.includes("notes/T0.md"),
  );
  assert.ok(note, JSON.stringify(accepted.notes));
  assert.ok(
    note.includes("holds no copy of notes/T0.md") &&
      note.includes("no local copy when the adoption ran"),
    `the note says the snapshot holds no copy: ${note}`,
  );
  assert.equal(
    note.includes("files/notes/T0.md"),
    false,
    `the note names no snapshot file: ${note}`,
  );
  assert.equal(
    note.includes("copy that one file"),
    false,
    `the note advises no copy step: ${note}`,
  );
  assert.equal(
    note.includes("restore"),
    false,
    `the note advises no restore fallback: ${note}`,
  );
  assert.equal(
    note.includes("<id>"),
    false,
    `the note is not the dry-run wording: ${note}`,
  );
});
