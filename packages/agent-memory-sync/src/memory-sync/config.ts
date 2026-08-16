const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");
const { CliError } = require("../errors");

interface SyncPathConfig {
  source: string;
  destination?: string;
  kind?: "file" | "directory";
  required?: boolean;
  // Marks a directory-kind entry as machine-exclusive (one owner file per
  // machine, named `<profile>.json` — the machine-state/frictions
  // convention documented in profiles/linux.json). Absent/false is the
  // pre-existing behavior (every file under the directory is offered).
  // See collectLocalSyncFiles' `options.ownerFilter` below: this field only
  // takes effect there, i.e. only for the PUSH collection, never for pull.
  ownerScoped?: boolean;
}

interface RunConfig {
  rootDir: string;
  repositorySubdir: string;
  syncPaths: SyncPathConfig[];
  // Present on every real caller (PushConfig/PullConfig both declare it
  // required) — optional here only so a minimal hand-built config (as some
  // existing tests use) still type-checks. Used solely to derive the
  // `<profile>.json` owner filename below.
  profile?: string;
}

interface LocalSyncFile {
  absolutePath: string;
  localRelativePath: string;
  remoteRelativePath: string;
  content: string;
}

interface CollectLocalSyncFilesOptions {
  // Applies the ownerScoped filter (see SyncPathConfig.ownerScoped above).
  // Pull must NEVER set this — pull is the one place a peer's owner file is
  // supposed to be materialized locally (D-004,
  // .ai/runs/2026-08-03-sync-conflict-markers-echo/03-decisions.md); only
  // push's own "what do I offer as my local snapshot" collection sets it, so
  // a machine never re-offers a peer's file it merely pulled as if it were
  // its own change (the Defect B echo/last-writer-wins race).
  ownerFilter?: boolean;
  // Fix-Runde HIGH finding (05-review-findings.md, agent-tasks 06d09cde):
  // when an ownerScoped directory has OTHER files but not this machine's own
  // `<profile>.json`, the pre-fix code silently offered nothing for that
  // destination — a real data-loss path, reachable whenever the resolved
  // `config.profile` doesn't match the machine's actual owner filename (the
  // CLI's [profile] positional defaults to 'default' and overrides the
  // config file's 'profile' field when omitted — run.ts's `.argument`
  // default plus loader.ts's override-order). Rather than staying silent,
  // that situation now pushes a warning string into this caller-supplied
  // array (an out-parameter, not a return-shape change, so callers that
  // don't pass it — i.e. pull, which never sets ownerFilter either —
  // continue to receive plain LocalSyncFile[] back, untouched). The caller
  // (push.ts) surfaces any collected warning via the same `notes` array
  // every other push/pull diagnostic already uses (see preview.ts's
  // summarizeOperation, which renders `notes=...` in text output, and the
  // JSON payload's own `notes` field).
  warnings?: string[];
}

function collectLocalSyncFiles(config: RunConfig, options: CollectLocalSyncFilesOptions = {}): LocalSyncFile[] {
  const results: LocalSyncFile[] = [];
  const ownerFileName = options.ownerFilter && config.profile ? `${config.profile}.json` : null;

  for (const entry of config.syncPaths) {
    const absoluteSource = resolveWorkspacePath(config.rootDir, entry.source);
    const destination = normalizeRemoteRelativePath(entry.destination || entry.source);
    const kind = resolveSyncPathKind(absoluteSource, entry);

    if (!existsSync(absoluteSource)) {
      if (entry.required) {
        throw new CliError(`required sync path '${entry.source}' does not exist.`, 4);
      }
      continue;
    }

    if (kind === "file") {
      results.push({
        absolutePath: absoluteSource,
        localRelativePath: normalizeLocalRelativePath(config.rootDir, absoluteSource),
        remoteRelativePath: destination,
        content: readFileSync(absoluteSource, "utf8")
      });
      continue;
    }

    if (kind === "directory" && entry.ownerScoped && ownerFileName) {
      const ownerAbsolutePath = path.join(absoluteSource, ownerFileName);
      if (existsSync(ownerAbsolutePath) && statSync(ownerAbsolutePath).isFile()) {
        results.push({
          absolutePath: ownerAbsolutePath,
          localRelativePath: normalizeLocalRelativePath(config.rootDir, ownerAbsolutePath),
          remoteRelativePath: path.posix.join(destination, ownerFileName),
          content: readFileSync(ownerAbsolutePath, "utf8")
        });
      } else {
        // Own file absent. Stay tolerant (no exception — a brand-new
        // machine's first run legitimately has no <profile>.json yet), but
        // only stay SILENT when the directory is genuinely empty of other
        // content too. If other files ARE present, this machine has
        // something to compare against and is about to publish nothing for
        // this destination — that is the silent-data-loss path the HIGH
        // finding flagged, so it becomes a visible warning instead.
        const peerFiles = walkFiles(absoluteSource);
        if (peerFiles.length > 0 && options.warnings) {
          options.warnings.push(
            `profile '${config.profile}': own file '${ownerFileName}' not found among ${peerFiles.length} file(s) in '${absoluteSource}'; ` +
              `this machine will publish no '${destination}' state — check the profile positional matches this machine`
          );
        }
      }
      continue;
    }

    for (const nestedFile of walkFiles(absoluteSource)) {
      const nestedRelative = path.relative(absoluteSource, nestedFile).replace(/\\/g, "/");
      results.push({
        absolutePath: nestedFile,
        localRelativePath: normalizeLocalRelativePath(config.rootDir, nestedFile),
        remoteRelativePath: path.posix.join(destination, nestedRelative),
        content: readFileSync(nestedFile, "utf8")
      });
    }
  }

  return results.sort((left, right) => left.remoteRelativePath.localeCompare(right.remoteRelativePath));
}

