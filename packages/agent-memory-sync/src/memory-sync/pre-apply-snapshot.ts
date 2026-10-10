// Rotating copies of a sync destination, taken immediately before a pull
// applies anything destructive to it.
//
// Origin: the memory-corpus wipe (agent-tasks cda5b12c). The pull deleted the local
// corpus from disk, the follow-up push published the deletion, and from that
// point the only surviving copy of those files was the remote's own history:
// recovery meant reading a bare repository's log. The guards in ./guards.ts
// make that sequence refuse instead of proceed, but a guard is a decision
// about what is plausible, and the one case it cannot help with is the
// deletion that really is intended and really is wrong. A copy of the tree
// that is about to change costs one directory and turns that case from an
// archaeology exercise into `restore --from-snapshot`.
//
// Not a backup system: generations are few (three by default) and local, and
// the remote's history remains the durable record. This covers the window
// between "this run is about to overwrite or delete files" and "the operator
// notices".
const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} = require("node:fs");
const path = require("node:path");
const { RestoreSourceNotFoundError } = require("../errors");

// How many generations per destination survive. Overridable per profile with
// the `snapshotGenerations` config key (src/config/loader.ts).
//
// Three, because the value of an older generation drops off sharply: a
// destructive apply an operator has not noticed within two further runs is
// one where the remote history is the better source anyway, and each
// generation is a full copy of the destination.
const DEFAULT_SNAPSHOT_GENERATIONS = 3;

interface SnapshotSource {
  remoteRelativePath: string;
  absolutePath: string;
}

interface SnapshotManifest {
  id: string;
  destination: string;
  createdAt: string;
  files: string[];
}

function snapshotsDir(stateDir: string): string {
  return path.join(stateDir, "snapshots");
}

function destinationDir(stateDir: string, destination: string): string {
  return path.join(snapshotsDir(stateDir), destination);
}

// Sorts chronologically as a string, which is what rotation and 'latest'
// rely on: a fixed-width UTC timestamp with the characters a path cannot
// carry portably (':' and '.') replaced, plus a counter.
//
// The counter, not a random suffix, is what makes two snapshots taken inside
// the same millisecond sort in the order they were taken rather than in an
// arbitrary one, which rotation would otherwise resolve by deleting the
// newer of the two. It counts only the ids already present for this same
// millisecond, so a clock that jumps cannot make it run away. The manifest
// carries the unmodified ISO timestamp.
function nextSnapshotId(stateDir: string, destination: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const prefix = `${stamp}-`;
  let counter = 0;
  for (const entry of listPreApplySnapshots(stateDir, destination)) {
    if (!entry.id.startsWith(prefix)) {
      continue;
    }
    const parsed = Number(entry.id.slice(prefix.length));
    if (Number.isInteger(parsed) && parsed >= counter) {
      counter = parsed + 1;
    }
  }

  return `${prefix}${String(counter).padStart(4, "0")}`;
}

function readManifest(dir: string): SnapshotManifest | null {
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<SnapshotManifest>;
    if (typeof parsed.id !== "string" || typeof parsed.destination !== "string") {
      return null;
    }
    return {
      id: parsed.id,
      destination: parsed.destination,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      files: Array.isArray(parsed.files) ? parsed.files : []
    };
  } catch {
    return null;
  }
}

// Every snapshot of `destination`, oldest first.
//
// A directory without a readable manifest is not a snapshot. That is what
// keeps a destination nested under another one ("logs" and "logs/archive"
// both being configured) from being listed as a generation of its parent:
// snapshots/logs/archive is a destination directory, not a snapshot
// directory, and carries no manifest.
function listPreApplySnapshots(
  stateDir: string,
  destination: string
): Array<{ id: string; dir: string; manifest: SnapshotManifest }> {
  const dir = destinationDir(stateDir, destination);
  if (!existsSync(dir)) {
    return [];
  }

  const found: Array<{ id: string; dir: string; manifest: SnapshotManifest }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const snapshotDir = path.join(dir, entry.name);
    const manifest = readManifest(snapshotDir);
    if (!manifest) {
      continue;
    }
    found.push({ id: entry.name, dir: snapshotDir, manifest });
  }

  return found.sort((left, right) => left.id.localeCompare(right.id));
}

