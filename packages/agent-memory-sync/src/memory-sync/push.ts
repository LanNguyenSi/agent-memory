const { readdirSync, rmSync } = require("node:fs");
const {
  collectLocalSyncFiles,
  filterOwnerScopedBaseMap,
  filterUnmappedBaseMap,
  toRepositoryRelativePath
} = require("./config");
const {
  MassDeleteRefusedError,
  RemoteUnavailableError,
  RemoteQueueEscalationError,
  UnreliableCheckoutError
} = require("../errors");
const { GitClient } = require("./git-client");
const { assertNoMassDelete, assertReliableCheckout } = require("./guards");
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
  // Operator override for the deletion guards (--allow-mass-delete on `run`
  // and `watch`), forwarded to ./guards.ts. The periodic jobs never pass it.
  allowMassDelete?: boolean;
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
  // launchd/systemd tick interval it is sized against. Explicit `null`
  // (as opposed to `undefined`, which falls through to the default above)
  // disables the escalation check entirely — mirrors
  // reachabilityCheckCommand's null-is-a-real-value convention: the queue
  // then keeps queuing silently, exit 0, forever, regardless of age.
  queueEscalationThresholdMs?: number | null;
  // Thresholds for the mass-delete guard (./guards.ts); absent means the
  // package defaults.
  massDeleteGuard?: { maxRatio?: number; maxFiles?: number } | null;
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
  // filterUnmappedBaseMap (agent-tasks 65380570) here is PERMANENT
  // load-bearing defense-in-depth, not a removable compatibility shim for
  // stores written before this fix shipped. pull.ts's write and this
  // function's own write (see the `stateStore.replaceBaseSnapshots` call
  // near the end of this function) both already filter through the same
  // helper, but this read still has to filter too: it is the last line of
  // defense against a base map contaminated by anything OTHER than those
  // two filtered writes: a store restored from an old backup, migrated
  // from a pre-fix on-disk copy, or otherwise written outside pull/push's
  // own code paths. Skip this read-side filter and applySnapshotToWorkingCopy
  // sees a base=<content>/local=null pair for such a path; with the remote
  // unchanged since, mergeText's remote===base fast path resolves to "local
  // wins" with content=null, silently deleting a peer's file this machine
  // never had a local copy of. See filterUnmappedBaseMap's own comment in
  // config.ts for the full writeup, including why removing any one of its
  // three call sites (this read, and both writes) reopens the bug.
  const currentBaseMap = filterUnmappedBaseMap(
    config,
    filterOwnerScopedBaseMap(config, stateStore.readBaseSnapshots())
  );

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
    // to begin with. filterUnmappedBaseMap (agent-tasks 65380570) runs on
    // baseFiles for the same reason it runs on currentBaseMap above: a
    // queued snapshot's stored baseFiles was captured from
    // stateStore.readBaseSnapshots() at enqueue time (enqueueCurrentSnapshot
    // below) and, being read back from disk rather than freshly produced by
    // a filtered write, is exactly the kind of external input the read-side
    // filter is permanent defense-in-depth against. Never treat this call
    // as redundant just because push's own write is filtered too.
    ...queuedSnapshots.map((entry: { id: string; data: { localFiles: Record<string, string>; baseFiles: Record<string, string | null> } }) => ({
      id: entry.id,
      localFiles: filterOwnerScopedBaseMap(config, entry.data.localFiles) as Record<string, string>,
      baseFiles: filterUnmappedBaseMap(config, filterOwnerScopedBaseMap(config, entry.data.baseFiles)),
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
          deletedFiles: [],
          queuedSnapshotId: null,
          notes: [
            `remote unreachable (${reachability.reason}); this run would enqueue a snapshot instead of pushing immediately`
          ]
        },
        ownerScopedWarnings
      );
    }

    return appendNotes(
      previewPush(config, snapshots, { allowMassDelete: options.allowMassDelete }),
      ownerScopedWarnings
    );
  }

  if (!reachability.reachable) {
    return appendNotes(
      enqueueCurrentSnapshot(
        stateStore,
        currentLocalMap,
        currentBaseMap,
        `remote unreachable (${reachability.reason}); stored the current local snapshot for replay on the next successful run`,
        resolveQueueEscalationThresholdMs(config.queueEscalationThresholdMs)
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

    // Guard 1 (agent-tasks cda5b12c): a working copy that does not represent
    // the remote produces a deletion plan for every path it fails to show.
    // Checked here, against the freshly fetched tree and before any merge,
    // so nothing is committed or pushed from it. See ./guards.ts. Takes no
    // --allow-mass-delete override (D-004/D-008): the flag answers "yes,
    // delete these files", not "trust this working copy".
    assertReliableCheckout({
      config,
      baseMap: currentBaseMap,
      remoteMap: collectRemoteFiles(config, gitClient, workingCopy.repoDir),
      remoteHead: workingCopy.remoteHead
    });

    const appliedFiles: string[] = [];
    const mergedFiles: string[] = [];
    const conflictFiles: string[] = [];
    const deletedFiles: string[] = [];

    for (const snapshot of snapshots) {
      const result = applySnapshotToWorkingCopy(config, gitClient, workingCopy.repoDir, snapshot);
      // Guard 2 (agent-tasks cda5b12c, AC-003): evaluated per snapshot and
      // BEFORE this snapshot's commit, so a refusal leaves the remote
      // untouched (the push below never runs) and the queued snapshots stay
      // queued rather than being dropped as replayed.
      //
      // Two measurements, in order of cost. The plan's own deletions are
      // already in hand, so they are checked first as a cheap pre-check. The
      // GATE is the second one: the deletions git has actually staged. The
      // two differ exactly where it matters (R1 critical, D-006) - a path
      // the working copy was already missing is not something the plan
      // "deletes", it never reads as a deletion at all, and yet the
      // `git add -A` inside commitAll stages and publishes it. Measuring the
      // index makes the guard's numerator the plan that is really about to
      // be committed.
      assertNoMassDelete({
        config,
        baseMap: snapshot.baseFiles,
        deletedPaths: result.plannedDeletions,
        allowMassDelete: options.allowMassDelete
      });
      const stagedDeletions = collectStagedDeletions(config, gitClient, workingCopy.repoDir);
      assertNoMassDelete({
        config,
        baseMap: snapshot.baseFiles,
        deletedPaths: stagedDeletions.claimed,
        unmappedDeletedPaths: stagedDeletions.unclaimed,
        allowMassDelete: options.allowMassDelete
      });
      appliedFiles.push(...result.appliedFiles);
      mergedFiles.push(...result.mergedFiles);
      conflictFiles.push(...result.conflictFiles);
      deletedFiles.push(...stagedDeletions.claimed);
      gitClient.commitAll(workingCopy.repoDir, snapshot.message);
    }

    gitClient.push(workingCopy.repoDir, config.branch);
    const remoteHeadAfter = gitClient.revParseHead(workingCopy.repoDir);

    const finalRemoteFiles = collectRemoteFiles(config, gitClient, workingCopy.repoDir);
    const state = stateStore.loadState();
    state.lastRemoteHead = remoteHeadAfter;
    state.lastRunAt = new Date().toISOString();
    // filterUnmappedBaseMap (agent-tasks 65380570): finalRemoteFiles is a
    // fresh, full read of the entire remote repositorySubdir tree, unmapped
    // paths included, regardless of whether THIS push touched them at all
    // (see collectRemoteFiles below). Left unfiltered, this write alone
    // re-contaminates the base store on every single push, with no pull
    // involved: the very next push would then read an unmapped peer path
    // back out of the base store (the read-side filter above exists
    // precisely to catch that), feed applySnapshotToWorkingCopy a
    // base=<content>/local=null pair for it, and silently delete it from
    // the remote. This is the root-cause fix for push's own base write,
    // symmetric with pull.ts's write-side filter. See that function's
    // comment in config.ts for the full three-call-site writeup.
    stateStore.replaceBaseSnapshots(filterUnmappedBaseMap(config, finalRemoteFiles));
    stateStore.saveState(state);
    stateStore.clearTemp(options.tempDirLabel || "push");

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
        deletedFiles: unique(deletedFiles),
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
        resolveQueueEscalationThresholdMs(config.queueEscalationThresholdMs)
      ),
      ownerScopedWarnings
    );
  }
}

