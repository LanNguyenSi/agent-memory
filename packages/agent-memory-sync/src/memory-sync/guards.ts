// Deletion guards for the pull and push paths.
//
// Origin: the 2026-09-11 memory-corpus wipe (agent-tasks cda5b12c, pandora
// run .ai/runs/2026-09-11-memory-sync-wipe). A periodic `run --mode sync`
// tick prepared a working copy under stateDir/tmp/pull while a concurrent
// `watch` tick called StateStore.clearTemp(), which removes the WHOLE
// stateDir/tmp tree. git had already reported a successful fetch+checkout,
// so the pull read an empty working copy, every remote path came back null,
// and mergeText's "local === base adopts remote" fast path resolved each one
// to a deletion: the local corpus was removed from disk. The follow-up push
// then saw local empty against a full base snapshot and published the same
// deletions, which the Linux peer mirrored one tick later.
//
// Neither half was a merge bug. mergeText answered exactly what it was
// asked; the inputs were wrong, and nothing checked whether the ANSWER was
// plausible. These two guards do that check:
//
//   assertReliableCheckout  the inputs: a destination the base snapshot says
//                           holds files came back missing enough of them
//                           that the checkout itself is not trustworthy, so
//                           no merge may run against it.
//   assertNoMassDelete      the plan: a push that would remove a large share
//                           of a destination, or a large number of files
//                           across the whole plan, stops and asks instead of
//                           publishing the removal.
const { resolveSyncPathEntries } = require("./config");
const {
  MassDeleteRefusedError,
  RemoteDeletionRefusedError,
  UnreliableCheckoutError
} = require("../errors");

interface MassDeleteGuardConfig {
  maxRatio: number;
  maxFiles: number;
}

// Defaults, overridable per profile via the `massDeleteGuard` config key
// (src/config/loader.ts).
//
// maxFiles bounds a single run's absolute damage: a tick removing more than
// this many files at once is far outside the steady state of a corpus that
// grows and shrinks by a handful of files a day, and it is the rule that
// catches the incident shape directly.
//
// maxRatio covers the range where the absolute rule is blind: a destination
// small enough to lose everything it has while staying under maxFiles.
// Above a few hundred tracked files the proportional rule is the looser of
// the two, so the two together stay meaningful across corpus sizes.
//
// The measured corpus sizes and deletion counts these numbers were chosen
// against belong to the incident record, not to shipped source: see the
// CHANGELOG entry for this change and the pandora run it points to.
const DEFAULT_MASS_DELETE_GUARD: MassDeleteGuardConfig = {
  maxRatio: 0.1,
  maxFiles: 20
};

// The proportional rule needs at least two deletions in one plan before it
// fires. Below that it carries no information about the plan, only about the
// size of the destination: with maxRatio 0.1, deleting a single file exceeds
// "10 percent" for every destination holding fewer than ten files, so a
// one-file rule would make routine single-file housekeeping impossible on a
// small destination and would force --allow-mass-delete for the most common
// legitimate deletion there is. AC-003's negative space names that case
// explicitly ("does not prevent a genuine gradual deletion below the
// thresholds"), and this package's own watch-mirror-delete.test.ts negative
// control depends on it.
//
// The absolute rule (maxFiles) is NOT floored this way, so a destination
// that loses everything it has is still caught the moment the count passes
// maxFiles, and a destination that loses everything it has with two or more
// files is caught by the proportional rule at 100 percent.
const MIN_PROPORTIONAL_DELETIONS = 2;

interface SyncPathLike {
  source: string;
  destination?: string;
  kind?: "file" | "directory";
  required?: boolean;
  ownerScoped?: boolean;
}

interface GuardConfig {
  rootDir: string;
  repositorySubdir: string;
  syncPaths: SyncPathLike[];
  profile?: string;
  massDeleteGuard?: Partial<MassDeleteGuardConfig> | null;
}

function resolveMassDeleteGuard(value?: Partial<MassDeleteGuardConfig> | null): MassDeleteGuardConfig {
  if (!value) {
    return { ...DEFAULT_MASS_DELETE_GUARD };
  }

  return {
    maxRatio: typeof value.maxRatio === "number" ? value.maxRatio : DEFAULT_MASS_DELETE_GUARD.maxRatio,
    maxFiles: typeof value.maxFiles === "number" ? value.maxFiles : DEFAULT_MASS_DELETE_GUARD.maxFiles
  };
}

