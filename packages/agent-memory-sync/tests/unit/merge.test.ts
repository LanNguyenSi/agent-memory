// Unit coverage for mergeText's marker-honesty guard (Teil 1, agent-tasks
// 06d09cde / .ai/runs/2026-08-03-sync-conflict-markers-echo).
//
// Root defect: both fast paths (`local === base` -> remote wins,
// `remote === base` -> local wins) and the appendOnly merge success path
// unconditionally returned `conflict: false`, even when the winning content
// itself already carried inline conflict markers left over from an earlier
// pass (e.g. a genuine conflict on `pull` writes `<<<<<<< local` /
// `=======` / `>>>>>>> remote` to the local file, then the very next `push`
// in the same sync sees `remote === base` and silently re-labels that
// marker-carrying local content as a clean "local wins" with conflicts=0 —
// see push-conflict-marker-honesty.test.ts for the end-to-end repro). This
// file pins the fix at the unit level: hasConflictMarkers() itself, and each
// of the three conflict:false paths upgrading to conflict:true when their
// returned content carries markers, while leaving the actual designed
// single-pass conflict fallback (marker construction, already
// conflict:true) and the untouched `unchanged`/strategy paths alone.
const test = require("node:test");
const assert = require("node:assert/strict");
const { hasConflictMarkers, mergeText } = require("../../src/memory-sync/merge");

// ─── hasConflictMarkers ──────────────────────────────────────────────────────

test("hasConflictMarkers: null content has no markers", () => {
  assert.equal(hasConflictMarkers(null), false);
});

test("hasConflictMarkers: plain content without markers", () => {
  assert.equal(hasConflictMarkers("just some ordinary text\nwith multiple lines\n"), false);
});

test("hasConflictMarkers: detects a '<<<<<<< local' line", () => {
  assert.equal(hasConflictMarkers("before\n<<<<<<< local\nafter\n"), true);
});

test("hasConflictMarkers: detects a '=======' line", () => {
  assert.equal(hasConflictMarkers("before\n=======\nafter\n"), true);
});

test("hasConflictMarkers: detects a '>>>>>>> remote' line", () => {
  assert.equal(hasConflictMarkers("before\n>>>>>>> remote\nafter\n"), true);
});

test("hasConflictMarkers: a marker substring that is not at the start of a line does not count (line-anchored)", () => {
  assert.equal(hasConflictMarkers("some text mentioning <<<<<<< local mid-line\n"), false);
  assert.equal(hasConflictMarkers("text ======= mid-line\n"), false);
  assert.equal(hasConflictMarkers("text >>>>>>> remote mid-line\n"), false);
});

test("hasConflictMarkers: recognizes the exact three-line marker block mergeText itself constructs", () => {
  const content = ["<<<<<<< local", "local content", "=======", "remote content", ">>>>>>> remote"].join("\n");
  assert.equal(hasConflictMarkers(content), true);
});

// ─── mergeText: fast paths upgrade conflict:false -> conflict:true ──────────

test("mergeText: local === base (remote wins) with a clean remote stays conflict:false", () => {
  const result = mergeText({ base: "same\n", local: "same\n", remote: "remote update\n", strategy: "inline-markers" });
  assert.equal(result.status, "remote");
  assert.equal(result.content, "remote update\n");
  assert.equal(result.conflict, false);
});

test("mergeText: local === base (remote wins) is upgraded to conflict:true when the remote winner already carries markers", () => {
  const markerRemote = ["<<<<<<< local", "stale local", "=======", "stale remote", ">>>>>>> remote"].join("\n");
  const result = mergeText({ base: "same\n", local: "same\n", remote: markerRemote, strategy: "inline-markers" });
  assert.equal(result.status, "remote");
  assert.equal(result.content, markerRemote, "payload must not be rewritten, only the conflict flag");
  assert.equal(result.conflict, true);
});

test("mergeText: remote === base (local wins) with clean local stays conflict:false", () => {
  const result = mergeText({ base: "same\n", local: "local edit\n", remote: "same\n", strategy: "inline-markers" });
  assert.equal(result.status, "local");
  assert.equal(result.content, "local edit\n");
  assert.equal(result.conflict, false);
});

test("mergeText: remote === base (local wins) is upgraded to conflict:true when the local winner already carries markers", () => {
  const markerLocal = ["<<<<<<< local", "stale local", "=======", "stale remote", ">>>>>>> remote"].join("\n");
  const result = mergeText({ base: "same\n", local: markerLocal, remote: "same\n", strategy: "inline-markers" });
  assert.equal(result.status, "local");
  assert.equal(result.content, markerLocal, "payload must not be rewritten, only the conflict flag");
  assert.equal(result.conflict, true);
});

// ─── mergeText: appendOnly success path upgrades too ────────────────────────

test("mergeText: appendOnly merge of two clean, non-overlapping suffixes stays conflict:false", () => {
  const result = mergeText({
    base: "base\n",
    local: "base\nlocal addition\n",
    remote: "base\nremote addition\n",
    strategy: "inline-markers"
  });
  assert.equal(result.status, "merged");
  assert.equal(result.content, "base\nremote addition\nlocal addition\n");
  assert.equal(result.conflict, false);
});

test("mergeText: appendOnly merge is upgraded to conflict:true when the merged result carries markers (e.g. a marker-carrying local suffix)", () => {
  // local's suffix (everything after base) itself already contains a marker
  // line, simulating a prior conflict's leftover content being appended to
  // again rather than replaced outright.
  const local = "base\n<<<<<<< local\nstale\n=======\nstale2\n>>>>>>> remote\n";
  const remote = "base\nremote addition\n";
  const result = mergeText({ base: "base\n", local, remote, strategy: "inline-markers" });
  assert.equal(result.status, "merged");
  assert.equal(hasConflictMarkers(result.content), true, "sanity: the merged content really does carry markers");
  assert.equal(result.conflict, true);
});

// ─── negative controls: paths the guard must NOT touch ──────────────────────

test("mergeText: unchanged (local === remote) stays conflict:false even when both already carry markers (nothing changed, not a new conflict)", () => {
  const markerContent = ["<<<<<<< local", "x", "=======", "y", ">>>>>>> remote"].join("\n");
  const result = mergeText({ base: "irrelevant\n", local: markerContent, remote: markerContent, strategy: "inline-markers" });
  assert.equal(result.status, "unchanged");
  assert.equal(result.conflict, false);
});

test("mergeText: genuine single-pass conflict (no clean fast path, no append merge) still builds markers and reports conflict:true, unchanged by this fix", () => {
  const result = mergeText({ base: "base\n", local: "local replaced\n", remote: "remote replaced\n", strategy: "inline-markers" });
  assert.equal(result.status, "conflict");
  assert.equal(result.conflict, true);
  assert.match(result.content, /<<<<<<< local/);
  assert.match(result.content, /local replaced/);
  assert.match(result.content, /=======/);
  assert.match(result.content, /remote replaced/);
  assert.match(result.content, />>>>>>> remote/);
});
