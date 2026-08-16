// Unit tests for summarizeOperation, the text-output renderer used by
// `run`'s default `--output text` mode (src/commands/run.ts: `writeResult(
// payload, runConfig.outputFormat, () => runs.map(summarizeOperation).join(
// "\n"))`). No existing test exercises text output for `run` (every
// integration test passes `--output json`), so this function was
// effectively untested — this file drives it directly with representative
// operation shapes instead of spawning a CLI process just to reach text
// mode.
//
// Each optional section (deletedFiles, skippedFiles, queuedSnapshotId,
// notes) is tested both present and absent/empty, since summarizeOperation
// only appends its segment when the field is truthy and non-empty.

const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeOperation } = require("../../src/memory-sync/preview");

function baseOperation(overrides: Record<string, unknown> = {}) {
  return {
    kind: "push",
    appliedFiles: ["MEMORY.md"],
    mergedFiles: [],
    conflictFiles: [],
    ...overrides
  };
}

test("summarizeOperation: minimal operation renders only the required counters", () => {
  const summary = summarizeOperation(baseOperation());
  assert.equal(summary, "operation=push applied=1 merged=0 conflicts=0");
});

test("summarizeOperation: counts reflect each array's length, not its content", () => {
  const summary = summarizeOperation(
    baseOperation({
      kind: "pull",
      appliedFiles: ["a.md", "b.md"],
      mergedFiles: ["a.md"],
      conflictFiles: ["b.md", "c.md", "d.md"]
    })
  );
  assert.equal(summary, "operation=pull applied=2 merged=1 conflicts=3");
});

test("summarizeOperation: a non-empty deletedFiles array appends a deleted= segment", () => {
  const summary = summarizeOperation(baseOperation({ deletedFiles: ["old.md", "older.md"] }));
  assert.equal(summary, "operation=push applied=1 merged=0 conflicts=0 deleted=2");
});

test("summarizeOperation: an empty deletedFiles array omits the deleted= segment", () => {
  const summary = summarizeOperation(baseOperation({ deletedFiles: [] }));
  assert.equal(summary, "operation=push applied=1 merged=0 conflicts=0");
});

test("summarizeOperation: a non-empty skippedFiles array appends a skipped= segment", () => {
  const summary = summarizeOperation(baseOperation({ skippedFiles: ["orphan.md"] }));
  assert.equal(summary, "operation=push applied=1 merged=0 conflicts=0 skipped=1");
});

test("summarizeOperation: an empty skippedFiles array omits the skipped= segment", () => {
  const summary = summarizeOperation(baseOperation({ skippedFiles: [] }));
  assert.equal(summary, "operation=push applied=1 merged=0 conflicts=0");
});

test("summarizeOperation: a truthy queuedSnapshotId appends a queued= segment", () => {
  const summary = summarizeOperation(baseOperation({ queuedSnapshotId: "1755300000-abcd1234" }));
  assert.equal(summary, "operation=push applied=1 merged=0 conflicts=0 queued=1755300000-abcd1234");
});

test("summarizeOperation: a null queuedSnapshotId omits the queued= segment", () => {
  const summary = summarizeOperation(baseOperation({ queuedSnapshotId: null }));
  assert.equal(summary, "operation=push applied=1 merged=0 conflicts=0");
});

test("summarizeOperation: a non-empty notes array is joined with '; ' and appended as notes=", () => {
  const summary = summarizeOperation(
    baseOperation({ notes: ["remote unreachable; queued", "clock skew detected"] })
  );
  assert.equal(
    summary,
    "operation=push applied=1 merged=0 conflicts=0 notes=remote unreachable; queued; clock skew detected"
  );
});

test("summarizeOperation: an empty notes array omits the notes= segment", () => {
  const summary = summarizeOperation(baseOperation({ notes: [] }));
  assert.equal(summary, "operation=push applied=1 merged=0 conflicts=0");
});

test("summarizeOperation: all optional segments combined appear in declaration order", () => {
  const summary = summarizeOperation(
    baseOperation({
      kind: "sync",
      deletedFiles: ["gone.md"],
      skippedFiles: ["orphan.md"],
      queuedSnapshotId: "snap-1",
      notes: ["replayed 1 queued snapshot(s)"]
    })
  );
  assert.equal(
    summary,
    "operation=sync applied=1 merged=0 conflicts=0 deleted=1 skipped=1 queued=snap-1 notes=replayed 1 queued snapshot(s)"
  );
});
