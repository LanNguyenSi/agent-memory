const { mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const {
  loadConfig,
  requireRemoteUrl,
  resolveRunConfig
} = require("../config/loader");
const { CliError, RestoreSourceNotFoundError } = require("../errors");
const { acquireStateDirLock } = require("../memory-sync/lock");
const {
  collectLocalSyncFiles,
  mapRemotePathToLocalAbsolute,
  resolveSyncPathEntries
} = require("../memory-sync/config");
const { GitClient } = require("../memory-sync/git-client");
const { readPreApplySnapshot, writePreApplySnapshot } = require("../memory-sync/pre-apply-snapshot");
const { StateStore } = require("../memory-sync/state-store");
const { writeDryRun, writeInfo, writeResult, writeWarning } = require("../output");

type OutputFormat = "text" | "json" | "yaml";

// The label of restore's own working copy under stateDir/tmp, named once so
// the directory it creates and the directory it clears cannot drift apart
// (see StateStore.clearTemp).
const RESTORE_TEMP_LABEL = "restore";

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
  fromCommit?: string;
  fromSnapshot?: string | boolean;
}

function registerRestoreCommand(program: import("commander").Command): void {
  program
    .command("restore")
    .description(
      "Restore memory files from a commit in the remote repository, or a whole sync destination from a " +
        "commit or from a local pre-apply snapshot"
    )
    // Two shapes, told apart by --from-commit/--from-snapshot rather than by
    // guessing what the positionals mean:
    //
    //   restore <sha> [--path P] [--yes]              one file or one tree, from a commit
    //   restore <profile> <destination> --from-commit <sha>
    //   restore <profile> <destination> --from-snapshot [<id>|latest]
    //
    // The first is the form this command shipped with and keeps working
    // unchanged; the second is the destination-shaped recovery the
    // 2026-09-11 wipe needed (agent-tasks cda5b12c, pandora run
    // .ai/runs/2026-09-11-memory-sync-wipe).
    .argument(
      "[target]",
      "Commit SHA to restore from, or the configuration profile when --from-commit/--from-snapshot is given",
      "default"
    )
    .argument("[destination]", "Sync destination to restore (with --from-commit/--from-snapshot)")
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
    .option(
      "--from-commit <sha>",
      "Restore a whole sync destination from this commit, and move the base snapshot for it to the " +
        "CURRENT remote tree, so the next push publishes the recovered files as additions"
    )
    .option(
      "--from-snapshot [id]",
      "Restore a whole sync destination from a local pre-apply snapshot (default: latest)"
    )
    .option("--dry-run", "List what would be restored without writing", false)
    .option(
      "--yes",
      "Confirm a full-snapshot restore, or a whole-destination restore (--from-commit/--from-snapshot), " +
        "without prompting",
      false
    )
    .option("-o, --output <format>", "Output format: text, json, yaml", "text")
    .option("-v, --verbose", "Enable verbose diagnostics", false)
    .option("-q, --quiet", "Suppress non-error diagnostics", false)
    .option("--no-color", "Disable colored diagnostics")
    .action(async (target: string, destination: string | undefined, options: RestoreOptions) => {
      const mode = resolveRestoreMode(target, destination, options);
      const sha = mode.kind === "file" ? mode.sha : "";

      if (mode.kind === "file" && !/^[0-9a-f]{4,64}$/i.test(sha)) {
        throw new CliError(`invalid commit sha '${sha}'.`, 2);
      }

      const loaded = await loadConfig(options.config);
      const resolved = resolveRunConfig(loaded, {
        // The profile decides which state directory (and so which lock,
        // which base snapshots and which pre-apply snapshots) this restore
        // operates on, so it has to be resolved before anything is taken or
        // read. The older form has no profile positional and keeps the
        // config file's own.
        profile: mode.kind === "file" ? undefined : mode.profile,
        outputFormat: options.output,
        verbose: options.verbose,
        quiet: options.quiet,
        color: options.color,
        rootDir: options.rootDir,
        remoteUrl: options.remote,
        branch: options.branch,
        repositorySubdir: options.repositorySubdir,
        stateDir: options.stateDir
      });
      // A snapshot restore reads nothing but the local state directory, so
      // it is the one form that works with no remote configured at all.
      const runConfig = mode.kind === "snapshot" ? resolved : requireRemoteUrl(resolved);

      if (mode.kind === "file" && !options.path && !options.yes && !options.dryRun) {
        throw new CliError(
          "full-snapshot restore requires --yes (or use --path to restore a single file, or --dry-run to preview).",
          2
        );
      }

      // The destination forms replace a whole tree, files removed included,
      // and ask for the same confirmation the full-snapshot form does. A dry
      // run writes nothing and needs none.
      if (mode.kind !== "file" && !options.yes && !options.dryRun) {
        throw new CliError(
          `restore ${mode.kind === "commit" ? "--from-commit" : "--from-snapshot"} replaces the whole ` +
            `'${mode.destination}' destination and requires --yes (or --dry-run to preview).`,
          2
        );
      }

      const outputOptions = {
        color: runConfig.color,
        quiet: runConfig.quiet,
        verbose: runConfig.verbose
      };

      // restore writes into the same workspace a sync or watch tick reads,
      // and checks out into the same stateDir/tmp they use, so it takes the
      // same advisory lock they do (src/memory-sync/lock.ts). A recovery
      // command racing a tick is the one race this package must not have.
      const lock = acquireStateDirLock({
        stateDir: runConfig.stateDir,
        command: "restore",
        staleMs: runConfig.lockStaleMs
      });

      // The working copy under stateDir/tmp/restore is a throwaway and is
      // removed on every exit below: a completed restore, a dry run and a
      // failed resolution alike. It used to survive a dry run and a failure,
      // sitting under tmp with a full checkout in it until some later
      // restore happened to reuse the label.
      const stateStore = new StateStore(runConfig.stateDir, runConfig.profile);
      try {
        if (mode.kind !== "file") {
          await restoreDestination(runConfig, options, outputOptions, mode);
          return;
        }

        const gitClient = new GitClient(runConfig.gitBinary);
        const workingCopy = gitClient.prepareWorkingCopy(
          runConfig.remoteUrl,
          runConfig.branch,
          gitClient.createTempRepoDir(runConfig.stateDir, RESTORE_TEMP_LABEL)
        );

        // Skip the network-only fetchRef path entirely when `sha` (full or
        // abbreviated) already resolves against objects prepareWorkingCopy
        // just fetched (the whole branch history). That is what makes an
        // abbreviated sha work at all, since fetchRef's own `git fetch origin
        // <ref>` cannot resolve one against the remote (see git-client.ts).
        // Capture the resolved FULL sha and use it for every subsequent git
        // call and in the reported payload below, instead of re-resolving the
        // (possibly abbreviated) `sha` the operator typed on every call and
        // reporting the abbreviation rather than the commit actually restored
        // from. `|| sha` is a defensive fallback for the practically-unreachable
        // case where fetchRef succeeds but the ref still doesn't resolve
        // locally afterwards (e.g. it named a non-commit object): it keeps
        // this file's prior behavior (operate on the as-typed ref) rather than
        // introducing a new failure mode for that corner.
        let resolvedSha = gitClient.resolveLocalCommit(workingCopy.repoDir, sha);
        if (!resolvedSha) {
          gitClient.fetchRef(workingCopy.repoDir, sha);
          resolvedSha = gitClient.resolveLocalCommit(workingCopy.repoDir, sha) || sha;
        }

        const targetRepoPaths = options.path
          ? [normalizeRequestedPath(runConfig.repositorySubdir, options.path)]
          : gitClient
              .listTreePaths(workingCopy.repoDir, resolvedSha, runConfig.repositorySubdir)
              .filter((p: string) => p.startsWith(`${runConfig.repositorySubdir}/`));

        if (targetRepoPaths.length === 0) {
          throw new RestoreSourceNotFoundError(
            `no files to restore at ${sha}${options.path ? ` for path '${options.path}'` : ""} under '${runConfig.repositorySubdir}/'.`
          );
        }

        // Every target path is mapped and validated here, before the write
        // loop below touches the filesystem at all: a later path in the list
        // failing to map (e.g. a backslash-named path a foreign writer
        // committed to the hub) must not leave the run half-applied, with
        // some files already overwritten and others never reached. This
        // package's own destination-restore path (restoreDestination) is
        // already all-writes-after-all-reads for the same reason (agent-tasks
        // 73ea60bf).
        const resolvedTargets: Array<{ repoRelativePath: string; remoteRelativePath: string; absoluteLocalPath: string }> = [];
        for (const repoRelativePath of targetRepoPaths) {
          const remoteRelativePath = repoRelativePath.slice(runConfig.repositorySubdir.length + 1);
          const absoluteLocalPath = mapRemotePathToLocalAbsolute(runConfig, remoteRelativePath);
          if (!absoluteLocalPath) {
            if (process.platform !== "win32" && remoteRelativePath.includes("\\")) {
              throw new CliError(
                `cannot restore '${remoteRelativePath}': it contains a backslash and cannot be mapped to a ` +
                  "portable local path on this platform. Fix the name at the hub, or use --path to restore " +
                  "an unaffected file.",
                3
              );
            }
            throw new CliError(
              `cannot map remote path '${remoteRelativePath}' to a local sync target. Update syncPaths or use --path.`,
              3
            );
          }
          resolvedTargets.push({ repoRelativePath, remoteRelativePath, absoluteLocalPath });
        }

        const restored: Array<{ remoteRelativePath: string; absoluteLocalPath: string; bytes: number }> = [];

        for (const { repoRelativePath, remoteRelativePath, absoluteLocalPath } of resolvedTargets) {
          const content = gitClient.showAtRef(workingCopy.repoDir, resolvedSha, repoRelativePath);
          if (content === null) {
            throw new RestoreSourceNotFoundError(`file '${repoRelativePath}' does not exist at ${sha}.`);
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
          sha: resolvedSha,
          dryRun: options.dryRun,
          repositorySubdir: runConfig.repositorySubdir,
          restored
        };

        writeResult(payload, runConfig.outputFormat, () =>
          restored
            .map((entry) => `${options.dryRun ? "[dry-run] " : ""}${entry.remoteRelativePath}`)
            .join("\n")
        );
      } finally {
        stateStore.clearTemp(RESTORE_TEMP_LABEL);
        lock.release();
      }
    });
}


type RestoreMode =
  | { kind: "file"; sha: string }
  | { kind: "commit"; profile: string; destination: string; sha: string }
  | { kind: "snapshot"; profile: string; destination: string; snapshot: string };

// Decides which of the command's two shapes was invoked. The flags decide,
// never the positionals: `restore <sha> --yes` and
// `restore <profile> <destination> --from-commit <sha>` would otherwise be
// told apart by guessing whether the first word looks like a sha, and a
// profile named like one would silently take the wrong branch.
function resolveRestoreMode(
  target: string,
  destination: string | undefined,
  options: RestoreOptions
): RestoreMode {
  const wantsCommit = typeof options.fromCommit === "string" && options.fromCommit.length > 0;
  const wantsSnapshot = typeof options.fromSnapshot !== "undefined" && options.fromSnapshot !== false;

  if (!wantsCommit && !wantsSnapshot) {
    if (destination) {
      throw new CliError(
        `restore takes a second positional only with --from-commit or --from-snapshot. ` +
          `Use 'restore <sha> [--path <p>] [--yes]', or ` +
          `'restore <profile> <destination> --from-commit <sha>'.`,
        2
      );
    }
    return { kind: "file", sha: target };
  }

  if (wantsCommit && wantsSnapshot) {
    throw new CliError("--from-commit and --from-snapshot name two different sources; pass one.", 2);
  }

  if (!destination) {
    throw new CliError(
      "restore --from-commit/--from-snapshot needs a destination: " +
        "'restore <profile> <destination> --from-commit <sha>'.",
      2
    );
  }

  if (wantsCommit) {
    const sha = options.fromCommit as string;
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
      throw new CliError(`invalid commit sha '${sha}'.`, 2);
    }
    return { kind: "commit", profile: target, destination, sha };
  }

  return {
    kind: "snapshot",
    profile: target,
    destination,
    // `--from-snapshot` with no value is the one an operator wants almost
    // every time: the copy the run that just surprised them took.
    snapshot: typeof options.fromSnapshot === "string" ? options.fromSnapshot : "latest"
  };
}

