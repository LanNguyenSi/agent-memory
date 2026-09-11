// Rotating copies of a sync destination, taken immediately before a pull
// applies anything destructive to it.
//
// Origin: the 2026-09-11 memory-corpus wipe (agent-tasks cda5b12c, pandora
// run .ai/runs/2026-09-11-memory-sync-wipe). The pull deleted the local
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
const { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
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

  rotate(input.stateDir, input.destination, resolveGenerations(input.generations));

  return { id, dir, destination: input.destination, files: stored };
}

function resolveGenerations(value?: number | null): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_SNAPSHOT_GENERATIONS;
}

function rotate(stateDir: string, destination: string, generations: number): void {
  const existing = listPreApplySnapshots(stateDir, destination);
  for (const entry of existing.slice(0, Math.max(0, existing.length - generations))) {
    rmSync(entry.dir, { recursive: true, force: true });
  }
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
  const selected =
    id === "latest" ? available[available.length - 1] : available.find((entry) => entry.id === id);

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
  listPreApplySnapshots,
  readPreApplySnapshot,
  snapshotsDir,
  writePreApplySnapshot
};
