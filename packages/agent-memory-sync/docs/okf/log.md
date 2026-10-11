# Log

<!-- Add new entries at the top, newest first. -->

- 2026-10-11T16:16:43Z, corrected and re-verified against the current sources:
  `destructive-write-safety-chain.md` now states its threshold rule for
  runs without an override flag and names what `--allow-mass-delete` and
  `--accept-mass-delete` let through, including the adoption's
  unthresholded local removals; the pre-apply snapshot rule still covers
  the adoption. `config-resolution.md` names both flags as per-run
  overrides of the mass-delete guard. Verified with
  `okf-kit check --json --require-anchors packages/agent-memory-sync/docs/okf`
  (no errors, no warnings) and `npm run format:check` in
  `packages/agent-memory-sync` (passes).

- 2026-10-11T16:02:50Z, corrected and re-verified against the current sources:
  `base-snapshot-lifecycle.md` now states the base rule per writer (pull
  records the hub content it merged against whatever the local result,
  push only where local equals the hub, and an `--accept-mass-delete`
  adoption stays when the push after it stops), with the matching wording
  in `overview.md`; `destructive-write-safety-chain.md` scopes its
  invariant to pull and push and adds a "Restore writes" section for
  `restore <sha>` (no pre-apply snapshot) and the destination restore's
  unchecked snapshot and unthresholded removals, linked from
  `stopped-run-runbook.md`. Tables and emphasis reformatted with the
  package's prettier config. Verified with
  `okf-kit check --json --require-anchors packages/agent-memory-sync/docs/okf`
  (no errors, no warnings) and `npm run format:check` in
  `packages/agent-memory-sync` (passes).
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
