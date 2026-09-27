---
type: invariant
title: Semantic search's silent-no-op contract, and its loud counterpart
description: The five distinct conditions under which semanticSearch() returns an empty array instead of throwing, which of those are visible on stderr, and the contrasting embedding-index provenance guard that throws instead, including which of its four call sites actually let that throw reach an operator versus swallow it into the same silent degradation.
tags: [semantic-search, silent-no-op, embedding-index, provenance, native-deps]
timestamp: 2026-09-27T14:48:54Z
sources:
  - packages/memory-router/src/embed/indexer.ts
  - packages/memory-router/src/embed/index-store.ts
  - packages/memory-router/src/embed/provider.ts
  - packages/memory-router/src/router.ts
  - packages/memory-router/src/cli.ts
  - packages/memory-router/src/mcp/server.ts
  - packages/memory-router/docs/scoring.md
  - packages/memory-router/README.md
---

# Semantic search's silent-no-op contract, and its loud counterpart

`semanticSearch()` in `packages/memory-router/src/embed/indexer.ts` is
reached by three different paths, not one shared chokepoint:
`resolveBlended()` (`packages/memory-router/src/router.ts`, called by the
`UserPromptSubmit` hook, MCP `memory_resolve`, and `memory-router eval`)
and `resolveConfidence()` (`packages/memory-router/src/router.ts:58-79`,
called by `memory-router test --semantic`) both call it internally, and
MCP's `memory_search` tool (`packages/memory-router/src/mcp/server.ts:84-89`)
calls it directly with no wrapper resolver at all. It is designed to never
throw for "this corpus isn't set up for semantic search yet": five
distinct states all return `[]` instead. But a separate part of the same
subsystem, the embedding index's own provenance guard inside
`openIndex()`, deliberately does the opposite and throws, and that throw
propagates straight out of `semanticSearch()` since nothing inside it
catches an `openIndex()` error. Confusing "no results" with "a real error
some caller swallowed" is the trap this doc closes.

## Every silent-`[]` path

| # | Condition | Where checked | stderr? |
|---|---|---|---|
| 1 | No embedding provider resolvable | `resolveProviderConfig` returns `null`, `packages/memory-router/src/embed/indexer.ts:208-209` | none, ever |
| 2 | Embedding index file does not exist on disk | `existsSync(idx)` is false, `packages/memory-router/src/embed/indexer.ts:211-220` | one line, once per process (`missingIndexWarned`) |
| 3 | Index exists but nothing has ever been embedded into it | `dimensions === null`, `packages/memory-router/src/embed/index-store.ts:784` | none |
| 4 | Every one of the `k` nearest-neighbor rows the KNN query returned carries a different embedding model tag (or a pre-v2 `NULL` tag) than the caller's model | Model filter runs after the KNN `LIMIT k`, `packages/memory-router/src/embed/index-store.ts:790-802` | one aggregate line, every call, whenever `countEntriesWithStaleModel(...) > 0` (`packages/memory-router/src/embed/indexer.ts:233-238`) |
| 5 | A returned hit's `id` is not present in the caller's loaded-memories map (the memory was removed from disk since it was indexed) | `byId` filter, `packages/memory-router/src/embed/indexer.ts:265-275` | none |

Row 4's stderr line reports a corpus-wide stale-row count, never which
specific query lost results to it, and it is not gated by a once-per-process
flag the way row 2's is: it repeats on every call while the condition
holds. It is also a crowding-out case, not only a rare "everything is
stale" total: because the model filter runs on the `k` rows the KNN
`LIMIT` already picked, a stale-model row that ranks inside the top `k` by
raw cosine distance takes a slot away from a current-model row that would
otherwise have ranked just outside that window, so a query can return
fewer results than `k`, down to zero, even when current-model matches
exist further down the full, unfiltered ranking. Rows 1, 3, and 5 have no
stderr signal at all: a caller staring at an empty result for one prompt
cannot distinguish any of rows 1, 3, 4, or 5 from each other, or from row
2 after its first warning, without instrumenting the index directly.

