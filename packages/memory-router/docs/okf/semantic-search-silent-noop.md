---
type: invariant
title: Semantic search's silent-no-op contract, and its loud counterpart
description: The conditions known at the time of writing under which semanticSearch() returns an empty array instead of throwing, with the stderr visibility of each, the errors that can propagate out of it instead, and how each of its callers, and each other openIndex() caller, handles those errors.
tags: [semantic-search, silent-no-op, embedding-index, provenance, native-deps]
timestamp: 2026-10-26T21:32:26Z
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

`semanticSearch()` (`packages/memory-router/src/embed/indexer.ts:328-445`)
is designed to return `[]`, not throw, when a corpus is not set up for
semantic search. Since schema v3 it scores each memory as the better of
its document vector and its best body chunk, so it runs two KNN queries
(`store.search` and `store.searchChunks`,
`packages/memory-router/src/embed/indexer.ts:397-398`) and merges them by
id; both paths are covered by the same contract. Separately, a set of
integrity and provenance checks in the same subsystem throw instead, and
what an operator sees for such a throw depends on which caller invoked
the search. Confusing "no results" with "a real error some caller turned
into no results" is the trap this doc closes.

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
(`packages/memory-router/src/embed/index-store.ts:1066-1109`) and
`searchChunks()` (`packages/memory-router/src/embed/index-store.ts:1121-1162`)
for a KNN query that itself returns no rows:

| # | Condition | Where checked | stderr |
|---|---|---|---|
| 1 | No embedding provider resolvable | `resolveProviderConfig` returns `null`, `packages/memory-router/src/embed/indexer.ts:334-335` | none |
| 2 | Embedding index file does not exist on disk | `existsSync(idx)` is false, `packages/memory-router/src/embed/indexer.ts:338-346` | one line per process (`missingIndexWarned`, `packages/memory-router/src/embed/indexer.ts:339-340`) |
| 3 | Index exists, nothing has ever been embedded into it, and no width is recorded yet (see the `lint --conflicts --semantic` note below) | `dimensions === null`, `packages/memory-router/src/embed/index-store.ts:1071` | none |
| 4 | Index had entries, but all of them were later removed (the rebuild's removal loop, `packages/memory-router/src/embed/indexer.ts:242-245`, deletes each entry's vector row, `packages/memory-router/src/embed/index-store.ts:839-858`) | the vector table keeps its recorded width, so `search()` passes the `dimensions` guard and the KNN query returns no rows | none (`countEntriesWithStaleModel` is 0) |
| 5 | Every row inside the KNN window carries a different model tag (or a pre-v2 `NULL` tag) than the caller's model: the window starts at `k` and widens x4 per retry up to sqlite-vec's 4096-row KNN ceiling (`MAX_KNN_K`), and the search stops early once the index is exhausted, so this needs at least that many stale rows nearer to the query than the nearest current-model row | model filter inside the widening loop, `packages/memory-router/src/embed/index-store.ts:1082-1104` (documents) and `:1146-1155` (chunks) | see below |
| 6 | A returned hit's `id` is not in the caller's loaded-memories map (the memory was removed from disk since it was indexed) | `byId` filter, `packages/memory-router/src/embed/indexer.ts:422-441` | none |

A memory whose chunks are absent or all stale scores on its document
vector alone: `searchChunks()` returns `[]` when the file has no chunk
tables or no chunk rows yet (a v2 index migrated but not yet re-indexed,
`packages/memory-router/src/embed/index-store.ts:1126-1128`), and that
path is silent by design. It can only ever lower the chunk contribution,
never the document one, so it never produces an empty result on its own.

Row 5 is the path that coincides with the stale-model line
(`packages/memory-router/src/embed/indexer.ts:359-365`). That line is
written the first time in a process that a call opens the index and finds
at least one stale-model row in it (`staleModelWarned`,
`packages/memory-router/src/embed/indexer.ts:360-361`), whether or not
that call's results lost anything to the filter, and it reports a
corpus-wide count, not which query was affected. Later calls in the same
process stay silent, and a call that finds no stale rows does not use up
the one warning. Row 5 is no longer a crowding-out case: `search()` filters by model while
it widens the KNN window (`packages/memory-router/src/embed/index-store.ts:1082-1104`),
so stale rows inside the top `k` no longer take slots that current-model
rows just outside it should fill. A query returns fewer than `k` results
only when fewer than `k` current-model rows exist within the reachable
window, that is the whole index, or its 4096 nearest rows when the index
is larger than sqlite-vec's KNN ceiling. A `k` above 4096 with a model
filter returns at most 4096 hits instead of throwing (the no-filter path
still throws). Cost: one KNN pass when the first `k` rows suffice,
otherwise up to one extra full-table KNN scan per x4 widening (bounded by
the ceiling), with no schema change to existing index files.
`searchChunks()` widens the same way but stops on `k` DISTINCT memory ids
rather than `k` rows, keeping one best chunk per id
(`packages/memory-router/src/embed/index-store.ts:1142-1155`), because a
long memory's own chunks would otherwise fill any plain `LIMIT` and crowd
every other memory out of the top k.

