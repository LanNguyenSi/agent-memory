const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const {
  loadConfig,
  requireRemoteUrl,
  resolveRunConfig
} = require("../config/loader");
const { CliError } = require("../errors");
const { mapRemotePathToLocalAbsolute } = require("../memory-sync/config");
const { GitClient } = require("../memory-sync/git-client");
const { writeDryRun, writeInfo, writeResult } = require("../output");

type OutputFormat = "text" | "json" | "yaml";

interface RestoreOptions {
  config?: string;
  output: OutputFormat;
  verbose: boolean;
  quiet: boolean;
  color: boolean;
  rootDir?: string;
  remote?: string;
  branch?: string;
  repositorySubdir?: string;
  stateDir?: string;
  path?: string;
  dryRun: boolean;
  yes: boolean;
}

function registerRestoreCommand(program: import("commander").Command): void {
  program
    .command("restore")
    .description("Restore memory files from a specific snapshot commit in the remote repository")
    .argument("<sha>", "Commit SHA to restore from")
    .option("--config <path>", "Override config file path")
    .option("--root-dir <path>", "Override the local workspace root")
    .option("--remote <url>", "Override the remote Git repository URL")
    .option("--branch <name>", "Override the remote branch")
    .option("--repository-subdir <path>", "Override the subdirectory inside the remote repository")
    .option("--state-dir <path>", "Override the local state directory")
    .option(
      "--path <relative>",
      "Restore only this remote-relative path (relative to repositorySubdir)"
    )
    .option("--dry-run", "List what would be restored without writing", false)
    .option("--yes", "Confirm a full-snapshot restore without prompting", false)
    .option("-o, --output <format>", "Output format: text, json, yaml", "text")
    .option("-v, --verbose", "Enable verbose diagnostics", false)
    .option("-q, --quiet", "Suppress non-error diagnostics", false)
    .option("--no-color", "Disable colored diagnostics")
    .action(async (sha: string, options: RestoreOptions) => {
      if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
        throw new CliError(`invalid commit sha '${sha}'.`, 2);
      }

      const loaded = await loadConfig(options.config);
      const runConfig = requireRemoteUrl(
        resolveRunConfig(loaded, {
          outputFormat: options.output,
          verbose: options.verbose,
          quiet: options.quiet,
          color: options.color,
          rootDir: options.rootDir,
          remoteUrl: options.remote,
          branch: options.branch,
          repositorySubdir: options.repositorySubdir,
          stateDir: options.stateDir
        })
      );

      if (!options.path && !options.yes && !options.dryRun) {
        throw new CliError(
          "full-snapshot restore requires --yes (or use --path to restore a single file, or --dry-run to preview).",
          2
        );
      }

      const outputOptions = {
        color: runConfig.color,
        quiet: runConfig.quiet,
        verbose: runConfig.verbose
      };

      const gitClient = new GitClient(runConfig.gitBinary);
      const workingCopy = gitClient.prepareWorkingCopy(
        runConfig.remoteUrl,
        runConfig.branch,
        gitClient.createTempRepoDir(runConfig.stateDir, "restore")
      );

      gitClient.fetchRef(workingCopy.repoDir, sha);

      const targetRepoPaths = options.path
        ? [normalizeRequestedPath(runConfig.repositorySubdir, options.path)]
        : gitClient
            .listTreePaths(workingCopy.repoDir, sha, runConfig.repositorySubdir)
            .filter((p: string) => p.startsWith(`${runConfig.repositorySubdir}/`));

      if (targetRepoPaths.length === 0) {
        throw new CliError(
          `no files to restore at ${sha}${options.path ? ` for path '${options.path}'` : ""} under '${runConfig.repositorySubdir}/'.`,
          5
        );
      }

      const restored: Array<{ remoteRelativePath: string; absoluteLocalPath: string; bytes: number }> = [];

      for (const repoRelativePath of targetRepoPaths) {
        const remoteRelativePath = repoRelativePath.slice(runConfig.repositorySubdir.length + 1);
        const absoluteLocalPath = mapRemotePathToLocalAbsolute(runConfig, remoteRelativePath);
        if (!absoluteLocalPath) {
          throw new CliError(
            `cannot map remote path '${remoteRelativePath}' to a local sync target. Update syncPaths or use --path.`,
            3
          );
        }

        const content = gitClient.showAtRef(workingCopy.repoDir, sha, repoRelativePath);
        if (content === null) {
          throw new CliError(
            `file '${repoRelativePath}' does not exist at ${sha}.`,
            5
          );
        }

        if (options.dryRun) {
          writeDryRun(`would restore ${remoteRelativePath} -> ${absoluteLocalPath} (${content.length} bytes)`, outputOptions);
        } else {
          mkdirSync(path.dirname(absoluteLocalPath), { recursive: true });
          writeFileSync(absoluteLocalPath, content, "utf8");
          writeInfo(`restored ${remoteRelativePath} -> ${absoluteLocalPath}`, outputOptions);
        }

        restored.push({
          remoteRelativePath,
          absoluteLocalPath,
          bytes: Buffer.byteLength(content, "utf8")
        });
      }

      const payload = {
        command: "restore",
        sha,
        dryRun: options.dryRun,
        repositorySubdir: runConfig.repositorySubdir,
        restored
      };

      writeResult(payload, runConfig.outputFormat, () =>
        restored
          .map((entry) => `${options.dryRun ? "[dry-run] " : ""}${entry.remoteRelativePath}`)
          .join("\n")
      );
    });
}

function normalizeRequestedPath(repositorySubdir: string, requested: string): string {
  const normalized = requested.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = normalized.split("/");
  if (!normalized || segments.includes("..") || segments.includes("")) {
    throw new CliError(`--path value '${requested}' is invalid.`, 2);
  }

  if (normalized.startsWith(`${repositorySubdir}/`)) {
    return normalized;
  }

  return `${repositorySubdir}/${normalized}`;
}

module.exports = { registerRestoreCommand };