Row 1 is easy to misread as "operator never configured embeddings at
all." It is not: `resolveProviderConfig({ autoDetectOllama: true })`
(`packages/memory-router/src/embed/indexer.ts:208`,
`packages/memory-router/src/embed/provider.ts:199-223`) auto-detects a
local Ollama endpoint whenever no provider is set explicitly and no
`OPENAI_API_KEY` is present (`packages/memory-router/src/embed/provider.ts:218-221`),
so a genuinely unconfigured machine reaches row 2 (missing index) on its
first request instead. The `null` return from `resolveProviderConfig` is
reached only by the explicit-and-broken path: `MEMORY_ROUTER_EMBED_PROVIDER=openai`
set with no `OPENAI_API_KEY` (`packages/memory-router/src/embed/provider.ts:206-211`),
a deliberate fail-open for a misconfiguration the operator already opted
into, not a default state for an unconfigured one.

## The loud counterpart: provenance mismatches throw, but not every caller lets them through

`openIndex()` (`packages/memory-router/src/embed/index-store.ts`) throws,
rather than returning anything, from four places once a store is actually
opened or queried:

- Provider mismatch: an existing index recorded a different
  `embed_provider` than the caller's active config
  (`packages/memory-router/src/embed/index-store.ts:415-426`).
- Legacy-index provenance: a pre-provenance index (no recorded provider)
  whose rows already carry a different model tag than the active config
  (`packages/memory-router/src/embed/index-store.ts:428-457`).
- Query-dimension mismatch: a query embedding whose length disagrees with
  the index's recorded/physical dimension, inside `search()`
  (`packages/memory-router/src/embed/index-store.ts:785-789`).
- Embed-call failure: `embedBatch()` rejects (network/HTTP/timeout),
  rethrown with provider/model context by `describeEmbedError`
  (`packages/memory-router/src/embed/indexer.ts:259-261`).

None of these four is caught inside `semanticSearch()` itself; all four
propagate straight out of it. What happens next depends entirely on which
caller invoked it, and only two of the four production paths actually let
that reach an operator as a loud failure:

- `resolveBlended()` (`packages/memory-router/src/router.ts:181-187`)
  catches every throw `semanticSearch` produces, without inspecting what
  kind of error it is, writes one generic stderr line, and degrades to the
  topic/tool-only `resolve()` path: the same silent-to-the-prompt outcome
  as the five no-op rows above. A provenance mismatch or a corrupted
  query-dimension error is, at the hook/MCP-`memory_resolve`/eval level,
  indistinguishable from "no index configured."
- `memory-router test --semantic` (`packages/memory-router/src/cli.ts:762-766`)
  does the same for `resolveConfidence`'s call: any throw is caught,
  printed as a `warning:` line, and the command falls back to sync-only
  hits rather than failing.
- MCP `memory_search` (`packages/memory-router/src/mcp/server.ts:84-89`)
  installs no catch of its own: any of the four throws above propagates
  out of the tool handler as a real MCP tool error.
- `memory-router index` (the rebuild path,
  `packages/memory-router/src/cli.ts:570-571` calling `rebuildIndex`)
  opens the index directly, not through `semanticSearch`, and also
  installs no catch: a provider or legacy-provenance mismatch fails the
  whole command loudly, with the exact rebuild command in the error text.

So "provenance mismatches throw" is true of `openIndex()` itself, but only
`memory_search` and `index` actually surface that as a loud failure; the
two paths built on `resolveBlended`/`resolveConfidence` degrade it into
the same quiet outcome as an unconfigured corpus. `packages/memory-router/src/embed/index-store.ts:44-79`
states the reason for throwing at all: different providers are never
comparable. This doc's own reading of that design intent is that a silent
`[]` for a real provenance disagreement would look identical to "nothing
indexed yet" while actually meaning the index and the active
configuration disagree, a state worth failing loudly for at the two call
sites that do let it through.

Native-dependency note: `packages/memory-router/src/embed/index-store.ts`
loads `better-sqlite3` and `sqlite-vec` unconditionally at module load
(`require('better-sqlite3')`, `sqliteVec.load(db)`); see
[native-deps-and-ci-smoke.md](native-deps-and-ci-smoke.md) in this bundle
for how a native-addon ABI mismatch is caught before it reaches any of the
paths above.
