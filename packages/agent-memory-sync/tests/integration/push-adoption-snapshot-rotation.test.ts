// A push with --accept-mass-delete removes local files only after copying
// them into a pre-apply snapshot, and that snapshot has to outlive the run's
// own rotation. A clock that ran ahead earlier leaves generations whose ids
// sort after the id a correct clock produces now; rotation used to rank by id
// alone and so deleted the snapshot the run had just written, after which the
// adoption removed the local files with no surviving copy anywhere.
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, readFileSync, rmSync } = require("node:fs");
const path = require("node:path");
const { writePreApplySnapshot } = require("../../src/memory-sync/pre-apply-snapshot");
const { createSandbox, initBareRemote, runCli, writeProjectConfig, writeText } = require("../helpers/cli.ts");

interface Spoke {
  name: string;
  workspace: string;
  stateDir: string;
  configPath: string;
}

function createSpoke(root: string, remoteDir: string, name: string): Spoke {
  const workspace = path.join(root, `workspace-${name}`);
  const spoke = {
    name,
    workspace,
    stateDir: path.join(root, `state-${name}`),
    configPath: path.join(root, `config-${name}.json`)
  };
  mkdirSync(path.join(workspace, "notes"), { recursive: true });
  writeProjectConfig(spoke.configPath, {
    profile: name,
    rootDir: workspace,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: spoke.stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: [{ source: path.join(workspace, "notes"), destination: "notes", kind: "directory" }]
  });
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
    ...extra
  ]);
  return JSON.parse(result.stdout).runs[0];
}

test("an accepted deletion keeps its own pre-apply snapshot when earlier generations are future-dated", () => {
  const root = createSandbox("push-adoption-snapshot-rotation");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  const peer = createSpoke(root, remoteDir, "spoke-peer");
  for (let index = 0; index < 10; index += 1) {
    writeText(path.join(s.workspace, "notes", `T${index}.md`), `t${index}\n`);
  }
  assert.equal(runPush(s).status, "applied");
  runCli(["run", peer.name, "--config", peer.configPath, "--mode", "pull", "--output", "json"]);

  for (let index = 0; index < 5; index += 1) {
    rmSync(path.join(peer.workspace, "notes", `T${index}.md`));
  }
  assert.equal(runPush(peer, ["--allow-mass-delete"]).status, "applied");

  // Three generations stamped far in the future, as an earlier skewed clock
  // would have left them; the default retention is three.
  const files = [{ remoteRelativePath: "notes/T0.md", absolutePath: path.join(s.workspace, "notes", "T0.md") }];
  for (const day of [1, 2, 3]) {
    writePreApplySnapshot({
      stateDir: s.stateDir,
      destination: "notes",
      files,
      now: new Date(Date.UTC(2999, 0, day))
    });
  }

  const accepted = runPush(s, ["--accept-mass-delete"]);
  assert.equal(accepted.status, "applied");
  assert.equal(accepted.snapshots.length, 1);

  // T0 was kept locally until the adoption removed it, so the run's own
  // snapshot is now the only copy of it.
  assert.equal(existsSync(path.join(s.workspace, "notes", "T0.md")), false);
  const snapshotFile = path.join(s.stateDir, "snapshots", "notes", accepted.snapshots[0], "files", "notes", "T0.md");
  assert.equal(existsSync(snapshotFile), true, `the adoption's snapshot ${accepted.snapshots[0]} survives rotation`);
  assert.equal(readFileSync(snapshotFile, "utf8"), "t0\n");
});
