const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } = require("node:fs");
const path = require("node:path");

interface SyncState {
  version: number;
  profile: string;
  lastRemoteHead: string | null;
  lastRunAt: string | null;
}

interface SnapshotData {
  localFiles: Record<string, string>;
  baseFiles: Record<string, string | null>;
}

class StateStore {
  rootDir: string;
  profile: string;

  constructor(rootDir: string, profile: string) {
    this.rootDir = rootDir;
    this.profile = profile;
  }

  ensure(): void {
    mkdirSync(this.rootDir, { recursive: true });
    mkdirSync(this.baseDir(), { recursive: true });
    mkdirSync(this.queueDir(), { recursive: true });
    mkdirSync(this.tempDir(), { recursive: true });
  }

  loadState(): SyncState {
    this.ensure();
    if (!existsSync(this.stateFile())) {
      return {
        version: 1,
        profile: this.profile,
        lastRemoteHead: null,
        lastRunAt: null
      };
    }

    return JSON.parse(readFileSync(this.stateFile(), "utf8")) as SyncState;
  }

  saveState(state: SyncState): void {
    this.ensure();
    writeFileSync(this.stateFile(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  readBaseSnapshots(): Record<string, string | null> {
    this.ensure();
    return readSnapshotTree(this.baseDir());
  }

  replaceBaseSnapshots(files: Record<string, string | null>): void {
    rmSync(this.baseDir(), { recursive: true, force: true });
    mkdirSync(this.baseDir(), { recursive: true });
    writeSnapshotTree(this.baseDir(), files);
  }

  enqueueSnapshot(snapshot: SnapshotData): string {
    this.ensure();
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const snapshotRoot = path.join(this.queueDir(), id);
    mkdirSync(snapshotRoot, { recursive: true });
    writeSnapshotTree(path.join(snapshotRoot, "local"), snapshot.localFiles);
    writeSnapshotTree(path.join(snapshotRoot, "base"), snapshot.baseFiles);
    writeFileSync(
      path.join(snapshotRoot, "manifest.json"),
      `${JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );
    return id;
  }

  listQueuedSnapshots(): Array<{ id: string; data: SnapshotData }> {
    this.ensure();
    return readdirSync(this.queueDir(), { withFileTypes: true })
      .filter((entry: { isDirectory: () => boolean }) => entry.isDirectory())
      .map((entry: { name: string }) => ({
        id: entry.name,
        data: {
          localFiles: readSnapshotTree(path.join(this.queueDir(), entry.name, "local")),
          baseFiles: readSnapshotTree(path.join(this.queueDir(), entry.name, "base"))
        }
      }))
      .sort(
        (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)
      );
  }

  removeQueuedSnapshot(id: string): void {
    rmSync(path.join(this.queueDir(), id), { recursive: true, force: true });
  }

  clearTemp(): void {
    rmSync(this.tempDir(), { recursive: true, force: true });
    mkdirSync(this.tempDir(), { recursive: true });
  }

  tempDir(): string {
    return path.join(this.rootDir, "tmp");
  }

  baseDir(): string {
    return path.join(this.rootDir, "base");
  }

  queueDir(): string {
    return path.join(this.rootDir, "queue");
  }

  stateFile(): string {
    return path.join(this.rootDir, "state.json");
  }
}

function writeSnapshotTree(rootDir: string, files: Record<string, string | null>): void {
  mkdirSync(rootDir, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const markerPath = path.join(rootDir, `${relativePath}.meta.json`);
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      `${JSON.stringify({ deleted: content === null }, null, 2)}\n`,
      "utf8"
    );

    if (content === null) {
      continue;
    }

    const absolutePath = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }
}

function readSnapshotTree(rootDir: string): Record<string, string | null> {
  if (!existsSync(rootDir)) {
    return {};
  }

  const result: Record<string, string | null> = {};

  for (const filePath of walkFiles(rootDir)) {
    if (filePath.endsWith(".meta.json")) {
      const relative = path.relative(rootDir, filePath).replace(/\\/g, "/");
      const key = relative.replace(/\.meta\.json$/, "");
      const metadata = JSON.parse(readFileSync(filePath, "utf8")) as { deleted: boolean };
      if (metadata.deleted) {
        result[key] = null;
      }
      continue;
    }

    const relative = path.relative(rootDir, filePath).replace(/\\/g, "/");
    result[relative] = readFileSync(filePath, "utf8");
  }

  return result;
}

function walkFiles(rootDir: string): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
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

module.exports = {
  StateStore
};