// Push-only companion to collectLocalSyncFiles' ownerFilter. Filtering the
// LOCAL snapshot alone is not enough: push's 3-way merge visits every path
// in `localFiles keys UNION baseFiles keys` (src/memory-sync/push.ts's
// applySnapshotToWorkingCopy), and the state store's base snapshot still
// legitimately carries a peer's ownerScoped file — it was written there by
// a prior pull's `stateStore.replaceBaseSnapshots(remoteMap)`. Left
// unfiltered, that foreign key survives in baseFiles alone (base non-null,
// local now absent because collectLocalSyncFiles dropped it, remote
// possibly having moved on since) and still gets visited: base !== local
// and base !== remote trips the genuine-conflict fallback, which would
// spuriously flag a "conflict" and write marker content combining an empty
// local half with the peer's real remote content — actively corrupting a
// file this machine never touched. Call this once, right where
// collectLocalSyncFiles' PUSH collection is also called, so both the
// "current" snapshot and anything newly enqueued from it stay consistent.
function filterOwnerScopedBaseMap(
  config: RunConfig,
  baseMap: Record<string, string | null>
): Record<string, string | null> {
  if (!config.profile) {
    return baseMap;
  }

  const ownerFileName = `${config.profile}.json`;
  const ownerScopedDestinations = config.syncPaths
    .filter(
      (entry) =>
        entry.ownerScoped && resolveSyncPathKind(resolveWorkspacePath(config.rootDir, entry.source), entry) === "directory"
    )
    .map((entry) => normalizeRemoteRelativePath(entry.destination || entry.source));

  if (ownerScopedDestinations.length === 0) {
    return baseMap;
  }

  const result: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(baseMap)) {
    const owningDestination = ownerScopedDestinations.find(
      (destination) => key === destination || key.startsWith(`${destination}/`)
    );
    if (owningDestination && key !== path.posix.join(owningDestination, ownerFileName)) {
      continue;
    }
    result[key] = value;
  }

  return result;
}

