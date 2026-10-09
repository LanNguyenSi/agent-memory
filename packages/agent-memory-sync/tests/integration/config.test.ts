const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createSandbox, fileExists, initBareRemote, runCli, writeText } = require("../helpers/cli.ts");

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
test("config get on a supported key that was never set exits 11 with a clear error", () => {
  const root = createSandbox("config-unset-key");
  const configPath = path.join(root, "config.json");

  // An empty-but-valid persisted config: `set` on a different key first, so
  // the file exists, but "branch" itself is never written.
  runCli(["config", "set", "remoteUrl", "/tmp/remote.git", "--config", configPath]);

  const result = runCli(["config", "get", "branch", "--config", configPath], { expectFailure: true });

  assert.equal(result.status, 11);
  assert.match(result.stderr, /config key 'branch' is not set/);
});

// validateConfigKey (src/config/loader.ts) rejects an unsupported key before
// getConfigValue ever runs, so this must stay on exit `3` even though an
// unset-but-supported key (test above) now exits `11`; the two are
// distinguished by exit code alone per the README's exit-code table.
test("config get on an unsupported key exits 3, distinct from an unset supported key", () => {
  const root = createSandbox("config-unsupported-key");
  const configPath = path.join(root, "config.json");

  runCli(["config", "set", "remoteUrl", "/tmp/remote.git", "--config", configPath]);

  const result = runCli(["config", "get", "notARealKey", "--config", configPath], { expectFailure: true });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /config key 'notARealKey' is not supported/);
});

// Every command that actually syncs (run, watch, restore) now refuses an
// explicitly named config path that does not exist, instead of loadConfig's
// usual silent {} fallback (which would run on bare defaults as if nothing
// were wrong: no remote, no real syncPaths). "config show"/"config get"
// keep the permissive fallback (loadConfig without requireExisting, see
// src/config/loader.ts), since inspecting a not-yet-configured machine is a
// legitimate use, unlike actually syncing against one.
test("run with a missing explicit --config path exits 3 naming the path, instead of silently syncing on defaults", () => {
  const root = createSandbox("config-missing-explicit-run");
  const missingConfigPath = path.join(root, "does-not-exist.json");

  const result = runCli(["run", "default", "--config", missingConfigPath, "--mode", "push"], {
    expectFailure: true
  });

  assert.equal(result.status, 3);
  assert.ok(result.stderr.includes(missingConfigPath), `expected the missing path in stderr, got: ${result.stderr}`);
  assert.match(result.stderr, /does not exist/);
  // The fix hint points at restoring the file first. It must not suggest
  // `config set`, which would create a stub that silently replaces a real
  // profile lost during migration.
  assert.match(
    result.stderr,
    /Restore the file \(see docs\/machine-setup\.md, section 'Real per-machine profiles are local-only'\)/
  );
  assert.doesNotMatch(result.stderr, /config set/);
});

test("watch with a missing explicit --config path exits 3 naming the path, before ever starting the watch loop", () => {
  const root = createSandbox("config-missing-explicit-watch");
  const missingConfigPath = path.join(root, "does-not-exist.json");

  const result = runCli(["watch", "default", "--config", missingConfigPath], { expectFailure: true });

  assert.equal(result.status, 3);
  assert.ok(result.stderr.includes(missingConfigPath), `expected the missing path in stderr, got: ${result.stderr}`);
  assert.match(result.stderr, /does not exist/);
});

test("restore with a missing explicit --config path exits 3 naming the path", () => {
  const root = createSandbox("config-missing-explicit-restore");
  const missingConfigPath = path.join(root, "does-not-exist.json");

  // A syntactically valid-looking commit sha, so restore's own sha-shape
  // check (exit 2, checked before the config is even loaded) does not fire
  // first and mask the config check this test is actually about.
  const result = runCli(["restore", "abcd1234", "--config", missingConfigPath], { expectFailure: true });

  assert.equal(result.status, 3);
  assert.ok(result.stderr.includes(missingConfigPath), `expected the missing path in stderr, got: ${result.stderr}`);
  assert.match(result.stderr, /does not exist/);
});