// Copies the destination's current tree into a new generation and rotates the
// older ones away. `files` is what the caller already collected for this
// destination (absolute local path plus the remote-relative key the rest of
// the package identifies a file by), so this never walks the workspace on its
// own and never disagrees with the caller about what belongs to the
// destination.
//
// An empty `files` is still a snapshot: "this destination held nothing" is a
// fact worth being able to restore to. It is the caller that decides whether
// a snapshot is warranted at all (see pull.ts: only a plan that deletes or
// overwrites something triggers one).
function writePreApplySnapshot(input: {
  stateDir: string;
  destination: string;
  files: SnapshotSource[];
  generations?: number | null;
  now?: Date;
}): { id: string; dir: string; destination: string; files: string[] } {
  const now = input.now || new Date();
  const id = nextSnapshotId(input.stateDir, input.destination, now);
  const dir = path.join(destinationDir(input.stateDir, input.destination), id);
  const filesDir = path.join(dir, "files");
  mkdirSync(filesDir, { recursive: true });

  const stored: string[] = [];
  try {
    for (const file of input.files) {
      if (!existsSync(file.absolutePath)) {
        continue;
      }
      const target = path.join(filesDir, file.remoteRelativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      // A byte copy, not a read-then-write: a snapshot that re-encoded the
      // bytes on the way in would not be the tree it claims to be.
      copyFileSync(file.absolutePath, target);
      stored.push(file.remoteRelativePath);
    }

    const manifest: SnapshotManifest = {
      id,
      destination: input.destination,
      createdAt: now.toISOString(),
      files: stored.sort()
    };
    writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    // A generation without a manifest is not listed, so nothing would ever
    // rotate it away; take the half-written directory with the failure.
    // Rotation still sweeps one a crash left behind (see rotate).
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  rotate(input.stateDir, input.destination, resolveGenerations(input.generations), id);

  return { id, dir, destination: input.destination, files: stored };
}

function resolveGenerations(value?: number | null): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : DEFAULT_SNAPSHOT_GENERATIONS;
}

// Drops the oldest generations beyond `generations`, never the one named by
// `pinnedId`. Ids rank by timestamp, so after a clock that ran ahead the id a
// correct clock produces now can rank below every older generation, and a
// plain "newest N by id" rule would delete the snapshot the current run has
// just written - the one copy a caller is about to rely on. The pinned
// generation counts toward `generations`; the oldest OTHER ones make room.
//
// It also removes a generation directory that never got a manifest (a
// snapshot write that died partway, or a crash between the file copies and the
// manifest), but only when it is older than the newest complete generation:
// a directory that sorts after every complete one may belong to a write still
// in flight. Only a directory named like a generation id counts, because a
// destination nested under another one ("logs/archive" under "logs") also
// appears as a manifest-less directory in its parent's listing.
function rotate(stateDir: string, destination: string, generations: number, pinnedId: string): void {
  removeStaleIncompleteGenerations(stateDir, destination);
  const others = listPreApplySnapshots(stateDir, destination).filter((entry) => entry.id !== pinnedId);
  const keepOthers = Math.max(0, generations - 1);
  for (const entry of others.slice(0, Math.max(0, others.length - keepOthers))) {
    rmSync(entry.dir, { recursive: true, force: true });
  }
}

const GENERATION_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{4,}$/;

function removeStaleIncompleteGenerations(stateDir: string, destination: string): void {
  const dir = destinationDir(stateDir, destination);
  if (!existsSync(dir)) {
    return;
  }
  const complete = listPreApplySnapshots(stateDir, destination);
  if (complete.length === 0) {
    return;
  }
  const newestComplete = complete[complete.length - 1].id;
  const completeIds = new Set(complete.map((entry) => entry.id));
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      !completeIds.has(entry.name) &&
      GENERATION_ID_PATTERN.test(entry.name) &&
      entry.name.localeCompare(newestComplete) < 0
    ) {
      rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    }
  }
}

