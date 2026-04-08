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

function mergeText(input: MergeInput): MergeResult {
  const { base, local, remote, strategy } = input;

  if (local === remote) {
    return { content: local, status: "unchanged", conflict: false };
  }

  if (local === base) {
    return { content: remote, status: "remote", conflict: false };
  }

  if (remote === base) {
    return { content: local, status: "local", conflict: false };
  }

  const appendMerge = mergeAppendOnly(base, local, remote);
  if (appendMerge) {
    return { content: appendMerge, status: "merged", conflict: false };
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
  mergeText
};
