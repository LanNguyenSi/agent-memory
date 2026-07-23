const {
  collectLocalSyncFiles,
  toRepositoryRelativePath
} = require("./config");
const { GitClient } = require("./git-client");
const { mergeText } = require("./merge");
const { checkRemoteReachable } = require("./reachability");
const { StateStore } = require("./state-store");

interface PushOptions {
  dryRun: boolean;
  // Overrides the "current" snapshot's commit message (default:
  // "sync(push): local memory update"). Used by `watch` to keep its
  // human-readable per-tick commit messages (buildCommitMessage in
  // ./snapshot.ts) after watch started reusing this function instead of its
  // own mirror-push (src/commands/watch.ts).
  commitMessage?: string;
  // Overrides the working-copy temp-dir label under stateDir/tmp (default:
  // "push"). `watch` passes "watch" here so its ticks keep their own
  // isolated working copy instead of sharing one with a concurrently
  // running `run --mode push/sync` on the same stateDir/profile.
  tempDirLabel?: string;
}

interface PushConfig {
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
  syncPaths: Array<{
    source: string;
    destination?: string;
    kind?: "file" | "directory";
    required?: boolean;
  }>;
}

async function performPush(config: PushConfig, options: PushOptions) {
  const stateStore = new StateStore(config.stateDir, config.profile);
  stateStore.ensure();

  const currentLocalFiles = collectLocalSyncFiles(config);
  const currentLocalMap = Object.fromEntries(
    currentLocalFiles.map((file: { remoteRelativePath: string; content: string }) => [
      file.remoteRelativePath,
      file.content
    ])
  );
  const currentBaseMap = stateStore.readBaseSnapshots();

  const queuedSnapshots = stateStore.listQueuedSnapshots();
  const snapshots = [
    ...queuedSnapshots.map((entry: { id: string; data: { localFiles: Record<string, string>; baseFiles: Record<string, string | null> } }) => ({
      id: entry.id,
      localFiles: entry.data.localFiles,
      baseFiles: entry.data.baseFiles,
      message: `sync(queue): replay ${entry.id}`
    })),
    {
      id: "current",
      localFiles: currentLocalMap,
      baseFiles: currentBaseMap,
      message: options.commitMessage || "sync(push): local memory update"
    }
  ];

  // Fast precheck before any network operation (push, and — since queued
  // snapshots are replayed inside the same working copy below — queue
  // replay too). An unreachable remote must not hang on `git ls-remote`; it
  // short-circuits into the same "queued" outcome the catch-block below
  // produces for a real git failure, just without paying for the hang.
  const reachability = checkRemoteReachable(config);

  if (options.dryRun) {
    if (!reachability.reachable) {
      return {
        kind: "push",
        status: "dry-run",
        remoteHeadBefore: null,
        remoteHeadAfter: null,
        appliedFiles: unique(Object.keys(snapshots[snapshots.length - 1]?.localFiles || {})),
        mergedFiles: [],
        conflictFiles: [],
        queuedSnapshotId: null,
        notes: [
          `remote unreachable (${reachability.reason}); this run would enqueue a snapshot instead of pushing immediately`
        ]
      };
    }

    return previewPush(config, snapshots);
  }

  if (!reachability.reachable) {
    return enqueueCurrentSnapshot(
      stateStore,
      currentLocalMap,
      currentBaseMap,
      `remote unreachable (${reachability.reason}); stored the current local snapshot for replay on the next successful run`
    );
  }

  let queuedSnapshotId: string | null = null;

  try {
    const gitClient = new GitClient(config.gitBinary);
    const workingCopy = gitClient.prepareWorkingCopy(
      config.remoteUrl,
      config.branch,
      gitClient.createTempRepoDir(config.stateDir, options.tempDirLabel || "push")
    );

    const appliedFiles: string[] = [];
    const mergedFiles: string[] = [];
    const conflictFiles: string[] = [];

    for (const snapshot of snapshots) {
      const result = applySnapshotToWorkingCopy(config, gitClient, workingCopy.repoDir, snapshot);
      appliedFiles.push(...result.appliedFiles);
      mergedFiles.push(...result.mergedFiles);
      conflictFiles.push(...result.conflictFiles);
      gitClient.commitAll(workingCopy.repoDir, snapshot.message);
    }

    gitClient.push(workingCopy.repoDir, config.branch);
    const remoteHeadAfter = gitClient.revParseHead(workingCopy.repoDir);

    const finalRemoteFiles = collectRemoteFiles(config, gitClient, workingCopy.repoDir);
    const state = stateStore.loadState();
    state.lastRemoteHead = remoteHeadAfter;
    state.lastRunAt = new Date().toISOString();
    stateStore.replaceBaseSnapshots(finalRemoteFiles);
    stateStore.saveState(state);
    stateStore.clearTemp();

    for (const queuedSnapshot of queuedSnapshots) {
      stateStore.removeQueuedSnapshot(queuedSnapshot.id);
    }

    return {
      kind: "push",
      status: "applied",
      remoteHeadBefore: workingCopy.remoteHead,
      remoteHeadAfter,
      appliedFiles: unique(appliedFiles),
      mergedFiles: unique(mergedFiles),
      conflictFiles: unique(conflictFiles),
      queuedSnapshotId,
      notes: queuedSnapshots.length > 0 ? [`replayed ${queuedSnapshots.length} queued snapshot(s)`] : []
    };
  } catch (error) {
    return enqueueCurrentSnapshot(
      stateStore,
      currentLocalMap,
      currentBaseMap,
      "remote unavailable; stored the current local snapshot for replay on the next successful run"
    );
  }
}

