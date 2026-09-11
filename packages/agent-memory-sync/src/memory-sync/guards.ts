// Deletion guards for the pull and push paths.
//
// Origin: the 2026-09-11 memory-corpus wipe (agent-tasks cda5b12c, pandora
// run .ai/runs/2026-09-11-memory-sync-wipe). A periodic `run --mode sync`
// tick prepared a working copy under stateDir/tmp/pull while a concurrent
// `watch` tick called StateStore.clearTemp(), which removes the WHOLE
// stateDir/tmp tree. git had already reported a successful fetch+checkout,
// so the pull read an empty working copy, every remote path came back null,
// and mergeText's "local === base adopts remote" fast path resolved each one
// to a deletion: 404 local files removed from disk. The follow-up push then
// saw local empty against a full base snapshot and published 406 deletions,
// which the Linux peer mirrored one tick later.
//
// Neither half was a merge bug. mergeText answered exactly what it was
// asked; the inputs were wrong, and nothing checked whether the ANSWER was
// plausible. These two guards do that check:
//
//   assertReliableCheckout  the inputs: a destination the base snapshot says
//                           holds files came back with none, so the checkout
//                           itself is not trustworthy and no merge may run.
//   assertNoMassDelete      the plan: a push that would remove a large share
//                           of a destination stops and asks, instead of
//                           publishing the removal.
const { resolveSyncPathEntries } = require("./config");
const { MassDeleteRefusedError, UnreliableCheckoutError } = require("../errors");

interface MassDeleteGuardConfig {
  maxRatio: number;
  maxFiles: number;
}

// Defaults, overridable per profile via the `massDeleteGuard` config key
// (src/config/loader.ts).
//
// maxFiles 20: the mini's real memory destination holds roughly 400 files
// and grows by a handful a day, so a single tick removing more than 20 of
// them is already far outside the observed steady state. It is also the rule
// that catches the incident shape directly (406 deletions in one plan).
//
// maxRatio 0.1: the absolute rule alone is blind on a small destination (a
// 15-file destination losing all 15 stays under 20). The proportional rule
// covers that range, and above roughly 200 tracked files it is the looser of
// the two, so the two together stay meaningful across corpus sizes.
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

interface MassDeleteFinding {
  destination: string;
  deleted: number;
  tracked: number;
  rule: "absolute" | "proportional";
}

// Pure decision half of assertNoMassDelete: returns the first destination
// whose deletion count trips a rule, or null when the plan is acceptable.
// Split out from the throwing wrapper so it can be unit-tested and reused by
// a caller that wants to report rather than refuse.
function findMassDelete(
  config: GuardConfig,
  baseMap: Record<string, string | null>,
  deletedPaths: string[],
  guard: MassDeleteGuardConfig
): MassDeleteFinding | null {
  if (deletedPaths.length === 0) {
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

  return null;
}

function formatPercent(value: number): string {
  const percent = value * 100;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

function describeMassDelete(finding: MassDeleteFinding, guard: MassDeleteGuardConfig): string {
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
// destination than the guard allows. Call this BEFORE the plan is committed
// or pushed, once per snapshot: the remote must be untouched when it throws.
function assertNoMassDelete(input: {
  config: GuardConfig;
  baseMap: Record<string, string | null>;
  deletedPaths: string[];
  allowMassDelete?: boolean;
}): void {
  if (input.allowMassDelete) {
    return;
  }

  const guard = resolveMassDeleteGuard(input.config.massDeleteGuard);
  const finding = findMassDelete(input.config, input.baseMap, input.deletedPaths, guard);
  if (!finding) {
    return;
  }

  throw new MassDeleteRefusedError(
    `${describeMassDelete(finding, guard)} Nothing was pushed. If this deletion is intended, re-run with ` +
      `--allow-mass-delete; otherwise check whether the local workspace or the working copy was emptied by ` +
      `another process first.`
  );
}

interface CheckoutFinding {
  destination: string;
  tracked: number;
}

// Pure decision half of assertReliableCheckout.
//
// A destination that the base snapshot says holds `tracked >=
// MIN_PROPORTIONAL_DELETIONS` files, and that the freshly fetched working
// copy reports as holding none, is the signature of a checkout that never
// materialized (or was wiped underneath this process) rather than of a
// remote that genuinely dropped every file at once. The same
// MIN_PROPORTIONAL_DELETIONS floor applies as for the proportional rule: a
// destination that tracked a single file and now reports none is an ordinary
// single-file deletion, which this package has always applied and which its
// existing suite pins.
//
// `remoteHead === null` means the remote branch has no commits at all (a
// freshly initialized remote before the first push), where an empty working
// copy is the correct, expected state and never an anomaly.
//
// The check is deliberately limited to "empty". A PARTIAL checkout cannot be
// told apart from a partial remote deletion by reading the tree alone; on
// the push side that case is covered proportionally by assertNoMassDelete
// above, since a partially-read remote resolves to a deletion plan.
function findUnreliableCheckout(
  config: GuardConfig,
  baseMap: Record<string, string | null>,
  remoteMap: Record<string, string | null>,
  remoteHead: string | null
): CheckoutFinding | null {
  if (!remoteHead) {
    return null;
  }

  const destinations = destinationsOf(config);
  const trackedCounts = countByDestination(destinations, baseMap);
  const remoteCounts = countByDestination(destinations, remoteMap);

  for (const destination of Array.from(trackedCounts.keys()).sort()) {
    const tracked = trackedCounts.get(destination) || 0;
    if (tracked < MIN_PROPORTIONAL_DELETIONS) {
      continue;
    }
    if ((remoteCounts.get(destination) || 0) === 0) {
      return { destination, tracked };
    }
  }

  return null;
}

// Throws UnreliableCheckoutError when the working copy cannot be trusted.
// Call this after prepareWorkingCopy and before any merge, on both the pull
// and the push side: pull must not delete local files from it, push must not
// build a deletion plan out of it.
function assertReliableCheckout(input: {
  config: GuardConfig;
  baseMap: Record<string, string | null>;
  remoteMap: Record<string, string | null>;
  remoteHead: string | null;
  allowMassDelete?: boolean;
}): void {
  if (input.allowMassDelete) {
    return;
  }

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
    `unreliable checkout: the fetched working copy for remote head ${input.remoteHead} has no files under ` +
      `'${finding.destination}', but the base snapshot tracks ${finding.tracked} file(s) there. Nothing was ` +
      `deleted locally and nothing was pushed. This is usually a temporary working copy that was wiped or ` +
      `never materialized (a concurrent watch/sync run sharing stateDir/tmp); re-run the command. If the ` +
      `remote really did drop every file under '${finding.destination}', re-run with --allow-mass-delete.`
  );
}

module.exports = {
  DEFAULT_MASS_DELETE_GUARD,
  MIN_PROPORTIONAL_DELETIONS,
  assertNoMassDelete,
  assertReliableCheckout,
  findMassDelete,
  findUnreliableCheckout,
  resolveMassDeleteGuard
};
