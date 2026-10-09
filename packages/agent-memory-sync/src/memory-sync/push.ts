const { readdirSync, rmSync } = require("node:fs");
const path = require("node:path");
const {
  collectLocalSyncFiles,
  filterOwnerScopedBaseMap,
  filterUnmappedBaseMap,
  mapRemotePathToLocalAbsolute,
  resolveSyncPathEntries,
  toRepositoryRelativePath
} = require("./config");
const {
  MassDeleteRefusedError,
  RemoteUnavailableError,
  RemoteQueueEscalationError,
  UnreliableCheckoutError
} = require("../errors");
const { GitClient } = require("./git-client");
const { acceptRemoteDeletions, findRemoteDeletionsToAccept } = require("./accept-remote-deletions");
const { assertNoMassDelete, assertReliableCheckout } = require("./guards");
const { hasConflictMarkers, mergeText } = require("./merge");
const { listPreApplySnapshots } = require("./pre-apply-snapshot");
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
  // Operator override for the PLAN guard (--allow-mass-delete on `run` and
  // `watch`), forwarded to ./guards.ts. The periodic jobs never pass it, and
  // it never reaches the checkout check.
  allowMassDelete?: boolean;
  // Operator override for the CHECKOUT check (--accept-mass-delete, on
  // `run` only and for one run): the remote really did drop those files.
  // Adopts the remote state locally first (./accept-remote-deletions.ts)
  // rather than merely silencing the refusal, so the push has nothing left
  // to publish for the deleted paths instead of republishing them. Never
  // set together with allowMassDelete: `run` refuses the pair as a usage
  // error, since after the adoption there is nothing left for the other
  // flag to publish except a deletion the plan guard would refuse.
  acceptMassDelete?: boolean;
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
  // How many pre-apply snapshots per destination survive
  // (./pre-apply-snapshot.ts).
  snapshotGenerations?: number | null;
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
  let currentLocalMap = Object.fromEntries(
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
  let currentBaseMap = filterUnmappedBaseMap(
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
    ...queuedSnapshots.map((entry: { id: string; data: { localFiles: Record<string, string>; baseFiles: Record<string, string | null> } }) => {
      const baseFiles = filterUnmappedBaseMap(config, filterOwnerScopedBaseMap(config, entry.data.baseFiles));
      return {
        id: entry.id,
        localFiles: filterOwnerScopedBaseMap(config, entry.data.localFiles) as Record<string, string>,
        baseFiles,
        guardBaseFiles: baseFiles,
        message: `sync(queue): replay ${entry.id}`
      };
    }),
    {
      id: "current",
      localFiles: currentLocalMap,
      baseFiles: currentBaseMap,
      // The mass-delete guard's denominator, fixed at what this run started
      // with. An accepted adoption below moves `baseFiles` (the merge's
      // input) off the adopted paths, and a refusal raised later in the
      // same run then read "(50 of 0 tracked)": the share a plan removes is
      // measured against the base as the run found it, not as the run
      // itself rewrote it.
      guardBaseFiles: currentBaseMap,
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
          snapshots: [],
          queuedSnapshotId: null,
          notes: [
            `remote unreachable (${reachability.reason}); this run would enqueue a snapshot instead of pushing immediately`
          ]
        },
        ownerScopedWarnings
      );
    }

    return appendNotes(
      previewPush(config, snapshots, {
        allowMassDelete: options.allowMassDelete,
        acceptMassDelete: options.acceptMassDelete
      }),
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

    // Guard 1: a working copy that does not represent the remote produces a
    // deletion plan for every path it fails to show. Checked here, against
    // the freshly fetched tree and before any merge, so nothing is committed
    // or pushed from it. --allow-mass-delete does not reach it: that flag
    // answers "yes, publish these deletions", not "trust this working copy",
    // and on a wiped copy it was the one instruction that published the
    // wipe. See ./guards.ts.
    //
    // --accept-mass-delete does reach it, and not as a silencer: it adopts
    // the remote's state locally first (copy the destinations, remove the
    // local files the remote no longer has, move the base snapshot to the
    // remote's), so this push then has nothing to publish for those paths.
    // Without that, silencing the refusal would push the "deleted" files
    // straight back to the remote on the following run. That adoption is
    // itself refused (acceptRemoteDeletions -> findRemoteDeletionsToAccept
    // -> assertOverridableCheckout in ./guards.ts) when the finding carries
    // emptied paths: the flag answers "the remote really did drop these
    // files", not "this checkout came back zeroed", so an emptied finding
    // still throws UnreliableCheckoutError here regardless of the flag.
    const remoteMap = collectRemoteFiles(config, gitClient, workingCopy.repoDir);
    const runStartTracked = listRunStartTracked(config, gitClient, workingCopy);
    let acceptedDeletions: string[] = [];
    let adoptedBasePaths: string[] = [];
    let preApplySnapshots: string[] = [];

    if (options.acceptMassDelete) {
      const accepted = acceptRemoteDeletions({
        config,
        stateStore,
        baseMap: currentBaseMap,
        localMap: currentLocalMap,
        localFiles: currentLocalFiles,
        remoteMap,
        remoteHead: workingCopy.remoteHead
      });

      if (accepted) {
        adoptedBasePaths = Object.keys(currentBaseMap).filter(
          (key) => !Object.prototype.hasOwnProperty.call(accepted.baseMap, key)
        );
        acceptedDeletions = accepted.deletedPaths;
        preApplySnapshots = accepted.snapshots;
        currentBaseMap = accepted.baseMap;
        currentLocalMap = accepted.localMap;
        // The "current" snapshot was assembled from these two maps before
        // the working copy existed; it has to reflect the adoption, or the
        // merge below would still see the removed files as local state.
        snapshots[snapshots.length - 1].localFiles = currentLocalMap;
        snapshots[snapshots.length - 1].baseFiles = currentBaseMap;
      }
    } else {
      assertReliableCheckout({
        config,
        baseMap: currentBaseMap,
        remoteMap,
        remoteHead: workingCopy.remoteHead
      });
    }

    const appliedFiles: string[] = [];
    const mergedFiles: string[] = [];
    const conflictFiles: string[] = [];
    const deletedFiles: string[] = [];
    const heldBack: HeldBackPath[] = [];

    // The base moves forward across the snapshots applied in this run: a
    // queued snapshot is merged against the base captured when it was
    // enqueued, and once its commit is in the working copy, the next
    // snapshot (the current one included) has to merge against what that
    // commit published, not against the base from before it. See
    // recordBaseAdvance.
    const baseDelta = newBaseDelta();

    for (const [index, snapshot] of snapshots.entries()) {
      const isLast = index === snapshots.length - 1;
      if (index > 0) {
        const advanced = applyBaseDelta(snapshot.baseFiles, baseDelta);
        // Paths adopted from the remote's deletions belong to the current
        // snapshot only; a queued snapshot keeps its own view of them.
        snapshot.baseFiles = isLast ? withoutKeys(advanced, adoptedBasePaths) : advanced;
      }
      const result = applySnapshotToWorkingCopy(config, gitClient, workingCopy.repoDir, snapshot);
      // Guard 2: evaluated per snapshot and
      // BEFORE this snapshot's commit, so a refusal leaves the remote
      // untouched (the push below never runs) and the queued snapshots stay
      // queued rather than being dropped as replayed.
      //
      // One measurement, and deliberately the later one: the deletions git
      // has actually staged. The merge's own plan is a strict subset of them
      // and differs exactly where it matters, since a path the working copy
      // was already missing is not something the plan "deletes" at all,
      // while `git add -A` stages and publishes it. Checking the plan as
      // well changes no outcome the staged check does not already produce
      // (measured: removing it leaves the whole suite green), so the
      // numerator is the index and nothing else.
      const stagedDeletions = collectStagedDeletions(config, gitClient, workingCopy.repoDir);
      assertNoMassDelete({
        config,
        baseMap: snapshot.guardBaseFiles,
        deletedPaths: netDeletionsAgainstRunStart(stagedDeletions.claimed, runStartTracked),
        unmappedDeletedPaths: stagedDeletions.unclaimed,
        allowMassDelete: options.allowMassDelete
      });
      appliedFiles.push(...result.appliedFiles);
      mergedFiles.push(...result.mergedFiles);
      conflictFiles.push(...result.conflictFiles);
      heldBack.push(...result.heldBack);
      deletedFiles.push(...stagedDeletions.claimed);
      // The index as measured, and nothing else, is what gets committed
      // (GitClient.commitStaged). A commit that staged again on its way in
      // would carry whatever the working copy looked like at that moment,
      // and a checkout wiped between the measurement and that second stage
      // was published as a total deletion the guard had measured as none.
      gitClient.commitStaged(workingCopy.repoDir, snapshot.message);
      if (!isLast) {
        recordBaseAdvance(
          config,
          baseDelta,
          snapshot,
          collectRemoteFiles(config, gitClient, workingCopy.repoDir)
        );
      }
    }

    gitClient.push(workingCopy.repoDir, config.branch);
    const remoteHeadAfter = gitClient.revParseHead(workingCopy.repoDir);

    const finalRemoteFiles = collectRemoteFiles(config, gitClient, workingCopy.repoDir);
    const state = stateStore.loadState();
    state.lastRemoteHead = remoteHeadAfter;
    state.lastRunAt = new Date().toISOString();
    // The base snapshot moves per path, not as a whole-tree copy of the hub.
    // Push never writes hub-won or merged content back into the local files,
    // so copying the hub into the base for a path this machine did not
    // converge on makes a stale local copy look unchanged against its base:
    // the next push (even one with no local change at all) would then
    // republish that stale copy over a peer's newer version, and a hub-only
    // file this machine never pulled would enter the base with no local copy
    // and be deleted from the hub on the push after that. See
    // nextBaseAfterPush for the per-path rule.
    //
    // filterUnmappedBaseMap (agent-tasks 65380570): finalRemoteFiles is a
    // fresh, full read of the entire remote repositorySubdir tree, unmapped
    // paths included, regardless of whether THIS push touched them at all
    // (see collectRemoteFiles below). Left unfiltered, the base write alone
    // would re-contaminate the base store on every single push, with no pull
    // involved: the very next push would then read an unmapped peer path
    // back out of the base store (the read-side filter above exists
    // precisely to catch that), feed applySnapshotToWorkingCopy a
    // base=<content>/local=null pair for it, and silently delete it from
    // the remote. The previous base is read back from the store here (not
    // taken from the in-memory map), so an entry written outside push's own
    // code paths is filtered out on this write too. This is the root-cause
    // fix for push's own base write, symmetric with pull.ts's write-side
    // filter. See that function's comment in config.ts for the full
    // three-call-site writeup.
    //
    // The owner-scoped filter is deliberately NOT applied to this write. It
    // is a read-side filter only (what push offers and merges). The base
    // store also holds the entries pull wrote for a peer's ownerScoped
    // files, and pull's local-only guard protects any local file that has no
    // base entry and is absent on the hub: stripping those entries here
    // would turn the peer's later deletion of its own file into a stale
    // local copy that is never removed. The kept-previous branch of
    // nextBaseAfterPush leaves such an entry exactly as pull wrote it.
    //
    // baseDelta carries what the queued snapshots replayed above changed in
    // the base, so the final per-path rule starts from the base as it stood
    // after those replays.
    stateStore.replaceBaseSnapshots(
      filterUnmappedBaseMap(
        config,
        nextBaseAfterPush(
          // Paths adopted from the remote's deletions have no local copy and
          // no base entry after the adoption. A queued snapshot that edited
          // one of them (replayed under conflictStrategy local-wins) left an
          // entry for it in the overlay; carried into this write it records
          // the replayed edit as converged with no local copy behind it, and
          // the next plain push would delete the edit from the hub.
          withoutKeys(applyBaseDelta(stateStore.readBaseSnapshots(), baseDelta), adoptedBasePaths),
          currentLocalMap,
          finalRemoteFiles
        )
      )
    );
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
        // The adopted deletions are local removals, not remote ones, and
        // are reported as deletions this run made all the same: leaving them
        // out would report a run that removed hundreds of local files as
        // having deleted nothing.
        deletedFiles: unique([...deletedFiles, ...acceptedDeletions]),
        snapshots: preApplySnapshots,
        queuedSnapshotId,
        notes: [
          ...(queuedSnapshots.length > 0 ? [`replayed ${queuedSnapshots.length} queued snapshot(s)`] : []),
          ...heldBackNotes(config, heldBack, { adoptedPaths: adoptedBasePaths, snapshotIds: preApplySnapshots })
        ]
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
    // commitStaged, collectRemoteFiles, any StateStore write: a full disk, a
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
    snapshots: [],
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

interface PushSnapshot {
  id: string;
  localFiles: Record<string, string>;
  baseFiles: Record<string, string | null>;
  // The mass-delete guard's denominator for this snapshot; see the
  // "current" snapshot's comment in performPush for why it is separate from
  // baseFiles.
  guardBaseFiles: Record<string, string | null>;
  message: string;
}

function previewPush(
  config: PushConfig,
  snapshots: PushSnapshot[],
  options: { allowMassDelete?: boolean; acceptMassDelete?: boolean } = {}
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

    const remoteMap = collectRemoteFiles(config, gitClient, workingCopy.repoDir);
    const runStartTracked = listRunStartTracked(config, gitClient, workingCopy);
    const current = snapshots[snapshots.length - 1];
    const notes: string[] = [];
    let adoptedDeletions: string[] = [];
    let previewSnapshots = snapshots;

    if (options.acceptMassDelete && current) {
      // Report-only twin of the real run's acceptRemoteDeletions: the same
      // paths, found the same way, but no snapshot is written, no local file
      // is removed and the base snapshot is not moved. The current
      // snapshot's in-memory maps are adjusted exactly as the real run
      // adjusts them, so the merge and the staged measurement below see the
      // plan the real run will see, and the preview's arithmetic matches.
      // It used to refuse the checkout here regardless of the flag, so the
      // one command an operator is told to run first could not preview
      // the acceptance at all. findRemoteDeletionsToAccept still refuses
      // (throws) for a finding with emptied paths - that half has no
      // override, flag or no flag - so only a pure-missing finding reaches
      // the adoption preview below.
      const lost = findRemoteDeletionsToAccept(config, current.baseFiles, remoteMap, workingCopy.remoteHead);
      if (lost.paths.length > 0) {
        adoptedDeletions = lost.paths;
        previewSnapshots = [
          ...snapshots.slice(0, -1),
          {
            ...current,
            localFiles: withoutKeys(current.localFiles, lost.paths) as Record<string, string>,
            baseFiles: withoutKeys(current.baseFiles, lost.paths)
          }
        ];
        notes.push(
          `would adopt ${lost.paths.length} remote deletion(s) under ` +
            `${lost.destinations.map((destination: string) => `'${destination}'`).join(", ")} with ` +
            `--accept-mass-delete: the destination is copied into stateDir/snapshots first, then the local ` +
            `copies listed under deletedFiles are removed and the base snapshot moves with the remote`
        );
      }
    } else {
      // Same guard as the real push: a dry-run that quietly previews a plan
      // the real run would refuse would be worse than useless, since
      // --dry-run is exactly how an operator checks a plan before running it.
      assertReliableCheckout({
        config,
        baseMap: current?.baseFiles || {},
        remoteMap,
        remoteHead: workingCopy.remoteHead
      });
    }

    const appliedFiles: string[] = [];
    const mergedFiles: string[] = [];
    const conflictFiles: string[] = [];
    const deletedFiles: string[] = [];
    const heldBack: HeldBackPath[] = [];

    // Same base chaining as the real run, so the preview's plan for the
    // current snapshot matches what the real run will do after the queued
    // snapshots have been replayed.
    const baseDelta = newBaseDelta();

    for (const [index, plannedSnapshot] of previewSnapshots.entries()) {
      const isLast = index === previewSnapshots.length - 1;
      const snapshot =
        index > 0 ? { ...plannedSnapshot, baseFiles: applyBaseDelta(plannedSnapshot.baseFiles, baseDelta) } : plannedSnapshot;
      const result = applySnapshotToWorkingCopy(config, gitClient, workingCopy.repoDir, snapshot);
      const stagedDeletions = collectStagedDeletions(config, gitClient, workingCopy.repoDir);
      assertNoMassDelete({
        config,
        baseMap: snapshot.guardBaseFiles,
        deletedPaths: netDeletionsAgainstRunStart(stagedDeletions.claimed, runStartTracked),
        unmappedDeletedPaths: stagedDeletions.unclaimed,
        allowMassDelete: options.allowMassDelete
      });
      appliedFiles.push(...result.appliedFiles);
      mergedFiles.push(...result.mergedFiles);
      conflictFiles.push(...result.conflictFiles);
      heldBack.push(...result.heldBack);
      deletedFiles.push(...stagedDeletions.claimed);
      // Committed even though nothing here is ever pushed: this working copy
      // is a throwaway under stateDir/tmp/push-preview, and the staged
      // measurement above is taken against HEAD. Without a commit between
      // snapshots, snapshot N would be measured against a HEAD that still
      // predates snapshot N-1 and would re-count its deletions, so a dry-run
      // could refuse a plan the real push accepts. Committing the measured
      // index, as the real run does, keeps the preview's arithmetic
      // identical to the real run's.
      gitClient.commitStaged(workingCopy.repoDir, snapshot.message);
      if (!isLast) {
        recordBaseAdvance(
          config,
          baseDelta,
          snapshot,
          collectRemoteFiles(config, gitClient, workingCopy.repoDir)
        );
      }
    }

    return {
      kind: "push",
      status: "dry-run",
      remoteHeadBefore: workingCopy.remoteHead,
      remoteHeadAfter: workingCopy.remoteHead,
      appliedFiles: unique(appliedFiles),
      mergedFiles: unique(mergedFiles),
      conflictFiles: unique(conflictFiles),
      deletedFiles: unique([...deletedFiles, ...adoptedDeletions]),
      snapshots: [],
      queuedSnapshotId: null,
      notes: [
        ...notes,
        ...heldBackNotes(config, heldBack, { adoptedPaths: adoptedDeletions, snapshotIds: [] })
      ]
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
      snapshots: [],
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
  const heldBack: HeldBackPath[] = [];

  for (const remoteRelativePath of Array.from(targetPaths).sort()) {
    const repositoryPath = toRepositoryRelativePath(config, remoteRelativePath);
    const remoteContent = gitClient.readFile(repoDir, repositoryPath);
    const localContent = readSnapshotValue(snapshot.localFiles, remoteRelativePath);
    const mergeResult = mergeText({
      base: readSnapshotValue(snapshot.baseFiles, remoteRelativePath),
      local: localContent,
      remote: remoteContent,
      strategy: config.conflictStrategy
    });

    if (mergeResult.status === "unchanged") {
      continue;
    }

    // A hub file that itself carries conflict markers is never merged into,
    // whatever the local copy or the strategy says: the path is skipped, the
    // hub keeps its content, and the path is reported as a conflict. Its base
    // entry stays where it was (nextBaseAfterPush keeps the previous entry
    // for a path whose local copy differs from the hub), so the same decision
    // is reached again on every later push until the hub copy is repaired.
    // A local copy identical to the hub copy never gets here (the unchanged
    // check above) and has nothing to publish.
    if (hasConflictMarkers(remoteContent)) {
      conflictFiles.push(remoteRelativePath);
      heldBack.push({ path: remoteRelativePath, kind: "hub-markers" });
      continue;
    }

    // A conflict is resolved by a person in the local file, never on the hub:
    // a path whose local content already carries conflict markers, or whose
    // merge could only produce a marker-carrying result, is held back. The hub
    // keeps its current content for it, the path is reported as a conflict,
    // and the base entry stays where it was (nextBaseAfterPush keeps the
    // previous entry for a path whose local copy differs from the hub), so
    // the same decision is reached again on every later push until the local
    // file is resolved. A configured wins strategy that resolves the conflict
    // to marker-free content is a resolution, not a conflict, and goes through.
    if (mergeResult.conflict || hasConflictMarkers(localContent)) {
      conflictFiles.push(remoteRelativePath);
      heldBack.push({
        path: remoteRelativePath,
        kind: hasConflictMarkers(localContent)
          ? "local-markers"
          : localContent === null
            ? "local-deletion"
            : "merge-conflict"
      });
      continue;
    }

    if (mergeResult.status === "merged") {
      mergedFiles.push(remoteRelativePath);
    }

    if (mergeResult.content === null) {
      // What a removed path costs is measured where it really happens, in
      // the index (collectStagedDeletions), which is the guard's gate: a
      // path the working copy is already missing never reads as a deletion
      // here at all, and that is exactly the shape a wiped checkout has.
      //
      // Deliberately kept out of appliedFiles too: a run that removes files
      // reported them as "applied" with an empty deletedFiles list, which
      // reads as a successful sync of those paths. appliedFiles is the files
      // this snapshot WROTE; deletions are reported as deletions.
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
    heldBack
  };
}

// Why push held a path back; each reason has its own recovery step.
type HeldBackKind = "hub-markers" | "local-markers" | "local-deletion" | "merge-conflict";

interface HeldBackPath {
  path: string;
  kind: HeldBackKind;
}

// One note per path push held back (see applySnapshotToWorkingCopy), so the
// summary line names the file instead of only counting it, and says what to
// do about it: the step differs by reason, and a push-only run never writes
// the hub version into the local file, so "resolve the local file" alone
// would be advice that cannot work.
//
// A path whose local copy is gone because --accept-mass-delete adopted the
// hub's deletion (adoptedPaths) is held back with its queued edit surviving
// only in the pre-apply snapshot that adoption took; that note names the
// snapshot id and the one snapshotted file to copy back.
function heldBackNotes(
  config: PushConfig,
  held: HeldBackPath[],
  adoption: { adoptedPaths: string[]; snapshotIds: string[] }
): string[] {
  // Later snapshots of one run describe the path's current state best.
  const kindByPath = new Map<string, HeldBackKind>();
  for (const entry of held) {
    kindByPath.set(entry.path, entry.kind);
  }

  return Array.from(kindByPath.keys())
    .sort()
    .map((remoteRelativePath) => {
      const kind = kindByPath.get(remoteRelativePath) as HeldBackKind;
      const prefix = `not published: ${remoteRelativePath}`;
      if (kind === "hub-markers") {
        return hubMarkersPushNote(remoteRelativePath);
      }
      if (adoption.adoptedPaths.includes(remoteRelativePath)) {
        return adoptedHeldBackNote(config, remoteRelativePath, adoption.snapshotIds);
      }
      if (kind === "local-markers") {
        return (
          `${prefix} carries conflict markers in the local file; the hub keeps its current content. ` +
          "Resolve the conflict markers in the local file, then push again"
        );
      }
      if (kind === "local-deletion") {
        return (
          `${prefix} was deleted locally but the hub version changed; the hub keeps its current content. ` +
          "The local deletion was not published because the hub version changed; pull to see the hub version, " +
          "then delete again or keep it"
        );
      }
      return (
        `${prefix} conflicts with the hub version; the hub keeps its current content. ` +
        "Run pull or sync to bring the hub version into the local file, resolve the conflict markers it writes, " +
        "then push again"
      );
    });
}

// The note for a path push skipped because the hub copy carries conflict
// markers. Exported so the combined sync run can drop it for a path the pull
// side already named (see src/commands/run.ts).
function hubMarkersPushNote(remoteRelativePath: string): string {
  return (
    `not published: ${remoteRelativePath} was left as it is because the hub copy carries conflict markers; the ` +
    "hub keeps its current content. Repair the hub copy (commit a clean version to the hub), then sync again"
  );
}

// The recovery step names the one file the adoption snapshotted for this path,
// and the local path to copy it to. A whole-destination restore from the same
// snapshot would also bring back every other file the adoption removed, and
// the next push would publish those to the hub again, so it is named only as a
// fallback that says so, and never with the confirmation flag.
function adoptedHeldBackNote(config: PushConfig, remoteRelativePath: string, snapshotIds: string[]): string {
  const resolvedEntries = resolveSyncPathEntries(config);
  const destinations: string[] = resolvedEntries
    .map((entry: { destination: string }) => entry.destination)
    .sort((left: string, right: string) => right.length - left.length);
  const destination =
    destinations.find(
      (candidate) => remoteRelativePath === candidate || remoteRelativePath.startsWith(`${candidate}/`)
    ) || "<destination>";
  // The snapshot of this destination that actually holds the path; the last
  // one wins when a run took several.
  const holding = snapshotIds.filter((id) =>
    listPreApplySnapshots(config.stateDir, destination).some(
      (entry: { id: string; manifest: { files: string[] } }) =>
        entry.id === id && entry.manifest.files.includes(remoteRelativePath)
    )
  );
  const id = holding.length > 0 ? holding[holding.length - 1] : null;
  const snapshotFile = path.join(
    config.stateDir,
    "snapshots",
    destination,
    id === null ? "<id>" : id,
    "files",
    remoteRelativePath
  );
  const localPath = mapRemotePathToLocalAbsolute(config, remoteRelativePath, resolvedEntries) || remoteRelativePath;
  const survives =
    id === null
      ? "The edit would survive only in the pre-apply snapshot the real run takes (its id is reported under " +
        `snapshots), as the file ${snapshotFile}`
      : `The edit survives only in the pre-apply snapshot ${id}, as the file ${snapshotFile}`;
  const restoreId = id === null ? "<id>" : id;
  return (
    `not published: ${remoteRelativePath} has no local copy because --accept-mass-delete adopted the hub's ` +
    "deletion of it, and the edit queued for it conflicts with that deletion; the hub keeps its current content. " +
    `${survives}. To keep the edit, copy that one file to ${localPath} and push again. ` +
    "Fallback: agent-memory-sync restore " +
    `${config.profile} ${destination} --from-snapshot ${restoreId} --dry-run previews restoring the whole ` +
    `'${destination}' destination from that snapshot; a real run replaces the whole destination and brings back ` +
    "every other file this adoption removed, which the next push then publishes to the hub again"
  );
}

// The deletions that count against the mass-delete guard are net of the run:
// a path the hub did not track when the run started was created by an earlier
// snapshot of this same run, so a later snapshot removing it again takes
// nothing away from the hub's tracked corpus. Without this, a create followed
// by a delete while offline was measured against the base the run started
// with and refused on every push.
function netDeletionsAgainstRunStart(claimedDeletions: string[], runStartTracked: Set<string>): string[] {
  return claimedDeletions.filter((remoteRelativePath) => runStartTracked.has(remoteRelativePath));
}

// The remote-relative paths the hub's commit tracked when the run started.
// Read from the commit, not from the working tree: a working copy that does
// not represent the hub (a wiped checkout) must not shrink the set, or the
// deletions of that very wipe would be excluded from the guard's count.
function listRunStartTracked(
  config: { repositorySubdir: string },
  gitClient: InstanceType<typeof GitClient>,
  workingCopy: { repoDir: string; remoteHead: string | null }
): Set<string> {
  if (!workingCopy.remoteHead) {
    return new Set();
  }

  const prefix = `${config.repositorySubdir}/`;
  return new Set(
    gitClient
      .listTreePaths(workingCopy.repoDir, "HEAD", config.repositorySubdir)
      .filter((repoRelativePath: string) => repoRelativePath.startsWith(prefix))
      .map((repoRelativePath: string) => repoRelativePath.slice(prefix.length))
  );
}

// Stages the working copy and reads back the deletions the next commit would
// carry, as remote-relative paths (the key space the guards, the base
// snapshot store and the result payload all use).
//
// This is the mass-delete guard's real numerator (agent-tasks cda5b12c,
// pandora run .ai/runs/2026-09-11-memory-sync-wipe). `git add -A` stages
// every path the working copy lacks, whether the merge plan asked for it or
// not, so the plan is not what gets committed and must not be what gets
// checked. This is also the ONLY stage of the working copy per snapshot:
// the commit that follows takes this index as it is (GitClient.commitStaged).
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

// What the snapshots applied so far in one run changed in the base, as a
// sparse overlay: `set` holds paths whose entry moved to new content,
// `removed` the paths whose entry went away. Layering it over any base
// (a later snapshot's own, the stored one) re-applies those moves without
// replacing the rest of that base.
interface BaseDelta {
  set: Record<string, string | null>;
  removed: Set<string>;
}

function newBaseDelta(): BaseDelta {
  return { set: {}, removed: new Set() };
}

function applyBaseDelta(
  base: Record<string, string | null>,
  delta: BaseDelta
): Record<string, string | null> {
  const result = withoutKeys(base, Array.from(delta.removed));
  return { ...result, ...delta.set };
}

// After a queued snapshot's commit, advance the base for the snapshots that
// follow with the same per-path rule the final write uses (nextBaseAfterPush),
// from that snapshot's own local files and the hub tree as the commit left
// it. Without this, a later snapshot that reverts what the replay just
// published reads the published content as "local unchanged against base"
// and the revert is never published.
function recordBaseAdvance(
  config: PushConfig,
  delta: BaseDelta,
  snapshot: PushSnapshot,
  hubMap: Record<string, string | null>
) {
  const has = (source: object, key: string) => Object.prototype.hasOwnProperty.call(source, key);
  const before = snapshot.baseFiles;
  const after = filterUnmappedBaseMap(config, nextBaseAfterPush(before, snapshot.localFiles, hubMap));

  for (const key of Object.keys(before)) {
    if (!has(after, key)) {
      delete delta.set[key];
      delta.removed.add(key);
    }
  }
  for (const key of Object.keys(after)) {
    if (!has(before, key) || before[key] !== after[key]) {
      delta.removed.delete(key);
      delta.set[key] = after[key];
    }
  }
}

// Per-path base advance after a successful push. For each path:
// - the local content (as collected for this push) equals the final hub
//   content: the base takes the hub content;
// - the path is absent locally and on the hub: no base entry;
// - anything else (local differs from the hub, or exists on only one side):
//   the previous base entry is kept exactly, present or absent. The
//   three-way merge of the next run then still sees the content this
//   machine last converged on, so a peer's newer hub version is not
//   mistaken for "remote unchanged" and a hub-only file stays remote-only.
function nextBaseAfterPush(
  previousBase: Record<string, string | null>,
  localMap: Record<string, string>,
  hubMap: Record<string, string | null>
): Record<string, string | null> {
  const has = (source: object, key: string) => Object.prototype.hasOwnProperty.call(source, key);
  const result: Record<string, string | null> = {};
  const paths = new Set([...Object.keys(previousBase), ...Object.keys(localMap), ...Object.keys(hubMap)]);

  for (const key of paths) {
    const local = has(localMap, key) ? localMap[key] : null;
    const hub = has(hubMap, key) ? hubMap[key] : null;

    if (local === null && hub === null) {
      continue;
    }

    if (local === hub) {
      result[key] = hub;
    } else if (has(previousBase, key)) {
      result[key] = previousBase[key];
    }
  }

  return result;
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

function withoutKeys<T>(source: Record<string, T>, keys: string[]): Record<string, T> {
  const result = { ...source };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

module.exports = {
  hubMarkersPushNote,
  performPush
};
