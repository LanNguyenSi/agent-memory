# Bundle log

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
