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
// winning payload (`<<<<<<< local` / `=======` / `>>>>>>> remote`, each
// checked as a literal line prefix, line-anchored — not a whole-content
// match, since the real marker lines carry a label/content suffix). Used to
// keep every conflict:false return path below honest: none of them may hand
// back marker-carrying content while still claiming "clean". See
// .ai/runs/2026-08-03-sync-conflict-markers-echo/01-plan.md (Teil 1) for the
// pull-then-push cascade this closes: a genuine conflict on pull writes
// markers to the local file and a clean base; the very next push then saw
// remote === base (nothing else changed the remote in between) and took the
// "local wins" fast path below, silently re-labeling that marker-carrying
// local content as a clean win with conflicts=0.
function hasConflictMarkers(content: string | null): boolean {
  if (content === null) {
    return false;
  }

  return content
    .split("\n")
    .some(
      (line) => line.startsWith("<<<<<<< ") || line.startsWith("=======") || line.startsWith(">>>>>>> ")
    );
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

  if (strategy === "local-wins") {
    return { content: local, status: "conflict", conflict: false };
  }

  if (strategy === "remote-wins") {
    return { content: remote, status: "conflict", conflict: false };
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
