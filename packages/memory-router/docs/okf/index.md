# Knowledge bundle index

Curated OKF knowledge bundle for the `memory-router` package (bundle
granularity is per package, the same decision `agent-dx` made for its
`orchestrator-workflow` package). memory-router's own invariants are
already partly documented in `README.md` and `docs/scoring.md`; this
bundle points at those docs where they answer a topic and adds the code
anchors (file and line) behind the cross-file mechanics they describe.
Where a topic is answered by the package docs, the doc here points at
them instead of repeating them.

## Docs

- [Score-blend resolver, degraded mode, and confidence-floor provenance](score-blend-resolver.md):
  code anchors for the blend entry point the blend callers run through,
  the `router.ts` branches that trigger the degraded (topic/tool-only)
  fallback, and the `confidence.ts` branch behind each
  `minSemanticScoreSource` tag value that gates the floor-drop hint.
- [Semantic search's silent-no-op contract, and its loud counterpart](semantic-search-silent-noop.md):
  the paths on which `semanticSearch()` returns `[]` instead of throwing,
  with the stderr visibility of each, and the errors that propagate out
  of it instead, whose visibility depends on which caller invoked it.
- [Three resolvers, two dedup rules](gate-composition-and-dedup.md): which
  of `resolve`/`resolveConfidence`/`resolveBlended` each production call
  site uses, and how the two dedup/ranking functions
  (`dedupeAndRank`, `rankWithToolPrivilege`) underneath them differ.
- [Native-dependency smoke check](native-deps-and-ci-smoke.md): why CI
  runs a dedicated `better-sqlite3`/`sqlite-vec` load probe ahead of
  typecheck/build, which matrix leg it actually exercises, and what it
  does not cover.

## Maintenance

Each doc's `timestamp` means "last verified against sources," not "created
on." When a change touches a path listed in a doc's `sources:`, re-verify
the doc against the change and re-stamp it, then add a line to
[log.md](log.md). The warn-only `okf-staleness` CI workflow reports drift
on pull requests against `master`; bundle findings never fail it, only a
tool or usage error of the check itself does.

Log entries record what changed and what was re-verified, not suite
totals: a total describes one tree and goes stale when a test is added
or removed.
