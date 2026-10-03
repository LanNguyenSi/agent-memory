const fs = require("node:fs");
const path = require("node:path");
const chokidar = require("chokidar");
const {
  loadConfig,
  requireRemoteUrl,
  resolveRunConfig
} = require("../config/loader");
const {
  CliError,
  MassDeleteRefusedError,
  StateDirLockedError,
  UnreliableCheckoutError
} = require("../errors");
const { acquireStateDirLock } = require("../memory-sync/lock");
const { buildCommitMessage } = require("../memory-sync/snapshot");
const { performPush } = require("../memory-sync/push");
const { writeInfo, writeWarning } = require("../output");
const {
  DEFAULT_MISSING_POLL_MS,
  confirmWatchLive,
  listFilesUnder,
  partitionSyncPaths,
  resolveArmTimeoutMs,
  trackMissingPaths
} = require("./watch-arming");

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
  allowMassDelete: boolean;
  // No acceptMassDelete here, deliberately: `watch` runs for as long as the
  // machine is up, so a flag on its command line would be consent for every
  // future tick, including the one that fetches a wiped checkout next week
  // (measured in review: with the flag, a wiped checkout deleted every local
  // file the remote still held, watcher exit 0). Accepting a remote deletion
  // is a one-shot decision about one observed state, and it lives on `run`.
}

