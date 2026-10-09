const { lstatSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const {
  collectLocalSyncFiles,
  filterUnmappedBaseMap,
  mapRemotePathToLocalAbsolute,
  normalizeRemoteRelativePath,
  ownerMismatchNote,
  resolveSyncPathEntries
} = require("./config");
const { CliError, AdoptionSnapshotNotIntactError } = require("../errors");
const { GitClient } = require("./git-client");
const { assertNoRemoteMassDelete, assertOverridableCheckout, assertReliableCheckout } = require("./guards");
const { hasConflictMarkers, mergeText } = require("./merge");
const { findPreApplySnapshotProblem, writePreApplySnapshot } = require("./pre-apply-snapshot");
const { checkRemoteReachable } = require("./reachability");
const { StateStore } = require("./state-store");

// The label of pull's own working copy under stateDir/tmp. Named once so
// the directory this run creates and the directory it clears afterwards
// cannot drift apart (see StateStore.clearTemp).
const PULL_TEMP_LABEL = "pull";

interface PullOptions {
  dryRun: boolean;
  // --accept-mass-delete: the operator's answer to "the remote really did
  // drop those files". It is the one thing that lets a pull apply a deletion
  // both guards below would otherwise refuse, and it is deliberately NOT
  // --allow-mass-delete, which answers the opposite question ("publish these
  // deletions") on the push side and never reaches either of these checks.
  //
  // It is also the only override of the checkout check. Nothing at the file
  // level distinguishes a working copy that was wiped from a remote that
  // genuinely dropped the files, so without an escape a legitimate large
  // deletion wedges every mode permanently; with it, an operator who has
  // confirmed the deletion is genuine can proceed, and the destination is
  // copied into stateDir/snapshots before a single file is removed.
  acceptMassDelete?: boolean;
}

interface PullConfig {
  profile: string;
  stateDir: string;
  rootDir: string;
  repositorySubdir: string;
  conflictStrategy: "inline-markers" | "local-wins" | "remote-wins";
  remoteUrl: string;
  branch: string;
  gitBinary: string;
  reachabilityTimeoutMs?: number;
  reachabilityCheckCommand?: string[] | null;
  massDeleteGuard?: { maxRatio?: number; maxFiles?: number } | null;
  // How many pre-apply snapshots per destination survive (./pre-apply-snapshot.ts).
  snapshotGenerations?: number | null;
  syncPaths: Array<{
    source: string;
    destination?: string;
    kind?: "file" | "directory";
    required?: boolean;
    ownerScoped?: boolean;
  }>;
}

async function performPull(config: PullConfig, options: PullOptions) {
  const stateStore = new StateStore(config.stateDir, config.profile);
  stateStore.ensure();

  // Fast precheck before the network operation. An unreachable remote must
  // not hang on `git ls-remote`/`fetch`; it short-circuits into a clean,
  // no-op "skipped" result that leaves local files and state untouched.
  const reachability = checkRemoteReachable(config);
  if (!reachability.reachable) {
    return {
      kind: "pull",
      status: "skipped",
      remoteHeadBefore: null,
      remoteHeadAfter: null,
      appliedFiles: [],
      mergedFiles: [],
      conflictFiles: [],
      deletedFiles: [],
      skippedFiles: [],
      protectedFiles: [],
      snapshots: [],
      notes: [`remote unreachable (${reachability.reason}); skipped pull, local files unchanged`]
    };
  }

  const gitClient = new GitClient(config.gitBinary);
  const workingCopy = gitClient.prepareWorkingCopy(
    config.remoteUrl,
    config.branch,
    gitClient.createTempRepoDir(config.stateDir, PULL_TEMP_LABEL)
  );

  const localFiles = collectLocalSyncFiles(config);
  const localMap = Object.fromEntries(
    localFiles.map((file: { remoteRelativePath: string; content: string }) => [file.remoteRelativePath, file.content])
  );
  const baseMap = stateStore.readBaseSnapshots();
  // A hub-side name that cannot be mapped to a portable local path on this
  // platform is skipped and reported here, never a whole-run abort - only
  // the local push/sync/restore/pull direction (a name this machine could
  // rename) refuses the whole run (agent-tasks 73ea60bf). Declared here,
  // ahead of collectRemoteFiles, so its hub-side backslash notes land in
  // the same array the rest of this function already appends its
  // diagnostics to below.
  const notes: string[] = [];
  const remoteMap = collectRemoteFiles(config, gitClient, workingCopy.repoDir, notes);
  // Guard 1: never merge against a working copy that cannot be trusted to
  // represent the remote. In the memory-corpus wipe (agent-tasks cda5b12c) the fetched copy under
  // stateDir/tmp/pull had been removed by a concurrent tick AFTER git
  // reported a successful checkout, so every remote path read as null and
  // the merge below deleted every local file the merge visited. This throws
  // before the loop, so no local file is touched and no base snapshot is
  // rewritten.
  //
  // It sits here rather than inside the loop because this is pull's only
  // deletion path, and it must refuse BEFORE the first deletion instead of
  // after counting the ones it already made. --allow-mass-delete does not
  // reach it: that flag answers "publish these deletions", not "trust this
  // working copy". --accept-mass-delete does, for a finding whose emptied
  // count is zero, because a genuine remote deletion is indistinguishable
  // from a wiped checkout at the file level and would otherwise have no way
  // through at all. A finding with emptied paths has no such ambiguity to
  // resolve by consent (see assertOverridableCheckout in ./guards.ts), so
  // it refuses here regardless of the flag.
  if (options.acceptMassDelete) {
    assertOverridableCheckout({
      config,
      baseMap,
      remoteMap,
      remoteHead: workingCopy.remoteHead
    });
  } else {
    assertReliableCheckout({
      config,
      baseMap,
      remoteMap,
      remoteHead: workingCopy.remoteHead
    });
  }

  const targetPaths = new Set<string>([...Object.keys(localMap), ...Object.keys(baseMap), ...Object.keys(remoteMap)]);

  const mergedFiles: string[] = [];
  const conflictFiles: string[] = [];
  const skippedFiles: string[] = [];
  const protectedFiles: string[] = [];
  // Paths whose hub copy carries conflict markers and that this pull
  // therefore left alone; their base entries must not move (see the base
  // write at the end of this function).
  const refusedPaths: string[] = [];
  // Everything this pull would write or delete, assembled before any of it
  // is carried out. The plan exists as its own phase so the guard below can
  // refuse an implausible one, and so the pre-apply snapshots can be taken,
  // while the workspace is still exactly as this run found it.
  const plan: PullPlanEntry[] = [];

  // Resolved once, outside the per-path loop below. See resolveSyncPathEntries'
  // own comment in config.ts (agent-tasks 65380570, LOW): this loop calls
  // mapRemotePathToLocalAbsolute once per path in targetPaths, so
  // re-resolving every syncPaths entry (including its existsSync/statSync
  // kind check) from scratch on every call is an O(paths x syncPaths) count
  // of redundant stat calls per run.
  const resolvedSyncPathEntries = resolveSyncPathEntries(config);

  for (const remoteRelativePath of Array.from(targetPaths).sort()) {
    // Guard 2: a local file the base snapshot has never recorded, and that
    // the remote does not have, is local-only. It is a candidate for the
    // next push and can never be a pull deletion, whatever the 3-way merge
    // would make of it. Checked BEFORE mergeText rather than after,
    // deliberately: today mergeText's `remote === base` fast path also keeps
    // such a file (both are null, so local wins), but that is an emergent
    // property of one branch's ordering inside a general-purpose merge
    // function, not a stated invariant of the pull. The incident showed what
    // it costs when a merge answer about deletion is trusted
    // unconditionally, so the invariant is stated here, where the deletion
    // lives, and the count is reported.
    //
    // Every key of localMap is mappable to a local destination by
    // construction (collectLocalSyncFiles builds them from the configured
    // syncPaths), so this cannot swallow a path the unmapped guard below
    // would otherwise classify as skipped.
    const hasBaseSnapshot = Object.prototype.hasOwnProperty.call(baseMap, remoteRelativePath);
    const localValue = readSnapshotValue(localMap, remoteRelativePath);
    const remoteValue = readSnapshotValue(remoteMap, remoteRelativePath);
    if (!hasBaseSnapshot && localValue !== null && remoteValue === null) {
      protectedFiles.push(remoteRelativePath);
      continue;
    }

    // the peer-file mirror rule (task e104c9f2; the incident class is recorded in
    // CHANGELOG.md's [Unreleased] entry): a peer's
    // file inside an ownerScoped directory destination is never this
    // machine's own state, so a 3-way merge over it (and the inline-markers
    // fallback that comes with one) is the wrong operation. This machine
    // cannot resolve a conflict in content it does not own; the remote is
    // definitionally correct for a peer file, so pull mirrors it
    // unconditionally instead of merging. This is what stopped a peer's
    // ownerScoped file from ever converging: base == remote, local carried
    // stale inline conflict markers from an earlier cascade, and the old
    // 3-way "local wins" fast path kept re-choosing the marker-carrying
    // local content forever because push's ownerFilter never publishes a
    // peer file to fix it from the other end. The machine's own
    // `<profile>.json` is exempt and keeps the existing 3-way rule below.
    const isOwnerScopedPeerFile = isOwnerScopedPeerPath(resolvedSyncPathEntries, config.profile, remoteRelativePath);

    // A hub file that itself carries conflict markers is never merged into
    // the local file, whichever strategy is configured: writing it, or a
    // merge built on it, would copy damaged content over a local file that
    // may be the only clean copy. The local file stays byte-identical (it is
    // not in the plan, so it is not snapshotted either), the path is reported
    // as a conflict and named in a note, and its base entry stays where it
    // was so the same decision is reached again until the hub copy is
    // repaired. A path whose local copy already equals the hub copy has
    // nothing to protect and goes on to the stale-marker note below, and a
    // path no sync path maps is skipped further down as before. An
    // ownerScoped peer file is exempt: the remote owns it and the mirror
    // rule takes it verbatim, flagged as a conflict.
    if (
      !isOwnerScopedPeerFile &&
      localValue !== remoteValue &&
      hasConflictMarkers(remoteValue) &&
      mapRemotePathToLocalAbsolute(config, remoteRelativePath, resolvedSyncPathEntries)
    ) {
      refusedPaths.push(remoteRelativePath);
      conflictFiles.push(remoteRelativePath);
      notes.push(hubMarkersPullNote(remoteRelativePath));
      continue;
    }

    const mergeResult = isOwnerScopedPeerFile
      ? {
          content: remoteValue,
          status: remoteValue === localValue ? "unchanged" : "remote",
          // The remote is
          // definitionally correct for a peer file, but "correct" is not the
          // same as "clean": a peer's own hub content can itself carry
          // stale inline markers (e.g. a peer's unresolved own-file conflict
          // pushed by mistake). Mirroring it must never claim conflict:false
          // for content that already has markers in it.
          conflict: hasConflictMarkers(remoteValue)
        }
      : mergeText({
          base: readSnapshotValue(baseMap, remoteRelativePath),
          local: localValue,
          remote: remoteValue,
          strategy: config.conflictStrategy
        });

    if (mergeResult.content === localValue) {
      continue;
    }

    const localAbsolutePath = mapRemotePathToLocalAbsolute(config, remoteRelativePath, resolvedSyncPathEntries);
    if (!localAbsolutePath) {
      // No configured syncPaths entry maps this remote path back to a local
      // destination, so nothing is ever written or deleted for it below.
      // Reporting-honesty fix (agent-tasks e4b5552a): this used to land in
      // changedFiles (surfaced as appliedFiles) BEFORE this guard skipped
      // the write, so the payload claimed "applied" for a file that was
      // never touched. Track it here instead, so appliedFiles stays an
      // honest "files this run actually wrote or deleted" list.
      //
      // Fix-round finding (agent-tasks e4b5552a, MEDIUM #1): this guard must
      // also run BEFORE the merged/conflict classification below, not just
      // before the write. An unmapped path that mergeText resolves to
      // "conflict" (e.g. base/remote both non-null, local null because it
      // was never written) used to still land in conflictFiles even though
      // no local file with markers was ever created for it: the payload
      // claimed conflicts=1 for a file nothing could ever show a conflict
      // in. Classifying it here, once, as skipped, and returning before the
      // merged/conflict pushes keeps conflictFiles/mergedFiles an honest
      // "files this run actually merged or left conflict markers in" list.
      skippedFiles.push(remoteRelativePath);
      continue;
    }

    if (mergeResult.status === "merged") {
      mergedFiles.push(remoteRelativePath);
    }
    if (mergeResult.conflict) {
      conflictFiles.push(remoteRelativePath);
    }

    plan.push({
      remoteRelativePath,
      localAbsolutePath,
      content: mergeResult.content,
      // A write onto a file that is already there replaces bytes that exist
      // nowhere else once it lands, which is what makes it worth a snapshot;
      // a write that creates a file takes nothing away.
      overwrite: localValue !== null
    });
  }

  const changedFiles = plan.map((entry) => entry.remoteRelativePath);
  const deletedFiles = plan.filter((entry) => entry.content === null).map((entry) => entry.remoteRelativePath);

  // Stale-marker note (task e104c9f2): a local file that already carries inline conflict markers
  // and that this run leaves untouched must say so, once per file, instead
  // of letting the summary report conflicts=0 while the file still sits
  // there unresolved. Two shapes reach this loop with markers still in the
  // local content: (1) remote == local == markered, so mergeText's (or the
  // peer-file mirror rule's) `mergeResult.content === localValue` fast path
  // hands back the same content unchanged, for the machine's own file or a
  // non-ownerScoped (e.g. memory) file as well as an ownerScoped peer file; and (2) a base-less protected peer file (Guard
  // 2 above), which carries markers and is never routed through the
  // mirror/merge branch at all. A path the plan is about to overwrite
  // (plannedPaths.has below) is excluded, since after the peer-file mirror
  // rule an ownerScoped peer file WITH a base snapshot is always planned
  // for overwrite and never reaches here. The note text below
  // distinguishes an ownerScoped peer file (fix at the hub or restore) from
  // every other case (fix by editing the file), since a peer file's fix
  // path is never a local edit.
  const plannedPaths = new Set(plan.map((entry) => entry.remoteRelativePath));

  // Profile mismatch (task e104c9f2): the CLI's [profile] positional
  // can silently not match this machine's actual owner filename (loader.ts's
  // override order), in which case the peer-file mirror rule above treats this
  // machine's own file as just another peer and mirrors/overwrites it from
  // the remote without a word. Push already surfaces the identical
  // mismatch as a warning (collectLocalSyncFiles' ownerFilter branch,
  // config.ts ~46-114); this reuses the same wording so the fix reads as
  // one diagnostic regardless of which side reports it. One note per
  // destination, independent of the merge/mirror loop above.
  for (const entry of resolvedSyncPathEntries) {
    if (entry.kind !== "directory" || !entry.ownerScoped) {
      continue;
    }
    const ownerFileName = `${config.profile}.json`;
    const ownFileKey = `${entry.destination}/${ownerFileName}`;
    if (Object.prototype.hasOwnProperty.call(localMap, ownFileKey)) {
      continue;
    }
    const peerFileCount = Object.keys(localMap).filter(
      (key) => key === entry.destination || key.startsWith(`${entry.destination}/`)
    ).length;
    if (peerFileCount > 0) {
      notes.push(
        ownerMismatchNote(config.profile, ownerFileName, peerFileCount, entry.absoluteSource, entry.destination)
      );
    }
  }

  for (const remoteRelativePath of Array.from(targetPaths).sort()) {
    if (plannedPaths.has(remoteRelativePath)) {
      continue;
    }
    if (!hasConflictMarkers(readSnapshotValue(localMap, remoteRelativePath))) {
      continue;
    }
    // A local copy equal to a hub copy that carries the same markers is exempt
    // from the refusal above (there is nothing local to protect), but editing
    // it is not enough: push holds a path whose hub copy carries markers
    // back, so a local resolution alone never reaches the hub.
    const hubCarriesSameMarkers =
      readSnapshotValue(remoteMap, remoteRelativePath) === readSnapshotValue(localMap, remoteRelativePath);
    notes.push(
      isOwnerScopedPeerPath(resolvedSyncPathEntries, config.profile, remoteRelativePath)
        ? `stale conflict markers in ${remoteRelativePath}; the remote owns this file, fix it at the hub or restore --from-commit`
        : hubCarriesSameMarkers
          ? `stale conflict markers in ${remoteRelativePath}; the hub copy carries the same markers, so repair the ` +
            "hub copy (commit a clean version to the hub), a local resolution alone is not published"
          : `stale conflict markers in ${remoteRelativePath}; resolve by editing the file`
    );
  }

  // Guard 3: the plan itself. Evaluated for a dry run too, since --dry-run
  // is how an operator inspects a plan before running it and must not
  // preview one the real run would refuse.
  assertNoRemoteMassDelete({
    config,
    baseMap,
    deletedPaths: deletedFiles,
    acceptMassDelete: options.acceptMassDelete
  });

  if (options.dryRun) {
    return {
      kind: "pull",
      status: "dry-run",
      remoteHeadBefore: workingCopy.remoteHead,
      remoteHeadAfter: workingCopy.remoteHead,
      appliedFiles: changedFiles,
      mergedFiles,
      conflictFiles,
      deletedFiles,
      skippedFiles,
      protectedFiles,
      snapshots: [],
      notes
    };
  }

  // Stop before any snapshot is written, and so before any older generation is
  // rotated away, when the plan reaches a path the snapshot could never hold.
  // That cause is persistent, so every retry or periodic tick would otherwise
  // write one more generation and drop one more of the older ones while still
  // failing at the read-back below.
  const uncollectedPath = findUncollectedPlanPath(plan, localFiles);
  if (uncollectedPath !== null) {
    throw new AdoptionSnapshotNotIntactError(
      `pull stopped: ${uncollectedPath} exists on disk but is not a regular file the sync collects ` +
        "(a symlink, a directory, a file whose name differs from the hub path only by case or Unicode " +
        "normalization, or a file created after the run collected its files), so no pre-apply snapshot can hold " +
        "a copy of it. No local file was written or removed, no snapshot was written and the base snapshot was " +
        `not moved; move ${uncollectedPath} aside and run the pull again`
    );
  }

  const writtenSnapshots = snapshotAffectedDestinations(config, plan, localFiles, resolvedSyncPathEntries);
  const snapshots = writtenSnapshots.map((written) => written.id);

  // Read every snapshot back before the first write or removal. The snapshots
  // were taken from the local files collected before the fetch, so a file that
  // appeared or changed since, or a generation that is gone by now, would
  // otherwise be overwritten or removed with no surviving copy. Nothing has
  // been touched yet, so stopping here leaves the workspace and the base
  // snapshot exactly as they were and the same command can simply be repeated.
  const snapshotProblem = findPullSnapshotProblem({
    stateDir: config.stateDir,
    plan,
    snapshots: writtenSnapshots,
    resolvedSyncPathEntries: resolvedSyncPathEntries
  });
  if (snapshotProblem) {
    throw new AdoptionSnapshotNotIntactError(
      `pull stopped: the pre-apply snapshot for '${snapshotProblem.destination}' is not intact ` +
        `(${snapshotProblem.problem}). No local file was written or removed and the base snapshot was not ` +
        "moved; run the pull again. If it stops again at the same path, that path is on disk but is not a " +
        "regular file the sync collects (a symlink, a directory, or a name that differs from the hub path only by " +
        "case or Unicode normalization): move it aside and run the pull again"
    );
  }

  for (const entry of plan) {
    if (entry.content === null) {
      rmSync(entry.localAbsolutePath, { force: true });
      continue;
    }

    mkdirSync(path.dirname(entry.localAbsolutePath), { recursive: true });
    writeFileSync(entry.localAbsolutePath, entry.content, "utf8");
  }

  const remoteHeadAfter = workingCopy.remoteHead ? gitClient.revParseHead(workingCopy.repoDir) : null;
  const state = stateStore.loadState();
  state.lastRemoteHead = remoteHeadAfter;
  state.lastRunAt = new Date().toISOString();
  // filterUnmappedBaseMap (config.ts): the base snapshot store must never
  // record a remote path this run just classified as skippedFiles above
  // (no configured syncPaths destination maps it back to a local file):
  // see that function's comment for the full agent-tasks 65380570
  // writeup. Left unfiltered, the next push's 3-way merge would see
  // base=<content>/local=null for that path and silently delete it from
  // the remote as a false "local wins".
  //
  // A path pull refused (its hub copy carries conflict markers) keeps the
  // base entry it had, or none: the local file did not converge on the hub
  // content, so recording that content as the base would make the next
  // three-way merge read the damaged hub copy as "unchanged".
  stateStore.replaceBaseSnapshots(
    keepPreviousBaseEntries(filterUnmappedBaseMap(config, remoteMap), baseMap, refusedPaths)
  );
  stateStore.saveState(state);
  stateStore.clearTemp(PULL_TEMP_LABEL);

  return {
    kind: "pull",
    status: "applied",
    remoteHeadBefore: workingCopy.remoteHead,
    remoteHeadAfter,
    appliedFiles: changedFiles,
    mergedFiles,
    conflictFiles,
    deletedFiles,
    skippedFiles,
    protectedFiles,
    snapshots,
    notes
  };
}

// The note for a path whose hub copy carries conflict markers and that a pull
// therefore left alone. Exported so the combined sync run can tell which paths
// the pull side already named (see src/commands/run.ts).
function hubMarkersPullNote(remoteRelativePath: string): string {
  return (
    `not pulled: ${remoteRelativePath}: the hub copy carries conflict markers and is not merged into the ` +
    "local file, which is left unchanged; repair the hub copy (commit a clean version to the hub), then sync again"
  );
}

// The base to store after a pull, with `keptPaths` holding the entry they had
// before this run (or no entry if they had none) instead of the hub content.
function keepPreviousBaseEntries(
  nextBase: Record<string, string | null>,
  previousBase: Record<string, string | null>,
  keptPaths: string[]
): Record<string, string | null> {
  const result = { ...nextBase };
  for (const key of keptPaths) {
    if (Object.prototype.hasOwnProperty.call(previousBase, key)) {
      result[key] = previousBase[key];
    } else {
      delete result[key];
    }
  }
  return result;
}

interface PullPlanEntry {
  remoteRelativePath: string;
  localAbsolutePath: string;
  content: string | null;
  overwrite: boolean;
}

// Copies every destination this plan is about to delete from or overwrite
// inside, and returns the written snapshots (destination and generation id)
// for the run's report and for the read-back that follows.
//
// A destination the plan only ADDS files to is not copied: nothing that
// exists is being replaced, so there is nothing a copy could preserve. A
// plan that changes nothing at all snapshots nothing, which is what keeps a
// quiet periodic sync from rotating through generations of identical copies
// and pushing the interesting one out.
function snapshotAffectedDestinations(
  config: PullConfig,
  plan: PullPlanEntry[],
  localFiles: Array<{ remoteRelativePath: string; absolutePath: string }>,
  resolvedSyncPathEntries: Array<{ destination: string }>
): Array<{ destination: string; id: string }> {
  const destinations = resolvedSyncPathEntries
    .map((entry) => entry.destination)
    .sort((left, right) => right.length - left.length);

  const affected = new Set<string>();
  for (const entry of plan) {
    if (entry.content !== null && !entry.overwrite) {
      continue;
    }
    const destination = destinationOf(destinations, entry.remoteRelativePath);
    if (destination !== null) {
      affected.add(destination);
    }
  }

  const written: Array<{ destination: string; id: string }> = [];
  for (const destination of Array.from(affected).sort()) {
    const files = localFiles.filter((file) => destinationOf(destinations, file.remoteRelativePath) === destination);
    written.push({
      destination,
      id: writePreApplySnapshot({
        stateDir: config.stateDir,
        destination,
        files: files.map((file) => ({
          remoteRelativePath: file.remoteRelativePath,
          absolutePath: file.absolutePath
        })),
        generations: config.snapshotGenerations
      }).id
    });
  }

  return written;
}

// True when something is at the path, a dangling symlink included: writing a
// file over a dangling symlink writes through it, so it is not "nothing there".
function pathExistsOnDisk(absolutePath: string): boolean {
  try {
    lstatSync(absolutePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

// The first path the plan creates, overwrites or removes that exists on disk
// but is not among the files the pull collected (and so is in no snapshot): a
// symlink, a directory, a case-only or Unicode-normalization alias of another
// file, or a file created after the collection. Returns its remote-relative
// path, or null when every path the plan touches that exists is collected.
function findUncollectedPlanPath(
  plan: PullPlanEntry[],
  localFiles: Array<{ remoteRelativePath: string }>
): string | null {
  const collected = new Set<string>(localFiles.map((file) => file.remoteRelativePath));
  for (const entry of plan) {
    if (pathExistsOnDisk(entry.localAbsolutePath) && !collected.has(entry.remoteRelativePath)) {
      return entry.remoteRelativePath;
    }
  }

  return null;
}

// The read-back of the snapshots a pull just wrote, run after they are
// written and before the first write or removal. Returns the first problem
// found, or null when the apply may go ahead.
//
// The paths that must be covered are decided here, from the disk as it is
// now, not from the files collected before the fetch: every path the plan
// removes or overwrites and that exists on disk must be listed by, and have a
// stored copy in, the snapshot of the destination it falls under. A path that
// does not exist has nothing to preserve. Every destination is checked and
// the first problem stops the whole apply, so a damaged snapshot for one
// destination keeps the others from being applied too: the plan is one unit.
function findPullSnapshotProblem(input: {
  stateDir: string;
  plan: PullPlanEntry[];
  snapshots: Array<{ destination: string; id: string }>;
  resolvedSyncPathEntries: Array<{ destination: string }>;
}): { destination: string; problem: string } | null {
  const destinations = input.resolvedSyncPathEntries
    .map((entry) => entry.destination)
    .sort((left, right) => right.length - left.length);

  const expectedByDestination = new Map<string, string[]>();
  for (const snapshot of input.snapshots) {
    expectedByDestination.set(snapshot.destination, []);
  }
  for (const entry of input.plan) {
    // Decided against the disk now, not from the plan's `overwrite` flag: that
    // flag comes from the files collected before the fetch, and a file that
    // appeared since is overwritten by a "create" all the same.
    if (!pathExistsOnDisk(entry.localAbsolutePath)) {
      continue;
    }
    const destination = destinationOf(destinations, entry.remoteRelativePath);
    const expected = destination === null ? undefined : expectedByDestination.get(destination);
    if (destination === null || !expected) {
      return {
        destination: destination === null ? entry.remoteRelativePath : destination,
        problem: `no pre-apply snapshot was taken that holds ${entry.remoteRelativePath}`
      };
    }
    expected.push(entry.remoteRelativePath);
  }

  for (const snapshot of input.snapshots) {
    const problem = findPreApplySnapshotProblem(
      input.stateDir,
      snapshot.destination,
      snapshot.id,
      expectedByDestination.get(snapshot.destination) || []
    );
    if (problem) {
      return { destination: snapshot.destination, problem };
    }
  }

  return null;
}

// Longest destination first, so the most specific configured destination
// claims a path when one destination is a prefix of another. Mirrors the
// same resolution in ./guards.ts and mapRemotePathToLocalAbsolute.
function destinationOf(destinations: string[], remoteRelativePath: string): string | null {
  for (const destination of destinations) {
    if (remoteRelativePath === destination || remoteRelativePath.startsWith(`${destination}/`)) {
      return destination;
    }
  }

  return null;
}

// Finds the ownerScoped directory-kind syncPaths entry a remote path falls
// under, the same way push's ownerFilter identifies one (config.ts's
// `entry.ownerScoped` on a directory-kind entry), so pull's mirror rule
// above depends on the same shape push already uses rather than deriving
// its own notion of "ownerScoped destination". Returns the first matching
// entry in config.syncPaths order, exactly like mapRemotePathToLocalAbsolute
// resolves the same path's local destination.
function findOwnerScopedDirectoryEntry(
  entries: Array<{ destination: string; kind: "file" | "directory"; ownerScoped: boolean }>,
  remoteRelativePath: string
): { destination: string } | null {
  for (const entry of entries) {
    if (
      entry.kind === "directory" &&
      entry.ownerScoped &&
      (remoteRelativePath === entry.destination || remoteRelativePath.startsWith(`${entry.destination}/`))
    ) {
      return entry;
    }
  }

  return null;
}

// True when remoteRelativePath falls under an ownerScoped directory
// destination AND is not this machine's own `<profile>.json` there, i.e.
// the peer-file mirror rule's own definition of "a peer file". Shared by the
// mirror-rule branch and the stale-marker note loop above so both
// use one notion of "peer file" rather than two independently maintained
// checks drifting apart.
function isOwnerScopedPeerPath(
  entries: Array<{ destination: string; kind: "file" | "directory"; ownerScoped: boolean }>,
  profile: string,
  remoteRelativePath: string
): boolean {
  const ownerScopedEntry = findOwnerScopedDirectoryEntry(entries, remoteRelativePath);
  return ownerScopedEntry !== null && remoteRelativePath !== `${ownerScopedEntry.destination}/${profile}.json`;
}

// A hub-side naming problem this machine cannot fix must not abort the whole
// pull the way the local push/sync/restore direction refuses outright - it
// is skipped and reported in `notes`, naming the hub path, and every other
// file still pulls. git-client.ts's listFiles returns a hub-relative path
// exactly as git holds it on non-win32 (no blanket backslash-to-slash
// flattening), so a hub-side name a foreign writer committed with a literal
// backslash reaches here raw; that name cannot be mapped to a portable local
// path on this platform (assertPortablePathSegment inside
// normalizeRemoteRelativePath throws for it) (agent-tasks 73ea60bf).
function collectRemoteFiles(
  config: { repositorySubdir: string },
  gitClient: InstanceType<typeof GitClient>,
  repoDir: string,
  notes: string[]
): Record<string, string | null> {
  const repoRelativeFiles = gitClient.listFiles(repoDir, config.repositorySubdir);
  const result: Record<string, string | null> = {};

  for (const repoRelativeFile of repoRelativeFiles) {
    if (!repoRelativeFile.startsWith(`${config.repositorySubdir}/`)) {
      continue;
    }

    const hubRelativePath = repoRelativeFile.slice(config.repositorySubdir.length + 1);
    let remoteRelativePath: string;
    try {
      remoteRelativePath = normalizeRemoteRelativePath(hubRelativePath);
    } catch (error) {
      if (error instanceof CliError && process.platform !== "win32" && hubRelativePath.includes("\\")) {
        notes.push(
          `hub path '${hubRelativePath}' contains a backslash and cannot be mapped to a portable local ` +
            "path on this platform; skipped - fix the name at the hub"
        );
        continue;
      }
      throw error;
    }
    result[remoteRelativePath] = gitClient.readFile(repoDir, repoRelativeFile);
  }

  return result;
}

function readSnapshotValue(source: Record<string, string | null>, key: string): string | null {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : null;
}

module.exports = {
  findPullSnapshotProblem,
  findUncollectedPlanPath,
  hubMarkersPullNote,
  performPull
};
