const {
  loadConfig,
  requireRemoteUrl,
  resolveRunConfig
} = require("../config/loader");
const {
  CliError,
  RemoteQueueEscalationError,
  RemoteUnavailableError,
  formatErrorMessage
} = require("../errors");
const { acquireStateDirLock } = require("../memory-sync/lock");
const { performPull } = require("../memory-sync/pull");
const { performPush } = require("../memory-sync/push");
const { summarizeOperation } = require("../memory-sync/preview");
const { nextScheduleTick, validateCronExpression } = require("../memory-sync/scheduler");
const { writeDryRun, writeInfo, writeResult, writeWarning } = require("../output");

type OutputFormat = "text" | "json" | "yaml";
type RunMode = "sync" | "push" | "pull";

interface RunOptions {
  config?: string;
  dryRun: boolean;
  output: OutputFormat;
  verbose: boolean;
  quiet: boolean;
  color: boolean;
  mode: RunMode;
  rootDir?: string;
  remote?: string;
  branch?: string;
  repositorySubdir?: string;
  stateDir?: string;
  schedule?: string;
  maxRuns?: string;
  conflictStrategy?: "inline-markers" | "local-wins" | "remote-wins";
  reachabilityTimeoutMs?: string;
  allowMassDelete: boolean;
  acceptMassDelete: boolean;
}

