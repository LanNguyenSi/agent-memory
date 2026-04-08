const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const tsxPath = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  return execFileSync(tsxPath, ["src/main.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
}

test("run command emits json payload", () => {
  const output = runCli(["run", "workspace", "--output", "json"]);
  const payload = JSON.parse(output);

  assert.equal(payload.command, "run");
  assert.equal(payload.target, "workspace");
  assert.equal(payload.output, "json");
});

test("config show resolves an existing config file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "memory-digest-cli-"));
  const configDir = path.join(root, ".config", "memory-digest-cli");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ outputFormat: "json", verbose: true }, null, 2),
    "utf8",
  );

  const output = runCli(["config", "show"], {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, ".config"),
  });
  const payload = JSON.parse(output);

  assert.equal(payload.settings.outputFormat, "json");
  assert.equal(payload.settings.verbose, true);
});
