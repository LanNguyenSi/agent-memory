const {
  loadConfig,
  requireRemoteUrl,
  resolveRunConfig
} = require("../config/loader");
const { CliError, isCliError } = require("../errors");
const { performPull } = require("../memory-sync/pull");
const { performPush } = require("../memory-sync/push");
const { summarizeOperation } = require("../memory-sync/preview");
const { nextScheduleTick, validateCronExpression } = require("../memory-sync/scheduler");
const { writeDryRun, writeInfo, writeResult } = require("../output");

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
          conflictStrategy: options.conflictStrategy
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

      while (remainingRuns > 0) {
        if (options.dryRun) {
          writeDryRun(`executing ${runConfig.mode} for profile '${runConfig.profile}'`, outputOptions);
        }

        const execution = await executeMode(runConfig, { dryRun: options.dryRun }, outputOptions);
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
  options: { dryRun: boolean },
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
      queuedSnapshotId: pushResult.queuedSnapshotId || null,
      notes: [...(pullResult.notes || []), ...(pushResult.notes || [])]
    };
  } catch (error: unknown) {
    const exitCode =
      typeof (error as { exitCode?: unknown }).exitCode === "number"
        ? (error as { exitCode: number }).exitCode
        : null;

    if (exitCode === 4) {
      writeInfo("remote unavailable during pull; queueing local snapshot instead", outputOptions);
      return performPush(runConfig, options);
    }

    throw error;
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
