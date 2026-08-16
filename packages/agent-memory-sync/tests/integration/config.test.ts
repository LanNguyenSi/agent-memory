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

// commands/config.ts's "get" prints `typeof value === "string" ? value :
// JSON.stringify(value)` — the test above only ever gets a string-valued key
// (remoteUrl), so the JSON.stringify(non-string) branch was untested.
// "verbose" is a boolean-typed config key (src/config/loader.ts's
// parseConfigValue), so getting it back exercises that branch.
test("config get on a non-string-typed key (verbose, a boolean) prints its JSON.stringify'd form", () => {
  const root = createSandbox("config-boolean-value");
  const configPath = path.join(root, "config.json");

  runCli(["config", "set", "verbose", "true", "--config", configPath]);
  const getResult = runCli(["config", "get", "verbose", "--config", configPath]);

  assert.equal(getResult.stdout.trim(), "true");
});

// getConfigValue throws when the key exists in the schema (validateConfigKey
// passes) but was never persisted — distinct from an unsupported key
// entirely, which validateConfigKey itself rejects earlier.
test("config get on a supported key that was never set exits non-zero with a clear error", () => {
  const root = createSandbox("config-unset-key");
  const configPath = path.join(root, "config.json");

  // An empty-but-valid persisted config: `set` on a different key first, so
  // the file exists, but "branch" itself is never written.
  runCli(["config", "set", "remoteUrl", "/tmp/remote.git", "--config", configPath]);

  const result = runCli(["config", "get", "branch", "--config", configPath], { expectFailure: true });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /config key 'branch' is not set/);
});