// Whether generation `id` of `destination` exists with a readable manifest and
// every file it lists (plus every file in `expectedFiles`) present on disk.
// Returns the first problem found, or null when the generation is intact. A
// caller that is about to delete the originals checks this after the write
// and after rotation, so a generation that vanished for any reason stops the
// deletion instead of leaving a file with no surviving copy.
function findPreApplySnapshotProblem(
  stateDir: string,
  destination: string,
  id: string,
  expectedFiles: string[] = []
): string | null {
  const entry = listPreApplySnapshots(stateDir, destination).find((candidate) => candidate.id === id);
  if (!entry) {
    return `generation ${id} of destination '${destination}' no longer exists under '${destinationDir(stateDir, destination)}'`;
  }

  const listed = new Set<string>([...entry.manifest.files, ...expectedFiles]);
  for (const remoteRelativePath of Array.from(listed).sort()) {
    if (!entry.manifest.files.includes(remoteRelativePath)) {
      return `generation ${id} does not list ${remoteRelativePath}`;
    }
    if (!existsSync(path.join(entry.dir, "files", remoteRelativePath))) {
      return `generation ${id} is missing its copy of ${remoteRelativePath}`;
    }
  }

  return null;
}

// True when something is at the path, a dangling symlink included: writing a
// file over a dangling symlink writes through it, so it is not "nothing there".
function pathExistsOnDisk(absolutePath: string): boolean {
  try {
    lstatSync(absolutePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

// The first path a run is about to create, overwrite or remove that exists on
// disk but is not among the files it collected (and so is in no snapshot): a
// symlink, a directory, a case-only or Unicode-normalization alias of another
// file, or a file created after the collection. Returns its remote-relative
// path, or null when every path the run touches that exists is collected.
//
// Run before any snapshot is written. The cause is persistent, so a stop found
// only at the read-back after the snapshot would write one more generation per
// retry and rotate an older one away each time.
function findUncollectedPlanPath(
  plan: Array<{ remoteRelativePath: string; localAbsolutePath: string }>,
  localFiles: Array<{ remoteRelativePath: string }>
): string | null {
  const collected = new Set<string>(localFiles.map((file) => file.remoteRelativePath));
  for (const entry of plan) {
    if (pathExistsOnDisk(entry.localAbsolutePath) && !collected.has(entry.remoteRelativePath)) {
      return entry.remoteRelativePath;
    }
  }

  return null;
}

// Reads one generation back. `id` may be "latest", which is how an operator
// names the one they almost always want: the copy taken by the run that just
// surprised them.
function readPreApplySnapshot(
  stateDir: string,
  destination: string,
  id: string
): { id: string; dir: string; createdAt: string; files: Array<{ remoteRelativePath: string; storedPath: string }> } {
  const available = listPreApplySnapshots(stateDir, destination);
  const selected = id === "latest" ? available[available.length - 1] : available.find((entry) => entry.id === id);

  if (!selected) {
    throw new RestoreSourceNotFoundError(
      `no snapshot ${id === "latest" ? "" : `'${id}' `}for destination '${destination}' under ` +
        `'${destinationDir(stateDir, destination)}'.` +
        (available.length > 0
          ? ` Available: ${available.map((entry) => entry.id).join(", ")}.`
          : " Nothing has been snapshotted for this destination yet.")
    );
  }

  return {
    id: selected.id,
    dir: selected.dir,
    createdAt: selected.manifest.createdAt,
    files: selected.manifest.files.map((remoteRelativePath) => ({
      remoteRelativePath,
      storedPath: path.join(selected.dir, "files", remoteRelativePath)
    }))
  };
}

module.exports = {
  DEFAULT_SNAPSHOT_GENERATIONS,
  findPreApplySnapshotProblem,
  findUncollectedPlanPath,
  listPreApplySnapshots,
  pathExistsOnDisk,
  readPreApplySnapshot,
  snapshotsDir,
  writePreApplySnapshot
};
