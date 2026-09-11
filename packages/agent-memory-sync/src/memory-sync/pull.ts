const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const {
  collectLocalSyncFiles,
  filterUnmappedBaseMap,
  mapRemotePathToLocalAbsolute,
  normalizeRemoteRelativePath,
  resolveSyncPathEntries
} = require("./config");
const { GitClient } = require("./git-client");
const { assertNoRemoteMassDelete, assertReliableCheckout } = require("./guards");
const { hasConflictMarkers, mergeText } = require("./merge");
const { writePreApplySnapshot } = require("./pre-apply-snapshot");
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
    localFiles.map((file: { remoteRelativePath: string; content: string }) => [
      file.remoteRelativePath,
      file.content
    ])
  );
  const baseMap = stateStore.readBaseSnapshots();
  const remoteMap = collectRemoteFiles(config, gitClient, workingCopy.repoDir);
  // Guard 1: never merge against a working copy that cannot be trusted to
  // represent the remote. In the 2026-09-11 wipe (agent-tasks cda5b12c,
  // pandora run .ai/runs/2026-09-11-memory-sync-wipe) the fetched copy under
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
  // working copy". --accept-mass-delete does, because a genuine remote
  // deletion is indistinguishable from a wiped checkout at the file level
  // and would otherwise have no way through at all. See ./guards.ts.
  if (!options.acceptMassDelete) {
    assertReliableCheckout({
      config,
      baseMap,
      remoteMap,
      remoteHead: workingCopy.remoteHead
    });
  }

  const targetPaths = new Set<string>([
    ...Object.keys(localMap),
    ...Object.keys(baseMap),
    ...Object.keys(remoteMap)
  ]);

  const mergedFiles: string[] = [];
  const conflictFiles: string[] = [];
  const skippedFiles: string[] = [];
  const protectedFiles: string[] = [];
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

    // AC-002 mirror rule (task e104c9f2, pandora run
    // .ai/runs/2026-09-11-sync-peer-file-conflict; incident record and dates
    // are in CHANGELOG.md's [Unreleased] entry, not repeated here): a peer's
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

    const mergeResult = isOwnerScopedPeerFile
      ? {
          content: remoteValue,
          status: remoteValue === localValue ? "unchanged" : "remote",
          // D-001 (review R1 medium, task e104c9f2): the remote is
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
  const deletedFiles = plan
    .filter((entry) => entry.content === null)
    .map((entry) => entry.remoteRelativePath);

  // AC-003 (task e104c9f2; see the AC-002 mirror-rule comment above for the
  // run pointer): a local file that already carries inline conflict markers
  // and that this run leaves untouched must say so, once per file, instead
  // of letting the summary report conflicts=0 while the file still sits
  // there unresolved. Two shapes reach this loop with markers still in the
  // local content: (1) remote == local == markered, so mergeText's (or the
  // AC-002 mirror rule's) `mergeResult.content === localValue` fast path
  // hands back the same content unchanged, for the machine's own file or a
  // non-ownerScoped (e.g. memory) file as well as an ownerScoped peer file
  // (AC-001's actual shape); and (2) a base-less protected peer file (Guard
  // 2 above), which carries markers and is never routed through the
  // mirror/merge branch at all. A path the plan is about to overwrite
  // (plannedPaths.has below) is excluded, since after the AC-002 mirror
  // rule an ownerScoped peer file WITH a base snapshot is always planned
  // for overwrite and never reaches here. D-003: the note text below
  // distinguishes an ownerScoped peer file (fix at the hub or restore) from
  // every other case (fix by editing the file), since a peer file's fix
  // path is never a local edit.
  const plannedPaths = new Set(plan.map((entry) => entry.remoteRelativePath));
  const notes: string[] = [];

  // D-002 (task e104c9f2, review R1 medium): the CLI's [profile] positional
  // can silently not match this machine's actual owner filename (loader.ts's
  // override order), in which case the AC-002 mirror rule above treats this
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
        `profile '${config.profile}': own file '${ownerFileName}' not found among ${peerFileCount} file(s) in '${entry.absoluteSource}'; ` +
          `this machine will publish no '${entry.destination}' state - check the profile positional matches this machine`
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
    notes.push(
      isOwnerScopedPeerPath(resolvedSyncPathEntries, config.profile, remoteRelativePath)
        ? `stale conflict markers in ${remoteRelativePath}; the remote owns this file, fix it at the hub or restore --from-commit`
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

  const snapshots = snapshotAffectedDestinations(config, plan, localFiles, resolvedSyncPathEntries);

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
  stateStore.replaceBaseSnapshots(filterUnmappedBaseMap(config, remoteMap));
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

interface PullPlanEntry {
  remoteRelativePath: string;
  localAbsolutePath: string;
  content: string | null;
  overwrite: boolean;
}

// Copies every destination this plan is about to delete from or overwrite
// inside, and returns the snapshot ids for the run's report.
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
): string[] {
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

  const written: string[] = [];
  for (const destination of Array.from(affected).sort()) {
    const files = localFiles.filter(
      (file) => destinationOf(destinations, file.remoteRelativePath) === destination
    );
    written.push(
      writePreApplySnapshot({
        stateDir: config.stateDir,
        destination,
        files: files.map((file) => ({
          remoteRelativePath: file.remoteRelativePath,
          absolutePath: file.absolutePath
        })),
        generations: config.snapshotGenerations
      }).id
    );
  }

  return written;
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
// the AC-002 mirror rule's own definition of "a peer file". Shared by the
// mirror-rule branch and the AC-003 stale-marker note loop above so both
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

function collectRemoteFiles(
  config: { repositorySubdir: string },
  gitClient: InstanceType<typeof GitClient>,
  repoDir: string
): Record<string, string | null> {
  const repoRelativeFiles = gitClient.listFiles(repoDir, config.repositorySubdir);
  const result: Record<string, string | null> = {};

  for (const repoRelativeFile of repoRelativeFiles) {
    if (!repoRelativeFile.startsWith(`${config.repositorySubdir}/`)) {
      continue;
    }

    const remoteRelativePath = normalizeRemoteRelativePath(
      repoRelativeFile.slice(config.repositorySubdir.length + 1)
    );
    result[remoteRelativePath] = gitClient.readFile(repoDir, repoRelativeFile);
  }

  return result;
}

function readSnapshotValue(source: Record<string, string | null>, key: string): string | null {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : null;
}

module.exports = {
  performPull
};
