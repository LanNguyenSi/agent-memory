# Changelog

All notable changes to `@lannguyensi/memory-router` are recorded here.
Versions follow [semver](https://semver.org/). The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `memory-router eval <golden.yml> [--dir <path>] [--json]`: golden-set precision/recall/MRR baseline measurement against a labelled `(prompt, expected memory ids)` set, mirroring exactly what the `UserPromptSubmit` hook would select per prompt. A report, not a gate: no threshold/exit-code contract on the metrics; exits 0 on any error-free run. `--json` emits a stable, documented schema including `unknownExpectIds` (golden ids that don't resolve against the loaded corpus). See README "Golden-set eval".
- `<MEMORY_ROUTER_DIR>/topics.yml` corpus-controlled topic vocabulary (mm-v1-T002): the Topic Gate and `lint --unknown-topics` no longer work against a closed, in-package 5-topic union. A `topics.yml` file (top-level list of `{ name, description?, patterns? }` entries) at the root of the memory dir overrides the built-in default (`deployment`, `destructive_ops`, `workflow`, `security`, `testing`) corpus-wide; a missing file falls back to the built-in default, unchanged. New `src/vocab/loader.ts` validates `name` (required, unique) and `patterns` (optional regex strings): a single non-compiling pattern, or a topic declared with no patterns at all, degrades to a keyword match on its own `name` instead of dropping the topic or crashing the loader. An invalid `topics.yml` (YAML error, missing/duplicate `name`, wrong field shape) is rejected with a clear message; the Topic Gate always falls back to the built-in default and never crashes (the `UserPromptSubmit` hook must never block a prompt), and `lint --unknown-topics` also falls back for its scan but surfaces the rejection reason at the top of its report via the new `LintReport.vocabularyError` field. `Topic` is now a plain `string` at the type level rather than a closed union — validity is resolved at load time against whichever vocabulary is active. `src/tag/heuristics.ts` (the offline `tag` CLI) is unchanged and stays on the built-in default only, out of scope for this change — see README "Topic vocabulary" for the resulting gate/lint-vs-tag inconsistency when a corpus overrides the vocabulary. New `tests/vocab-loader.test.ts` plus extended `tests/topic.test.ts` / `tests/lint-topics.test.ts` cover custom-vocabulary load/match, missing/broken-file fallback, duplicate/missing-field rejection, and single-bad-pattern degradation (304 tests in the full suite, all pass; `npm run typecheck` clean; new tests verified to fail against the pre-change source). Example vocabulary at `tests/fixtures/vocab/topics.yml`. The real Pandora corpus vocabulary is not part of this change, it lands with the corpus rollout.

## [0.5.0] - 2026-06-16

**Coverage suite and security hardening.**

### Added

- `tests/coverage/` false-negative regression suite (PR #50): structured set of labelled prompts that exercise the router's pass/fail boundary so regressions in gate logic surface as test failures rather than silent behaviour drift.

### Security

- `tsx` bumped to `^4.22.4` (PR #55): clears two transitive `esbuild` advisories GHSA-gv7w-rqvm-qjhr and GHSA-g7r4-m6w7-qqqr.
- `hono` bumped to `^4.12.23` (PR #53): clears 4 MEDIUM CVEs in the dev dependency.
- `qs` bumped to `6.15.2` (PR #48): patches CVE-2026-8723.

### Tests

- Scrubbed a real repository name from one labelled prompt in the coverage fixture.

## [0.4.0] - 2026-05-24

### Added

- `memory-router test "<prompt>" [--dir <path>] [--semantic] [--max-hits <n>] [--json]` (#46): new CLI verb that dry-runs the live router (same matcher the UserPromptSubmit hook calls) against a memory corpus and prints which memories would fire, their gate (topic / tool / confidence), score, and description. Replaces the manual JSON-pipe workaround documented in memory `feedback_memory_router_dogfood`. Corpus dir resolution: `--dir` flag, then `$MEMORY_ROUTER_DIR` env; clean error when neither is set. Sync gates always run; `--semantic` opts into the async confidence gate with fail-open on missing `OPENAI_API_KEY` / network error. `--max-hits` caps printed matches; the parser refuses to swallow the next flag as a value, so `--max-hits --json` errors rather than silently consuming `--json`. `--json` emits a parseable report with `{ prompt, dir, hits: [{ id, name, description, gate, score, reason }] }` shape. New `tests/cli-test.test.ts` covers positive topic match against fixture, no-match path, JSON shape, `$MEMORY_ROUTER_DIR` fallback, missing-dir error, missing-prompt error, `--max-hits` swallow guard, `--max-hits` accepts integer (8 tests, all 188 in suite pass). Dogfooded against the real 55-memory corpus at `~/.claude/projects/-home-lan-git-pandora/memory`: positive prompt yields 5 topic matches, negative prompt prints "no match.".

### Changed

- `PACKAGE_VERSION` constant in `src/hooks/user-prompt-submit.ts` bumped to `0.4.0` in lockstep with `package.json` per the cli-version drift guard.

agent-tasks task `1e3a371f`, PR #46.

## [0.3.0] - 2026-05-15

### Added

- `memory-router-user-prompt-submit --version` (alias `-v`): fast-exit CLI short-circuit that prints the package version and returns 0 before touching stdin. Tooling that probes installed memory routers (e.g. `harness doctor`'s `memory.router.min_version` check in harness 0.13) otherwise hangs on `readStdin()` until the 5s probe budget expires. A new node:test in `tests/cli-version.test.ts` reads `package.json#version` and asserts the bin's stdout matches, catching drift if the in-source `PACKAGE_VERSION` constant gets out of sync with `package.json` on a release bump.

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