// Keeps a base snapshot map from ever recording a remote path that has no
// configured syncPaths mapping back to a local destination — the push-side
// half of the defect closed on the pull side by agent-tasks e4b5552a's
// skippedFiles guard below (mapRemotePathToLocalAbsolute's null return, used
// there to classify an unmapped remote path as "skipped" instead of
// "applied"). Design decision (agent-tasks 65380570): an unmapped path is
// excluded from base snapshots entirely, rather than kept and marked
// "foreign" (the way filterOwnerScopedBaseMap above handles a peer's
// ownerScoped file, which IS locally mappable, just not owned by this
// machine). Two reasons drove that choice over a foreign-marker scheme:
// (1) it keeps pull's skippedFiles contract from #101 intact — an unmapped
// path was never materialized locally and never will be, so there is no
// local state for a base snapshot to track "did local change relative to"
// in the first place; recording it at all was the bug, not a
// under-annotated version of correct behavior. (2) it needs no change to the
// base snapshot's Record<string, string | null> shape (no wrapper object, no
// sibling "foreign paths" list to keep in sync) — the same shape
// filterOwnerScopedBaseMap already filters in place.
//
// Left unfiltered, an unmapped path pull recorded into the base store
// (pre-fix: pull.ts's replaceBaseSnapshots(remoteMap) stored every remote
// file, mapped or not) survives into push's own 3-way merge
// (applySnapshotToWorkingCopy in push.ts) as base=<content>, local=null
// (collectLocalSyncFiles never produces an entry for a path with no
// syncPaths mapping) — and once the remote itself is unchanged since that
// pull, mergeText's remote===base fast path resolves to "local wins" with
// content=null, deleting a peer's file this machine never even had a local
// copy of and reporting it under appliedFiles as if legitimately applied.
// Call this both where pull decides what to persist as the new base (the
// root-cause fix, going forward) and where push reads the base snapshot
// store back (a defensive backstop for a store that already carries a
// contaminated entry from before this fix shipped — mirrors why
// filterOwnerScopedBaseMap is applied on both the write and read side of its
// own defect class).
function filterUnmappedBaseMap(
  config: RunConfig,
  baseMap: Record<string, string | null>
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(baseMap)) {
    if (mapRemotePathToLocalAbsolute(config, key) === null) {
      continue;
    }
    result[key] = value;
  }

  return result;
}

function mapRemotePathToLocalAbsolute(config: RunConfig, remoteRelativePath: string): string | null {
  const normalizedRemotePath = normalizeRemoteRelativePath(remoteRelativePath);

  for (const entry of config.syncPaths) {
    const absoluteSource = resolveWorkspacePath(config.rootDir, entry.source);
    const destination = normalizeRemoteRelativePath(entry.destination || entry.source);
    const kind = resolveSyncPathKind(absoluteSource, entry);

    if (kind === "file" && normalizedRemotePath === destination) {
      return absoluteSource;
    }

    if (
      kind === "directory" &&
      (normalizedRemotePath === destination || normalizedRemotePath.startsWith(`${destination}/`))
    ) {
      const relativeSuffix = normalizedRemotePath.slice(destination.length).replace(/^\/+/, "");
      const resolved = path.resolve(absoluteSource, relativeSuffix);
      if (resolved !== absoluteSource && !resolved.startsWith(`${absoluteSource}${path.sep}`)) {
        return null;
      }
      return resolved;
    }
  }

  return null;
}

function toRepositoryRelativePath(config: RunConfig, remoteRelativePath: string): string {
  return path.posix.join(config.repositorySubdir, normalizeRemoteRelativePath(remoteRelativePath));
}

function normalizeRemoteRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("..")) {
    throw new CliError(`sync destination '${value}' is invalid.`, 3);
  }
  return normalized;
}

function resolveWorkspacePath(rootDir: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(rootDir, candidate);
}

function normalizeLocalRelativePath(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).replace(/\\/g, "/");
}

function resolveSyncPathKind(absoluteSource: string, entry: SyncPathConfig): "file" | "directory" {
  if (entry.kind) {
    return entry.kind;
  }

  if (existsSync(absoluteSource)) {
    return statSync(absoluteSource).isDirectory() ? "directory" : "file";
  }

  return path.extname(entry.source) ? "file" : "directory";
}

function walkFiles(rootDir: string): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (isHiddenEntryName(entry.name)) {
      continue;
    }

    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(absolutePath));
      continue;
    }
    if (entry.isFile()) {
      results.push(absolutePath);
    }
  }

  return results;
}

// Directory-kind syncPaths (e.g. every committed profile's source: "."
// covering the whole rootDir) must not sweep up dotfiles/dot-directories —
// .DS_Store, AppleDouble resource-fork shadows (._*, which also start with
// "." so this one check covers them too), .git, editor swap dirs, etc. On
// macOS these are machine-local cruft that differs byte-for-byte between
// machines, producing spurious recurring inline-conflict-marker diffs on
// every run. A hidden entry is skipped entirely, including not descending
// into a hidden directory. Note this is mirrored in ./git-client.ts's own
// walkFiles (used to read back the remote's current tree during pull/push)
// so a hidden path already sitting in the remote is symmetrically never
// materialized locally either — keep both in sync if this rule changes.
function isHiddenEntryName(name: string): boolean {
  return name.startsWith(".");
}

module.exports = {
  collectLocalSyncFiles,
  filterOwnerScopedBaseMap,
  filterUnmappedBaseMap,
  mapRemotePathToLocalAbsolute,
  normalizeRemoteRelativePath,
  toRepositoryRelativePath
};
