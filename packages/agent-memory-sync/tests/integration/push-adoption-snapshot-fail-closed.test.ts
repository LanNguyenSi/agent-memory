// A push with --accept-mass-delete whose pre-apply snapshot is not intact
// before the first deletion stops with its own exit code (12), names the
// cause on stderr, removes no local file and leaves the base snapshot alone.
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");
const { StateStore } = require("../../src/memory-sync/state-store");
const { createSandbox, initBareRemote, runCli, writeProjectConfig, writeText } = require("../helpers/cli.ts");

const preload = path.resolve(process.cwd(), "tests", "helpers", "drop-adoption-snapshot.cjs");

function createSpoke(root: string, remoteDir: string, name: string) {
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

function runPush(
  spoke: { name: string; configPath: string },
  extra: string[] = [],
  options: { env?: NodeJS.ProcessEnv; expectFailure?: boolean } = {}
) {
  return runCli(
    ["run", spoke.name, "--config", spoke.configPath, "--mode", "push", "--output", "json", ...extra],
    options
  );
}

function baseSnapshot(spoke: { name: string; stateDir: string }): Record<string, string | null> {
  return new StateStore(spoke.stateDir, spoke.name).readBaseSnapshots();
}

test("an accepted deletion whose snapshot is gone exits 12, names the cause and removes nothing", () => {
  const root = createSandbox("push-adoption-fail-closed");
  const remoteDir = initBareRemote(root);
  const s = createSpoke(root, remoteDir, "spoke-s");
  const peer = createSpoke(root, remoteDir, "spoke-peer");
  for (let index = 0; index < 10; index += 1) {
    writeText(path.join(s.workspace, "notes", `T${index}.md`), `t${index}\n`);
  }
  runPush(s);
  runCli(["run", peer.name, "--config", peer.configPath, "--mode", "pull", "--output", "json"]);
  for (let index = 0; index < 5; index += 1) {
    rmSync(path.join(peer.workspace, "notes", `T${index}.md`));
  }
  runPush(peer, ["--allow-mass-delete"]);

  const baseBefore = baseSnapshot(s);
  assert.equal(Object.keys(baseBefore).length, 10);
  const result = runPush(s, ["--accept-mass-delete"], {
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${preload}"`.trim(),
      AGENT_MEMORY_SYNC_TEST_DROP_SNAPSHOT: "1"
    },
    expectFailure: true
  });

  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stderr, /--accept-mass-delete stopped: the pre-apply snapshot for 'notes' is not intact/);
  assert.match(result.stderr, /No local file was removed and the base snapshot was not moved/);
  for (let index = 0; index < 10; index += 1) {
    assert.equal(existsSync(path.join(s.workspace, "notes", `T${index}.md`)), true, `T${index}.md is still on disk`);
  }
  assert.deepEqual(baseSnapshot(s), baseBefore, "the base snapshot did not move");
});
