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
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

test("registerGenerateCommand: subcommand has the expected description", () => {
  const { generateCmd } = buildProgram();
  assert.equal(
    generateCmd.description(),
    "Generate a memory digest from markdown files"
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

// ─── real-action integration tests ──────────────────────────────────────────
//
// The tests above all replace the action handler with a spy, so the real
// action body in generate.ts (scan → extract → generate → format →
// write/print, plus the catch/process.exit path) is never exercised. The
// tests below run the REAL action registered by registerGenerateCommand
// against real temp-dir fixtures on disk.
//
// The scanner only matches files literally named `YYYY-MM-DD.md` and filters
// by the date encoded in the filename (not mtime), so fixtures must use
// today's date computed at test-run time -- a hardcoded date would drift out
// of the default 7-day window and start failing later.

function todayFileName(): string {
  return `${new Date().toISOString().slice(0, 10)}.md`;
}

// Sentinel thrown by the stubbed process.exit so the real action's async
// control flow stops exactly where the real process.exit would have
// terminated the process, without actually killing the test runner.
class ProcessExitSentinel extends Error {
  code: number | undefined;
  constructor(code: number | undefined) {
    super(`process.exit called with code ${code}`);
    this.code = code;
  }
}

// Runs `fn` with console.log/console.error/process.exit stubbed out, and
// returns what was captured. console.log calls are recorded (the action's
// stdout print branch uses it); console.error is silenced (the action logs
// progress and error messages through it); process.exit is replaced with a
// spy that records the exit code and throws ProcessExitSentinel so the
// action's control flow halts the same way a real process.exit would, then
// swallows that specific sentinel so the test doesn't fail on it.
async function withStubbedIO(
  fn: () => Promise<void>
): Promise<{ logs: unknown[][]; exitCode: number | undefined; exitCalled: boolean }> {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;

  const logs: unknown[][] = [];
  let exitCode: number | undefined;
  let exitCalled = false;

  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  console.error = () => {};
  process.exit = ((code?: number) => {
    exitCalled = true;
    exitCode = code;
    throw new ProcessExitSentinel(code);
  }) as typeof process.exit;

  try {
    await fn();
  } catch (error) {
    if (!(error instanceof ProcessExitSentinel)) {
      throw error;
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  return { logs, exitCode, exitCalled };
}

test("generate: real action writes a markdown digest to --output", async () => {
  const { program } = buildProgram();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "generate-real-md-"));
  await fs.writeFile(
    path.join(tmpDir, todayFileName()),
    "# Today\n\n- Decided to adopt the new digest format\n- Fixed a bug in the extractor\n",
    "utf-8"
  );
  const outFile = path.join(tmpDir, "out.md");

  const { exitCalled } = await withStubbedIO(async () => {
    await program.parseAsync(["generate", "--dir", tmpDir, "--output", outFile], {
      from: "user",
    });
  });

  assert.equal(exitCalled, false, "process.exit must not be called on success");
  const content = await fs.readFile(outFile, "utf-8");
  assert.ok(content.length > 0, "output file should be non-empty");
});

test("generate: real action writes valid JSON to --output with --json (and parses --days/--max)", async () => {
  const { program } = buildProgram();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "generate-real-json-"));
  await fs.writeFile(
    path.join(tmpDir, todayFileName()),
    "# Today\n\n- Learned something new\n- Shipped a fix\n",
    "utf-8"
  );
  const outFile = path.join(tmpDir, "out.json");

  const { exitCalled } = await withStubbedIO(async () => {
    await program.parseAsync(
      [
        "generate",
        "--dir", tmpDir,
        "--output", outFile,
        "--json",
        "--days", "30",
        "--max", "5",
      ],
      { from: "user" }
    );
  });

  assert.equal(exitCalled, false, "process.exit must not be called on success");
  const content = await fs.readFile(outFile, "utf-8");
  assert.doesNotThrow(() => JSON.parse(content), "written file must be valid JSON");
});

test("generate: real action prints the digest to stdout when --output is omitted", async () => {
  const { program } = buildProgram();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "generate-real-stdout-"));
  await fs.writeFile(
    path.join(tmpDir, todayFileName()),
    "# Today\n\n- Did a thing worth remembering\n",
    "utf-8"
  );

  const { logs, exitCalled } = await withStubbedIO(async () => {
    await program.parseAsync(["generate", "--dir", tmpDir], { from: "user" });
  });

  assert.equal(exitCalled, false, "process.exit must not be called on success");
  assert.equal(logs.length, 1, "console.log should be called exactly once with the digest");
  assert.ok(
    typeof logs[0][0] === "string" && logs[0][0].length > 0,
    "printed digest should be a non-empty string"
  );
});

test("generate: real action calls process.exit(1) when --output cannot be written", async () => {
  const { program } = buildProgram();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "generate-real-exit-"));
  await fs.writeFile(
    path.join(tmpDir, todayFileName()),
    "# Today\n\n- A note\n",
    "utf-8"
  );
  // Parent directory of the output path does not exist, so fs.writeFile
  // rejects with ENOENT and the action's catch block must run.
  const badOutput = path.join(tmpDir, "does-not-exist-subdir", "out.md");

  const { exitCode, exitCalled } = await withStubbedIO(async () => {
    await program.parseAsync(["generate", "--dir", tmpDir, "--output", badOutput], {
      from: "user",
    });
  });

  assert.equal(exitCalled, true, "process.exit should have been called");
  assert.equal(exitCode, 1, "process.exit should be called with code 1");
});