// Restores one whole sync destination, from a commit in the remote or from a
// local pre-apply snapshot, and leaves the destination holding exactly what
// the source held: files the source has are written, files it does not are
// removed. Both halves are covered by the copy this takes of the current
// tree before it changes anything, so a restore aimed at the wrong source is
// itself undoable.
async function restoreDestination(
  runConfig: {
    profile: string;
    rootDir: string;
    stateDir: string;
    repositorySubdir: string;
    remoteUrl: string;
    branch: string;
    gitBinary: string;
    outputFormat: OutputFormat;
    snapshotGenerations: number;
    syncPaths: Array<{ source: string; destination?: string; kind?: "file" | "directory"; required?: boolean }>;
  },
  options: RestoreOptions,
  outputOptions: { color: boolean; quiet: boolean; verbose: boolean },
  mode: Extract<RestoreMode, { kind: "commit" | "snapshot" }>
): Promise<void> {
  const resolvedEntries = resolveSyncPathEntries(runConfig);
  const destinations = resolvedEntries.map((entry: { destination: string }) => entry.destination);
  if (!destinations.includes(mode.destination)) {
    throw new CliError(
      `'${mode.destination}' is not a configured sync destination. Configured: ${destinations.sort().join(", ")}.`,
      3
    );
  }

  // Everything the destination currently holds, read before anything is
  // written: the copy below and the removals further down both depend on it.
  const currentFiles = collectLocalSyncFiles(runConfig).filter(
    (file: { remoteRelativePath: string }) =>
      belongsToDestination(file.remoteRelativePath, mode.destination)
  );

  const gitClient = new GitClient(runConfig.gitBinary);
  let sourceFiles: Array<{ remoteRelativePath: string; read: () => Buffer }>;
  let workingCopy: { repoDir: string; remoteHead: string | null } | null = null;
  let resolvedSha = "";

  if (mode.kind === "commit") {
    const prepared = gitClient.prepareWorkingCopy(
      runConfig.remoteUrl,
      runConfig.branch,
      gitClient.createTempRepoDir(runConfig.stateDir, RESTORE_TEMP_LABEL)
    );
    workingCopy = prepared;
    const repoDir = prepared.repoDir;
    resolvedSha = gitClient.resolveLocalCommit(repoDir, mode.sha) || "";
    if (!resolvedSha) {
      gitClient.fetchRef(repoDir, mode.sha);
      resolvedSha = gitClient.resolveLocalCommit(repoDir, mode.sha) || mode.sha;
    }

    const prefix = `${runConfig.repositorySubdir}/`;
    sourceFiles = gitClient
      .listTreePaths(repoDir, resolvedSha, runConfig.repositorySubdir)
      .filter((repoRelativePath: string) => repoRelativePath.startsWith(prefix))
      .map((repoRelativePath: string) => repoRelativePath.slice(prefix.length))
      .filter((remoteRelativePath: string) => belongsToDestination(remoteRelativePath, mode.destination))
      .map((remoteRelativePath: string) => ({
        remoteRelativePath,
        read: () =>
          Buffer.from(
            gitClient.showAtRef(
              repoDir,
              resolvedSha,
              `${runConfig.repositorySubdir}/${remoteRelativePath}`
            ) || "",
            "utf8"
          )
      }));

    if (sourceFiles.length === 0) {
      throw new RestoreSourceNotFoundError(
        `commit ${resolvedSha} holds no files under '${runConfig.repositorySubdir}/${mode.destination}'.`
      );
    }
  } else {
    // Resolved to a concrete generation BEFORE the copy below adds one, so
    // "latest" never means the snapshot this very command is about to take.
    const stored = readPreApplySnapshot(runConfig.stateDir, mode.destination, mode.snapshot);
    resolvedSha = stored.id;
    sourceFiles = stored.files.map((file: { remoteRelativePath: string; storedPath: string }) => ({
      remoteRelativePath: file.remoteRelativePath,
      read: () => readFileSync(file.storedPath)
    }));
  }

  const sourcePaths = new Set(sourceFiles.map((file) => file.remoteRelativePath));
  const removable = currentFiles.filter(
    (file: { remoteRelativePath: string }) => !sourcePaths.has(file.remoteRelativePath)
  );

  if (options.dryRun) {
    for (const file of sourceFiles) {
      writeDryRun(`would restore ${file.remoteRelativePath}`, outputOptions);
    }
    for (const file of removable) {
      writeDryRun(`would remove ${file.remoteRelativePath}`, outputOptions);
    }
  } else {
    writePreApplySnapshot({
      stateDir: runConfig.stateDir,
      destination: mode.destination,
      files: currentFiles.map((file: { remoteRelativePath: string; absolutePath: string }) => ({
        remoteRelativePath: file.remoteRelativePath,
        absolutePath: file.absolutePath
      })),
      generations: runConfig.snapshotGenerations
    });

    for (const file of sourceFiles) {
      const absolutePath = mapRemotePathToLocalAbsolute(runConfig, file.remoteRelativePath, resolvedEntries);
      if (!absolutePath) {
        throw new CliError(
          `cannot map '${file.remoteRelativePath}' to a local sync target. Update syncPaths.`,
          3
        );
      }
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      // Written as a Buffer, never through a decode-and-re-encode of this
      // command's own. What that buys depends on the source. A snapshot
      // source is byte-exact: the copy was taken with copyFileSync and is
      // read back as raw bytes here. A commit source is UTF-8-exact:
      // showAtRef decodes git's output as UTF-8, which is the same fidelity
      // collectLocalSyncFiles imposes on every file this package syncs in
      // the first place (files are read and pushed as UTF-8 text), so no
      // byte a sync could have carried is lost on the way back, while a
      // byte sequence that is not valid UTF-8 would be replaced here just as
      // it would have been on the way in.
      writeFileSync(absolutePath, file.read());
      writeInfo(`restored ${file.remoteRelativePath}`, outputOptions);
    }

    for (const file of removable) {
      rmSync(file.absolutePath, { force: true });
      writeInfo(`removed ${file.remoteRelativePath}`, outputOptions);
    }

    if (mode.kind === "commit" && workingCopy) {
      moveBaseToCurrentRemote(runConfig, gitClient, workingCopy.repoDir, mode.destination, outputOptions);
    }
  }

  const payload = {
    command: "restore",
    profile: runConfig.profile,
    destination: mode.destination,
    dryRun: options.dryRun,
    source:
      mode.kind === "commit"
        ? { kind: "commit", commit: resolvedSha }
        : { kind: "snapshot", snapshot: resolvedSha },
    restored: sourceFiles.map((file) => file.remoteRelativePath).sort(),
    removed: removable.map((file: { remoteRelativePath: string }) => file.remoteRelativePath).sort()
  };

  writeResult(payload, runConfig.outputFormat, () =>
    [
      ...payload.restored.map((p: string) => `${options.dryRun ? "[dry-run] " : ""}restore ${p}`),
      ...payload.removed.map((p: string) => `${options.dryRun ? "[dry-run] " : ""}remove ${p}`)
    ].join("\n")
  );
}

