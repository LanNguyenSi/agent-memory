const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { CliError } = require("../errors");

interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface WorkingCopy {
  repoDir: string;
  remoteHead: string | null;
}

class GitClient {
  gitBinary: string;

  constructor(gitBinary = "git") {
    this.gitBinary = gitBinary;
  }

  prepareWorkingCopy(remoteUrl: string, branch: string, repoDir: string): WorkingCopy {
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });

    this.run(["init"], repoDir);
    this.run(["config", "user.name", "agent-memory-sync"], repoDir);
    this.run(["config", "user.email", "agent-memory-sync@local.invalid"], repoDir);
    this.run(["remote", "add", "origin", remoteUrl], repoDir);

    const remoteHead = this.lookupRemoteHead(remoteUrl, branch, repoDir);
    if (remoteHead) {
      this.run(["fetch", "origin", branch], repoDir);
      this.run(["checkout", "-B", branch, "FETCH_HEAD"], repoDir);
    } else {
      this.run(["checkout", "--orphan", branch], repoDir);
      this.run(["reset", "--mixed"], repoDir);
    }

    return {
      repoDir,
      remoteHead
    };
  }

  lookupRemoteHead(remoteUrl: string, branch: string, cwd: string): string | null {
    const result = this.run(
      ["ls-remote", "--heads", remoteUrl, branch],
      cwd,
      true
    );

    if (result.exitCode !== 0) {
      throw new CliError(
        `could not reach remote git repository '${remoteUrl}'. Check connectivity and repository access.`,
        4
      );
    }

    const line = result.stdout.trim().split("\n").find(Boolean);
    if (!line) {
      return null;
    }

    return line.split(/\s+/)[0] || null;
  }

  readFile(repoDir: string, relativePath: string): string | null {
    const absolutePath = path.join(repoDir, relativePath);
    if (!existsSync(absolutePath)) {
      return null;
    }

    return readFileSync(absolutePath, "utf8");
  }

  writeFile(repoDir: string, relativePath: string, content: string): void {
    const absolutePath = path.join(repoDir, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }

  deleteFile(repoDir: string, relativePath: string): void {
    const absolutePath = path.join(repoDir, relativePath);
    rmSync(absolutePath, { force: true });
  }

  listFiles(repoDir: string, relativeDir: string): string[] {
    const absoluteDir = path.join(repoDir, relativeDir);
    if (!existsSync(absoluteDir)) {
      return [];
    }

    return walkFiles(absoluteDir).map((absolutePath) =>
      path.relative(repoDir, absolutePath).replace(/\\/g, "/")
    );
  }

  hasChanges(repoDir: string): boolean {
    const result = this.run(["status", "--porcelain"], repoDir);
    return Boolean(result.stdout.trim());
  }

  commitAll(repoDir: string, message: string): string | null {
    this.run(["add", "-A"], repoDir);
    if (!this.hasChanges(repoDir)) {
      return null;
    }

    this.run(["commit", "-m", message], repoDir);
    return this.revParseHead(repoDir);
  }

  push(repoDir: string, branch: string): void {
    const result = this.run(["push", "origin", `HEAD:refs/heads/${branch}`], repoDir, true);
    if (result.exitCode !== 0) {
      if (/\[rejected\]|fetch first|non-fast-forward/i.test(result.stderr)) {
        throw new CliError(
          "remote branch changed during push. Re-run the sync to merge against the latest remote state.",
          4
        );
      }

      throw new CliError("git push failed. Check repository access and branch permissions.", 4);
    }
  }

  revParseHead(repoDir: string): string {
    return this.run(["rev-parse", "HEAD"], repoDir).stdout.trim();
  }

  createTempRepoDir(stateDir: string, label: string): string {
    const repoDir = path.join(stateDir, "tmp", label);
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    return repoDir;
  }

  run(args: string[], cwd: string, allowFailure = false): GitCommandResult {
    try {
      const stdout = execFileSync(this.gitBinary, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });

      return {
        stdout,
        stderr: "",
        exitCode: 0
      };
    } catch (error) {
      const failure = error as {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        status?: number;
        code?: string;
      };

      const result = {
        stdout: toUtf8(failure.stdout),
        stderr: toUtf8(failure.stderr),
        exitCode: failure.status ?? 1
      };

      if (allowFailure) {
        return result;
      }

      throw new CliError(
        `git command failed: ${this.gitBinary} ${args.join(" ")}.`,
        4
      );
    }
  }
}

function walkFiles(rootDir: string): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(absolutePath));
      continue;
    }
    if (entry.isFile()) {
      results.push(absolutePath);
    }
  }

  return results;
}

function toUtf8(value?: string | Buffer): string {
  if (!value) {
    return "";
  }
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

module.exports = {
  GitClient
};