// Every configured destination, longest first. Longest-first matters when
// one destination is a prefix of another ("logs" and "logs-archive" are not,
// but "a" and "a/b" are): the most specific match must win, the same way
// mapRemotePathToLocalAbsolute resolves a remote path to a local one.
function destinationsOf(config: GuardConfig): string[] {
  return resolveSyncPathEntries(config)
    .map((entry: { destination: string }) => entry.destination)
    .sort((left: string, right: string) => right.length - left.length);
}

function destinationOf(destinations: string[], remoteRelativePath: string): string | null {
  for (const destination of destinations) {
    if (remoteRelativePath === destination || remoteRelativePath.startsWith(`${destination}/`)) {
      return destination;
    }
  }

  return null;
}

// Counts, per destination, how many entries of `map` carry real content. A
// null value is a tombstone (StateStore's `.meta.json` deleted marker), not a
// tracked file, so it never inflates the denominator of the proportional
// rule.
function countByDestination(
  destinations: string[],
  map: Record<string, string | null>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const destination of destinations) {
    counts.set(destination, 0);
  }

  for (const [key, value] of Object.entries(map)) {
    if (value === null) {
      continue;
    }
    const destination = destinationOf(destinations, key);
    if (destination === null) {
      continue;
    }
    counts.set(destination, (counts.get(destination) || 0) + 1);
  }

  return counts;
}

function countPathsByDestination(destinations: string[], paths: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const remoteRelativePath of paths) {
    const destination = destinationOf(destinations, remoteRelativePath);
    if (destination === null) {
      continue;
    }
    counts.set(destination, (counts.get(destination) || 0) + 1);
  }

  return counts;
}

// `destination: null` marks the plan-wide total rule, which is about the
// plan as a whole rather than about any one destination.
interface MassDeleteFinding {
  destination: string | null;
  deleted: number;
  tracked: number;
  rule: "absolute" | "proportional" | "total";
}

// Pure decision half of assertNoMassDelete: returns the first rule the plan
// trips, or null when the plan is acceptable. Split out from the throwing
// wrapper so it can be unit-tested and reused by a caller that wants to
// report rather than refuse.
//
// Per-destination rules are evaluated first, because they produce the more
// specific message. The plan-wide total is evaluated last and exists because
// both per-destination rules are, by construction, blind to a plan that
// stays just under the limit in each of several destinations at once: with
// three configured destinations, maxFiles refuses 21 deletions in one of
// them and accepts 60 spread evenly across all three (R1 medium, D-007).
// AC-003's text is unqualified about the count, so the total is checked too.
//
// `unmappedDeletedPaths` are staged deletions no configured destination
// claims (a path outside repositorySubdir in the same remote repository).
// They have no base denominator, so neither per-destination rule can say
// anything about them, and `git add -A` publishes them exactly like any
// other deletion. Only the absolute plan-wide rule applies to them.
function findMassDelete(
  config: GuardConfig,
  baseMap: Record<string, string | null>,
  deletedPaths: string[],
  guard: MassDeleteGuardConfig,
  unmappedDeletedPaths: string[] = []
): MassDeleteFinding | null {
  if (deletedPaths.length === 0 && unmappedDeletedPaths.length === 0) {
    return null;
  }

  const destinations = destinationsOf(config);
  const trackedCounts = countByDestination(destinations, baseMap);
  const deletedCounts = countPathsByDestination(destinations, deletedPaths);

  for (const destination of Array.from(deletedCounts.keys()).sort()) {
    const deleted = deletedCounts.get(destination) || 0;
    const tracked = trackedCounts.get(destination) || 0;

    if (deleted > guard.maxFiles) {
      return { destination, deleted, tracked, rule: "absolute" };
    }

    if (
      deleted >= MIN_PROPORTIONAL_DELETIONS &&
      tracked > 0 &&
      deleted > tracked * guard.maxRatio
    ) {
      return { destination, deleted, tracked, rule: "proportional" };
    }
  }

  // Two contributions: the deletions that map to a configured destination,
  // and the ones no destination claims. The per-destination rules above can
  // only see the first kind, since the second has no tracked denominator to
  // be a share of, but the commit carries both.
  let totalDeleted = unmappedDeletedPaths.length;
  for (const count of deletedCounts.values()) {
    totalDeleted += count;
  }
  if (totalDeleted > guard.maxFiles) {
    let totalTracked = 0;
    for (const count of trackedCounts.values()) {
      totalTracked += count;
    }
    return { destination: null, deleted: totalDeleted, tracked: totalTracked, rule: "total" };
  }

  return null;
}