function registerRunCommand(program: import("commander").Command): void {
  program
    .command("run")
    .description("Sync local memory files with the configured Git repository")
    .argument("[profile]", "Configuration profile to execute", "default")
    .option("--config <path>", "Override config file path")
    .option("--mode <mode>", "Sync mode: sync, push, pull", "sync")
    .option("--root-dir <path>", "Override the local workspace root")
    .option("--remote <url>", "Override the remote Git repository URL")
    .option("--branch <name>", "Override the remote branch")
    .option("--repository-subdir <path>", "Override the subdirectory inside the remote repository")
    .option("--state-dir <path>", "Override the local state directory")
    .option("--schedule <expr>", "Run on a cron-compatible schedule (5 fields)")
    .option("--max-runs <count>", "Limit the number of scheduled runs")
    .option(
      "--conflict-strategy <strategy>",
      "Conflict strategy: inline-markers, local-wins, remote-wins"
    )
    .option(
      "--reachability-timeout-ms <ms>",
      "Timeout for the remote reachability precheck before pull/push (default 4000, env AGENT_MEMORY_SYNC_REACHABILITY_TIMEOUT_MS)"
    )
    .option(
      "--allow-mass-delete",
      "Push a plan the mass-delete guard would refuse (see massDeleteGuard in the config). It does not " +
        "override an unreliable checkout: a working copy that came back missing files is still refused",
      false
    )
    .option(
      "--accept-mass-delete",
      "Apply a remote change that deletes more of a destination than the guard allows, and adopt a " +
        "checkout the run would otherwise call unreliable. The destination is copied into " +
        "stateDir/snapshots first. Use it only once the remote deletion is known to be genuine",
      false
    )
    .option("--dry-run", "Preview without making changes", false)
    .option("-o, --output <format>", "Output format: text, json, yaml", "text")
    .option("-v, --verbose", "Enable verbose diagnostics", false)
    .option("-q, --quiet", "Suppress non-error diagnostics", false)
    .option("--no-color", "Disable colored diagnostics")
    .action(async (profile: string, options: RunOptions) => {
      const loaded = await loadConfig(options.config);
      const runConfig = requireRemoteUrl(
        resolveRunConfig(loaded, {
          profile,
          outputFormat: options.output,
          verbose: options.verbose,
          quiet: options.quiet,
          color: options.color,
          mode: options.mode,
          rootDir: options.rootDir,
          remoteUrl: options.remote,
          branch: options.branch,
          repositorySubdir: options.repositorySubdir,
          stateDir: options.stateDir,
          schedule: options.schedule,
          conflictStrategy: options.conflictStrategy,
          reachabilityTimeoutMs: parseOptionalInteger(
            options.reachabilityTimeoutMs,
            "--reachability-timeout-ms"
          ) ?? undefined
        })
      );

      if (runConfig.schedule) {
        validateCronExpression(runConfig.schedule);
      }

      const maxRuns = parseOptionalInteger(options.maxRuns, "--max-runs");
      const outputOptions = {
        color: runConfig.color,
        quiet: runConfig.quiet,
        verbose: runConfig.verbose
      };

      const runs: Array<Record<string, unknown>> = [];
      let remainingRuns = maxRuns || (runConfig.schedule ? Number.POSITIVE_INFINITY : 1);
      // Set once a scheduled tick escalates (RemoteQueueEscalationError) so
      // the whole invocation still exits 6 after the loop below finishes —
      // see the try/catch inside the loop for why a scheduled run does not
      // stop ticking the moment that happens.
      let queueEscalationError: unknown = null;

      while (remainingRuns > 0) {
        if (options.dryRun) {
          writeDryRun(`executing ${runConfig.mode} for profile '${runConfig.profile}'`, outputOptions);
        }

        // Taken before anything reads or writes rootDir, the base snapshots,
        // the queue or a working copy under stateDir/tmp, and released again
        // between scheduled ticks rather than held across the sleep: a run
        // that cannot have the lock has to leave all of them untouched, and
        // a scheduled run must not lock out the watch job while it waits for
        // its next tick. See src/memory-sync/lock.ts.
        const lock = acquireStateDirLock({
          stateDir: runConfig.stateDir,
          command: `run --mode ${runConfig.mode}${options.dryRun ? " --dry-run" : ""}`,
          staleMs: runConfig.lockStaleMs
        });

        let execution: Record<string, unknown>;
        try {
          execution = await executeMode(
            runConfig,
            {
              dryRun: options.dryRun,
              allowMassDelete: options.allowMassDelete,
              acceptMassDelete: options.acceptMassDelete
            },
            outputOptions
          );
        } catch (error) {
          // Single run (no --schedule): preserve the pre-fix behavior
          // exactly — RemoteQueueEscalationError (and everything else)
          // propagates immediately, uncaught, straight out of this action
          // handler to main.ts's top-level catch, with writeResult() below
          // never reached. Immediate exit 6, same as before this fix.
          //
          // Scheduled run: an escalating tick must not kill the scheduler
          // outright. run --schedule IS its own supervisor/replay loop — a
          // tick that escalated failed to drain the queue on THIS tick, but
          // the queue is still safely persisted and a later tick, once the
          // remote recovers, is exactly what replays it. Dying on the first
          // escalation stranded every remaining tick from ever getting that
          // chance (measured: exit 6 after tick 1 of 3, zero stdout, no
          // further ticks ran at all). So: record it, keep ticking, and
          // still exit 6 once the loop ends — just after every remaining
          // tick had its shot, and after writeResult() below has run so a
          // --output json consumer still sees every tick that did complete.
          if (!runConfig.schedule || !(error instanceof RemoteQueueEscalationError)) {
            throw error;
          }

          queueEscalationError = error;
          execution = {
            kind: runConfig.mode,
            status: "escalated",
            remoteHeadBefore: null,
            remoteHeadAfter: null,
            appliedFiles: [],
            mergedFiles: [],
            conflictFiles: [],
            queuedSnapshotId: null,
            notes: [formatErrorMessage(error)]
          };
        } finally {
          lock.release();
        }

        runs.push(execution);
        remainingRuns -= 1;

        if (!runConfig.schedule || remainingRuns <= 0) {
          break;
        }

        const tick = nextScheduleTick(runConfig.schedule, new Date());
        writeInfo(
          `next scheduled run for profile '${runConfig.profile}' at ${tick.runAt}`,
          outputOptions
        );
        await delay(tick.waitMs);
      }

      const payload = {
        command: "run",
        profile: runConfig.profile,
        mode: runConfig.mode,
        dryRun: options.dryRun,
        schedule: runConfig.schedule,
        runs
      };

      writeResult(payload, runConfig.outputFormat, () => runs.map(summarizeOperation).join("\n"));

      if (queueEscalationError) {
        throw queueEscalationError;
      }
    });
}

