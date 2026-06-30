// Unit tests for packages/memory-digest-cli/src/commands/generate.ts
//
// Strategy: Register the command on a fresh Commander instance, then REPLACE
// the action handler with a spy before calling parseAsync.  This drives the
// option-parsing layer without touching the filesystem or any external lib.
//
// The action override is the standard Commander API — calling .action() again
// replaces the previously registered handler.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { registerGenerateCommand } from "../src/commands/generate.js";

// Helper: create a fresh program with the generate subcommand registered and
// return references to both.  Each test call gets a completely isolated
// Commander tree so option-parser state never bleeds between tests.
function buildProgram(): { program: Command; generateCmd: Command } {
  const program = new Command();
  // Prevent Commander from calling process.exit on unknown args or --help.
  program.exitOverride();
  program.allowUnknownOption(false);

  registerGenerateCommand(program);

  const generateCmd = program.commands.find((c) => c.name() === "generate");
  assert.ok(generateCmd, "generate subcommand must be registered by registerGenerateCommand");
  return { program, generateCmd: generateCmd! };
}

// ─── registration ────────────────────────────────────────────────────────────

test("registerGenerateCommand: registers a subcommand named 'generate'", () => {
  const { generateCmd } = buildProgram();
  assert.equal(generateCmd.name(), "generate");
});

test("registerGenerateCommand: subcommand has a non-empty description", () => {
  const { generateCmd } = buildProgram();
  assert.ok(
    generateCmd.description().length > 0,
    "description should not be empty"
  );
});

// ─── default option values ───────────────────────────────────────────────────

test("generate: default options are correct when no flags are passed", async () => {
  const { program, generateCmd } = buildProgram();

  let capturedOptions: Record<string, unknown> | undefined;
  generateCmd.action((opts: Record<string, unknown>) => {
    capturedOptions = opts;
  });

  await program.parseAsync(["generate"], { from: "user" });

  assert.ok(capturedOptions !== undefined, "action must have been called");
  assert.equal(capturedOptions.dir, process.cwd(), "--dir default must be process.cwd()");
  assert.equal(capturedOptions.days, "7", "--days default must be '7'");
  assert.equal(capturedOptions.max, "50", "--max default must be '50'");
  assert.equal(capturedOptions.recursive, false, "--recursive default must be false");
  assert.equal(capturedOptions.json, false, "--json default must be false");
  assert.equal(capturedOptions.output, undefined, "--output default must be undefined");
});

// ─── non-default flag mappings ───────────────────────────────────────────────

test("generate: --days and --max override their defaults", async () => {
  const { program, generateCmd } = buildProgram();

  let capturedOptions: Record<string, unknown> | undefined;
  generateCmd.action((opts: Record<string, unknown>) => {
    capturedOptions = opts;
  });

  await program.parseAsync(
    ["generate", "--days", "30", "--max", "100"],
    { from: "user" }
  );

  assert.equal(capturedOptions!.days, "30");
  assert.equal(capturedOptions!.max, "100");
  // Unaffected defaults must remain intact.
  assert.equal(capturedOptions!.recursive, false);
  assert.equal(capturedOptions!.json, false);
});

test("generate: --recursive and --json boolean flags are set to true", async () => {
  const { program, generateCmd } = buildProgram();

  let capturedOptions: Record<string, unknown> | undefined;
  generateCmd.action((opts: Record<string, unknown>) => {
    capturedOptions = opts;
  });

  await program.parseAsync(["generate", "--recursive", "--json"], { from: "user" });

  assert.equal(capturedOptions!.recursive, true, "--recursive must become true");
  assert.equal(capturedOptions!.json, true, "--json must become true");
});

test("generate: -d short alias sets the dir option", async () => {
  const { program, generateCmd } = buildProgram();

  let capturedOptions: Record<string, unknown> | undefined;
  generateCmd.action((opts: Record<string, unknown>) => {
    capturedOptions = opts;
  });

  await program.parseAsync(["generate", "-d", "/tmp/my-memories"], { from: "user" });

  assert.equal(capturedOptions!.dir, "/tmp/my-memories");
});

test("generate: -o short alias sets the output option", async () => {
  const { program, generateCmd } = buildProgram();

  let capturedOptions: Record<string, unknown> | undefined;
  generateCmd.action((opts: Record<string, unknown>) => {
    capturedOptions = opts;
  });

  await program.parseAsync(["generate", "-o", "digest.md"], { from: "user" });

  assert.equal(capturedOptions!.output, "digest.md");
});

test("generate: all non-default flags can be passed together", async () => {
  const { program, generateCmd } = buildProgram();

  let capturedOptions: Record<string, unknown> | undefined;
  generateCmd.action((opts: Record<string, unknown>) => {
    capturedOptions = opts;
  });

  await program.parseAsync(
    [
      "generate",
      "--dir", "/tmp/memories",
      "--output", "out.json",
      "--days", "14",
      "--max", "200",
      "--recursive",
      "--json",
    ],
    { from: "user" }
  );

  assert.equal(capturedOptions!.dir, "/tmp/memories");
  assert.equal(capturedOptions!.output, "out.json");
  assert.equal(capturedOptions!.days, "14");
  assert.equal(capturedOptions!.max, "200");
  assert.equal(capturedOptions!.recursive, true);
  assert.equal(capturedOptions!.json, true);
});
