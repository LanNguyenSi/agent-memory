// Exact texts of the snapshot sentence in the exit-13 message
// (describePartialApplySnapshot in src/memory-sync/pull.ts): it points at a
// snapshot only for applied paths that had previous content.
const test = require("node:test");
const assert = require("node:assert/strict");
const { describePartialApplySnapshot } = require("../../src/memory-sync/pull");

const base = {
  failingPath: "notes/new.md",
  failingIsCreate: true,
  snapshots: [{ destination: "notes", id: "20260101T000000Z" }],
  stateDir: "/state",
  profile: "default"
};
const location = "(path /state/snapshots/<destination>/<id>; restore default <destination> --from-snapshot <id>). ";
const created =
  "notes/new.md was being created, so no snapshot holds a previous copy of it, and it may be partially written. ";

test("exit 13 snapshot sentence: empty applied list names no snapshot content", () => {
  const result = describePartialApplySnapshot({ ...base, appliedWithPreviousContent: [] });
  assert.equal(result.sentence, created);
  assert.equal(result.copyAside, false);
});

test("exit 13 snapshot sentence: creates-only applied list names no snapshot content", () => {
  // Applied creates never enter appliedWithPreviousContent, so the list is empty.
  const result = describePartialApplySnapshot({ ...base, appliedWithPreviousContent: [] });
  assert.equal(result.sentence, created);
  assert.doesNotMatch(result.sentence, /The previous content of/);
});

test("exit 13 snapshot sentence: mixed list names only the overwritten and removed paths", () => {
  const result = describePartialApplySnapshot({
    ...base,
    appliedWithPreviousContent: ["notes/a.md", "notes/b.md"]
  });
  assert.equal(
    result.sentence,
    `The previous content of notes/a.md, notes/b.md is in the pre-apply snapshot 'notes' 20260101T000000Z ${location}${created}`
  );
  assert.equal(result.copyAside, true);
});

test("exit 13 snapshot sentence: a failing overwrite names its own previous content", () => {
  const result = describePartialApplySnapshot({
    ...base,
    failingIsCreate: false,
    appliedWithPreviousContent: []
  });
  assert.equal(
    result.sentence,
    `The previous content of notes/new.md itself, which may be partially written, is in the pre-apply snapshot 'notes' 20260101T000000Z ${location}`
  );
});

test("exit 13 snapshot sentence: no snapshot written", () => {
  const result = describePartialApplySnapshot({ ...base, snapshots: [], appliedWithPreviousContent: [] });
  assert.equal(result.sentence, "No snapshot was needed because only new files were created. ");
});
