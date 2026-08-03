interface MergeInput {
  base: string | null;
  local: string | null;
  remote: string | null;
  strategy: "inline-markers" | "local-wins" | "remote-wins";
}

interface MergeResult {
  content: string | null;
  status: "unchanged" | "local" | "remote" | "merged" | "conflict";
  conflict: boolean;
}

// Detects a previous pass's inline conflict markers surviving inside a
// winning payload. Used to keep every conflict:false return path below
// honest: none of them may hand back marker-carrying content while still
// claiming "clean". See
// .ai/runs/2026-08-03-sync-conflict-markers-echo/01-plan.md (Teil 1) for the
// pull-then-push cascade this closes: a genuine conflict on pull writes
// markers to the local file and a clean base; the very next push then saw
// remote === base (nothing else changed the remote in between) and took the
// "local wins" fast path below, silently re-labeling that marker-carrying
// local content as a clean win with conflicts=0.
//
// Only the `<<<<<<< ` opener line (checked as a literal, line-anchored
// prefix) is checked — deliberately NOT the bare `=======`/`>>>>>>> ` lines
// the block below also writes. mergeText only ever emits the full
// three-line block together (see the "conflict" fallback below), so the
// opener alone is already an unambiguous signal that inherited marker
// content is present; requiring it also is what keeps this from
// false-positiving on ordinary Markdown that legitimately starts a line
// with 7+ `=` (a setext H1 underline, an `====`-style section divider) or
// `>>>>>>> ` (a deeply nested blockquote/reply-quote line) — content agent
// memory files carry routinely and that earlier revisions of this check
// mis-flagged as conflict:true. Fix-Runde 05-review-findings.md MEDIUM
// finding #2 (agent-tasks 06d09cde).
function hasConflictMarkers(content: string | null): boolean {
  if (content === null) {
    return false;
  }

  return content.split("\n").some((line) => line.startsWith("<<<<<<< "));
}

function mergeText(input: MergeInput): MergeResult {
  const { base, local, remote, strategy } = input;

  if (local === remote) {
    return { content: local, status: "unchanged", conflict: false };
  }

  if (local === base) {
    return { content: remote, status: "remote", conflict: hasConflictMarkers(remote) };
  }

  if (remote === base) {
    return { content: local, status: "local", conflict: hasConflictMarkers(local) };
  }

  const appendMerge = mergeAppendOnly(base, local, remote);
  if (appendMerge) {
    return { content: appendMerge, status: "merged", conflict: hasConflictMarkers(appendMerge) };
  }

  // Both wins-strategy branches upgrade conflict:false -> conflict:true when
  // their picked winner already carries markers, mirroring the fast paths
  // and the appendOnly success path above (Invariant-Vollstaendigkeit: every
  // conflict:false return must hold for marker-free content). Unreachable
  // today via the deployed inline-markers strategy, but local-wins/
  // remote-wins are still a public MergeInput.strategy value the honesty
  // invariant must hold for. Fix-Runde 05-review-findings.md LOW finding #4
  // (agent-tasks 06d09cde).
  if (strategy === "local-wins") {
    return { content: local, status: "conflict", conflict: hasConflictMarkers(local) };
  }

  if (strategy === "remote-wins") {
    return { content: remote, status: "conflict", conflict: hasConflictMarkers(remote) };
  }

  return {
    content: [
      "<<<<<<< local",
      local || "",
      "=======",
      remote || "",
      ">>>>>>> remote"
    ].join("\n"),
    status: "conflict",
    conflict: true
  };
}

function mergeAppendOnly(base: string | null, local: string | null, remote: string | null): string | null {
  if (base === null || local === null || remote === null) {
    return null;
  }

  if (!local.startsWith(base) || !remote.startsWith(base)) {
    return null;
  }

  const localSuffix = local.slice(base.length);
  const remoteSuffix = remote.slice(base.length);

  if (!localSuffix || !remoteSuffix) {
    return localSuffix ? local : remote;
  }

  if (localSuffix === remoteSuffix) {
    return local;
  }

  if (localSuffix.includes(remoteSuffix)) {
    return local;
  }

  if (remoteSuffix.includes(localSuffix)) {
    return remote;
  }

  return `${base}${remoteSuffix}${localSuffix}`;
}

module.exports = {
  hasConflictMarkers,
  mergeText
};
