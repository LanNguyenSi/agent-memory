const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

function createSandbox(name: string): string {
  const root = path.join(tmpdir(), `agent-memory-sync-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function runCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; expectFailure?: boolean } = {}
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(
    path.resolve(process.cwd(), "node_modules", ".bin", "tsx"),
    ["src/main.ts", ...args],
    {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      encoding: "utf8"
    }
  );

  if (!options.expectFailure && result.status !== 0) {
    throw new Error(result.stderr || `CLI exited with code ${result.status}`);
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? 1
  };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initBareRemote(root: string): string {
  const remoteDir = path.join(root, "remote.git");
  mkdirSync(remoteDir, { recursive: true });
  git(["init", "--bare", "--initial-branch=main"], remoteDir);
  return remoteDir;
}

function cloneRemote(remoteDir: string, root: string, name: string): string {
  const checkoutDir = path.join(root, name);
  git(["clone", remoteDir, checkoutDir], root);
  git(["config", "user.name", "test-runner"], checkoutDir);
  git(["config", "user.email", "test-runner@example.invalid"], checkoutDir);
  return checkoutDir;
}

function writeProjectConfig(configPath: string, config: Record<string, unknown>): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function writeText(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

module.exports = {
  createSandbox,
  runCli,
  git,
  initBareRemote,
  cloneRemote,
  writeProjectConfig,
  readText,
  writeText,
  fileExists
};