const DEFAULT_DEBOUNCE_MS = 5000;
// Longest wait for the chokidar watcher of a syncPath that appeared after start
// to report `ready` before the path is read once more regardless.
const APPEARED_READY_BOUND_MS = 5000;

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
    .option(
      "--allow-mass-delete",
      "Push a plan the mass-delete guard would refuse (see massDeleteGuard in the config). It does not " +
        "override an unreliable checkout: a working copy that came back missing files, or present but " +
        "emptied to zero bytes, is still refused",
      false
    )
    .option("-o, --output <format>", "Output format: text, json, yaml", "text")
    .option("-v, --verbose", "Enable verbose diagnostics", false)
    .option("-q, --quiet", "Suppress non-error diagnostics", false)
    .option("--no-color", "Disable colored diagnostics")
    .action(async (profile: string, options: WatchOptions) => {
      const loaded = await loadConfig(options.config, { requireExisting: true });
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

      // Taken before chokidar.watch(), so it matches what chokidar's own first
      // stat() of each path sees. Only the paths that exist go to the main
      // chokidar watcher; each missing one gets its own tracker below. See
      // ./watch-arming.ts.
      const { existing: existingAtStart, missing: missingAtStart } = partitionSyncPaths(watchedPaths);
      const watcherOptions = {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
      };
      // The main watcher plus one per syncPath that appeared after start.
      const watchers = new Set<{ close: () => Promise<void> | void }>();
      let missingTracker: { close: () => void } | null = null;

      const pendingChanges = new Set<string>();
      const pendingDeletes = new Set<string>();
      let debounceTimer: NodeJS.Timeout | null = null;
      let runsCompleted = 0;
      let shouldExit = false;
      let watcherClosed = false;
      const armingAbort = new AbortController();
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
        armingAbort.abort();
        missingTracker?.close();
        await Promise.all([...watchers].map((entry) => entry.close()));
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
      // (see docs/service-supervision.md for the documented contract
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
          tempDirLabel: "watch",
          allowMassDelete: options.allowMassDelete
        });

        if (result.status === "queued") {
          writeInfo(
            `watch tick queued locally instead of pushing (${(result.notes || []).join("; ") || "remote unavailable"})`,
            outputOptions
          );
          return;
        }

        // Gated on writes AND deletions, not on writes alone: a tick whose
        // whole outcome is a deletion has no applied file to count, and used
        // to report "no remote changes" while the remote really did shrink.
        // The count is in the result line for the same reason.
        const deletedCount = (result.deletedFiles || []).length;
        if (result.appliedFiles.length === 0 && deletedCount === 0) {
          writeInfo("watch tick produced no remote changes", outputOptions);
          return;
        }

        writeInfo(
          `pushed snapshot ${result.remoteHeadAfter ? result.remoteHeadAfter.slice(0, 7) : "?"} ` +
            `(${result.appliedFiles.length} file(s) applied` +
            `${deletedCount ? `, ${deletedCount} deletion(s)` : ""}` +
            `${result.conflictFiles.length ? `, ${result.conflictFiles.length} conflict(s)` : ""})`,
          outputOptions
        );
      }

      async function runTick(): Promise<void> {
        if (shouldExit) {
          return;
        }
        if (pendingChanges.size === 0 && pendingDeletes.size === 0) {
          return;
        }

        // Taken BEFORE the pending changes are consumed, so a tick that
        // cannot have the lock leaves them pending and reschedules instead
        // of swallowing them: they would otherwise sit unpushed until the
        // next unrelated edit. The whole tick runs under the lock, including
        // the push's own commit, which is the window the sync job used to be
        // free to wipe (see src/memory-sync/lock.ts).
        let lock: { release: () => void };
        try {
          lock = acquireStateDirLock({
            stateDir: runConfig.stateDir,
            command: "watch",
            staleMs: runConfig.lockStaleMs
          });
        } catch (error) {
          if (!(error instanceof StateDirLockedError)) {
            handleSnapshotError(error);
            await maybeShutdown();
            return;
          }

          writeWarning(`watch tick deferred: ${(error as Error).message}`, outputOptions);
          scheduleFlush();
          return;
        }

        try {
          const message = takePendingMessage();
          if (!message) {
            return;
          }
          await pushSnapshot(message);
        } catch (error) {
          // A refused deletion plan or an unreliable working copy
          // (agent-tasks cda5b12c, pandora run
          // .ai/runs/2026-09-11-memory-sync-wipe; see
          // src/memory-sync/guards.ts) is a
          // decision about THIS tick, not a broken watcher: the snapshot was
          // not pushed, nothing was lost, and the next tick is free to try
          // again once the workspace or the working copy looks sane. Log it
          // loudly and keep watching, instead of routing it through
          // handleSnapshotError, which sets a non-zero exit code and shuts
          // the watcher down. A wedged watcher would be its own outage: the
          // 2026-09-11 incident was noticed only because the watch job was
          // still running and still pushing.
          if (!isGuardRefusal(error)) {
            handleSnapshotError(error);
            await maybeShutdown();
            return;
          }

          writeWarning(`watch tick refused: ${(error as Error).message}`, outputOptions);
        } finally {
          lock.release();
        }

        // Counts every tick that completed a pushSnapshot() call, whether
        // performPush actually pushed, queued the snapshot locally
        // (unreachable/failed remote) or had its plan refused by a guard.
        // This matches run.ts's own --max-runs, which counts scheduled
        // invocations rather than only ones that pushed something. This also
        // keeps --max-runs usable as a deterministic test-termination
        // mechanism for an offline tick, which never throws (see
        // pushSnapshot above) and so would otherwise never increment a
        // "successful pushes only" counter.
        runsCompleted += 1;
        if (maxRuns && runsCompleted >= maxRuns) {
          shouldExit = true;
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
            // The shutdown flush is a tick like any other and takes the same
            // lock. A lock it cannot have leaves the pending edits on disk,
            // where the next watch start or the next periodic run picks them
            // up: it is never a reason to fail a clean shutdown.
            let lock: { release: () => void };
            try {
              lock = acquireStateDirLock({
                stateDir: runConfig.stateDir,
                command: "watch (shutdown flush)",
                staleMs: runConfig.lockStaleMs
              });
            } catch (error) {
              if (error instanceof StateDirLockedError) {
                writeWarning(`watch shutdown flush deferred: ${(error as Error).message}`, outputOptions);
              } else {
                handleSnapshotError(error);
              }
              await maybeShutdown();
              return;
            }

            try {
              const finalMessage = takePendingMessage();
              if (finalMessage) {
                try {
                  await pushSnapshot(finalMessage);
                } catch (error) {
                  // Same treatment as a refused tick above: a guard refusal on
                  // the final flush is a decision about the pending snapshot,
                  // not a watcher failure, so it must not turn a clean
                  // SIGINT/SIGTERM shutdown into a non-zero exit.
                  if (isGuardRefusal(error)) {
                    writeWarning(`watch tick refused: ${(error as Error).message}`, outputOptions);
                  } else {
                    handleSnapshotError(error);
                  }
                }
              }
            } finally {
              lock.release();
            }
            await maybeShutdown();
          })
          .catch((error) => {
            handleSnapshotError(error);
            void maybeShutdown();
          });
      }

      function createWatcher(paths: string[]) {
        const created = chokidar.watch(paths, watcherOptions);
        watchers.add(created);
        created.on("add", (filePath: string) => {
          pendingChanges.add(filePath);
          scheduleFlush();
        });
        created.on("change", (filePath: string) => {
          pendingChanges.add(filePath);
          scheduleFlush();
        });
        created.on("unlink", (filePath: string) => {
          pendingDeletes.add(filePath);
          pendingChanges.delete(filePath);
          scheduleFlush();
        });
        created.on("error", (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          writeWarning(`watcher error: ${message}`, outputOptions);
        });
        return created;
      }

      // A syncPath that was missing at start now exists (./watch-arming.ts):
      // it gets its own chokidar watcher, so it does not depend on any other
      // path's listener, and once that watcher is ready (the OS watch on the
      // path and on what is inside it is open) the path is read once more.
      // What the path already held before the watch opened produces no event
      // (ignoreInitial), so the re-read reports it as a change; a file seen by
      // both the re-read and the watcher is one pending change.
      async function armAppearedPath(target: string): Promise<boolean | void> {
        if (watcherClosed || shouldExit) {
          return;
        }
        // The path can be gone again by now (removed right after the tracker
        // saw it). chokidar would then take its lossy missing-path branch for
        // it, so it goes back to the tracker instead. Returning false does
        // that. A path removed after this check and before its watcher is
        // ready is not covered, like any removal after the path appeared.
        if (!fs.existsSync(target)) {
          writeInfo(`syncPath ${target} disappeared again before it could be watched, waiting for it`, outputOptions);
          return false;
        }
        writeInfo(`syncPath ${target} appeared, watching it`, outputOptions);
        const appeared = createWatcher([target]);
        await new Promise<void>((resolve) => {
          // `ready` normally follows within milliseconds. The bound keeps a
          // watcher that never reports it from skipping the re-read.
          // unref'd: a shutdown between the appearance and `ready` must not
          // be held up by this bound.
          const bound = setTimeout(resolve, APPEARED_READY_BOUND_MS);
          bound.unref();
          appeared.once("ready", () => {
            clearTimeout(bound);
            resolve();
          });
        });
        if (watcherClosed || shouldExit) {
          return;
        }
        const found = await listFilesUnder(target);
        if (watcherClosed || shouldExit) {
          return;
        }
        for (const file of found) {
          pendingChanges.add(file);
        }
        if (found.length > 0) {
          scheduleFlush();
        }
        writeInfo(`syncPath ${target} is armed (${found.length} existing file(s) reported)`, outputOptions);
      }

      // Printed from chokidar's own 'ready' event (fired once its initial
      // recursive scan of the syncPaths that exist at start completes) rather
      // than unconditionally right after chokidar.watch() returns. Two reasons:
      // (1) it is semantically correct — the line claims "watching", which is
      // only true once the initial scan has actually finished; (2) on an
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
      // bookkeeping. Measured in isolation (agent-tasks f876dff6): a write
      // issued 0ms after the watch is reported armed was lost 10/10 times,
      // while a write issued >=1ms after was caught 10/10 times, both idle
      // and under load. In practice this package's own waitForWatcherReady
      // test helper (tests/helpers/watch-process.ts) polls at a 25ms
      // cadence, which leaves comfortable margin above that threshold; see
      // that file's header comment for the full measurement notes.
      //
      // The line also waits for an OS watch opened after chokidar's `ready` to
      // deliver an event (confirmWatchLive, ./watch-arming.ts). Measured on
      // macOS: a write made synchronously after fs.watch(file) returned was
      // missed 100 of 100 times, one made after a single setImmediate 0 of
      // 100, so a file watch is not live until the event loop has polled once;
      // waiting for an event on a scratch watch guarantees at least that. The
      // wait is bounded, and a timeout or a failure to set the probe up is a
      // warning, not a failure.
      //
      // A syncPath that does not exist at start is never handed to chokidar,
      // whose handling of it is early and lossy (agent-tasks 50a13ffe,
      // d09a0d3a): its tracker is started before this line is printed, so
      // "watching" holds for it as well, in the sense that its creation will
      // be noticed and delivered. Rationale: ./watch-arming.ts.
      let readyAnnounced = false;
      function announceReady(): void {
        if (readyAnnounced || watcherClosed) {
          return;
        }
        readyAnnounced = true;
        writeInfo(
          `watching ${watchedPaths.length} path(s) under ${runConfig.rootDir} (debounce ${debounceMs}ms)`,
          outputOptions
        );
      }

      if (existingAtStart.length > 0) {
        createWatcher(existingAtStart).once("ready", async () => {
          const timeoutMs = resolveArmTimeoutMs();
          let setupError: unknown = null;
          const live = await confirmWatchLive({
            timeoutMs,
            signal: armingAbort.signal,
            onError: (error: unknown) => {
              setupError = error;
            }
          });
          if (!live && !watcherClosed) {
            const consequence =
              "continuing, so a change made right after start may be missed until watch is restarted";
            if (setupError !== null) {
              const reason = setupError instanceof Error ? setupError.message : String(setupError);
              writeWarning(
                `could not check that the operating system file watch is live (${reason}); ${consequence}`,
                outputOptions
              );
            } else {
              writeWarning(
                `could not confirm within ${timeoutMs}ms that the operating system file watch is live; ${consequence}`,
                outputOptions
              );
            }
          }
          announceReady();
        });
      }
      if (missingAtStart.length > 0) {
        writeInfo(
          `${missingAtStart.length} syncPath(s) do not exist yet and are checked every ${DEFAULT_MISSING_POLL_MS}ms: ` +
            missingAtStart.join(", "),
          outputOptions
        );
        missingTracker = trackMissingPaths(missingAtStart, armAppearedPath, {
          onError: (target: string, error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            writeWarning(`could not start watching ${target}: ${message}`, outputOptions);
          }
        });
      }
      if (existingAtStart.length === 0) {
        // Nothing for chokidar to scan: the trackers are armed already.
        announceReady();
      }

      const sigintHandler = () => requestShutdown("received SIGINT, flushing pending changes before exit");
      const sigtermHandler = () => requestShutdown("received SIGTERM, flushing pending changes before exit");
      process.on("SIGINT", sigintHandler);
      process.on("SIGTERM", sigtermHandler);

      await done;
      process.off("SIGINT", sigintHandler);
      process.off("SIGTERM", sigtermHandler);
    });
}

// A deletion guard's refusal (src/memory-sync/guards.ts): the tick decided
// not to push, which leaves the local workspace, the remote and the queue
// exactly as they were. Distinguished from every other error so the watch
// loop survives it. See runTick's own comment for why that matters.
function isGuardRefusal(error: unknown): boolean {
  return error instanceof MassDeleteRefusedError || error instanceof UnreliableCheckoutError;
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
  // Not routed through assertPortablePathSegment: this value is
  // display-only text for a commit message / log line, never a key
  // push/pull maps back to a file, so a raw "\" surviving here (on
  // darwin/linux) is cosmetic, not a correctness path - the actual push
  // still refuses the same file's real sync path elsewhere (agent-tasks
  // 73ea60bf).
  const relative = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../")) {
    return path.basename(absolutePath);
  }
  return relative;
}

module.exports = { registerWatchCommand };
