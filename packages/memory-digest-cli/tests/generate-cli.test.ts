// CLI-level tests for the generate command: parsePositiveInt validation and
// end-to-end runs of src/main.ts through tsx, asserting that errors
// propagate to main.ts (which prints "error: <message>" and sets
// process.exitCode = 1).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parsePositiveInt } from "../src/commands/generate.js";

function runCli(args: string[]): { status: number | null; stderr: string } {
  const tsxPath = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const result = spawnSync(tsxPath, ["src/main.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr ?? "" };
}

test("parsePositiveInt accepts positive integers", () => {
  assert.equal(parsePositiveInt("days", "7"), 7);
});

for (const value of ["0", "-1", "abc", "7x", "", "1.5"]) {
  test(`parsePositiveInt rejects "${value}"`, () => {
    assert.throws(
      () => parsePositiveInt("days", value),
      (error: Error) => {
        assert.ok(
          error.message.includes("--days must be a positive integer"),
          `message should mention the flag, got: ${error.message}`,
        );
        return true;
      },
    );
  });
}

test("CLI generate with a missing --dir exits 1 with an error: line", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "generate-cli-"));
  const missingDir = path.join(root, "does-not-exist");

  const { status, stderr } = runCli(["generate", "--dir", missingDir]);

  assert.equal(status, 1);
  assert.match(stderr, /error:/);
});

test("CLI generate with --days 0 exits 1 with the validation message", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-cli-"));

  const { status, stderr } = runCli([
    "generate",
    "--days",
    "0",
    "--dir",
    tmpDir,
  ]);

  assert.equal(status, 1);
  assert.match(stderr, /--days must be a positive integer/);
});
