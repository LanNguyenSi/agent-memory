// The push side's one escape from the unreliable-checkout refusal - for a
// finding whose emptied count is zero. NOT for one that carries emptied
// paths (present-but-zeroed): see assertOverridableCheckout in ./guards.ts,
// the shared predicate findRemoteDeletionsToAccept below routes through,
// which refuses those outright, flag or no flag.
//
// Origin: the memory-corpus wipe (agent-tasks cda5b12c) and the review round that
// followed it. The checkout guard (./guards.ts) refuses a working copy that
// came back missing a large share of what the base snapshot tracks, or
// present but emptied to zero bytes, and nothing at the file level tells a
// wiped-or-truncated checkout apart from a remote that genuinely dropped
// those files: both look like "base has N, the checkout shows fewer or
// zeroed". Without a way through, a legitimate large deletion wedges push,
// pull, sync and watch at exit 7 for good - but only for the missing half of
// that ambiguity. A checkout with emptied paths is treated differently, not
// because it is unambiguous, but because guessing wrong costs more: adopting
// it would copy zero-byte content into stateDir/snapshots and apply it as if
// it were the remote's real state, which is corruption, not consent. The
// route forward for a hub that really did empty those files on purpose is
// not this flag: re-commit real content at the hub, or raise
// massDeleteGuard.maxFiles/maxRatio in the config for one run.
//
// `--accept-mass-delete` is that way through, and this is what it means on
// the push side. A pull applies the remote's deletions through its own
// merge; a push has no merge that touches local files, so accepting the
// remote state has to be done explicitly: copy the affected destinations,
// remove the local files the remote no longer has, and move the base
// snapshot for those paths to where the remote is. The push then has nothing
// left to publish for them, rather than republishing the files the operator
// just agreed were deleted.
const { existsSync, rmSync } = require("node:fs");
const { mapRemotePathToLocalAbsolute, resolveSyncPathEntries } = require("./config");
const { assertOverridableCheckout } = require("./guards");
const { writePreApplySnapshot } = require("./pre-apply-snapshot");

interface AcceptConfig {
  stateDir: string;
  rootDir: string;
  repositorySubdir: string;
  profile?: string;
  massDeleteGuard?: { maxRatio?: number; maxFiles?: number } | null;
  snapshotGenerations?: number | null;
  syncPaths: Array<{
    source: string;
    destination?: string;
    kind?: "file" | "directory";
    required?: boolean;
    ownerScoped?: boolean;
  }>;
}

interface StateStoreLike {
  readBaseSnapshots: () => Record<string, string | null>;
  replaceBaseSnapshots: (files: Record<string, string | null>) => void;
}

// The pure decision half: what an acceptance would adopt, without adopting
// it. Shared by acceptRemoteDeletions below and by the push's --dry-run
// preview, which reports these paths and changes nothing.
//
// Empty when there is nothing to accept: the checkout shows what the base
// snapshot expects, so no refusal was going to happen and no local file may
// be removed on the strength of a flag alone. The flag permits adopting a
// deletion the run objected to; it never invents one.
//
// Otherwise every path the base snapshot tracks that the remote no longer
// has, in EVERY destination, not only the one that tripped the guard:
// adopting half of a remote state would leave the other half to be
// republished on the next push as a local-only addition, which is the
// opposite of what the operator asked for. `destinations` names the ones
// those paths fall under, sorted, for the report.
function findRemoteDeletionsToAccept(
  config: AcceptConfig,
  baseMap: Record<string, string | null>,
  remoteMap: Record<string, string | null>,
  remoteHead: string | null
): { paths: string[]; destinations: string[] } {
  // Throws UnreliableCheckoutError instead of returning when the finding
  // carries emptied paths - see the module comment above and
  // assertOverridableCheckout in ./guards.ts. Every caller of this function
  // (the real push run and its --dry-run preview) gets that refusal for
  // free rather than needing its own branch.
  const finding = assertOverridableCheckout({ config, baseMap, remoteMap, remoteHead });
  if (!finding) {
    return { paths: [], destinations: [] };
  }

  const destinations = resolveSyncPathEntries(config)
    .map((entry: { destination: string }) => entry.destination)
    .sort((left: string, right: string) => right.length - left.length);

  const paths: string[] = [];
  const affected = new Set<string>();
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
      paths.push(key);
      affected.add(destination);
    }
  }

  return { paths: paths.sort(), destinations: Array.from(affected).sort() };
}

