// Unit coverage for StateStore.oldestQueuedSnapshotAgeMs — the mechanism
// push.ts's checkQueueEscalation (src/memory-sync/push.ts) uses to detect a
// permanently unreachable/misconfigured remote (agent-tasks 11424b5e,
// reviewer findings from 1b63070d): the OLDEST queued snapshot's
// manifest.json `createdAt` (already written by enqueueSnapshot on every
// enqueue) is read back and compared against a threshold, with no new
// persisted state. See tests/integration/remote-unreachable-escalation.test.ts
// for the end-to-end behavior through `run`/`watch`.

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { StateStore } = require("../../src/memory-sync/state-store");

function sandbox(name: string): string {
  const root = path.join(
    tmpdir(),
    `agent-memory-sync-state-store-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  mkdirSync(root, { recursive: true });
  return root;
}

test("oldestQueuedSnapshotAgeMs: returns null when the queue is empty", () => {
  const store = new StateStore(sandbox("empty"), "default");
  assert.equal(store.oldestQueuedSnapshotAgeMs(), null);
});

test("oldestQueuedSnapshotAgeMs: computes age from a single queued snapshot's manifest.json createdAt", () => {
  const store = new StateStore(sandbox("single"), "default");
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  store.enqueueSnapshot({ localFiles: { "a.md": "one" }, baseFiles: {} });

  // Backdate the manifest this test just wrote, exactly like the
  // integration test does — no real waiting required.
  const [id] = readdirSync(store.queueDir());
  const manifestPath = path.join(store.queueDir(), id, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, createdAt: createdAt.toISOString() }, null, 2));

  const referenceTime = createdAt.getTime() + 5000;
  assert.equal(store.oldestQueuedSnapshotAgeMs(referenceTime), 5000);
});

test("oldestQueuedSnapshotAgeMs: reports the OLDEST of several queued snapshots, not the newest", () => {
  const store = new StateStore(sandbox("multiple"), "default");
  const older = new Date("2026-01-01T00:00:00.000Z");
  const newer = new Date("2026-01-02T00:00:00.000Z");

  store.enqueueSnapshot({ localFiles: { "a.md": "one" }, baseFiles: {} });
  store.enqueueSnapshot({ localFiles: { "b.md": "two" }, baseFiles: {} });

  const ids = readdirSync(store.queueDir()).sort();
  const timestamps = [older, newer];
  ids.forEach((id: string, index: number) => {
    const manifestPath = path.join(store.queueDir(), id, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, createdAt: timestamps[index].toISOString() }, null, 2)
    );
  });

  const referenceTime = newer.getTime();
  assert.equal(store.oldestQueuedSnapshotAgeMs(referenceTime), newer.getTime() - older.getTime());
});

test("oldestQueuedSnapshotAgeMs: a queued directory with a missing/corrupt manifest.json is ignored, not treated as infinitely old", () => {
  const store = new StateStore(sandbox("corrupt"), "default");
  store.ensure();
  mkdirSync(path.join(store.queueDir(), "not-a-real-snapshot"), { recursive: true });
  // No manifest.json written at all inside it.

  assert.equal(store.oldestQueuedSnapshotAgeMs(), null);
});

// Reviewer-named test (agent-tasks 11424b5e fix round, LOW finding #7): pins
// the other half of the one-way-bias trade-off documented above
// oldestQueuedSnapshotAgeMs — a corrupt manifest must not suppress
// escalation as long as at least one genuinely old manifest survives
// intact. Without this, a naive implementation that defaulted a corrupt
// manifest's timestamp to "now" instead of excluding it would drag the
// MIN() toward the present and hide a real stuck queue.
test("oldestQueuedSnapshotAgeMs: a mix of some corrupt manifests and one older valid manifest still reports the valid one's age, not null", () => {
  const store = new StateStore(sandbox("mixed-corrupt"), "default");
  const older = new Date("2026-01-01T00:00:00.000Z");

  const survivingId = store.enqueueSnapshot({ localFiles: { "a.md": "one" }, baseFiles: {} });
  const corruptId = store.enqueueSnapshot({ localFiles: { "b.md": "two" }, baseFiles: {} });

  const survivingManifestPath = path.join(store.queueDir(), survivingId, "manifest.json");
  const survivingManifest = JSON.parse(readFileSync(survivingManifestPath, "utf8"));
  writeFileSync(
    survivingManifestPath,
    JSON.stringify({ ...survivingManifest, createdAt: older.toISOString() }, null, 2)
  );

  const corruptManifestPath = path.join(store.queueDir(), corruptId, "manifest.json");
  writeFileSync(corruptManifestPath, "{ not valid json");

  const referenceTime = older.getTime() + 5000;
  assert.equal(store.oldestQueuedSnapshotAgeMs(referenceTime), 5000);
});

test("oldestQueuedSnapshotAgeMs: clears back to null after removeQueuedSnapshot empties the queue", () => {
  const store = new StateStore(sandbox("cleared"), "default");
  const id = store.enqueueSnapshot({ localFiles: { "a.md": "one" }, baseFiles: {} });
  assert.notEqual(store.oldestQueuedSnapshotAgeMs(), null);

  store.removeQueuedSnapshot(id);
  assert.equal(store.oldestQueuedSnapshotAgeMs(), null);
});
