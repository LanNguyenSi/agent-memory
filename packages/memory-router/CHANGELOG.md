# Changelog

All notable changes to `@lannguyensi/memory-router` are recorded here.
Versions follow [semver](https://semver.org/). The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Build now restores `+x` on the four `bin` targets (`memory-router`, `memory-router-user-prompt-submit`, `memory-router-pre-tool-use`, `memory-router-mcp`) via a postbuild `scripts/chmod-bins.mjs` step. `tsc` strips the execute bit on its JS output, and `npm link` (unlike registry installs) does not chmod link targets, so every rebuild used to leave the hooks failing with "Permission denied" until manually fixed.

## [0.2.0] - 2026-05-05

### Added

- `lint --conflicts --semantic` (#30): embedding-cosine upgrade for paraphrased opposite-polarity pairs the regex pass misses ("always squash before merge" vs "never squash, use fast-forward only"). Reuses the live `index.sqlite` when available; embeds misses on the fly without persisting. Fail-open with a stderr warning when `OPENAI_API_KEY` is unset, so CI without secrets stays green.
- `lint --conflicts --json` (#32): machine-readable report mirroring the `--drift --json` contract. Schema: `{ scannedCount, feedbackCount, hits: [{ severity, topic, reason, a, b }] }`. When combined with `--drift --json`, drift owns stdout and conflicts routes to stderr so a single CI step can pipe both fds.
- Extended polarity vocabulary (#32): formal-register markers `mandatory`, `mandate`, `compulsory`, `prohibit`, `forbid`, `disallow`, `cannot` (plus inflections), so memories written without `ALWAYS`/`NEVER` still classify and still get filtered out of subject-token Jaccard.
- `stale --repo-root <p>` repeated, and variadic `stale --repo-roots <p1> <p2> ...` (#33): multi-repo workspace mode for the stale linter. A ref is STALE only when none of the roots resolves it; first hit wins. The single-root detail format is preserved for v1 CI scrapers; multi-root emits a single-line aggregated summary. `symbolCheckDegraded` is `true` only when every probed root is non-git.
- Date-staleness pass (#34): every memory whose newest ISO date in the body is more than 90 days old AND whose frontmatter has no newer `updatedAt:` is flagged `possibly-stale`. INFO-only, never blocks CI.
- `stale --check-urls` (#34): HEAD-request every external URL extracted from the body. `4xx` → STALE; `5xx` and network errors → `skipped`; `2xx`/`3xx`-following → silent. 5-second timeout. Off by default because it's network-dependent.

### Changed

- Polarity detection scope (#31): lowercase markers (`always`, `never`, `prefer`, `avoid`, ...) now only fire against the first two whitespace-separated tokens of the line; ALL-CAPS variants still match anywhere. Mixed polarity is still detected when a leading directive is contradicted later on the line. The Jaccard subject-overlap floor was lowered from `0.25` to `0.15` now that descriptive mid-sentence false positives are filtered upstream.
- Debug stderr prefix unified to `[memory-router]` (#29): both the loader's rejection warnings and the indexer's query-cache observability share one bracketed prefix; `grep '^\[memory-router\]'` now catches every gated diagnostic.

### Schema

- v1 → v2 migration (#35): adds `model TEXT` column to the `entries` table. Embeddings are now stamped with the producing model so `semanticSearch` (Confidence Gate) and `lint --conflicts --semantic` cannot silently mix vectors from incompatible embedding spaces. The migration is idempotent (PRAGMA `table_info` probe before `ALTER`), so opening a 0.1.x index file just adds the column; pre-v2 rows survive with NULL model. The next `semanticSearch` open emits a one-line stderr warning recommending `memory-router index <dir>` to refresh; once rebuilt, every row carries the active `MEMORY_ROUTER_EMBED_MODEL`.

### Compatibility

- API change: `IndexStore.upsert(id, mtime, embedding)` is now `upsert(id, mtime, model, embedding)`. `getEmbedding(id, expectedModel?)` and `search(query, k, expectedModel?)` accept an optional model filter that rejects cross-model rows (and pre-v2 NULL rows). Direct programmatic callers of `IndexStore` need to pass a model name; hook / CLI / MCP users see no behaviour change beyond the upgrade-path warning above.

## [0.1.0] - 2026-05-05

First public release.

### Added

- **Three-gate router**: deterministic memory injection for Claude Code, gated by topic dictionary, tool-call regex, or a fallback ambiguity-driven semantic match.
- **Hook binaries**: `memory-router-user-prompt-submit` and `memory-router-pre-tool-use` consume Claude Code's hook stdin contract and emit `hookSpecificOutput.additionalContext` on stdout.
- **MCP server** (`memory-router-mcp`) exposing `memory_search`, `memory_resolve`, and `memory_apply` for imperative checks.
- **CLI** (`memory-router`) with subcommands:
  - `tag` to propose `topics:` / `severity:` frontmatter for legacy memories.
  - `index` to build a sqlite-vec embedding index, including an LRU query-embedding cache.
  - `lint` with three checks: `--drift` (MEMORY.md vs. on-disk corpus), `--unknown-topics` (typos against the topic registry), `--conflicts` (opt-in: pairs of feedback memories with topic overlap and opposite-imperative directives).
  - `stale` to flag broken path / symbol references in memory bodies. `verify:`-frontmatter-only by default; `--scan-body` opts in to body-regex extraction.
- **Schema-versioned sqlite index**: `meta.schema_version` row + migration framework, so future on-disk shape changes have a clean upgrade path.
- **Frontmatter `verify:` contract**: memories declare claims about the repo state. The runtime side prefixes a stale warning when the claim no longer holds; `memory-router stale` checks the same claims proactively.
- **Observability**: `MEMORY_ROUTER_DEBUG=1` emits one stderr line per rejected memory file (broken YAML, missing required field, etc.) without touching stdout.

### Compatibility

- Node 22 or newer.
- Native dependencies: `better-sqlite3` and `sqlite-vec`. The CI smoke step verifies they load before tests run.
