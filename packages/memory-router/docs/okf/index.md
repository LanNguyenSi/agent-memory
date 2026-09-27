# Knowledge bundle index

Curated OKF knowledge bundle for the `memory-router` package (bundle
granularity is per package, the same decision `agent-dx` made for its
`orchestrator-workflow` package). memory-router's own invariants are
already partly documented in `README.md` and `docs/scoring.md`; this
bundle consolidates the cross-file mechanics neither of those docs states
as a single, code-anchored claim, rather than re-explaining what they
already cover well. Where a topic is already fully answered by the package
docs, the corresponding doc here is a short pointer instead of a
duplicate.

## Docs

- [Score-blend resolver, degraded mode, and confidence-floor provenance](score-blend-resolver.md):
  the one function every blend caller runs through, the exact three-way
  trigger for the degraded (topic/tool-only) fallback, and the four-state
  tag (`env`/`map`/`provider`/`fallback`) that decides whether an
  all-below-floor run gets a one-time stderr hint.
- [Semantic search's silent-no-op contract, and its loud counterpart](semantic-search-silent-noop.md):
  the two ways `semanticSearch()` returns an empty result instead of
  throwing, the separate case where matching rows are filtered silently at
  query time, and the contrasting embedding-index provenance guard that
  throws instead of degrading quietly.
- [Three resolvers, two dedup rules](gate-composition-and-dedup.md): which
  of `resolve`/`resolveConfidence`/`resolveBlended` each production call
  site actually uses, and the one real difference between the two
  dedup/ranking functions (`dedupeAndRank`, `rankWithToolPrivilege`)
  underneath them.
- [Native-dependency smoke check](native-deps-and-ci-smoke.md): why CI
  runs a dedicated `better-sqlite3`/`sqlite-vec` load probe ahead of
  typecheck/build, which matrix leg it actually exercises, and what it
  does not cover.

## Maintenance

Each doc's `timestamp` means "last verified against sources," not "created
on." When a change touches a path listed in a doc's `sources:`, re-verify
the doc against the change and re-stamp it, then add a line to
[log.md](log.md). The warn-only `okf-staleness` CI workflow surfaces drift
on every pull request without ever blocking a merge.

Log entries record what changed and what was re-verified, not suite
totals: a total describes exactly one tree and goes stale on the very next
test added or removed.
