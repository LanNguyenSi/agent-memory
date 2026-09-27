# Bundle log

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