test("run with AGENT_MEMORY_SYNC_CONFIG pointing at a missing file exits 3 naming the path too", () => {
  const root = createSandbox("config-missing-env-run");
  const missingConfigPath = path.join(root, "does-not-exist.json");

  const result = runCli(["run", "default", "--mode", "push"], {
    expectFailure: true,
    env: { ...process.env, AGENT_MEMORY_SYNC_CONFIG: missingConfigPath }
  });

  assert.equal(result.status, 3);
  assert.ok(result.stderr.includes(missingConfigPath), `expected the missing path in stderr, got: ${result.stderr}`);
});

// The create-on-write path this change must NOT break: `config set` reads
// via readPersistedConfig (which never sets requireExisting), so a brand
// new, not-yet-existing --config path is still created rather than refused.
test("config set on a --config path that does not exist yet still creates it", () => {
  const root = createSandbox("config-set-creates-new-file");
  const configPath = path.join(root, "brand-new-subdir", "config.json");

  assert.equal(fileExists(configPath), false);

  const result = runCli(["config", "set", "remoteUrl", "/tmp/remote.git", "--config", configPath]);

  assert.equal(result.status, 0);
  assert.equal(fileExists(configPath), true);
});

// The first-run invariant: the refusal above applies only to a path the
// caller named explicitly. A machine with no --config flag, no
// AGENT_MEMORY_SYNC_CONFIG and no file at the default location still syncs
// on defaults, as it always did.
test("run with no --config, no AGENT_MEMORY_SYNC_CONFIG and no default config file still syncs on defaults", () => {
  const root = createSandbox("config-first-run-defaults");
  const remoteDir = initBareRemote(root);
  const workspaceDir = path.join(root, "workspace");
  const emptyXdgConfigHome = path.join(root, "empty-xdg-config-home");
  writeText(path.join(workspaceDir, "MEMORY.md"), "first-run memory\n");
  writeText(path.join(emptyXdgConfigHome, ".keep"), "");

  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: emptyXdgConfigHome };
  delete env.AGENT_MEMORY_SYNC_CONFIG;
  assert.equal(fileExists(path.join(emptyXdgConfigHome, "agent-memory-sync", "config.json")), false);

  const result = runCli(
    [
      "run",
      "default",
      "--remote",
      remoteDir,
      "--root-dir",
      workspaceDir,
      "--state-dir",
      path.join(root, "state"),
      "--mode",
      "push",
      "--output",
      "json"
    ],
    { env, expectFailure: true }
  );

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  const payload = JSON.parse(result.stdout).runs[0];
  assert.equal(payload.status, "applied");
  assert.deepEqual(payload.appliedFiles, ["MEMORY.md"]);
});

// Inspecting commands keep the permissive fallback for a missing explicit
// path: `config show` reports empty settings, `config get` reports the key
// as not set (exit 11, ConfigKeyNotSetError), neither refuses the path.
test("config show on a missing explicit --config path exits 0 with empty settings", () => {
  const root = createSandbox("config-show-missing-explicit");
  const missingConfigPath = path.join(root, "does-not-exist.json");

  const result = runCli(["config", "show", "--config", missingConfigPath, "--output", "json"], {
    expectFailure: true
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.path, missingConfigPath);
  assert.deepEqual(payload.settings, {});
});

test("config get on a missing explicit --config path reports the key as not set (exit 11), not a missing file", () => {
  const root = createSandbox("config-get-missing-explicit");
  const missingConfigPath = path.join(root, "does-not-exist.json");

  const result = runCli(["config", "get", "remoteUrl", "--config", missingConfigPath], { expectFailure: true });

  assert.equal(result.status, 11);
  assert.match(result.stderr, /config key 'remoteUrl' is not set/);
  assert.doesNotMatch(result.stderr, /does not exist/);
});
