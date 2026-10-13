// Coverage for the loader precedence + JSON-parse-error + commander-default
// changes in src/config/loader.ts and src/commands/run.ts.
//
// Hermetic: loadConfig/resolveRunConfig/setConfigValue are driven directly
// against temp config files and a cleared AGENT_MEMORY_SYNC_* environment
// (same style as tests/unit/env-config.test.ts). Every env var touched is
// saved in beforeEach and restored in afterEach.

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { CliError } = require("../../src/errors");
const { loadConfig, resolveRunConfig, setConfigValue, readPersistedConfig } = require("../../src/config/loader");
const { buildRunOverrides } = require("../../src/commands/run");

let savedEnv: Record<string, string | undefined> = {};

test.beforeEach(() => {
  savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AGENT_MEMORY_SYNC_")) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

test.afterEach(() => {
  for (const key of Object.keys(savedEnv)) {
    if (typeof savedEnv[key] === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key] as string;
    }
  }
});

function writeConfig(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ams-loader-"));
  const file = path.join(dir, "config.json");
  writeFileSync(file, contents, "utf8");
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

// ─── JSON parse errors -> CliError exit 3, naming the source ──────────────────

test("readPersistedConfig (config show) of a config file that is not valid JSON throws CliError exit 3 naming the path", () => {
  const file = writeConfig("{");
  assert.throws(
    () => readPersistedConfig(file),
    (error: unknown) => {
      assert.ok(error instanceof CliError, `expected CliError, got ${String(error)}`);
      assert.equal((error as InstanceType<typeof CliError>).exitCode, 3);
      assert.match((error as Error).message, /is not valid JSON/);
      assert.ok(
        (error as Error).message.includes(file),
        `message should name the path ${file}, got: ${(error as Error).message}`
      );
      return true;
    }
  );
});

test("config set of massDeleteGuard with an invalid JSON value throws CliError exit 3 naming the key", () => {
  assert.throws(
    () => setConfigValue({}, "massDeleteGuard", "{"),
    (error: unknown) => {
      assert.ok(error instanceof CliError, `expected CliError, got ${String(error)}`);
      assert.equal((error as InstanceType<typeof CliError>).exitCode, 3);
      assert.ok(
        (error as Error).message.includes("massDeleteGuard"),
        `message should name the key, got: ${(error as Error).message}`
      );
      return true;
    }
  );
});

test("config set of reachabilityCheckCommand with an invalid JSON value throws CliError exit 3 naming the key", () => {
  assert.throws(
    () => setConfigValue({}, "reachabilityCheckCommand", "["),
    (error: unknown) => {
      assert.ok(error instanceof CliError, `expected CliError, got ${String(error)}`);
      assert.equal((error as InstanceType<typeof CliError>).exitCode, 3);
      assert.ok(
        (error as Error).message.includes("reachabilityCheckCommand"),
        `message should name the key, got: ${(error as Error).message}`
      );
      return true;
    }
  );
});

test("invalid JSON in the config file throws CliError exit 3 naming the path", async () => {
  const file = writeConfig("{ this is not json");
  await assert.rejects(
    () => loadConfig(file, { requireExisting: true }),
    (error: unknown) => {
      assert.ok(error instanceof CliError, `expected CliError, got ${String(error)}`);
      assert.equal((error as InstanceType<typeof CliError>).exitCode, 3);
      assert.match((error as Error).message, /is not valid JSON/);
      assert.ok(
        (error as Error).message.includes(file),
        `message should name the path ${file}, got: ${(error as Error).message}`
      );
      return true;
    }
  );
});

test("invalid JSON in AGENT_MEMORY_SYNC_SYNC_PATHS throws CliError exit 3 naming the variable", async () => {
  process.env.AGENT_MEMORY_SYNC_SYNC_PATHS = "{";
  const file = writeConfig("{}");
  const loaded = await loadConfig(file);
  assert.throws(
    () => resolveRunConfig(loaded, { remoteUrl: "/tmp/does-not-matter.git" }),
    (error: unknown) => {
      assert.ok(error instanceof CliError, `expected CliError, got ${String(error)}`);
      assert.equal((error as InstanceType<typeof CliError>).exitCode, 3);
      assert.ok(
        (error as Error).message.includes("AGENT_MEMORY_SYNC_SYNC_PATHS"),
        `message should name the env var, got: ${(error as Error).message}`
      );
      return true;
    }
  );
});

test("config set of a JSON-valued key with an invalid value throws CliError exit 3 naming the key", () => {
  assert.throws(
    () => setConfigValue({}, "syncPaths", "{"),
    (error: unknown) => {
      assert.ok(error instanceof CliError, `expected CliError, got ${String(error)}`);
      assert.equal((error as InstanceType<typeof CliError>).exitCode, 3);
      assert.ok(
        (error as Error).message.includes("syncPaths"),
        `message should name the key, got: ${(error as Error).message}`
      );
      return true;
    }
  );
});

// ─── Precedence: env overrides config file, CLI overrides both ────────────────

test("environment value overrides the config file; a CLI override beats both", async () => {
  const file = writeConfig(JSON.stringify({ remoteUrl: "https://from-config-file.example/repo.git" }));

  process.env.AGENT_MEMORY_SYNC_REMOTE_URL = "https://from-env.example/repo.git";
  const loaded = await loadConfig(file, { requireExisting: true });

  const withEnv = resolveRunConfig(loaded);
  assert.equal(withEnv.remoteUrl, "https://from-env.example/repo.git", "env must override the config file");

  const withCli = resolveRunConfig(loaded, { remoteUrl: "https://from-cli.example/repo.git" });
  assert.equal(withCli.remoteUrl, "https://from-cli.example/repo.git", "CLI override must beat env and file");
});

// ─── Commander defaults are gone: omitted flags defer to the config file ───────

// buildRunOverrides is the extracted overrides builder (registerRunCommand's
// action would otherwise require a full sandbox + remote to reach
// resolveRunConfig). Options here mimic what commander hands the action when
// the flag was never passed: output/verbose/quiet undefined, color defaulted
// to true by commander's --no-color handling but NOT sourced from the CLI;
// the command stub reports no CLI source for color, as commander does then.
test("run: omitted --output/--verbose/--quiet/--no-color leave those keys to the config file", () => {
  const file = writeConfig(JSON.stringify({ outputFormat: "json", verbose: true, quiet: false }));
  const overrides = buildRunOverrides(
    undefined,
    { mode: "sync", dryRun: false, color: true },
    { getOptionValueSource: () => "default" }
  );

  assert.equal(overrides.outputFormat, undefined, "--output must be dropped when omitted");
  assert.equal(overrides.verbose, undefined, "--verbose must be dropped when omitted");
  assert.equal(overrides.quiet, undefined, "--quiet must be dropped when omitted");
  assert.equal(overrides.color, undefined, "--no-color must be dropped when omitted");
  assert.equal(overrides.profile, undefined, "the profile argument must be dropped when omitted");

  const loaded = { path: file, settings: JSON.parse(require("node:fs").readFileSync(file, "utf8")) };
  const runConfig = resolveRunConfig(loaded, overrides);
  assert.equal(runConfig.outputFormat, "json", 'config file outputFormat: "json" must be honored');
  assert.equal(runConfig.verbose, true, "config file verbose must be honored");
  assert.equal(runConfig.profile, "default", "an omitted profile argument falls back to the loader default");
});

test("run: --no-color passed overrides the config file color", () => {
  const overrides = buildRunOverrides(
    undefined,
    { mode: "sync", dryRun: false, color: false },
    { getOptionValueSource: (name: string) => (name === "color" ? "cli" : undefined) }
  );
  assert.equal(overrides.color, false, "color must be an override when --no-color was passed");
});
