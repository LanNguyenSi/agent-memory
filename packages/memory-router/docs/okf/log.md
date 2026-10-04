# Bundle log

- 2026-10-04T12:55:59Z, release cut 0.7.3 bumped `package.json` and the `PACKAGE_VERSION`
  constant in `src/hooks/user-prompt-submit.ts` (one-line change, no line
  shift). Re-verified `gate-composition-and-dedup.md` (`ctx` built without
  `tool` at `user-prompt-submit.ts:40`), `score-blend-resolver.md`
  (`resolveBlended` call at `user-prompt-submit.ts:54`) and
  `native-deps-and-ci-smoke.md` (`better-sqlite3` and `sqlite-vec` are
  declared dependencies in `package.json`); claims unchanged; re-stamped.

- 2026-10-03T13:13:22Z, merged master into the staleness-template branch: master's
  `ci.yml` now passes `matrix.package` to the native-dep smoke step through
  `env: PACKAGE`, two lines longer. Re-pointed `native-deps-and-ci-smoke.md`
  (`ci.yml:47-53` for the step, `:52` for the smoke command); claims
  unchanged; re-stamped.
- 2026-10-03T12:12:29Z, okf-staleness workflow re-synced from the okf-kit
  workflow template (fleet convergence ticket fdc01728): the workflow header
  now names the template as its source instead of calling the file a pattern
  to keep in sync, the pin stays okf-kit@0.16.0, `--require-anchors` joined
  the invocation, and the job stays warn-only. Measured on the tree before the
  change with `okf-kit check --json <bundle>`: at okf-kit@0.16.0, 0 errors, 3
  warnings, 0 notices (exit 0) plain and 0 errors, 103 warnings, 0 notices
  (exit 0) with `--require-anchors`; at okf-kit@0.16.0, 0 errors, 3 warnings,
  0 notices (exit 0) plain and 0 errors, 103 warnings, 0 notices (exit 0) with
  `--require-anchors`. Of the anchored-run warnings, 100 are anchor-required
  findings (full citations without an anchor); anchoring them is separate work
  and none of them blocks anything.

- 2026-10-01T15:03:27Z, `semantic-search-silent-noop.md`:
  re-verified the semantic lint open-failure warning against the changed
  `conflicts.ts` condition. It preserves the width and newer-schema repair
  advice and appends one rebuild hint to a raw reason even when its path
  contains `rebuild`; the fallback to fresh embedding is unchanged.

- 2026-09-30T11:14:55Z, `semantic-search-silent-noop.md`:
  the `lint --conflicts --semantic` open-failure warning now appends the
  `memory-router index <dir>` rebuild hint unless the reason already says
  to rebuild; the `conflicts.ts` citation range was moved. Re-verified
  against the changed code and re-stamped.

- 2026-09-30T07:24:20Z, `semantic-search-silent-noop.md` and `native-deps-and-ci-smoke.md`
  re-verified after the comment-only change to `index-store.ts` and
  `indexer.ts` (line counts unchanged) and after merging the model-filter
  and once-per-process warning changes; the `getEmbedding` citation was
  moved to its current line. Re-stamped.

- 2026-09-30T07:01:07Z, `semantic-search-silent-noop.md`:
  on an `openIndex()` failure `lint --conflicts --semantic` now warns once
  and embeds fresh without reusing the index instead of skipping the
  semantic step; the `cli.ts` line citations in this doc and in
  `gate-composition-and-dedup.md` were moved for the three help-text lines
  added to `src/cli.ts`. Re-stamped.

- 2026-09-30T06:51:55Z, `semantic-search-silent-noop.md`:
  `lint --conflicts --semantic` now opens the index read-only without a width hint, so it no longer
  records a width on an index that has none, and an `openIndex()` throw
  there skips the semantic step with one stderr warning instead of
  failing the command; the "Other `openIndex()` callers" entry and its
  line reference were rewritten to match. Re-stamped.

- 2026-09-30T07:06:26Z, `semantic-search-silent-noop.md` row 5 now states that a `k` above the
  4096-row KNN ceiling with a model filter returns at most 4096 hits instead
  of throwing, and that the widening costs up to one extra full-table KNN
  scan per x4 step; `native-deps-and-ci-smoke.md` re-verified and
  re-stamped. Re-stamped.

- 2026-09-30T06:54:06Z, `semantic-search-silent-noop.md` row 5 and the
  crowding-out paragraph describe the model filter running inside a
  widening KNN window instead of after a single `LIMIT k`, and the
  `index-store.ts` line citations after the changed search path are
  re-pointed; `native-deps-and-ci-smoke.md` re-verified against the changed
  file and re-stamped. Re-stamped.