function formatPercent(value: number): string {
  const percent = value * 100;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

function describeMassDelete(
  finding: MassDeleteFinding,
  guard: MassDeleteGuardConfig,
  config: GuardConfig,
  unmappedDeleted = 0
): string {
  if (finding.rule === "total") {
    const mapped = finding.deleted - unmappedDeleted;
    const outside =
      unmappedDeleted > 0 ? `, plus ${unmappedDeleted} outside '${config.repositorySubdir}/'` : "";
    return (
      `refusing to push a plan that deletes ${finding.deleted} file(s) across all sync destinations ` +
      `(${mapped} of ${finding.tracked} tracked${outside}), over the mass-delete limit of ` +
      `${guard.maxFiles} file(s).`
    );
  }

  if (finding.rule === "absolute") {
    return (
      `refusing to push a plan that deletes ${finding.deleted} file(s) under '${finding.destination}' ` +
      `(${finding.deleted} of ${finding.tracked} tracked), over the mass-delete limit of ` +
      `${guard.maxFiles} file(s).`
    );
  }

  const ratio = finding.tracked > 0 ? finding.deleted / finding.tracked : 1;
  return (
    `refusing to push a plan that deletes ${finding.deleted} of ${finding.tracked} tracked file(s) under ` +
    `'${finding.destination}' (${formatPercent(ratio)}), over the mass-delete threshold of ` +
    `${formatPercent(guard.maxRatio)}.`
  );
}

// Throws MassDeleteRefusedError when the push plan removes more of a
// destination, or of the plan as a whole, than the guard allows.
//
// `deletedPaths` must be the deletions the commit will ACTUALLY carry, not
// the deletions the 3-way merge intended: push.ts stages the working copy
// and reads them back out of the index (GitClient.listStagedDeletions)
// before calling this. A plan-derived list is a strict subset and misses
// every path that was already missing from the working copy, which is the
// exact shape a wiped temp checkout produces (R1 critical, D-006).
//
// Call this BEFORE the plan is committed or pushed, once per snapshot: the
// remote must be untouched when it throws.
function assertNoMassDelete(input: {
  config: GuardConfig;
  baseMap: Record<string, string | null>;
  deletedPaths: string[];
  unmappedDeletedPaths?: string[];
  allowMassDelete?: boolean;
}): void {
  if (input.allowMassDelete) {
    return;
  }

  const unmappedDeletedPaths = input.unmappedDeletedPaths || [];
  const guard = resolveMassDeleteGuard(input.config.massDeleteGuard);
  const finding = findMassDelete(
    input.config,
    input.baseMap,
    input.deletedPaths,
    guard,
    unmappedDeletedPaths
  );
  if (!finding) {
    return;
  }

  throw new MassDeleteRefusedError(
    `${describeMassDelete(finding, guard, input.config, unmappedDeletedPaths.length)} Nothing was pushed. ` +
      `If this deletion is intended, re-run with ` +
      `--allow-mass-delete; otherwise check whether the local workspace or the working copy was emptied by ` +
      `another process first.`
  );
}

// The pull-side companion to assertNoMassDelete: the same thresholds, asked
// about the deletions a pull is about to apply to the LOCAL workspace rather
// than about the deletions a push is about to publish.
//
// Its relationship to assertReliableCheckout, which runs first and is the
// broader net: a planned deletion is always a path the base snapshot tracks
// and the checkout no longer shows, so per destination the checkout check
// sees everything this one sees and more (a lost path whose local copy was
// edited since is not deleted by the merge, but is still lost). What it
// cannot see is the plan-wide total across destinations, which it has no
// notion of: three destinations each losing a share small enough to pass on
// its own still add up to a run that removes far more than the absolute
// limit allows. That is this check's own ground, and the reason it carries
// its own exit code rather than being folded into the other.
//
// Call this on the assembled plan, before the first local file is touched.
function assertNoRemoteMassDelete(input: {
  config: GuardConfig;
  baseMap: Record<string, string | null>;
  deletedPaths: string[];
  acceptMassDelete?: boolean;
}): void {
  if (input.acceptMassDelete) {
    return;
  }

  const guard = resolveMassDeleteGuard(input.config.massDeleteGuard);
  const finding = findMassDelete(input.config, input.baseMap, input.deletedPaths, guard);
  if (!finding) {
    return;
  }

  throw new RemoteDeletionRefusedError(
    `${describeRemoteMassDelete(finding, guard)} Nothing was deleted locally and nothing was pushed. If the ` +
      `remote really did drop those files, re-run with --accept-mass-delete: the destination is copied into ` +
      `stateDir/snapshots first, and the deletion is then applied. If it did not, recover the remote (see ` +
      `'agent-memory-sync restore --help') before syncing again.`
  );
}

function describeRemoteMassDelete(finding: MassDeleteFinding, guard: MassDeleteGuardConfig): string {
  if (finding.rule === "total") {
    return (
      `refusing to apply a remote change that deletes ${finding.deleted} file(s) across all sync ` +
      `destinations (${finding.deleted} of ${finding.tracked} tracked), over the mass-delete limit of ` +
      `${guard.maxFiles} file(s).`
    );
  }

  if (finding.rule === "absolute") {
    return (
      `refusing to apply a remote change that deletes ${finding.deleted} file(s) under ` +
      `'${finding.destination}' (${finding.deleted} of ${finding.tracked} tracked), over the mass-delete ` +
      `limit of ${guard.maxFiles} file(s).`
    );
  }

  const ratio = finding.tracked > 0 ? finding.deleted / finding.tracked : 1;
  return (
    `refusing to apply a remote change that deletes ${finding.deleted} of ${finding.tracked} tracked ` +
    `file(s) under '${finding.destination}' (${formatPercent(ratio)}), over the mass-delete threshold of ` +
    `${formatPercent(guard.maxRatio)}.`
  );
}

interface CheckoutFinding {
  destination: string;
  tracked: number;
  present: number;
  lost: number;
  rule: "absolute" | "proportional";
}

// Pure decision half of assertReliableCheckout.
//
// A destination the base snapshot says holds files, and that the freshly
// fetched working copy reports as having lost a large share of them, is the
// signature of a checkout that never materialized (or was wiped underneath
// this process) rather than of a remote that genuinely dropped that many
// files at once.
//
// The thresholds are the mass-delete guard's own (R1 critical, D-006): the
// original check fired only on a destination that came back with EXACTLY
// zero files, which a partially wiped working copy walks straight past, and
// a partial wipe is not a milder failure than a total one. The same
// MIN_PROPORTIONAL_DELETIONS floor applies as for the proportional rule: a
// destination that tracked a single file and now reports none is an ordinary
// single-file deletion, which this package has always applied and which its
// existing suite pins.
//
// `remoteHead === null` means the remote branch has no commits at all (a
// freshly initialized remote before the first push), where an empty working
// copy is the correct, expected state and never an anomaly.
function findUnreliableCheckout(
  config: GuardConfig,
  baseMap: Record<string, string | null>,
  remoteMap: Record<string, string | null>,
  remoteHead: string | null,
  guard: MassDeleteGuardConfig = resolveMassDeleteGuard(config.massDeleteGuard)
): CheckoutFinding | null {
  if (!remoteHead) {
    return null;
  }

  const destinations = destinationsOf(config);
  const trackedCounts = countByDestination(destinations, baseMap);
  const presentCounts = countByDestination(destinations, remoteMap);
  // Counted per path rather than as tracked-minus-present: a checkout that
  // dropped ten tracked files while carrying ten new ones has still lost
  // ten, and a difference of counts would report zero.
  const lostCounts = countLostByDestination(destinations, baseMap, remoteMap);

  for (const destination of Array.from(trackedCounts.keys()).sort()) {
    const tracked = trackedCounts.get(destination) || 0;
    const present = presentCounts.get(destination) || 0;
    const lost = lostCounts.get(destination) || 0;

    if (lost > guard.maxFiles) {
      return { destination, tracked, present, lost, rule: "absolute" };
    }

    if (
      lost >= MIN_PROPORTIONAL_DELETIONS &&
      tracked > 0 &&
      lost > tracked * guard.maxRatio
    ) {
      return { destination, tracked, present, lost, rule: "proportional" };
    }
  }

  return null;
}

// How many of the files the base snapshot tracks under each destination the
// working copy no longer has. A tombstone (null) on either side is not a
// file: it is neither tracked nor lost.
function countLostByDestination(
  destinations: string[],
  baseMap: Record<string, string | null>,
  remoteMap: Record<string, string | null>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const destination of destinations) {
    counts.set(destination, 0);
  }

  for (const [key, value] of Object.entries(baseMap)) {
    if (value === null) {
      continue;
    }
    const destination = destinationOf(destinations, key);
    if (destination === null) {
      continue;
    }
    const remoteValue = Object.prototype.hasOwnProperty.call(remoteMap, key) ? remoteMap[key] : null;
    if (remoteValue === null) {
      counts.set(destination, (counts.get(destination) || 0) + 1);
    }
  }

  return counts;
}

