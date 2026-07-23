// Formerly also held `commitAndPushSnapshot`: a whole-subtree MIRROR push
// used by `watch` (src/commands/watch.ts) that blindly overwrote any
// differing remote file with the local version and deleted any remote path
// under `repositorySubdir` missing locally — including a peer machine's file
// this workspace simply had not pulled yet. `watch` now reuses the
// base-snapshot-aware `performPush` (./push.ts) that `run --mode sync/push`
// already used, so that mirror-push (and its hazard) is gone; only the
// commit-message formatter survives here, since watch's per-tick commit
// messages ("update N memories" + bulleted body) are independent of the push
// mechanics and are still worth keeping human-readable. Kept as its own
// small module rather than folded into watch.ts or push.ts, to keep this
// change's diff minimal.

function buildCommitMessage(changedFiles: string[], deletedFiles: string[]): string {
  const all = Array.from(new Set([...changedFiles, ...deletedFiles])).sort();

  if (all.length === 0) {
    return "snapshot: noop";
  }

  if (all.length === 1) {
    const isDelete = deletedFiles.includes(all[0]);
    return `${isDelete ? "remove" : "update"} ${all[0]}`;
  }

  const bullets = all
    .map((file) => (deletedFiles.includes(file) ? `- remove ${file}` : `- update ${file}`))
    .join("\n");

  return `update ${all.length} memories\n\n${bullets}`;
}

module.exports = {
  buildCommitMessage
};
