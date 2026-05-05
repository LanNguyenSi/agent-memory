# Changelog

All notable changes to `@lannguyensi/memory-router` are recorded here.
Versions follow [semver](https://semver.org/). The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