Row 1 is easy to misread as "operator never configured embeddings."
`resolveProviderConfig({ autoDetectOllama: true })`
(`packages/memory-router/src/embed/indexer.ts:334`,
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
  (`packages/memory-router/src/embed/index-store.ts:532-543`): the index
  recorded a different `embed_provider` than the active config.
- Legacy provenance, in `openIndex()`
  (`packages/memory-router/src/embed/index-store.ts:556-574`): a
  pre-provenance index whose rows carry a different model tag than the
  active config.
- Other open-time integrity errors in `openIndex()`: an invalid, too-new,
  or unmigratable schema version (`applyMigrations`,
  `packages/memory-router/src/embed/index-store.ts:221`, `:226`, `:235`,
  run on this writable open at
  `packages/memory-router/src/embed/index-store.ts:460`), an unreadable
  vector-table width (`packages/memory-router/src/embed/index-store.ts:422-426`,
  and the same recovery for the v3 chunk table at
  `:444-448`), recorded dimensions that disagree with the vector table
  (`packages/memory-router/src/embed/index-store.ts:478-486`), and a
  `vec`/`chunk_vec` width disagreement
  (`packages/memory-router/src/embed/index-store.ts:491-499`).
- Fresh-query dimension mismatch, thrown by `putCachedQuery`
  (`packages/memory-router/src/embed/index-store.ts:1044-1048`, message
  starting `cached embedding dimension`), which `semanticSearch` calls at
  `packages/memory-router/src/embed/indexer.ts:389`, before `search()` at
  `packages/memory-router/src/embed/indexer.ts:397`.
- `search()`'s own query-dimension check
  (`packages/memory-router/src/embed/index-store.ts:1072-1076`) and
  `searchChunks()`'s identical one
  (`packages/memory-router/src/embed/index-store.ts:1129-1133`), reached
  only when the query vector came from the query cache
  (`packages/memory-router/src/embed/indexer.ts:367`), since a freshly
  embedded vector meets `putCachedQuery`'s check first.
- Embed-call failure: `embedBatch()` rejects, and
  `packages/memory-router/src/embed/indexer.ts:386-388` catches it and
  rethrows it wrapped by `describeEmbedError`.

`upsert`'s throws (`packages/memory-router/src/embed/index-store.ts:803-822`)
and `replaceChunks`' throws
(`packages/memory-router/src/embed/index-store.ts:883-908`) are not on
this path: `semanticSearch()` does not write.

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
  (`packages/memory-router/src/embed/index-store.ts:541`, `:570`), is
  written on every call that throws.
- `memory-router test --semantic`
  (`packages/memory-router/src/cli.ts:776-787`) catches the throw from
  `resolveConfidence`, writes a `warning:` line that also interpolates
  `String(err)` (`packages/memory-router/src/cli.ts:784`), and prints the
  sync-only hits.
- MCP `memory_search` (`packages/memory-router/src/mcp/server.ts:80-92`)
  has no catch in its handler: the error leaves the tool handler.

## Other `openIndex()` callers

These do not go through `semanticSearch()`. The call sites are the ones
`rg -n 'openIndex\(' packages/memory-router/src` finds at the time of
writing:

- `rebuildIndex()` (`packages/memory-router/src/embed/indexer.ts:167-171`),
  run by `memory-router index`
  (`packages/memory-router/src/cli.ts:582-583`). `runIndex` has no catch;
  the CLI's top-level handler
  (`packages/memory-router/src/cli.ts:1153-1156`) prints the error and
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
  `packages/memory-router/src/embed/index-store.ts:919`) and the pass
  embeds the pairs fresh, and a later `semanticSearch()` still takes row 3
  under any model width. An `openIndex()` throw at this call site is
  caught (`packages/memory-router/src/lint/conflicts.ts:498-515`): one
  `--semantic: cannot open embedding index, embedding fresh without reuse`
  line, carrying the error message as its reason (with
  ``run `memory-router index <dir>` to rebuild it`` appended unless the
  reason ends in the inconsistent-width repair advice or the
  newer-schema `upgrade memory-router` advice),
  goes to stderr, only the
  reuse of stored embeddings is skipped, and the pairs are embedded fresh
  as when no index exists, so a zero-byte or legacy pre-meta index file is
  left byte-identical and the semantic upgrade still happens; the index is
  only a reuse cache here.
  The read-only open skips `applyMigrations`, so the newer-schema error is
  not currently emitted by this lint path; its warning formatting still
  preserves upgrade advice if that reason is supplied. A path containing
  `rebuild` in a raw error does not suppress the rebuild hint. The same
  readonly rule covers the schema v3 chunk tables: a readonly open neither
  creates nor migrates them, and its chunk reads return nothing when the
  file does not have them
  (`packages/memory-router/src/embed/index-store.ts:1126-1128`), so a
  pre-v3 index file is left byte-identical by such an open too.
- The consolidate near-duplicate pass
  (`packages/memory-router/src/consolidate/near-dupes.ts:141-157`) opens it
  read-only with `opts.meta`, catches an `openIndex()` throw, and reports
  the pass as skipped with the error message as its reason (the lint
  call site above also warns on an open failure, without `opts.meta`, but
  falls back to fresh embedding instead of skipping, since it does not need
  the index).

`packages/memory-router/src/embed/index-store.ts:31-83` states why the
provenance checks throw at all: embeddings from different providers are
never comparable. This doc's own reading of that intent is that a silent
`[]` for a provenance disagreement would look like "nothing indexed yet"
while meaning the index and the active configuration disagree. The
document vector and `getEmbedding` are deliberately unchanged by schema
v3, so the near-duplicate pass and `lint --conflicts --semantic` keep
reading document vectors only and are unaffected by the chunk tables.

Native-dependency note: `packages/memory-router/src/embed/index-store.ts`
loads `better-sqlite3` and `sqlite-vec` at module load; see
[native-deps-and-ci-smoke.md](native-deps-and-ci-smoke.md) in this bundle
for the CI step that loads them before the test run.