// The base snapshot for this destination becomes the CURRENT remote tree,
// not the restored one. That is what makes the restored files read as
// local-only additions on the next push instead of as a local copy that is
// merely out of date: with base === remote for those paths, the 3-way merge
// sees base null, local present, remote null and publishes them. Setting the
// base to the restored tree would produce the opposite, and a push that
// deletes them all over again.
//
// Only this destination's keys move. Another destination's base entries are
// left exactly as they were, including a peer's owner-scoped file, which is
// why this reads and rewrites the stored map rather than replacing it.
function moveBaseToCurrentRemote(
  runConfig: { profile: string; stateDir: string; repositorySubdir: string },
  gitClient: InstanceType<typeof GitClient>,
  repoDir: string,
  destination: string,
  outputOptions: { color: boolean; quiet: boolean; verbose: boolean }
): void {
  const stateStore = new StateStore(runConfig.stateDir, runConfig.profile);
  const stored = stateStore.readBaseSnapshots();

  for (const key of Object.keys(stored)) {
    if (belongsToDestination(key, destination)) {
      delete stored[key];
    }
  }

  const prefix = `${runConfig.repositorySubdir}/`;
  for (const repoRelativePath of gitClient.listFiles(repoDir, runConfig.repositorySubdir)) {
    if (!repoRelativePath.startsWith(prefix)) {
      continue;
    }
    const remoteRelativePath = repoRelativePath.slice(prefix.length);
    if (!belongsToDestination(remoteRelativePath, destination)) {
      continue;
    }
    // A base-snapshot key must always have a local counterpart, or the next
    // push's 3-way merge reads it as a local deletion. git-client.ts's
    // listFiles no longer flattens a real "\" in a hub-side name into "/" on
    // this platform, so a foreign writer's backslash-named path reaches here
    // raw; it cannot become a base-snapshot key here any more than it could
    // become a written local file in the loop above. Skip it and say so, the
    // same hub-side-skip idiom pull.ts's collectRemoteFiles uses (agent-tasks
    // 73ea60bf).
    if (process.platform !== "win32" && remoteRelativePath.includes("\\")) {
      writeWarning(
        `skipped ${remoteRelativePath}; contains a backslash and cannot be mapped to a portable local ` +
          "path on this platform - fix the name at the hub",
        outputOptions
      );
      continue;
    }
    stored[remoteRelativePath] = gitClient.readFile(repoDir, repoRelativePath);
  }

  stateStore.replaceBaseSnapshots(stored);
}

function belongsToDestination(remoteRelativePath: string, destination: string): boolean {
  return remoteRelativePath === destination || remoteRelativePath.startsWith(`${destination}/`);
}

function normalizeRequestedPath(repositorySubdir: string, requested: string): string {
  // Silently flattening an operator-typed "\" would target the wrong file
  // with no error at all, so this refuses outright instead of guessing. On
  // win32 the blanket replace below is exact (a typed "\" IS a separator
  // there), but on darwin/linux an operator-typed "\" is legal inside a real
  // path segment; unlike the internal call sites, this function's sibling
  // paths route through assertPortablePathSegment (agent-tasks 73ea60bf).
  if (process.platform !== "win32" && requested.includes("\\")) {
    throw new CliError(
      `--path value '${requested}' contains a backslash and cannot be mapped to a portable remote path ` +
        "on this platform. Rename the file, or pass its actual remote path segments.",
      3
    );
  }

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
