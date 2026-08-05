const {
  collectLocalSyncFiles,
  filterOwnerScopedBaseMap,
  toRepositoryRelativePath
} = require("./config");
const { RemoteUnavailableError, RemoteQueueEscalationError } = require("../errors");
const { GitClient } = require("./git-client");
const { mergeText } = require("./merge");
const { checkRemoteReachable } = require("./reachability");
const { StateStore, DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS } = require("./state-store");

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
  // How long the queue may keep failing to drain (oldest queued snapshot's
  // age — see StateStore.oldestQueuedSnapshotAgeMs) before a tick that would
  // otherwise be a clean, silent "queued" outcome instead throws
  // RemoteQueueEscalationError and crashes loud. Defaults to
  // DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS (24h) — see that constant's
  // comment in state-store.ts for the full rationale, including the real
  // launchd/systemd tick interval it is sized against.
  queueEscalationThresholdMs?: number;
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

  // ownerFilter: true — this is the PUSH-side collection of "what is my
  // local snapshot", the only place Defect B's echo (a peer's ownerScoped
  // file, materialized locally by a prior pull, getting offered back as
  // this machine's own change) can originate. Pull's own collectLocalSyncFiles
  // call (src/memory-sync/pull.ts) deliberately omits this option — see
  // config.ts's CollectLocalSyncFilesOptions and D-004 in
  // .ai/runs/2026-08-03-sync-conflict-markers-echo/03-decisions.md.
  const ownerScopedWarnings: string[] = [];
  const currentLocalFiles = collectLocalSyncFiles(config, {
    ownerFilter: true,
    warnings: ownerScopedWarnings
  });
  const currentLocalMap = Object.fromEntries(
    currentLocalFiles.map((file: { remoteRelativePath: string; content: string }) => [
      file.remoteRelativePath,
      file.content
    ])
  );
  // Strips any foreign ownerScoped file (e.g. a peer's machine-state/frictions
  // file, materialized locally by a prior pull) out of the base snapshot
  // too — filtering currentLocalMap above is not sufficient on its own,
  // since applySnapshotToWorkingCopy's targetPaths is localFiles keys UNION
  // baseFiles keys; see filterOwnerScopedBaseMap's own comment in config.ts.
  const currentBaseMap = filterOwnerScopedBaseMap(config, stateStore.readBaseSnapshots());

  const queuedSnapshots = stateStore.listQueuedSnapshots();
  const snapshots = [
    // Fix-Runde MEDIUM finding #3 (05-review-findings.md, agent-tasks
    // 06d09cde): a snapshot enqueued BEFORE this machine's profile picked up
    // ownerScoped:true (or before this fix shipped at all) can still carry a
    // peer's ownerScoped file in its stored localFiles/baseFiles — it was
    // captured verbatim from an older, unfiltered collectLocalSyncFiles/
    // readBaseSnapshots() call. Replaying it verbatim would re-introduce
    // exactly the echo Fix 2/D-002-D-004 closed for the "current" snapshot,
    // just via the queue instead of a live collection. Route both maps
    // through the same filterOwnerScopedBaseMap used for currentBaseMap
    // below so a stale queued peer file is stripped here too, not just on
    // freshly collected snapshots. The `as Record<string, string>` cast is
    // safe: filterOwnerScopedBaseMap only ever drops keys, it never turns an
    // existing string value into null, and localFiles never held null values
    // to begin with.
    ...queuedSnapshots.map((entry: { id: string; data: { localFiles: Record<string, string>; baseFiles: Record<string, string | null> } }) => ({
      id: entry.id,
      localFiles: filterOwnerScopedBaseMap(config, entry.data.localFiles) as Record<string, string>,
      baseFiles: filterOwnerScopedBaseMap(config, entry.data.baseFiles),
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
      return appendNotes(
        {
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
        },
        ownerScopedWarnings
      );
    }

    return appendNotes(previewPush(config, snapshots), ownerScopedWarnings);
  }

  if (!reachability.reachable) {
    return appendNotes(
      enqueueCurrentSnapshot(
        stateStore,
        currentLocalMap,
        currentBaseMap,
        `remote unreachable (${reachability.reason}); stored the current local snapshot for replay on the next successful run`,
        config.queueEscalationThresholdMs ?? DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS
      ),
      ownerScopedWarnings
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

    return appendNotes(
      {
        kind: "push",
        status: "applied",
        remoteHeadBefore: workingCopy.remoteHead,
        remoteHeadAfter,
        appliedFiles: unique(appliedFiles),
        mergedFiles: unique(mergedFiles),
        conflictFiles: unique(conflictFiles),
        queuedSnapshotId,
        notes: queuedSnapshots.length > 0 ? [`replayed ${queuedSnapshots.length} queued snapshot(s)`] : []
      },
      ownerScopedWarnings
    );
  } catch (error) {
    // Only a RemoteUnavailableError (thrown exclusively from
    // GitClient.lookupRemoteHead and GitClient.push — see errors.ts) is
    // queued instead of crashing: those are the two operations that can
    // fail because the *remote* is unavailable or rejecting the push. Any
    // other error raised inside this try block (prepareWorkingCopy's own
    // init/fetch/checkout, applySnapshotToWorkingCopy's file writes,
    // commitAll, collectRemoteFiles, any StateStore write — a full disk, a
    // broken commit hook, a corrupted git config, ...) re-throws, so it
    // still crashes loud and reaches the supervisor-restart path (launchd
    // KeepAlive, systemd StartLimit*) instead of being misreported as a
    // benign "remote unavailable" queue. See
    // tests/integration/watch-mirror-delete.test.ts's "non-network git
    // failure inside the push" test for the case this guards against.
    if (!(error instanceof RemoteUnavailableError)) {
      throw error;
    }

    return appendNotes(
      enqueueCurrentSnapshot(
        stateStore,
        currentLocalMap,
        currentBaseMap,
        "remote unavailable; stored the current local snapshot for replay on the next successful run",
        config.queueEscalationThresholdMs ?? DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS
      ),
      ownerScopedWarnings
    );
  }
}

// Fix-Runde HIGH finding (05-review-findings.md, agent-tasks 06d09cde):
// merges collectLocalSyncFiles' ownerScoped "own file missing among peer
// files" warnings (see config.ts's CollectLocalSyncFilesResult.warnings)
// into whatever `notes` array a given result already carries, on every
// return path below — dry-run, queued (both the reachability-precheck skip
// and the catch-all git-failure fallback), and a real applied push all still
// need to surface the warning, since it describes THIS machine's local
// collection state, independent of whether the push itself succeeded.
function appendNotes<T extends { notes?: string[] }>(result: T, extraNotes: string[]): T {
  if (extraNotes.length === 0) {
    return result;
  }

  return { ...result, notes: [...(result.notes || []), ...extraNotes] };
}

// Shared by the reachability-precheck skip path and the catch-all fallback
// below: stash the current local state as a new queued snapshot (existing
// queued snapshots are left untouched — they are only cleared after a
// successful push), then check whether the queue has now been failing to
// drain for longer than queueEscalationThresholdMs (see
// checkQueueEscalation below) before reporting a clean "queued" result —
// escalation takes priority: it throws instead of returning, so a caller
// that has crossed the threshold never sees a benign-looking "queued"
// outcome for that tick, even though the snapshot itself is safely persisted
// either way.
function enqueueCurrentSnapshot(
  stateStore: InstanceType<typeof StateStore>,
  currentLocalMap: Record<string, string>,
  currentBaseMap: Record<string, string | null>,
  note: string,
  queueEscalationThresholdMs: number
) {
  const queuedSnapshotId = stateStore.enqueueSnapshot({
    localFiles: currentLocalMap,
    baseFiles: currentBaseMap
  });

  checkQueueEscalation(stateStore, queueEscalationThresholdMs);

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

// Age-based escalation (see DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS in
// state-store.ts for the full "why age, not a counter" rationale and the
// real launchd/systemd tick interval the default is sized against). Runs
// after every enqueue; throws RemoteQueueEscalationError — crashing the
// current tick loud, same supervisor-restart surface as a non-network
// failure — once the OLDEST queued snapshot is older than the threshold, i.e.
// once the remote has been continuously unreachable for that long, not just
// unreachable on this one tick. Below the threshold this is a no-op, so a
// machine that is merely offline (a laptop closed overnight, a flight, a
// weekend) keeps queuing exactly as before this rework: silently, exit 0,
// every tick.
function checkQueueEscalation(stateStore: InstanceType<typeof StateStore>, thresholdMs: number): void {
  const oldestAgeMs = stateStore.oldestQueuedSnapshotAgeMs();
  if (oldestAgeMs === null || oldestAgeMs < thresholdMs) {
    return;
  }

  const queuedCount = stateStore.listQueuedSnapshots().length;
  throw new RemoteQueueEscalationError(
    `remote has been unreachable for ${formatDurationMs(oldestAgeMs)}, past the ` +
      `${formatDurationMs(thresholdMs)} queue escalation threshold (${queuedCount} snapshot(s) queued in ` +
      `${stateStore.queueDir()}). This usually means the remote is permanently misconfigured (wrong remoteUrl, ` +
      `a renamed repository path, or a host that accepts a connection but cannot serve the repository) rather ` +
      `than temporarily offline — check remoteUrl/branch/repositorySubdir. Every queued snapshot is still ` +
      `safely stored and will be replayed automatically once the remote is reachable again; tune the ` +
      `'queueEscalationThresholdMs' config key if this threshold does not fit this machine's expected offline ` +
      `windows.`
  );
}

function formatDurationMs(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const totalMinutes = totalSeconds / 60;
  if (totalMinutes < 60) {
    return `${totalMinutes.toFixed(1)}m`;
  }
  return `${(totalMinutes / 60).toFixed(1)}h`;
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
