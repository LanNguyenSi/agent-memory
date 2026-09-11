const { existsSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const {
  collectLocalSyncFiles,
  filterUnmappedBaseMap,
  mapRemotePathToLocalAbsolute,
  normalizeRemoteRelativePath,
  resolveSyncPathEntries
} = require("./config");
const { GitClient } = require("./git-client");
const { assertReliableCheckout } = require("./guards");
const { mergeText } = require("./merge");
const { checkRemoteReachable } = require("./reachability");
const { StateStore } = require("./state-store");

interface PullOptions {
  dryRun: boolean;
  // Deliberately no allowMassDelete (D-004, D-008): --allow-mass-delete is
  // the operator's override for the PUSH-side plan guard, and pull has no
  // plan of its own to override. The one guard pull runs, the checkout
  // check, is about whether the fetched working copy is the remote at all,
  // which no flag can answer. The pull-side accept flag AC-007 describes
  // (--accept-mass-delete, for a remote change that really does delete a
  // large share of a destination) is a separate, still-to-come decision,
  // deliberately not this flag.
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
  syncPaths: Array<{
    source: string;
    destination?: string;
    kind?: "file" | "directory";
    required?: boolean;
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
      notes: [`remote unreachable (${reachability.reason}); skipped pull, local files unchanged`]
    };
  }

  const gitClient = new GitClient(config.gitBinary);
  const workingCopy = gitClient.prepareWorkingCopy(
    config.remoteUrl,
    config.branch,
    gitClient.createTempRepoDir(config.stateDir, "pull")
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
  // Guard 1 (agent-tasks cda5b12c): never merge against a working copy that
  // cannot be trusted to represent the remote. In the 2026-09-11 wipe the
  // fetched copy under stateDir/tmp/pull had been removed by a concurrent
  // watch tick's StateStore.clearTemp() AFTER git reported a successful
  // checkout, so every remote path read as null and the merge below deleted
  // 404 real local files. This throws UnreliableCheckoutError before the
  // loop, so no local file is touched and no base snapshot is rewritten.
  //
  // The check covers a partially wiped copy too, not just an empty one
  // (D-006), which is why it sits here rather than inside the loop: this is
  // pull's only rmSync path, and it must refuse BEFORE the first deletion,
  // not after counting the deletions it already made. It takes no
  // --allow-mass-delete override (D-004, D-008); see ./guards.ts.
  assertReliableCheckout({
    config,
    baseMap,
    remoteMap,
    remoteHead: workingCopy.remoteHead
  });

  const targetPaths = new Set<string>([
    ...Object.keys(localMap),
    ...Object.keys(baseMap),
    ...Object.keys(remoteMap)
  ]);

  const changedFiles: string[] = [];
  const mergedFiles: string[] = [];
  const conflictFiles: string[] = [];
  const deletedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const protectedFiles: string[] = [];

  // Resolved once, outside the per-path loop below. See resolveSyncPathEntries'
  // own comment in config.ts (agent-tasks 65380570, LOW): this loop calls
  // mapRemotePathToLocalAbsolute once per path in targetPaths, so
  // re-resolving every syncPaths entry (including its existsSync/statSync
  // kind check) from scratch on every call is an O(paths x syncPaths) count
  // of redundant stat calls per run.
  const resolvedSyncPathEntries = resolveSyncPathEntries(config);

  for (const remoteRelativePath of Array.from(targetPaths).sort()) {
    // Guard 2 (agent-tasks cda5b12c, AC-002): a local file the base snapshot
    // has never recorded, and that the remote does not have, is local-only.
    // It is a candidate for the next push and can never be a pull deletion,
    // whatever the 3-way merge would make of it. Checked BEFORE mergeText
    // rather than after, deliberately: today mergeText's `remote === base`
    // fast path also keeps such a file (both are null, so local wins), but
    // that is an emergent property of one branch's ordering inside a
    // general-purpose merge function, not a stated invariant of the pull.
    // The incident showed what it costs when a merge answer about deletion
    // is trusted unconditionally, so the invariant is stated here, where the
    // rmSync lives, and the count is reported.
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

    const mergeResult = mergeText({
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
      // no local file with markers was ever created for it — the payload
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

    changedFiles.push(remoteRelativePath);

    if (options.dryRun) {
      if (mergeResult.content === null) {
        deletedFiles.push(remoteRelativePath);
      }
      continue;
    }

    if (mergeResult.content === null) {
      rmSync(localAbsolutePath, { force: true });
      deletedFiles.push(remoteRelativePath);
      continue;
    }

    mkdirSync(path.dirname(localAbsolutePath), { recursive: true });
    writeFileSync(localAbsolutePath, mergeResult.content, "utf8");
  }

  if (!options.dryRun) {
    const remoteHeadAfter = workingCopy.remoteHead ? gitClient.revParseHead(workingCopy.repoDir) : null;
    const state = stateStore.loadState();
    state.lastRemoteHead = remoteHeadAfter;
    state.lastRunAt = new Date().toISOString();
    // filterUnmappedBaseMap (config.ts): the base snapshot store must never
    // record a remote path this run just classified as skippedFiles above
    // (no configured syncPaths destination maps it back to a local file) —
    // see that function's comment for the full agent-tasks 65380570
    // writeup. Left unfiltered, the next push's 3-way merge would see
    // base=<content>/local=null for that path and silently delete it from
    // the remote as a false "local wins".
    stateStore.replaceBaseSnapshots(filterUnmappedBaseMap(config, remoteMap));
    stateStore.saveState(state);
    stateStore.clearTemp();

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
      notes: []
    };
  }

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
    notes: []
  };
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