// Returns null when there is nothing to accept (see
// findRemoteDeletionsToAccept).
function acceptRemoteDeletions(input: {
  config: AcceptConfig;
  stateStore: StateStoreLike;
  baseMap: Record<string, string | null>;
  localMap: Record<string, string>;
  localFiles: Array<{ remoteRelativePath: string; absolutePath: string }>;
  remoteMap: Record<string, string | null>;
  remoteHead: string | null;
}): {
  deletedPaths: string[];
  snapshots: string[];
  baseMap: Record<string, string | null>;
  localMap: Record<string, string>;
} | null {
  const lost = findRemoteDeletionsToAccept(input.config, input.baseMap, input.remoteMap, input.remoteHead);
  const lostPaths = lost.paths;
  if (lostPaths.length === 0) {
    return null;
  }

  const resolvedEntries = resolveSyncPathEntries(input.config);
  const destinations = resolvedEntries
    .map((entry: { destination: string }) => entry.destination)
    .sort((left: string, right: string) => right.length - left.length);

  // Copy first, delete second: the whole point of accepting a deletion this
  // large is that the operator can still be wrong about it.
  const snapshots: string[] = [];
  for (const destination of lost.destinations) {
    const files = input.localFiles.filter(
      (file) => destinationOf(destinations, file.remoteRelativePath) === destination
    );
    snapshots.push(
      writePreApplySnapshot({
        stateDir: input.config.stateDir,
        destination,
        files: files.map((file) => ({
          remoteRelativePath: file.remoteRelativePath,
          absolutePath: file.absolutePath
        })),
        generations: input.config.snapshotGenerations
      }).id
    );
  }

  const deletedPaths: string[] = [];
  for (const lostPath of lostPaths) {
    const absolutePath = mapRemotePathToLocalAbsolute(input.config, lostPath, resolvedEntries);
    if (!absolutePath || !existsSync(absolutePath)) {
      continue;
    }
    rmSync(absolutePath, { force: true });
    deletedPaths.push(lostPath);
  }

  // The base snapshot moves to where the remote is for exactly these paths,
  // and is persisted now rather than left to the end of the push: the local
  // files are already gone, so a push that fails afterwards must not leave a
  // base snapshot still claiming they exist. Read back from the store rather
  // than written from the caller's own map, which has been filtered for the
  // merge and would drop a peer's owner-scoped entries if written back.
  const storedBase = input.stateStore.readBaseSnapshots();
  for (const lostPath of lostPaths) {
    delete storedBase[lostPath];
  }
  input.stateStore.replaceBaseSnapshots(storedBase);

  const baseMap = { ...input.baseMap };
  const localMap = { ...input.localMap };
  for (const lostPath of lostPaths) {
    delete baseMap[lostPath];
    delete localMap[lostPath];
  }

  return { deletedPaths, snapshots, baseMap, localMap };
}

// Longest destination first, so the most specific configured destination
// claims a path when one destination is a prefix of another. Mirrors the
// same resolution in ./guards.ts, ./pull.ts and mapRemotePathToLocalAbsolute.
function destinationOf(destinations: string[], remoteRelativePath: string): string | null {
  for (const destination of destinations) {
    if (remoteRelativePath === destination || remoteRelativePath.startsWith(`${destination}/`)) {
      return destination;
    }
  }

  return null;
}

module.exports = {
  acceptRemoteDeletions,
  findRemoteDeletionsToAccept
};