function describeUnreliableCheckout(finding: CheckoutFinding): string {
  if (finding.present === 0) {
    return (
      `has no files under '${finding.destination}', but the base snapshot tracks ${finding.tracked} file(s) ` +
      `there`
    );
  }

  return (
    `is missing ${finding.lost} of the ${finding.tracked} file(s) the base snapshot tracks under ` +
    `'${finding.destination}' (${finding.present} still present)`
  );
}

// Throws UnreliableCheckoutError when the working copy cannot be trusted.
// Call this after prepareWorkingCopy and before any merge, on both the pull
// and the push side: pull must not delete local files from it, push must not
// build a deletion plan out of it.
//
// Deliberately takes no override (D-004, D-008). --allow-mass-delete is an
// operator's answer to "yes, delete these files"; it is not an answer to
// "the working copy this run fetched is not the remote", which is a question
// about the inputs, not about the plan. An operator reaching for the flag on
// a wiped working copy would publish the wipe, which is the live path the
// incident took. A genuine full removal goes through `restore` or a fresh
// base snapshot instead.
function assertReliableCheckout(input: {
  config: GuardConfig;
  baseMap: Record<string, string | null>;
  remoteMap: Record<string, string | null>;
  remoteHead: string | null;
}): void {
  const finding = findUnreliableCheckout(
    input.config,
    input.baseMap,
    input.remoteMap,
    input.remoteHead
  );
  if (!finding) {
    return;
  }

  throw new UnreliableCheckoutError(
    `unreliable checkout: the fetched working copy for remote head ${input.remoteHead} ` +
      `${describeUnreliableCheckout(finding)}. Nothing was deleted locally and nothing was pushed. There ` +
      `are two ways on from here. (1) If this is a temporary working copy that was wiped or never ` +
      `materialized (a concurrent watch/sync run sharing stateDir/tmp), re-run the command once nothing ` +
      `else is touching stateDir/tmp. (2) If the remote really did drop those files and that was intended, ` +
      `re-run with --accept-mass-delete, which copies the destination into stateDir/snapshots and then ` +
      `applies the remote's state locally. To bring the files back instead, restore the destination from a ` +
      `commit that still had them ('agent-memory-sync restore --from-commit <sha>') and let the next run ` +
      `push them.`
  );
}

module.exports = {
  DEFAULT_MASS_DELETE_GUARD,
  MIN_PROPORTIONAL_DELETIONS,
  assertNoMassDelete,
  assertNoRemoteMassDelete,
  assertReliableCheckout,
  findMassDelete,
  findUnreliableCheckout,
  resolveMassDeleteGuard
};
