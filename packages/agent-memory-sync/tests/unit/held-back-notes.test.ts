// Unit coverage for the adopted-path wording of heldBackNotes
// (src/memory-sync/push.ts): which cause a note states depends on whether the
// adoption deleted a local copy and whether a snapshot still holds it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { heldBackNotes } = require("../../src/memory-sync/push");

function config() {
  const root = path.join(
    tmpdir(),
    `agent-memory-sync-held-back-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  mkdirSync(root, { recursive: true });
  return {
    stateDir: path.join(root, "state"),
    rootDir: path.join(root, "workspace"),
    repositorySubdir: "shared",
    profile: "unit",
    syncPaths: [{ source: path.join(root, "workspace", "notes"), destination: "notes", kind: "directory" }]
  };
}

const held = [{ path: "notes/T0.md", kind: "local-deletion" }];

test("a path with no local copy when the adoption ran states that cause and that nothing needs doing", () => {
  const [note] = heldBackNotes(config(), held, {
    adoptedPaths: ["notes/T0.md"],
    deletedPaths: [],
    snapshotIds: [],
    dryRun: false
  });

  assert.ok(note.includes("no local copy when the adoption ran"), note);
  assert.ok(note.includes("holds no copy of notes/T0.md"), note);
  assert.ok(
    note.endsWith(
      "The queued edit is not stored anywhere else, and the local deletion already matches the hub, so no action is needed"
    ),
    note
  );
});

test("a path the adoption deleted whose snapshot copy is missing does not claim it had no local copy", () => {
  const [note] = heldBackNotes(config(), held, {
    adoptedPaths: ["notes/T0.md"],
    deletedPaths: ["notes/T0.md"],
    snapshotIds: ["2026-01-01T00-00-00-000Z-0000"],
    dryRun: false
  });

  assert.ok(note.includes("had a local copy when the adoption ran"), note);
  assert.ok(note.includes("snapshot copy of notes/T0.md is missing"), note);
  assert.equal(note.includes("no local copy when the adoption ran"), false, note);
  assert.equal(note.includes("no action is needed"), false, note);
  assert.equal(note.includes("copy that one file"), false, note);
  assert.equal(note.includes("<id>"), false, note);
});
