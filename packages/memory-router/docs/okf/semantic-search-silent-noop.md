---
type: invariant
title: Semantic search's silent-no-op contract, and its loud counterpart
description: The conditions known at the time of writing under which semanticSearch() returns an empty array instead of throwing, with the stderr visibility of each, the errors that can propagate out of it instead, and how each of its callers, and each other openIndex() caller, handles those errors.
tags: [semantic-search, silent-no-op, embedding-index, provenance, native-deps]
timestamp: 2026-09-30T07:01:07Z
sources:
  - packages/memory-router/src/embed/indexer.ts
  - packages/memory-router/src/embed/index-store.ts
  - packages/memory-router/src/embed/provider.ts
  - packages/memory-router/src/router.ts
  - packages/memory-router/src/cli.ts
  - packages/memory-router/src/index.ts
  - packages/memory-router/src/mcp/server.ts
  - packages/memory-router/src/lint/conflicts.ts
  - packages/memory-router/src/consolidate/near-dupes.ts
  - packages/memory-router/tests/blend.test.ts
  - packages/memory-router/docs/scoring.md
---

# Semantic search's silent-no-op contract, and its loud counterpart

`semanticSearch()` (`packages/memory-router/src/embed/indexer.ts:202-279`)
is designed to return `[]`, not throw, when a corpus is not set up for
semantic search. Separately, a set of integrity and provenance checks in
the same subsystem throw instead, and what an operator sees for such a
throw depends on which caller invoked the search. Confusing "no results"
with "a real error some caller turned into no results" is the trap this
doc closes.

The call sites below are the ones among the hits of
`rg -n 'semanticSearch\b' packages/memory-router/src` at the time of
writing (comments, imports, and the definition set aside):

- `resolveBlended()` (`packages/memory-router/src/router.ts:182`), used by
  the `UserPromptSubmit` hook, MCP `memory_resolve`, and
  `memory-router eval`.
- `resolveConfidence()` (`packages/memory-router/src/router.ts:69`), used
  by `memory-router test --semantic`.
- MCP `memory_search` (`packages/memory-router/src/mcp/server.ts:84-89`),
  which calls it directly.
- The package entry point re-exports it
  (`packages/memory-router/src/index.ts:35`), so a library consumer can
  call it as well.

## Silent-`[]` paths

The paths known at the time of writing, from
`rg -n 'return \[\]|\.filter\(' packages/memory-router/src/embed/indexer.ts packages/memory-router/src/embed/index-store.ts`
plus a reading of `search()`
(`packages/memory-router/src/embed/index-store.ts:779-807`) for a KNN
query that itself returns no rows:

| # | Condition | Where checked | stderr |
|---|---|---|---|
| 1 | No embedding provider resolvable | `resolveProviderConfig` returns `null`, `packages/memory-router/src/embed/indexer.ts:208-209` | none |
| 2 | Embedding index file does not exist on disk | `existsSync(idx)` is false, `packages/memory-router/src/embed/indexer.ts:211-220` | one line per process (`missingIndexWarned`, `packages/memory-router/src/embed/indexer.ts:213-214`) |
| 3 | Index exists, nothing has ever been embedded into it, and no width is recorded yet (see the `lint --conflicts --semantic` note below) | `dimensions === null`, `packages/memory-router/src/embed/index-store.ts:784` | none |
| 4 | Index had entries, but all of them were later removed (the rebuild's removal loop, `packages/memory-router/src/embed/indexer.ts:156-161`, deletes each entry's vector row, `packages/memory-router/src/embed/index-store.ts:616-621`) | the vector table keeps its recorded width, so `search()` passes the `dimensions` guard and the KNN query returns no rows | none (`countEntriesWithStaleModel` is 0) |
| 5 | The `k` nearest-neighbor rows the KNN query returned all carry a different model tag (or a pre-v2 `NULL` tag) than the caller's model | model filter runs after the KNN `LIMIT k`, `packages/memory-router/src/embed/index-store.ts:790-802` | see below |
| 6 | A returned hit's `id` is not in the caller's loaded-memories map (the memory was removed from disk since it was indexed) | `byId` filter, `packages/memory-router/src/embed/indexer.ts:265-275` | none |

