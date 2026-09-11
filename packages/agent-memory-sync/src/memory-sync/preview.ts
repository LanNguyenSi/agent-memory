function summarizeOperation(operation: {
  kind: string;
  appliedFiles: string[];
  mergedFiles: string[];
  conflictFiles: string[];
  deletedFiles?: string[];
  // Remote paths pull saw changed but never wrote/deleted locally, because no
  // configured syncPaths entry maps them to a local destination. Within
  // pull's own reporting, kept out of appliedFiles/mergedFiles/conflictFiles
  // so those stay an honest "files this run actually touched" list
  // (agent-tasks e4b5552a). On a merged sync result the same path can still
  // appear in appliedFiles/conflictFiles too, if push's own remote-side
  // handling independently touched it; skippedFiles here only reflects
  // pull's side of that combined payload.
  skippedFiles?: string[];
  // Local files a pull kept because no base snapshot records them and the
  // remote does not have them: local-only files, candidates for the next
  // push, never pull deletions (agent-tasks cda5b12c, AC-002). Reported so a
  // run that protected files says so, rather than leaving the operator to
  // infer it from a count that did not change.
  protectedFiles?: string[];
  // Ids of the pre-apply snapshots this run wrote before touching a
  // destination (agent-tasks cda5b12c). Reported so a run that copied
  // something says where the copy is, instead of leaving the operator to
  // discover stateDir/snapshots on their own.
  snapshots?: string[];
  queuedSnapshotId?: string | null;
  notes?: string[];
}): string {
  const parts = [
    `operation=${operation.kind}`,
    `applied=${operation.appliedFiles.length}`,
    `merged=${operation.mergedFiles.length}`,
    `conflicts=${operation.conflictFiles.length}`
  ];

  if (operation.deletedFiles && operation.deletedFiles.length > 0) {
    parts.push(`deleted=${operation.deletedFiles.length}`);
  }

  if (operation.skippedFiles && operation.skippedFiles.length > 0) {
    parts.push(`skipped=${operation.skippedFiles.length}`);
  }

  if (operation.protectedFiles && operation.protectedFiles.length > 0) {
    parts.push(`protected=${operation.protectedFiles.length}`);
  }

  if (operation.snapshots && operation.snapshots.length > 0) {
    parts.push(`snapshots=${operation.snapshots.length}`);
  }

  if (operation.queuedSnapshotId) {
    parts.push(`queued=${operation.queuedSnapshotId}`);
  }

  if (operation.notes && operation.notes.length > 0) {
    parts.push(`notes=${operation.notes.join("; ")}`);
  }

  return parts.join(" ");
}

module.exports = {
  summarizeOperation
};
