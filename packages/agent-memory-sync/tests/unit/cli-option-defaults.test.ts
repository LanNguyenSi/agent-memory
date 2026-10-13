// Commander-level pin of the removed-defaults change on run, watch and
// restore: -o/--output, -v/--verbose, -q/--quiet and --no-color carry no
// commander defaults, and the [profile] argument of run/watch has none
// either, so an omitted flag/positional reaches the action as undefined and
// dropUndefined in the loader lets the config file/env value apply. Each
// command is registered for real on a fresh commander Command and only its
// action is replaced by a capture, which keeps the real option and argument
// definitions these tests pin (tests/unit/config-precedence-json.test.ts
// covers buildRunOverrides/resolveRunConfig themselves).

const test = require("node:test");
const assert = require("node:assert/strict");
const { Command } = require("commander");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { registerRunCommand, buildRunOverrides } = require("../../src/commands/run");
const { registerWatchCommand } = require("../../src/commands/watch");
const { registerRestoreCommand } = require("../../src/commands/restore");
const { colorFromCli } = require("../../src/commands/cli-options");
const { resolveRunConfig } = require("../../src/config/loader");

type CapturedOptions = { output?: unknown; verbose?: unknown; quiet?: unknown; color?: boolean };
type ColorSourceCommand = { getOptionValueSource(name: string): string | undefined };

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

// Registers the real command on a fresh program, replaces only its action
// with a capture, parses, and returns the captured action arguments. The
// options object is the second-to-last captured argument, the command the
// last one.
async function capturedArgs(register: (program: unknown) => void, name: string, extraArgs: string[]): Promise<any[]> {
  const program = new Command();
  program.exitOverride();
  register(program);
  const sub = program.commands.find((command: { name(): string }) => command.name() === name);
  assert.ok(sub, `command '${name}' was not registered`);
  let captured: any[] = [];
  sub.action((...args: any[]) => {
    captured = args;
  });
  await program.parseAsync(["node", "cli", name, ...extraArgs]);
  assert.ok(captured.length > 0, "the replaced action was never invoked");
  return captured;
}

function optionsAndCommand(captured: any[]): [CapturedOptions, ColorSourceCommand] {
  return [captured[captured.length - 2] as CapturedOptions, captured[captured.length - 1] as ColorSourceCommand];
}

// ─── Omitted flags and positional: everything stays undefined ─────────────────

test("run: omitted --output/--verbose/--quiet/--no-color and [profile] arrive as undefined", async () => {
  const captured = await capturedArgs(registerRunCommand, "run", []);
  assert.equal(captured[0], undefined, "the [profile] positional must have no commander default");
  const [options, command] = optionsAndCommand(captured);
  assert.equal(options.output, undefined, "--output must have no commander default");
  assert.equal(options.verbose, undefined, "--verbose must have no commander default");
  assert.equal(options.quiet, undefined, "--quiet must have no commander default");
  assert.equal(colorFromCli(command, options), undefined, "--no-color must not be an override when omitted");
});

test("watch: omitted --output/--verbose/--quiet/--no-color and [profile] arrive as undefined", async () => {
  const captured = await capturedArgs(registerWatchCommand, "watch", []);
  assert.equal(captured[0], undefined, "the [profile] positional must have no commander default");
  const [options, command] = optionsAndCommand(captured);
  assert.equal(options.output, undefined, "--output must have no commander default");
  assert.equal(options.verbose, undefined, "--verbose must have no commander default");
  assert.equal(options.quiet, undefined, "--quiet must have no commander default");
  assert.equal(colorFromCli(command, options), undefined, "--no-color must not be an override when omitted");
});

test("restore: omitted --output/--verbose/--quiet/--no-color arrive as undefined", async () => {
  const captured = await capturedArgs(registerRestoreCommand, "restore", []);
  const [options, command] = optionsAndCommand(captured);
  assert.equal(options.output, undefined, "--output must have no commander default");
  assert.equal(options.verbose, undefined, "--verbose must have no commander default");
  assert.equal(options.quiet, undefined, "--quiet must have no commander default");
  assert.equal(colorFromCli(command, options), undefined, "--no-color must not be an override when omitted");
});

// ─── Passed flags: real CLI values, colorFromCli sees them ────────────────────

test("run: --no-color -o json arrive as real CLI values", async () => {
  const captured = await capturedArgs(registerRunCommand, "run", ["--no-color", "-o", "json"]);
  const [options, command] = optionsAndCommand(captured);
  assert.equal(colorFromCli(command, options), false, "--no-color must be an override when passed");
  assert.equal(options.output, "json", "-o json must reach the action as the value typed");
});

test("watch: --no-color arrives as a real CLI value", async () => {
  const captured = await capturedArgs(registerWatchCommand, "watch", ["--no-color"]);
  const [options, command] = optionsAndCommand(captured);
  assert.equal(colorFromCli(command, options), false, "--no-color must be an override when passed");
});

test("restore: --no-color arrives as a real CLI value", async () => {
  const captured = await capturedArgs(registerRestoreCommand, "restore", ["--no-color"]);
  const [options, command] = optionsAndCommand(captured);
  assert.equal(colorFromCli(command, options), false, "--no-color must be an override when passed");
});

// ─── End to end through buildRunOverrides + resolveRunConfig ──────────────────

// The captured no-flag options of a real `run` parse fed through exactly the
// pipeline the action runs: no override may beat the config file.
test("run: captured no-flag options keep the config file outputFormat/verbose/color/profile", async () => {
  const captured = await capturedArgs(registerRunCommand, "run", []);
  const profile = captured[0] as string | undefined;
  const [options, command] = optionsAndCommand(captured);

  const dir = mkdtempSync(path.join(tmpdir(), "ams-cli-defaults-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  const settings = { outputFormat: "json", verbose: true, quiet: false, color: false, profile: "p1" };
  writeFileSync(file, JSON.stringify(settings), "utf8");

  const loaded = { path: file, settings };
  const overrides = buildRunOverrides(profile, options, colorFromCli(command, options));
  const runConfig = resolveRunConfig(loaded, overrides);

  assert.equal(runConfig.outputFormat, "json", 'config file outputFormat: "json" must be honored');
  assert.equal(runConfig.verbose, true, "config file verbose must be honored");
  assert.equal(runConfig.color, false, "config file color must be honored");
  assert.equal(runConfig.profile, "p1", "config file profile must be honored");
});
