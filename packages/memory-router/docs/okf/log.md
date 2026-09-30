# Bundle log

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
