const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createSandbox, runCli } = require("../helpers/cli.ts");

test("config set, get, show, and reset manage the persisted config file", () => {
  const root = createSandbox("config");
  const configPath = path.join(root, "config.json");

  const setResult = runCli(["config", "set", "remoteUrl", "/tmp/remote.git", "--config", configPath]);
  assert.equal(setResult.status, 0);

  const getResult = runCli(["config", "get", "remoteUrl", "--config", configPath]);
  assert.equal(getResult.stdout.trim(), "/tmp/remote.git");

  const showResult = runCli(["config", "show", "--config", configPath, "--output", "json"]);
  const payload = JSON.parse(showResult.stdout);
  assert.equal(payload.settings.remoteUrl, "/tmp/remote.git");

  const resetResult = runCli(["config", "reset", "--config", configPath]);
  assert.equal(resetResult.status, 0);
});