Row 5 is the path that coincides with the stale-model line
(`packages/memory-router/src/embed/indexer.ts:233-238`). That line is
written on every call that opens the index and finds at least one
stale-model row in it, whether or not this call's results lost anything
to the filter, and it reports a corpus-wide count, not which query was
affected. Row 5 is also a
crowding-out case, not only an "everything is stale" case: the filter runs
on the `k` rows the KNN `LIMIT` already picked, so stale rows inside the
top `k` take slots that current-model rows just outside it would
otherwise have filled, and a query can return fewer than `k` results, down
to zero, while current-model matches exist further down the unfiltered
ranking.

Row 1 is easy to misread as "operator never configured embeddings."
`resolveProviderConfig({ autoDetectOllama: true })`
(`packages/memory-router/src/embed/indexer.ts:208`,
`packages/memory-router/src/embed/provider.ts:199-223`) auto-detects a
local Ollama endpoint when no provider is set explicitly and no
`OPENAI_API_KEY` is present
(`packages/memory-router/src/embed/provider.ts:218-221`), so an
unconfigured machine reaches row 2 instead. The `null` return comes from
`MEMORY_ROUTER_EMBED_PROVIDER=openai` set with no `OPENAI_API_KEY`
(`packages/memory-router/src/embed/provider.ts:206-211`), a fail-open for
an explicit misconfiguration.

## Errors that can propagate out of `semanticSearch()`

The throws known at the time of writing on the `semanticSearch()` path,
from `rg -n 'throw ' packages/memory-router/src/embed/index-store.ts packages/memory-router/src/embed/indexer.ts`
(this does not enumerate errors raised inside `better-sqlite3` or
`sqlite-vec` themselves):

- Provider mismatch, in `openIndex()`
  (`packages/memory-router/src/embed/index-store.ts:415-426`): the index
  recorded a different `embed_provider` than the active config.
- Legacy provenance, in `openIndex()`
  (`packages/memory-router/src/embed/index-store.ts:428-457`): a
  pre-provenance index whose rows carry a different model tag than the
  active config.
- Other open-time integrity errors in `openIndex()`: an invalid, too-new,
  or unmigratable schema version (`applyMigrations`,
  `packages/memory-router/src/embed/index-store.ts:172`, `:177`, `:186`,
  run on this writable open at
  `packages/memory-router/src/embed/index-store.ts:356`), an unreadable
  vector-table width (`packages/memory-router/src/embed/index-store.ts:341`),
  and recorded dimensions that disagree with the vector table
  (`packages/memory-router/src/embed/index-store.ts:379`).
- Fresh-query dimension mismatch, thrown by `putCachedQuery`
  (`packages/memory-router/src/embed/index-store.ts:757-760`, message
  starting `cached embedding dimension`), which `semanticSearch` calls at
  `packages/memory-router/src/embed/indexer.ts:262`, before `search()` at
  `packages/memory-router/src/embed/indexer.ts:264`.
- `search()`'s own query-dimension check
  (`packages/memory-router/src/embed/index-store.ts:785-789`), reached
  only when the query vector came from the query cache
  (`packages/memory-router/src/embed/indexer.ts:240`), since a freshly
  embedded vector meets `putCachedQuery`'s check first.
- Embed-call failure: `embedBatch()` rejects, and
  `packages/memory-router/src/embed/indexer.ts:259-261` catches it and
  rethrows it wrapped by `describeEmbedError`.

`upsert`'s throws (`packages/memory-router/src/embed/index-store.ts:594-611`)
are not on this path: `semanticSearch()` does not call `upsert`.

### What each caller does with them

