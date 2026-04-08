function summarizeOperation(operation: {
  kind: string;
  appliedFiles: string[];
  mergedFiles: string[];
  conflictFiles: string[];
  deletedFiles?: string[];
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