async function executeMode(
  runConfig: {
    mode: RunMode;
    profile: string;
    stateDir: string;
    rootDir: string;
    repositorySubdir: string;
    conflictStrategy: "inline-markers" | "local-wins" | "remote-wins";
    remoteUrl: string;
    branch: string;
    gitBinary: string;
    syncPaths: Array<{
      source: string;
      destination?: string;
      kind?: "file" | "directory";
      required?: boolean;
    }>;
  },
  options: { dryRun: boolean; allowMassDelete: boolean; acceptMassDelete: boolean },
  outputOptions: { color: boolean; quiet: boolean; verbose: boolean }
) {
  if (runConfig.mode === "push") {
    return performPush(runConfig, options);
  }

  if (runConfig.mode === "pull") {
    return performPull(runConfig, options);
  }

  try {
    const pullResult = await performPull(runConfig, options);
    const pushResult = await performPush(runConfig, options);

    return {
      kind: "sync",
      status: summarizeSyncStatus(pullResult.status, pushResult.status),
      remoteHeadBefore: pullResult.remoteHeadBefore,
      remoteHeadAfter: pushResult.remoteHeadAfter,
      appliedFiles: unique([...pullResult.appliedFiles, ...pushResult.appliedFiles]),
      mergedFiles: unique([...pullResult.mergedFiles, ...pushResult.mergedFiles]),
      conflictFiles: unique([...pullResult.conflictFiles, ...pushResult.conflictFiles]),
      deletedFiles: unique([...(pullResult.deletedFiles || []), ...(pushResult.deletedFiles || [])]),
      snapshots: unique([...(pullResult.snapshots || []), ...(pushResult.snapshots || [])]),
      skippedFiles: unique([...(pullResult.skippedFiles || []), ...(pushResult.skippedFiles || [])]),
      protectedFiles: unique([...(pullResult.protectedFiles || []), ...(pushResult.protectedFiles || [])]),
      queuedSnapshotId: pushResult.queuedSnapshotId || null,
      notes: [...(pullResult.notes || []), ...(pushResult.notes || [])]
    };
  } catch (error: unknown) {
    // Root cause of the 2026-09-11 wipe (agent-tasks cda5b12c): this used to
    // discriminate on `exitCode === 4`, and exit code 4 is shared by every
    // git failure GitClient.run wraps in a generic CliError ("git command
    // failed: ..."). A pull that died because its own working copy had been
    // removed underneath it therefore looked exactly like "the remote is
    // unavailable", and the answer to that, a push-only retry, is what
    // published 406 deletions from a local workspace the same tick had just
    // emptied.
    //
    // Only RemoteUnavailableError means the remote is the problem: it is
    // thrown from exactly two sites (GitClient.lookupRemoteHead and
    // GitClient.push, see errors.ts), and for that case a push-only retry is
    // still right, since performPush queues the snapshot locally. Everything
    // else now propagates and fails the run loudly, which is what the
    // supervisor (launchd KeepAlive, systemd StartLimit*) is for.
    if (!(error instanceof RemoteUnavailableError)) {
      throw error;
    }

    // writeWarning, not writeInfo: the periodic jobs run without --verbose,
    // which made this the one line explaining a degraded tick and made it
    // invisible in exactly the runs that needed it. The same text is also
    // appended to the result payload below, so a --quiet or --output json
    // consumer still sees it.
    const diagnostic = "remote unavailable during pull; queueing local snapshot instead";
    writeWarning(diagnostic, outputOptions);
    const pushResult = await performPush(runConfig, options);
    return { ...pushResult, notes: [...(pushResult.notes || []), diagnostic] };
  }
}

function summarizeSyncStatus(pullStatus: string, pushStatus: string): string {
  if (pullStatus === "dry-run" || pushStatus === "dry-run") {
    return "dry-run";
  }
  if (pushStatus === "queued") {
    return "queued";
  }
  return "applied";
}

function parseOptionalInteger(value: string | undefined, flag: string): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} must be a positive integer.`, 2);
  }

  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

module.exports = { registerRunCommand };
