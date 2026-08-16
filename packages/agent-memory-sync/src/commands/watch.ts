const path = require("node:path");
const chokidar = require("chokidar");
const {
  loadConfig,
  requireRemoteUrl,
  resolveRunConfig
} = require("../config/loader");
const { CliError } = require("../errors");
const { buildCommitMessage } = require("../memory-sync/snapshot");
const { performPush } = require("../memory-sync/push");
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
      "Exit after this many watch ticks complete — pushed or queued locally when the remote " +
        "is unreachable (primarily for tests)"
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

      // Routes through the same base-snapshot-aware performPush that
      // `run --mode sync/push` uses (src/memory-sync/push.ts), instead of
      // the former whole-subtree mirror push (src/memory-sync/snapshot.ts's
      // now-removed commitAndPushSnapshot). That mirror blindly overwrote a
      // concurrently-changed remote file and deleted any remote path missing
      // locally, including a peer machine's file this workspace had not
      // pulled yet — performPush's 3-way merge over localFiles ∪ baseFiles
      // touches neither. `tempDirLabel: "watch"` keeps watch's working copy
      // isolated from a concurrently running `run --mode push/sync` on the
      // same stateDir/profile (both otherwise default to the "push" label).
      //
      // A genuinely unreachable/failed push is no longer a thrown error here
      // (see README.md's "watch" section for the documented contract
      // change): performPush queues the snapshot locally and returns
      // normally instead, exactly like `run --mode push/sync` already does.
      // Config/data errors (e.g. a required syncPaths entry missing) still
      // throw before performPush's own try/catch and so still propagate to
      // handleSnapshotError below (fail loud, non-zero exit), unchanged.
      async function pushSnapshot(message: string): Promise<void> {
        // Printed the instant this tick actually starts performPush (fetch +
        // 3-way merge + commit + push over git), not only once the result is
        // known below. Before this line, --verbose watch went silent between
        // its "watching N path(s)..." ready line and this tick's own result
        // line, so a long-but-progressing tick (CPU-starved host, slow
        // remote) was indistinguishable from a genuinely wedged child from
        // the outside — see tests/helpers/watch-process.ts's withTickDeadline,
        // which polls this exact line (stably shaped: literal
        // "watch tick pushing snapshot", never templated with per-run data)
        // to reset its inactivity deadline instead of bounding the whole
        // tick by a fixed wall-clock budget.
        writeInfo("watch tick pushing snapshot", outputOptions);
        const result = await performPush(runConfig, {
          dryRun: false,
          commitMessage: message,
          tempDirLabel: "watch"
        });

        if (result.status === "queued") {
          writeInfo(
            `watch tick queued locally instead of pushing (${(result.notes || []).join("; ") || "remote unavailable"})`,
            outputOptions
          );
          return;
        }

        if (result.appliedFiles.length === 0) {
          writeInfo("watch tick produced no remote changes", outputOptions);
          return;
        }

        writeInfo(
          `pushed snapshot ${result.remoteHeadAfter ? result.remoteHeadAfter.slice(0, 7) : "?"} ` +
            `(${result.appliedFiles.length} file(s) applied` +
            `${result.conflictFiles.length ? `, ${result.conflictFiles.length} conflict(s)` : ""})`,
          outputOptions
        );
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
          // Counts every tick that completed a pushSnapshot() call, whether
          // performPush actually pushed or queued the snapshot locally
          // (unreachable/failed remote) — matching run.ts's own --max-runs,
          // which counts scheduled invocations rather than only ones that
          // pushed something. This also keeps --max-runs usable as a
          // deterministic test-termination mechanism for an offline tick,
          // which never throws (see pushSnapshot above) and so would
          // otherwise never increment a "successful pushes only" counter.
          await pushSnapshot(message);
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
                await pushSnapshot(finalMessage);
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

      // Printed from chokidar's own 'ready' event (fired once its initial
      // recursive scan of watchedPaths completes) rather than unconditionally
      // right after chokidar.watch() returns. Two reasons: (1) it is
      // semantically correct — the line claims "watching", which is only
      // true once the initial scan has actually finished; (2) on an
      // inotify-backed watcher (Linux) that scan is not instantaneous, and a
      // filesystem write issued before it completes can be silently missed —
      // chokidar has not finished wiring up inotify watch descriptors for
      // every (possibly nested) watched path yet. This line is a large
      // improvement over an unconditional sleep() before it, but is NOT a
      // complete guarantee on macOS: this package's chokidar version (^4.0.3)
      // depends on neither `fsevents` nor `usePolling` by default (v4 dropped
      // the optional `fsevents` native dependency entirely and watches
      // exclusively via Node's own fs.watch/fs.watchFile), and on macOS a
      // freshly-created fs.watch() can still miss a write issued immediately
      // after it returns — a currently-unfixed Node.js/libuv behavior
      // (nodejs/node#52601, "Not possible to know when fs.watch has started
      // on macOS"), independent of chokidar's own initial-scan/'ready'
      // bookkeeping. Measured in tests/helpers/watch-process.ts's "ROOT
      // CAUSE" comment (agent-tasks f876dff6): a write 0ms after the watch
      // is reported armed is lost 100% of the time in isolation, on both a
      // bare fs.watch() and this exact chokidar config, idle or under load;
      // any real delay (>=5ms measured here) resolves it 100% of the time.
      // The mitigation for that residual race lives entirely on the test
      // side (retrying a stalled trigger edit rather than waiting longer),
      // since Node exposes no stronger "truly armed" signal this line could
      // wait for instead.
      watcher.on("ready", () => {
        writeInfo(
          `watching ${watchedPaths.length} path(s) under ${runConfig.rootDir} (debounce ${debounceMs}ms)`,
          outputOptions
        );
      });

      const sigintHandler = () => requestShutdown("received SIGINT, flushing pending changes before exit");
      const sigtermHandler = () => requestShutdown("received SIGTERM, flushing pending changes before exit");
      process.on("SIGINT", sigintHandler);
      process.on("SIGTERM", sigtermHandler);

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
