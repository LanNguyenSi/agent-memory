// Unit coverage for the pre-apply snapshots (src/memory-sync/pre-apply-snapshot.ts).
//
// Origin: the 2026-09-11 memory-corpus wipe (agent-tasks cda5b12c, pandora
// run .ai/runs/2026-09-11-memory-sync-wipe). The local corpus was removed
// from disk before anything had a copy of it, and the only surviving copy
// was the remote's own history. A pull that is about to delete or overwrite
// files in a destination now copies that destination first.
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  DEFAULT_SNAPSHOT_GENERATIONS,
  listPreApplySnapshots,
  readPreApplySnapshot,
  snapshotsDir,
  writePreApplySnapshot
} = require("../../src/memory-sync/pre-apply-snapshot");

function sandbox(name: string): string {
  const root = path.join(
    tmpdir(),
    `agent-memory-sync-pre-apply-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  mkdirSync(root, { recursive: true });
  return root;
}

function seedTree(workspaceRoot: string, count: number): Array<{ remoteRelativePath: string; absolutePath: string }> {
  const files: Array<{ remoteRelativePath: string; absolutePath: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const absolutePath = path.join(workspaceRoot, "logs", `note-${index}.md`);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, `entry ${index}\n`, "utf8");
    files.push({ remoteRelativePath: `logs/note-${index}.md`, absolutePath });
  }
  return files;
}

test("the documented default keeps three generations", () => {
  assert.equal(DEFAULT_SNAPSHOT_GENERATIONS, 3);
});

test("a snapshot copies the destination's current tree byte for byte", () => {
  const root = sandbox("bytes");
  const stateDir = path.join(root, "state");
  const files = seedTree(root, 3);
  // Bytes that a text-mode round trip would change if anything re-encoded
  // them on the way in or out.
  writeFileSync(files[0].absolutePath, "umlauts: äöü\r\nno trailing newline", "utf8");

  const snapshot = writePreApplySnapshot({ stateDir, destination: "logs", files });

  assert.ok(snapshot);
  assert.equal(snapshot.destination, "logs");
  assert.equal(snapshot.files.length, 3);
  for (const file of files) {
    const stored = path.join(snapshot.dir, "files", file.remoteRelativePath);
    assert.equal(readFileSync(stored, "utf8"), readFileSync(file.absolutePath, "utf8"));
  }

  const manifest = JSON.parse(readFileSync(path.join(snapshot.dir, "manifest.json"), "utf8"));
  assert.equal(manifest.destination, "logs");
  assert.deepEqual(manifest.files.sort(), files.map((f) => f.remoteRelativePath).sort());
  assert.ok(Number.isFinite(Date.parse(manifest.createdAt)), `createdAt is not an ISO timestamp: ${manifest.createdAt}`);
});

test("snapshots live under stateDir/snapshots/<destination> and are listed newest last", () => {
  const root = sandbox("listing");
  const stateDir = path.join(root, "state");
  const files = seedTree(root, 2);

  const first = writePreApplySnapshot({ stateDir, destination: "logs", files });
  const second = writePreApplySnapshot({ stateDir, destination: "logs", files });

  assert.equal(path.dirname(first.dir), path.join(snapshotsDir(stateDir), "logs"));
  const listed = listPreApplySnapshots(stateDir, "logs").map((entry: { id: string }) => entry.id);
  assert.deepEqual(listed, [first.id, second.id].sort());
  assert.equal(listed[listed.length - 1], second.id);
});

test("rotation keeps only the configured number of generations", () => {
  const root = sandbox("rotation");
  const stateDir = path.join(root, "state");
  const files = seedTree(root, 1);

  const written: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    written.push(writePreApplySnapshot({ stateDir, destination: "logs", files, generations: 2 }).id);
  }

  const kept = listPreApplySnapshots(stateDir, "logs").map((entry: { id: string }) => entry.id);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept, written.slice(-2));
});

test("a destination nested under another is not mistaken for a snapshot of it", () => {
  const root = sandbox("nested");
  const stateDir = path.join(root, "state");
  const files = seedTree(root, 1);

  const outer = writePreApplySnapshot({ stateDir, destination: "logs", files });
  writePreApplySnapshot({ stateDir, destination: "logs/archive", files });

  assert.deepEqual(
    listPreApplySnapshots(stateDir, "logs").map((entry: { id: string }) => entry.id),
    [outer.id]
  );
});

test("a snapshot of an empty destination is still a record of what was there", () => {
  const root = sandbox("empty");
  const stateDir = path.join(root, "state");

  const snapshot = writePreApplySnapshot({ stateDir, destination: "logs", files: [] });
  assert.equal(snapshot.files.length, 0);
  assert.equal(existsSync(path.join(snapshot.dir, "manifest.json")), true);
});

test("a stored snapshot reads back as the paths and bytes it captured", () => {
  const root = sandbox("read-back");
  const stateDir = path.join(root, "state");
  const files = seedTree(root, 2);

  const written = writePreApplySnapshot({ stateDir, destination: "logs", files });
  const readBack = readPreApplySnapshot(stateDir, "logs", written.id);

  assert.equal(readBack.id, written.id);
  assert.deepEqual(
    readBack.files.map((f: { remoteRelativePath: string }) => f.remoteRelativePath).sort(),
    ["logs/note-0.md", "logs/note-1.md"]
  );
  for (const file of readBack.files) {
    assert.equal(readFileSync(file.storedPath, "utf8"), `entry ${file.remoteRelativePath.slice(-4, -3)}\n`);
  }
});

test("'latest' resolves to the newest snapshot of a destination", () => {
  const root = sandbox("latest");
  const stateDir = path.join(root, "state");
  const files = seedTree(root, 1);

  writePreApplySnapshot({ stateDir, destination: "logs", files });
  const newest = writePreApplySnapshot({ stateDir, destination: "logs", files });

  assert.equal(readPreApplySnapshot(stateDir, "logs", "latest").id, newest.id);
});

test("reading a snapshot that does not exist fails loudly", () => {
  const root = sandbox("missing");
  const stateDir = path.join(root, "state");

  assert.throws(
    () => readPreApplySnapshot(stateDir, "logs", "latest"),
    (error: Error & { exitCode?: number }) => {
      assert.equal(error.exitCode, 5);
      assert.match(error.message, /no snapshot/);
      return true;
    }
  );
  // A read creates nothing, not even the directory it looked in.
  assert.deepEqual(readdirSync(root), []);
});
