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
//
// Fix-Runde (05-review-findings.md, agent-tasks 06d09cde): two follow-up
// clusters added below.
//   Fix 2 (MEDIUM, "Markdown-Ausschluss"): the first cut of
//   hasConflictMarkers also matched a bare `=======` / `>>>>>>> ` line, which
//   false-positives on ordinary Markdown (setext H1 underlines, `====`
//   dividers, deep blockquotes) that legitimately starts a line that way —
//   spurious conflict:true on content that was never actually corrupted.
//   Narrowed to the unambiguous `<<<<<<< ` opener alone (mergeText always
//   writes the full three-line block together, so the opener is sufficient
//   and does not need corroboration from the other two lines).
//   Fix 4 (LOW, "wins-Honesty"): the local-wins/remote-wins strategy
//   branches still returned unconditional conflict:false, breaking the same
//   invariant on an unreachable-today-but-still-public code path.
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

// Fix 2 (MEDIUM, Markdown-Ausschluss): a bare '=======' or '>>>>>>> ' line,
// with no accompanying '<<<<<<< ' opener anywhere in the content, is NOT a
// conflict marker on its own — it's what a setext H1 underline, an
// '===='-style section divider, or a deeply nested blockquote look like in
// ordinary agent-memory Markdown. The pre-fix implementation matched these
// two line prefixes unconditionally and produced spurious conflict:true on
// such content. These two cases replace what used to assert `true` here.
test("hasConflictMarkers: a lone '=======' line with no '<<<<<<< ' opener (e.g. a setext H1 underline) is NOT a conflict marker", () => {
  assert.equal(hasConflictMarkers("before\n=======\nafter\n"), false);
});

test("hasConflictMarkers: a lone '>>>>>>> ' line with no '<<<<<<< ' opener (e.g. a deep blockquote) is NOT a conflict marker", () => {
  assert.equal(hasConflictMarkers("before\n>>>>>>> remote\nafter\n"), false);
});

test("hasConflictMarkers: a setext-style H1 underline in ordinary memory Markdown is not flagged", () => {
  assert.equal(hasConflictMarkers("Overview\n=======\nnotes"), false);
});

test("hasConflictMarkers: an '====' style section divider (no opener anywhere) is not flagged", () => {
  assert.equal(hasConflictMarkers("Section one\n\n====\n\nSection two\n"), false);
});

test("hasConflictMarkers: a deeply nested blockquote line starting with '>>>>>>> ' (no opener anywhere) is not flagged", () => {
  assert.equal(hasConflictMarkers("some reply\n>>>>>>> quoted from someone\nmore text\n"), false);
});

test("hasConflictMarkers: a real inherited conflict block (opener present) is still flagged true even amid lone '=======' /'>>>>>>> '-style Markdown elsewhere", () => {
  const content = [
    "Notes",
    "=======",
    "<<<<<<< local",
    "local content",
    "=======",
    "remote content",
    ">>>>>>> remote",
    "",
    "quoted reply:",
    ">>>>>>> someone else"
  ].join("\n");
  assert.equal(hasConflictMarkers(content), true);
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

// ─── Fix 4: local-wins/remote-wins strategy branches upgrade too ────────────
//
// Unreachable via the deployed inline-markers conflictStrategy, but
// local-wins/remote-wins are still public MergeInput.strategy values; both
// branches previously returned unconditional conflict:false even when their
// picked winner already carried inherited markers, breaking the same
// honesty invariant the fast paths and appendOnly path above were fixed for.

test("mergeText: local-wins strategy is upgraded to conflict:true when the local winner already carries markers", () => {
  const markerLocal = ["<<<<<<< local", "stale local", "=======", "stale remote", ">>>>>>> remote"].join("\n");
  const result = mergeText({
    base: "base\n",
    local: markerLocal,
    remote: "remote replaced\n",
    strategy: "local-wins"
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.content, markerLocal, "payload must not be rewritten, only the conflict flag");
  assert.equal(result.conflict, true);
});

test("mergeText: remote-wins strategy is upgraded to conflict:true when the remote winner already carries markers", () => {
  const markerRemote = ["<<<<<<< local", "stale local", "=======", "stale remote", ">>>>>>> remote"].join("\n");
  const result = mergeText({
    base: "base\n",
    local: "local replaced\n",
    remote: markerRemote,
    strategy: "remote-wins"
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.content, markerRemote, "payload must not be rewritten, only the conflict flag");
  assert.equal(result.conflict, true);
});

// The two tests above only ever exercise the marker-carrying (conflict:true)
// side of local-wins/remote-wins; the clean (no inherited markers) side —
// which must stay conflict:false — was untested for both strategies.

test("mergeText: local-wins strategy picks local and stays conflict:false when neither side carries markers", () => {
  const result = mergeText({
    base: "base\n",
    local: "local replaced\n",
    remote: "remote replaced\n",
    strategy: "local-wins"
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.content, "local replaced\n");
  assert.equal(result.conflict, false);
});

test("mergeText: remote-wins strategy picks remote and stays conflict:false when neither side carries markers", () => {
  const result = mergeText({
    base: "base\n",
    local: "local replaced\n",
    remote: "remote replaced\n",
    strategy: "remote-wins"
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.content, "remote replaced\n");
  assert.equal(result.conflict, false);
});

// ─── mergeAppendOnly: sub-branches not exercised by the "two clean,
//     non-overlapping suffixes" success-path test above ────────────────────
//
// mergeAppendOnly's own `!localSuffix || !remoteSuffix` and `localSuffix ===
// remoteSuffix` branches are NOT covered here — they are structurally
// unreachable through the public mergeText() API: reaching mergeAppendOnly
// at all requires local !== base AND remote !== base (mergeText's own fast
// paths intercept both equal-to-base cases first), and mergeAppendOnly
// itself requires local.startsWith(base) && remote.startsWith(base). Given
// all of that, an empty suffix on either side, or two equal suffixes, would
// force local === remote as full strings — which mergeText's very first
// check (`if (local === remote)`) already intercepts before mergeAppendOnly
// is ever called. Flagged as a discrepancy in the implementation report
// rather than worked around with a fabricated caller.

test("mergeText: appendOnly — local's suffix already contains remote's suffix (local is further ahead) returns local unchanged", () => {
  const result = mergeText({
    base: "base\n",
    local: "base\nremote bit\nmore local text\n",
    remote: "base\nremote bit\n",
    strategy: "inline-markers"
  });
  assert.equal(result.status, "merged");
  assert.equal(result.content, "base\nremote bit\nmore local text\n");
  assert.equal(result.conflict, false);
});

test("mergeText: appendOnly — remote's suffix already contains local's suffix (remote is further ahead) returns remote unchanged", () => {
  const result = mergeText({
    base: "base\n",
    local: "base\nlocal bit\n",
    remote: "base\nlocal bit\nmore remote text\n",
    strategy: "inline-markers"
  });
  assert.equal(result.status, "merged");
  assert.equal(result.content, "base\nlocal bit\nmore remote text\n");
  assert.equal(result.conflict, false);
});