// Shared by the reachability-precheck skip path and the catch-all fallback
// below: stash the current local state as a new queued snapshot (existing
// queued snapshots are left untouched — they are only cleared after a
// successful push) and report a clean "queued" result.
function enqueueCurrentSnapshot(
  stateStore: InstanceType<typeof StateStore>,
  currentLocalMap: Record<string, string>,
  currentBaseMap: Record<string, string | null>,
  note: string
) {
  const queuedSnapshotId = stateStore.enqueueSnapshot({
    localFiles: currentLocalMap,
    baseFiles: currentBaseMap
  });

  return {
    kind: "push",
    status: "queued",
    remoteHeadBefore: null,
    remoteHeadAfter: null,
    appliedFiles: Object.keys(currentLocalMap).sort(),
    mergedFiles: [],
    conflictFiles: [],
    queuedSnapshotId,
    notes: [note]
  };
}

function previewPush(
  config: { stateDir: string; profile: string; conflictStrategy: "inline-markers" | "local-wins" | "remote-wins"; repositorySubdir: string; remoteUrl: string; branch: string; gitBinary: string },
  snapshots: Array<{ id: string; localFiles: Record<string, string>; baseFiles: Record<string, string | null> }>
) {
  try {
    const gitClient = new GitClient(config.gitBinary);
    const workingCopy = gitClient.prepareWorkingCopy(
      config.remoteUrl,
      config.branch,
      gitClient.createTempRepoDir(config.stateDir, "push-preview")
    );

    const appliedFiles: string[] = [];
    const mergedFiles: string[] = [];
    const conflictFiles: string[] = [];

    for (const snapshot of snapshots) {
      const result = applySnapshotToWorkingCopy(config, gitClient, workingCopy.repoDir, snapshot);
      appliedFiles.push(...result.appliedFiles);
      mergedFiles.push(...result.mergedFiles);
      conflictFiles.push(...result.conflictFiles);
    }

    return {
      kind: "push",
      status: "dry-run",
      remoteHeadBefore: workingCopy.remoteHead,
      remoteHeadAfter: workingCopy.remoteHead,
      appliedFiles: unique(appliedFiles),
      mergedFiles: unique(mergedFiles),
      conflictFiles: unique(conflictFiles),
      queuedSnapshotId: null,
      notes: []
    };
  } catch (error) {
    return {
      kind: "push",
      status: "dry-run",
      remoteHeadBefore: null,
      remoteHeadAfter: null,
      appliedFiles: unique(Object.keys(snapshots[snapshots.length - 1]?.localFiles || {})),
      mergedFiles: [],
      conflictFiles: [],
      queuedSnapshotId: null,
      notes: ["remote unavailable; this run would enqueue a snapshot instead of pushing immediately"]
    };
  }
}

function applySnapshotToWorkingCopy(
  config: { repositorySubdir: string; conflictStrategy: "inline-markers" | "local-wins" | "remote-wins" },
  gitClient: InstanceType<typeof GitClient>,
  repoDir: string,
  snapshot: { localFiles: Record<string, string>; baseFiles: Record<string, string | null> }
) {
  const targetPaths = new Set<string>([
    ...Object.keys(snapshot.localFiles),
    ...Object.keys(snapshot.baseFiles)
  ]);
  const appliedFiles: string[] = [];
  const mergedFiles: string[] = [];
  const conflictFiles: string[] = [];

  for (const remoteRelativePath of Array.from(targetPaths).sort()) {
    const repositoryPath = toRepositoryRelativePath(config, remoteRelativePath);
    const remoteContent = gitClient.readFile(repoDir, repositoryPath);
    const mergeResult = mergeText({
      base: readSnapshotValue(snapshot.baseFiles, remoteRelativePath),
      local: readSnapshotValue(snapshot.localFiles, remoteRelativePath),
      remote: remoteContent,
      strategy: config.conflictStrategy
    });

    if (mergeResult.status === "unchanged") {
      continue;
    }

    appliedFiles.push(remoteRelativePath);

    if (mergeResult.status === "merged") {
      mergedFiles.push(remoteRelativePath);
    }
    if (mergeResult.conflict) {
      conflictFiles.push(remoteRelativePath);
    }

    if (mergeResult.content === null) {
      gitClient.deleteFile(repoDir, repositoryPath);
      continue;
    }

    gitClient.writeFile(repoDir, repositoryPath, mergeResult.content);
  }

  return {
    appliedFiles,
    mergedFiles,
    conflictFiles
  };
}

function collectRemoteFiles(
  config: { repositorySubdir: string },
  gitClient: InstanceType<typeof GitClient>,
  repoDir: string
): Record<string, string | null> {
  const result: Record<string, string | null> = {};

  for (const repoRelativePath of gitClient.listFiles(repoDir, config.repositorySubdir)) {
    if (!repoRelativePath.startsWith(`${config.repositorySubdir}/`)) {
      continue;
    }

    const key = repoRelativePath.slice(config.repositorySubdir.length + 1);
    result[key] = gitClient.readFile(repoDir, repoRelativePath);
  }

  return result;
}

function readSnapshotValue(source: Record<string, string | null> | Record<string, string>, key: string): string | null {
  return Object.prototype.hasOwnProperty.call(source, key) ? (source as Record<string, string | null>)[key] : null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

module.exports = {
  performPush
};
