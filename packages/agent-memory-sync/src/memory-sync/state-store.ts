const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } = require("node:fs");
const path = require("node:path");

// Default escalation threshold for StateStore.oldestQueuedSnapshotAgeMs
// consumers (see push.ts's checkQueueEscalation): how long the queue may
// keep failing to drain before a tick that would otherwise be a clean,
// silent "queued" outcome instead crashes loud. 24h, derived from this
// package's own committed launchd/systemd periodic-sync tick interval — 900s
// (docs/launchd/com.agent-memory-sync.sync.plist.template's StartInterval)
// and the equivalent systemd OnUnitActiveSec=15min
// (docs/machine-setup.md section (c)) — 24h is 96 consecutive missed ticks
// at that cadence, comfortably longer than the "MacBook closed overnight"
// steady state both templates are written to tolerate silently, while still
// bounding how long a genuinely broken remote (wrong remoteUrl, a renamed
// repository path, a host that accepts a connection but cannot serve the
// repository) can hide before an operator is guaranteed to see it within a
// day. See push.ts's checkQueueEscalation and errors.ts's
// RemoteQueueEscalationError for how this value is consumed.
const DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS = 24 * 60 * 60 * 1000;

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

  // Age, in milliseconds, of the OLDEST currently-queued snapshot — derived
  // entirely from each snapshot's manifest.json `createdAt` (already written
  // by enqueueSnapshot above on every enqueue), so this needs no new
  // persisted state. Returns null when the queue is empty (nothing to
  // escalate) or when every manifest is missing/unparsable (defensive: a
  // corrupt manifest must not be treated as "infinitely old" and force a
  // spurious escalation).
  //
  // Why this reflects "how long has the remote been continuously
  // unreachable" rather than just "how long has the oldest single snapshot
  // sat here": a successful push clears every queued snapshot in one shot
  // (see the `removeQueuedSnapshot` loop in performPush,
  // src/memory-sync/push.ts, run only after `gitClient.push` succeeds) — so
  // the oldest surviving snapshot's age is exactly the time since the FIRST
  // tick that failed to reach the remote in the current unbroken failure
  // streak; it resets to null the moment a push actually succeeds. See
  // push.ts's checkQueueEscalation for how this is used.
  oldestQueuedSnapshotAgeMs(referenceTime: number = Date.now()): number | null {
    this.ensure();
    const createdTimestamps = readdirSync(this.queueDir(), { withFileTypes: true })
      .filter((entry: { isDirectory: () => boolean }) => entry.isDirectory())
      .map((entry: { name: string }) => {
        const manifestPath = path.join(this.queueDir(), entry.name, "manifest.json");
        if (!existsSync(manifestPath)) {
          return null;
        }
        let manifest: { createdAt?: string };
        try {
          manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        } catch {
          return null;
        }
        const parsed = manifest.createdAt ? Date.parse(manifest.createdAt) : NaN;
        return Number.isFinite(parsed) ? parsed : null;
      })
      .filter((value: number | null): value is number => value !== null);

    if (createdTimestamps.length === 0) {
      return null;
    }

    return Math.max(0, referenceTime - Math.min(...createdTimestamps));
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
  StateStore,
  DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS
};
