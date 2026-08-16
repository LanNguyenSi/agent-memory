// Unit tests for buildCommitMessage, the human-readable per-tick commit
// message formatter used by `watch` (src/commands/watch.ts:
// `buildCommitMessage(changedFiles, deletedFiles)`). Only reached
// indirectly through watch integration tests, which never asserted on the
// message text itself, so the "empty"/"single-delete"/"multi-file bullets"
// branches were unexercised. Tested directly here instead.

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCommitMessage } = require("../../src/memory-sync/snapshot");

test("buildCommitMessage: no changed or deleted files renders a noop message", () => {
  assert.equal(buildCommitMessage([], []), "snapshot: noop");
});

test("buildCommitMessage: a single changed (non-deleted) file renders 'update <file>'", () => {
  assert.equal(buildCommitMessage(["MEMORY.md"], []), "update MEMORY.md");
});

test("buildCommitMessage: a single deleted file renders 'remove <file>'", () => {
  assert.equal(buildCommitMessage(["old.md"], ["old.md"]), "remove old.md");
});

test("buildCommitMessage: multiple files render a bulleted, sorted 'update N memories' summary distinguishing updates from removals", () => {
  const message = buildCommitMessage(["b.md", "a.md"], ["c.md"]);
  assert.equal(
    message,
    "update 3 memories\n\n- update a.md\n- update b.md\n- remove c.md"
  );
});

test("buildCommitMessage: a file present in both changedFiles and deletedFiles is deduplicated and marked as removed", () => {
  const message = buildCommitMessage(["dup.md", "other.md"], ["dup.md"]);
  assert.equal(message, "update 2 memories\n\n- remove dup.md\n- update other.md");
});