- 2026-09-30T06:51:44Z, `semantic-search-silent-noop.md` now says the stale-model stderr
  line is written once per process (a `staleModelWarned` flag mirroring
  `missingIndexWarned`), not on every call, and that a call finding no
  stale rows does not use up the warning. Its `indexer.ts` line citations
  were re-pointed to the shifted source. Re-stamped.

- 2026-09-27T15:18:36Z, `semantic-search-silent-noop.md` notes that
  `lint --conflicts --semantic` opens the index writable with the fixed
  1536 width hint, which records that width on an index that has none yet,
  so the never-embedded row holds only while no width is recorded;
  `gate-composition-and-dedup.md` shows the `resolveBlended` call without
  an options argument, as all three call sites make it. Re-stamped.

- 2026-09-27T15:09:05Z: second fact-check pass on the concept docs
  and `index.md`, re-verified against the checked-out source at head.
  Replaced counted and exclusive claims about paths, throws, and callers
  with lists that name the `rg` command they were enumerated from.
  `semantic-search-silent-noop.md`: the loud-counterpart section now lists
  the errors that can propagate out of `semanticSearch()` (provenance and
  other open-time integrity errors, `putCachedQuery`'s fresh-query
  dimension check, `search()`'s dimension check on a cache hit, the
  wrapped embed failure), states that the `resolveBlended` and
  `test --semantic` catches return the same hits as the unconfigured case
  but write the full error text to stderr, adds the silent path for an
  index whose entries were all removed, and separates the `semanticSearch` callers
  from the other `openIndex()` callers. This corrects the previous entry's
  "all five silent-`[]` paths" wording, which was not complete.
  `score-blend-resolver.md`: degraded-output and hint-exclusion prose
  replaced by pointers into `docs/scoring.md` and the pinning tests.
  `gate-composition-and-dedup.md`: call-site count dropped, the
  gate-override and tool-privilege wording tightened. `native-deps-and-ci-smoke.md`:
  probe-to-runtime wording corrected (the probe's `require` order differs).
  Sources lists pruned to the files each doc cites and extended where a
  doc now cites more.
- 2026-09-27T14:48:54Z: fact-check pass on `score-blend-resolver.md`,
  `semantic-search-silent-noop.md`, and `gate-composition-and-dedup.md`,
  re-verified against the checked-out source at head. Corrected the
  semantic-search fail posture (the router/CLI degrade catches swallow any
  `semanticSearch` throw, not only a network/API error, and only MCP
  `memory_search` and the `index` rebuild let a provenance/dimension
  mismatch propagate), listed all five silent-`[]` paths instead of two,
  fixed the null-provider rationale (it is the explicit openai-without-key
  misconfiguration, not an unconfigured machine), corrected `DEFAULT_GATES`'s
  actual scope (also reached by `test --semantic` and `resolveBlended`'s
  degraded fallback), fixed which `resolveBlended` caller can pass
  `ctx.tool` (only MCP `memory_resolve`, not the `UserPromptSubmit` hook),
  named `resolveDefaultMinSemanticScoreDetail` instead of the wrapper it
  calls, removed a stale/misattributed cross-reference into
  `docs/scoring.md`, and completed each doc's `sources:` list for files now
  cited inline (`src/embed/provider.ts`, `src/eval/runner.ts`,
  `docs/scoring.md`, `tests/index-store.test.ts`).
- 2026-09-27T14:23:45Z: bundle created (`index.md`, this log, and four
  concept docs: `score-blend-resolver.md`, `semantic-search-silent-noop.md`,
  `gate-composition-and-dedup.md`, `native-deps-and-ci-smoke.md`). Every
  inline citation was verified against the checked-out source at the base
  commit before writing. Two of the originally scoped candidate topics
  (the score-blend resolver's degraded-mode fallback, and the
  model-conditional relevance-floor/confidence-floor-provenance table)
  were merged into one doc (`score-blend-resolver.md`) rather than kept
  separate: both run through the same `resolveBlended` function in
  `packages/memory-router/src/router.ts`, and the floor's own value table
  is already fully covered by `README.md` "Calibration" and
  `docs/scoring.md`, so a separate doc for it would have mostly duplicated
  those. The warn-only `okf-staleness` GitHub Actions workflow was added
  in the same change, pointed at this bundle.
