const path = require("node:path");
const chokidar = require("chokidar");
const {
  loadConfig,
  requireRemoteUrl,
  resolveRunConfig
} = require("../config/loader");
const { CliError } = require("../errors");
const { commitAndPushSnapshot, buildCommitMessage } = require("../memory-sync/snapshot");
const { writeInfo, writeWarning } = require("../output");

type OutputFormat = "text" | "json" | "yaml";

interface WatchOptions {
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
  debounceMs?: string;
  maxRuns?: string;
}

const DEFAULT_DEBOUNCE_MS = 5000;

function registerWatchCommand(program: import("commander").Command): void {
  program
    .command("watch")
    .description(
      "Watch the local workspace for changes and commit + push a snapshot per debounce window"
    )
    .argument("[profile]", "Configuration profile to execute", "default")
    .option("--config <path>", "Override config file path")
    .option("--root-dir <path>", "Override the local workspace root")
    .option("--remote <url>", "Override the remote Git repository URL")
    .option("--branch <name>", "Override the remote branch")
    .option("--repository-subdir <path>", "Override the subdirectory inside the remote repository")
    .option("--state-dir <path>", "Override the local state directory")
    .option(
      "--debounce-ms <ms>",
      "Aggregate rapid changes within this window (default 5000, env AGENT_MEMORY_SYNC_WATCH_DEBOUNCE_MS)"
    )
    .option(
      "--max-runs <count>",
      "Exit after this many snapshots have been pushed (primarily for tests)"
    )
    .option("-o, --output <format>", "Output format: text, json, yaml", "text")
    .option("-v, --verbose", "Enable verbose diagnostics", false)
    .option("-q, --quiet", "Suppress non-error diagnostics", false)
    .option("--no-color", "Disable colored diagnostics")
    .action(async (profile: string, options: WatchOptions) => {
      const loaded = await loadConfig(options.config);
      const runConfig = requireRemoteUrl(
        resolveRunConfig(loaded, {
          profile,
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

      const debounceMs = resolveDebounceMs(options.debounceMs);
      const maxRuns = parsePositiveInteger(options.maxRuns, "--max-runs");
      const outputOptions = {
        color: runConfig.color,
        quiet: runConfig.quiet,
        verbose: runConfig.verbose
      };

      const watchedPaths = runConfig.syncPaths.map((entry: { source: string }) =>
        path.isAbsolute(entry.source) ? entry.source : path.resolve(runConfig.rootDir, entry.source)
      );

      const watcher = chokidar.watch(watchedPaths, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
      });

      const pendingChanges = new Set<string>();
      const pendingDeletes = new Set<string>();
      let debounceTimer: NodeJS.Timeout | null = null;
      let runsCompleted = 0;
      let shouldExit = false;
      let watcherClosed = false;
      let workChain: Promise<void> = Promise.resolve();
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      async function maybeShutdown(): Promise<void> {
        if (!shouldExit || watcherClosed) {
          return;
        }
        watcherClosed = true;
        await watcher.close();
        resolveDone();
      }

      function takePendingMessage(): string | null {
        const changedFiles = Array.from(pendingChanges).map((p) => relativeForMessage(p, runConfig.rootDir));
        const deletedFiles = Array.from(pendingDeletes).map((p) => relativeForMessage(p, runConfig.rootDir));
        pendingChanges.clear();
        pendingDeletes.clear();
        if (changedFiles.length === 0 && deletedFiles.length === 0) {
          return null;
        }
        return buildCommitMessage(changedFiles, deletedFiles);
      }

      function pushSnapshot(message: string): void {
        const result = commitAndPushSnapshot(runConfig, message);
        if (result.status === "committed") {
          writeInfo(
            `pushed snapshot ${result.commitSha?.slice(0, 7)} (${result.addedOrChangedFiles.length} changed, ${result.deletedFiles.length} deleted)`,
            outputOptions
          );
        } else {
          writeInfo("watch tick produced no remote changes", outputOptions);
        }
      }

      async function runTick(): Promise<void> {
        if (shouldExit) {
          return;
        }
        const message = takePendingMessage();
        if (!message) {
          return;
        }
        try {
          pushSnapshot(message);
          runsCompleted += 1;
          if (maxRuns && runsCompleted >= maxRuns) {
            shouldExit = true;
          }
        } catch (error) {
          handleSnapshotError(error);
        }
        await maybeShutdown();
      }

      function handleSnapshotError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`snapshot push failed: ${message}\n`);
        const exitCode =
          typeof (error as { exitCode?: unknown }).exitCode === "number"
            ? (error as { exitCode: number }).exitCode
            : 1;
        process.exitCode = exitCode;
        shouldExit = true;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        void maybeShutdown();
      }

      function scheduleFlush(): void {
        if (shouldExit) {
          return;
        }
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          workChain = workChain.then(runTick).catch(handleSnapshotError);
        }, debounceMs);
      }

      function requestShutdown(reason: string): void {
        writeInfo(reason, outputOptions);
        shouldExit = true;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        workChain = workChain
          .then(async () => {
            const finalMessage = takePendingMessage();
            if (finalMessage) {
              try {
                pushSnapshot(finalMessage);
              } catch (error) {
                handleSnapshotError(error);
              }
            }
            await maybeShutdown();
          })
          .catch((error) => {
            handleSnapshotError(error);
            void maybeShutdown();
          });
      }

      watcher.on("add", (filePath: string) => {
        pendingChanges.add(filePath);
        scheduleFlush();
      });
      watcher.on("change", (filePath: string) => {
        pendingChanges.add(filePath);
        scheduleFlush();
      });
      watcher.on("unlink", (filePath: string) => {
        pendingDeletes.add(filePath);
        pendingChanges.delete(filePath);
        scheduleFlush();
      });
      watcher.on("error", (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        writeWarning(`watcher error: ${message}`, outputOptions);
      });

      const sigintHandler = () => requestShutdown("received SIGINT, flushing pending changes before exit");
      const sigtermHandler = () => requestShutdown("received SIGTERM, flushing pending changes before exit");
      process.on("SIGINT", sigintHandler);
      process.on("SIGTERM", sigtermHandler);

      writeInfo(
        `watching ${watchedPaths.length} path(s) under ${runConfig.rootDir} (debounce ${debounceMs}ms)`,
        outputOptions
      );

      await done;
      process.off("SIGINT", sigintHandler);
      process.off("SIGTERM", sigtermHandler);
    });
}

function resolveDebounceMs(override?: string): number {
  if (override) {
    return parseDebounceMs(override, "--debounce-ms");
  }

  const envValue = process.env.AGENT_MEMORY_SYNC_WATCH_DEBOUNCE_MS;
  if (envValue) {
    return parseDebounceMs(envValue, "AGENT_MEMORY_SYNC_WATCH_DEBOUNCE_MS");
  }

  return DEFAULT_DEBOUNCE_MS;
}

function parseDebounceMs(value: string, source: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError(`${source} must be a non-negative number of milliseconds.`, 2);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, flag: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} must be a positive integer.`, 2);
  }
  return parsed;
}

function relativeForMessage(absolutePath: string, rootDir: string): string {
  const relative = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../")) {
    return path.basename(absolutePath);
  }
  return relative;
}

module.exports = { registerWatchCommand };