// `undefined` (the field was never set at all — e.g. a PushConfig built
// outside the config loader) falls back to the default threshold, same as
// before this fix. Explicit `null` is a distinct, real value meaning
// "escalation disabled" — see the PushConfig.queueEscalationThresholdMs
// comment above and loader.ts's queueEscalationThresholdMs validation for
// where that convention is enforced end-to-end.
function resolveQueueEscalationThresholdMs(value: number | null | undefined): number | null {
  if (value === null) {
    return null;
  }
  return value ?? DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS;
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
// either way. A non-null diagnostic note from checkQueueEscalation (the
// clock-skew sanity-ceiling guard fired instead of escalating) is folded
// into the returned "queued" result's own notes, so it is still visible on
// this otherwise-silent, exit-0 path.
function enqueueCurrentSnapshot(
  stateStore: InstanceType<typeof StateStore>,
  currentLocalMap: Record<string, string>,
  currentBaseMap: Record<string, string | null>,
  note: string,
  queueEscalationThresholdMs: number | null
) {
  const queuedSnapshotId = stateStore.enqueueSnapshot({
    localFiles: currentLocalMap,
    baseFiles: currentBaseMap
  });

  const skewNote = checkQueueEscalation(stateStore, queueEscalationThresholdMs);

  return {
    kind: "push",
    status: "queued",
    remoteHeadBefore: null,
    remoteHeadAfter: null,
    appliedFiles: Object.keys(currentLocalMap).sort(),
    mergedFiles: [],
    conflictFiles: [],
    deletedFiles: [],
    queuedSnapshotId,
    notes: skewNote ? [note, skewNote] : [note]
  };
}

// 30x the effective threshold: a sanity ceiling guarding against clock skew.
// A queued manifest's `createdAt` (StateStore.enqueueSnapshot) is a
// wall-clock timestamp, so oldestQueuedSnapshotAgeMs is only ever as
// trustworthy as this machine's clock was AT ENQUEUE TIME (see
// DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS's comment in state-store.ts). A
// machine that enqueued under a wrong-in-the-past system clock (dead RTC
// battery, a container that started before NTP synced, ...) would otherwise
// compute an implausibly large age — and escalate — the moment NTP corrects
// the clock forward, which is exactly backwards: that machine's queue may
// not have been stuck at all. An age past this ceiling is far more likely a
// clock artifact than 30x the configured "how long is too long" threshold of
// genuine remote unavailability, so checkQueueEscalation below skips
// escalating and emits a diagnostic note instead of crashing loud.
const QUEUE_ESCALATION_SANITY_CEILING_MULTIPLE = 30;

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
// every tick. `thresholdMs === null` means escalation is disabled outright
// (see PushConfig.queueEscalationThresholdMs) — also a no-op. Returns a
// diagnostic note (string) instead of throwing when the computed age is past
// the clock-skew sanity ceiling above; returns null when there is nothing to
// report.
function checkQueueEscalation(
  stateStore: InstanceType<typeof StateStore>,
  thresholdMs: number | null
): string | null {
  if (thresholdMs === null) {
    return null;
  }

  const oldestAgeMs = stateStore.oldestQueuedSnapshotAgeMs();
  if (oldestAgeMs === null || oldestAgeMs < thresholdMs) {
    return null;
  }

  // Direct directory count instead of stateStore.listQueuedSnapshots() —
  // that helper reads every queued snapshot's full local/base file trees
  // off disk just to report a count here, on every single enqueue.
  const queuedCount = readdirSync(stateStore.queueDir(), { withFileTypes: true }).filter(
    (entry: { isDirectory: () => boolean }) => entry.isDirectory()
  ).length;

  const sanityCeilingMs = thresholdMs * QUEUE_ESCALATION_SANITY_CEILING_MULTIPLE;
  if (oldestAgeMs > sanityCeilingMs) {
    return (
      `note: the oldest queued snapshot in ${stateStore.queueDir()} claims to be ` +
      `${formatDurationMs(oldestAgeMs)} old, past the ${formatDurationMs(sanityCeilingMs)} sanity ceiling ` +
      `(${QUEUE_ESCALATION_SANITY_CEILING_MULTIPLE}x the ${formatDurationMs(thresholdMs)} queue escalation ` +
      `threshold) — skipping escalation instead of crashing loud, since an age this implausible more likely ` +
      `means this machine's clock was wrong when the snapshot was queued than that the remote has genuinely ` +
      `been unreachable this long.`
    );
  }

  throw new RemoteQueueEscalationError(
    `remote has been unreachable for ${formatDurationMs(oldestAgeMs)}, past the ` +
      `${formatDurationMs(thresholdMs)} queue escalation threshold (${queuedCount} snapshot(s) queued in ` +
      `${stateStore.queueDir()}); this usually means the remote is permanently misconfigured rather than ` +
      `temporarily offline. Check remoteUrl/branch/repositorySubdir.`
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
  config: PushConfig,
  snapshots: Array<{
    id: string;
    localFiles: Record<string, string>;
    baseFiles: Record<string, string | null>;
    message: string;
  }>,
  options: { allowMassDelete?: boolean } = {}
) {
  // Removed again in the finally below, on every exit: a completed preview,
  // a refusal, and a preview that gave up on an unreachable remote all used
  // to leave a full checkout (with commits in it, see the per-snapshot
  // commit further down) sitting under stateDir/tmp until some later run
  // happened to reuse the label.
  let previewRepoDir: string | null = null;

  try {
    const gitClient = new GitClient(config.gitBinary);
    previewRepoDir = gitClient.createTempRepoDir(config.stateDir, "push-preview");
    const workingCopy = gitClient.prepareWorkingCopy(
      config.remoteUrl,
      config.branch,
      previewRepoDir
    );

    // Same two guards as the real push: a dry-run that quietly previews a
    // plan the real run would refuse would be worse than useless, since
    // --dry-run is exactly how an operator checks a plan before running it.
    assertReliableCheckout({
      config,
      baseMap: snapshots[snapshots.length - 1]?.baseFiles || {},
      remoteMap: collectRemoteFiles(config, gitClient, workingCopy.repoDir),
      remoteHead: workingCopy.remoteHead
    });

    const appliedFiles: string[] = [];
    const mergedFiles: string[] = [];
    const conflictFiles: string[] = [];
    const deletedFiles: string[] = [];

    for (const snapshot of snapshots) {
      const result = applySnapshotToWorkingCopy(config, gitClient, workingCopy.repoDir, snapshot);
      assertNoMassDelete({
        config,
        baseMap: snapshot.baseFiles,
        deletedPaths: result.plannedDeletions,
        allowMassDelete: options.allowMassDelete
      });
      const stagedDeletions = collectStagedDeletions(config, gitClient, workingCopy.repoDir);
      assertNoMassDelete({
        config,
        baseMap: snapshot.baseFiles,
        deletedPaths: stagedDeletions.claimed,
        unmappedDeletedPaths: stagedDeletions.unclaimed,
        allowMassDelete: options.allowMassDelete
      });
      appliedFiles.push(...result.appliedFiles);
      mergedFiles.push(...result.mergedFiles);
      conflictFiles.push(...result.conflictFiles);
      deletedFiles.push(...stagedDeletions.claimed);
      // Committed even though nothing here is ever pushed: this working copy
      // is a throwaway under stateDir/tmp/push-preview, and the staged
      // measurement above is taken against HEAD. Without a commit between
      // snapshots, snapshot N would be measured against a HEAD that still
      // predates snapshot N-1 and would re-count its deletions, so a dry-run
      // could refuse a plan the real push accepts. Committing keeps the
      // preview's arithmetic identical to the real run's.
      gitClient.commitAll(workingCopy.repoDir, snapshot.message);
    }

    return {
      kind: "push",
      status: "dry-run",
      remoteHeadBefore: workingCopy.remoteHead,
      remoteHeadAfter: workingCopy.remoteHead,
      appliedFiles: unique(appliedFiles),
      mergedFiles: unique(mergedFiles),
      conflictFiles: unique(conflictFiles),
      deletedFiles: unique(deletedFiles),
      queuedSnapshotId: null,
      notes: []
    };
  } catch (error) {
    // A refused plan is a real answer about the plan, not a symptom of an
    // unreachable remote: it must reach the caller instead of being folded
    // into the catch-all "remote unavailable" preview below.
    if (error instanceof MassDeleteRefusedError || error instanceof UnreliableCheckoutError) {
      throw error;
    }

    return {
      kind: "push",
      status: "dry-run",
      remoteHeadBefore: null,
      remoteHeadAfter: null,
      appliedFiles: unique(Object.keys(snapshots[snapshots.length - 1]?.localFiles || {})),
      mergedFiles: [],
      conflictFiles: [],
      deletedFiles: [],
      queuedSnapshotId: null,
      notes: ["remote unavailable; this run would enqueue a snapshot instead of pushing immediately"]
    };
  } finally {
    if (previewRepoDir) {
      rmSync(previewRepoDir, { recursive: true, force: true });
    }
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
  const plannedDeletions: string[] = [];

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

    if (mergeResult.status === "merged") {
      mergedFiles.push(remoteRelativePath);
    }
    if (mergeResult.conflict) {
      conflictFiles.push(remoteRelativePath);
    }

    if (mergeResult.content === null) {
      // Only a path the working copy actually holds counts as a PLANNED
      // deletion: removing a path that is not there is a no-op of this
      // merge's own, so counting it here would report a deletion this plan
      // did not make. What such a path costs is measured where it really
      // happens instead, in the index (collectStagedDeletions), which is the
      // guard's gate.
      //
      // Deliberately kept out of appliedFiles too (R1 medium): a run that
      // removes files reported them as "applied" with an empty deletedFiles
      // list, which reads as a successful sync of those paths. appliedFiles
      // is the files this snapshot WROTE; deletions are reported as
      // deletions.
      if (remoteContent !== null) {
        plannedDeletions.push(remoteRelativePath);
      }
      gitClient.deleteFile(repoDir, repositoryPath);
      continue;
    }

    appliedFiles.push(remoteRelativePath);
    gitClient.writeFile(repoDir, repositoryPath, mergeResult.content);
  }

  return {
    appliedFiles,
    mergedFiles,
    conflictFiles,
    plannedDeletions
  };
}

// Stages the working copy and reads back the deletions the next commit would
// carry, as remote-relative paths (the key space the guards, the base
// snapshot store and the result payload all use).
//
// This is the mass-delete guard's real numerator (agent-tasks cda5b12c, R1
// critical, D-006). `git add -A` inside GitClient.commitAll publishes every
// path the working copy lacks, whether the merge plan asked for it or not,
// so the plan is not what gets committed and must not be what gets checked.
//
// A staged deletion outside repositorySubdir maps to no sync destination, so
// it is returned separately, as a repository-relative path, rather than
// dropped: the commit carries it whatever this profile claims to sync, and
// the guard's plan-wide rule has to count it (see findMassDelete's
// `unmappedDeletedPaths`). Only the per-destination rules cannot say anything
// about it, since there is no base snapshot to be a share of.
function collectStagedDeletions(
  config: { repositorySubdir: string },
  gitClient: InstanceType<typeof GitClient>,
  repoDir: string
): { claimed: string[]; unclaimed: string[] } {
  gitClient.stageAll(repoDir);

  const prefix = `${config.repositorySubdir}/`;
  const claimed: string[] = [];
  const unclaimed: string[] = [];
  for (const repoRelativePath of gitClient.listStagedDeletions(repoDir)) {
    if (!repoRelativePath.startsWith(prefix)) {
      unclaimed.push(repoRelativePath);
      continue;
    }
    claimed.push(repoRelativePath.slice(prefix.length));
  }

  return { claimed, unclaimed };
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
