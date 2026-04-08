const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createSandbox, runCli, writeProjectConfig, writeText } = require("../helpers/cli.ts");

test("run exits with code 3 when remote is missing", () => {
  const root = createSandbox("missing-remote");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "content\n");
  writeProjectConfig(configPath, {
    rootDir: workspaceRoot,
    syncPaths: [{ source: "MEMORY.md", kind: "file" }]
  });

  const result = runCli(["run", "default", "--config", configPath], { expectFailure: true });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /remote URL is not configured/i);
});

test("run exits with code 2 for an invalid cron expression", () => {
  const root = createSandbox("bad-cron");
  const configPath = path.join(root, "config.json");

  writeProjectConfig(configPath, {
    remoteUrl: path.join(root, "unused.git")
  });

  const result = runCli(
    ["run", "default", "--config", configPath, "--schedule", "* *"],
    { expectFailure: true }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /cron expression/i);
});
