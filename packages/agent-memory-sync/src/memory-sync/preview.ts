function summarizeOperation(operation: {
  kind: string;
  appliedFiles: string[];
  mergedFiles: string[];
  conflictFiles: string[];
  deletedFiles?: string[];
  // Remote paths pull saw changed but never wrote/deleted locally, because no
  // configured syncPaths entry maps them to a local destination. Kept out of
  // appliedFiles/mergedFiles/conflictFiles so those stay an honest "files
  // this run actually touched" list (agent-tasks e4b5552a).
  skippedFiles?: string[];
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
