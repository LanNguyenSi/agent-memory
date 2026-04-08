const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createSandbox, initBareRemote, runCli, writeProjectConfig, writeText } = require("../helpers/cli.ts");

test("json output keeps the top-level run schema stable", () => {
  const root = createSandbox("contract");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "contract\n");
  writeProjectConfig(configPath, {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    repositorySubdir: "shared",
    syncPaths: [{ source: "MEMORY.md", destination: "MEMORY.md", kind: "file" }]
  });

  const result = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.deepEqual(Object.keys(payload).sort(), ["command", "dryRun", "mode", "profile", "runs", "schedule"]);
  assert.equal(payload.command, "run");
  assert.equal(payload.mode, "push");
  assert.equal(Array.isArray(payload.runs), true);

  const run = payload.runs[0];
  assert.deepEqual(
    Object.keys(run).sort(),
    [
      "appliedFiles",
      "conflictFiles",
      "kind",
      "mergedFiles",
      "notes",
      "queuedSnapshotId",
      "remoteHeadAfter",
      "remoteHeadBefore",
      "status"
    ]
  );
});
