# Log

<!-- Add new entries at the top, newest first. -->

- 2026-10-11T12:47:47Z, bundle introduced with `okf-kit init` (okf-kit 0.16.0) and
  written against the current sources: `overview.md`,
  `config-resolution.md`, `base-snapshot-lifecycle.md`,
  `destructive-write-safety-chain.md`, `offline-queue-and-lock.md` and
  `stopped-run-runbook.md`; the unused scaffold templates were removed.
  Every code citation carries a string anchor on its last line. The
  `okf-staleness` workflow now runs once per bundle through a matrix over
  `packages/memory-router/docs/okf` and `packages/agent-memory-sync/docs/okf`,
  documented as a deviation from the okf-kit template next to its
  REPO-SPECIFIC marker; the okf-kit pin stays at 0.16.0. Verified with
  `okf-kit check --json --require-anchors packages/agent-memory-sync/docs/okf`:
  no errors, no warnings.