- `resolveBlended()` (`packages/memory-router/src/router.ts:181-187`)
  catches any throw from the search and degrades to `resolve()`
  (`packages/memory-router/src/router.ts:248`). The returned hits equal
  the unconfigured case: see [docs/scoring.md "Degradation and the Tool
  Gate"](../scoring.md#degradation-and-the-tool-gate), pinned by the
  tests at `packages/memory-router/tests/blend.test.ts:449` (a thrown
  search) and `packages/memory-router/tests/blend.test.ts:473` (no
  index/provider). stderr does not equal it: the catch interpolates
  `String(err)` (`packages/memory-router/src/router.ts:185`), so the full
  error message, including the rebuild command a provenance error carries
  (`packages/memory-router/src/embed/index-store.ts:424`, `:453`), is
  written on every call that throws.
- `memory-router test --semantic`
  (`packages/memory-router/src/cli.ts:760-769`) catches the throw from
  `resolveConfidence`, writes a `warning:` line that also interpolates
  `String(err)` (`packages/memory-router/src/cli.ts:767`), and prints the
  sync-only hits.
- MCP `memory_search` (`packages/memory-router/src/mcp/server.ts:80-92`)
  has no catch in its handler: the error leaves the tool handler.

## Other `openIndex()` callers

These do not go through `semanticSearch()`. The call sites are the ones
`rg -n 'openIndex\(' packages/memory-router/src` finds at the time of
writing:

- `rebuildIndex()` (`packages/memory-router/src/embed/indexer.ts:132-136`),
  run by `memory-router index`
  (`packages/memory-router/src/cli.ts:573-574`). `runIndex` has no catch;
  the CLI's top-level handler
  (`packages/memory-router/src/cli.ts:1136-1139`) prints the error and
  exits non-zero, so a provider or legacy-provenance mismatch fails the
  command with the rebuild command in its text.
- `lint --conflicts --semantic`
  (`packages/memory-router/src/lint/conflicts.ts:497`) opens the index
  without `opts.meta`, so the provider-mismatch and legacy-provenance
  checks, both conditioned on `opts.meta`, do not run for it. It opens the
  index read-only (`readonly: true`) and passes no `dimensions` hint, so
  the open never creates the vector table or records a width: on an index
  with no recorded width the lookup finds no stored embeddings (the
  `dimensions === null` guard in `getEmbedding`,
  `packages/memory-router/src/embed/index-store.ts:632`) and the pass
  embeds the pairs fresh, and a later `semanticSearch()` still takes row 3
  under any model width. An `openIndex()` throw at this call site is
  caught (`packages/memory-router/src/lint/conflicts.ts:498-510`): one
  `--semantic: cannot open embedding index, embedding fresh without reuse`
  line, carrying the error message as its reason, goes to stderr, only the
  reuse of stored embeddings is skipped, and the pairs are embedded fresh
  as when no index exists, so a zero-byte or legacy pre-meta index file is
  left byte-identical and the semantic upgrade still happens; the index is
  only a reuse cache here.
- The consolidate near-duplicate pass
  (`packages/memory-router/src/consolidate/near-dupes.ts:141-157`) opens it
  read-only with `opts.meta`, catches an `openIndex()` throw, and reports
  the pass as skipped with the error message as its reason (the lint
  call site above also warns on an open failure, without `opts.meta`, but
  falls back to fresh embedding instead of skipping, since it does not need
  the index).

`packages/memory-router/src/embed/index-store.ts:44-79` states why the
provenance checks throw at all: embeddings from different providers are
never comparable. This doc's own reading of that intent is that a silent
`[]` for a provenance disagreement would look like "nothing indexed yet"
while meaning the index and the active configuration disagree.

Native-dependency note: `packages/memory-router/src/embed/index-store.ts`
loads `better-sqlite3` and `sqlite-vec` at module load; see
[native-deps-and-ci-smoke.md](native-deps-and-ci-smoke.md) in this bundle
for the CI step that loads them before the test run.
