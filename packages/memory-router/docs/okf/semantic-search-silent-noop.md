---
type: invariant
title: Semantic search's silent-no-op contract, and its loud counterpart
description: The exact conditions under which semanticSearch() returns an empty array instead of throwing, which of those are visible on stderr, and the contrasting case (embedding-index provenance mismatch) where the same file throws instead of staying quiet.
tags: [semantic-search, silent-no-op, embedding-index, provenance, native-deps]
timestamp: 2026-09-27T14:18:37Z
sources:
  - packages/memory-router/src/embed/indexer.ts
  - packages/memory-router/src/embed/index-store.ts
  - packages/memory-router/src/router.ts
  - packages/memory-router/README.md
---

# Semantic search's silent-no-op contract, and its loud counterpart

`semanticSearch()` in `packages/memory-router/src/embed/indexer.ts` is the
one entry point every caller (the score-blend resolver, the MCP
`memory_search` tool, `memory-router eval`) goes through for a raw semantic
hit list. It is designed to never throw for "this corpus isn't set up for
semantic search yet": every one of those states returns `[]` instead. But
"returns `[]`" covers two structurally different situations, and a
separate part of the same subsystem (the embedding index's own provenance
guard) deliberately does the opposite and throws. Confusing the two when
debugging "why did nothing come back" is the trap this doc closes.

## The two silent-`[]` paths

| Condition | Where checked | Return | stderr? |
|---|---|---|---|
| No embedding provider resolvable (e.g. `MEMORY_ROUTER_EMBED_PROVIDER=openai` with no `OPENAI_API_KEY`) | `resolveProviderConfig` returns null, `packages/memory-router/src/embed/indexer.ts:208-209` | empty array | none, ever |
| Embedding index file does not exist on disk | `existsSync(idx)` is false, `packages/memory-router/src/embed/indexer.ts:211-220` | empty array | one line, once per process (`missingIndexWarned`) |

The first case is completely silent by design: an operator who never
configured an embedding provider at all should not see a warning on every
prompt. The second case is silent in its *return value* but not entirely
invisible: the very first time a caller in this process asks for semantic
search against a missing index, `packages/memory-router/src/embed/indexer.ts:211-220`
writes one `memory-router: embedding index missing, run \`memory-router
index <dir>\` to build it.` line to stderr and flips module-level
`missingIndexWarned` so every later call in the same process stays fully
quiet. This is the same "once per process, not once per call" shape
[docs/scoring.md](../scoring.md#embedding-provider) documents for the
provider/model reference elsewhere in this package; here it protects a
long-lived caller (the MCP server) from repeating the hint on every single
tool call in a session.

## The third case: results, not the call, go silently empty

Once an index exists and a query embedding is produced, `search()` in
`packages/memory-router/src/embed/index-store.ts:779-807` filters out any
row whose stored `model` does not match the caller's `expectedModel`
(`packages/memory-router/src/embed/index-store.ts:799-802`), a row left
over from a previous embedding model, or a pre-schema-v2 row with a `NULL`
model tag. That filter is unconditional and silent at the row level: a
memory that *is* indexed can still fail to surface for a query if its
stored embedding belongs to a different model, with no per-row signal.
The only visibility into this is aggregate and separate:
`packages/memory-router/src/embed/indexer.ts:233-238` counts stale-model
rows via `countEntriesWithStaleModel` and writes one stderr line whenever
the count is greater than zero, on every call (not gated by a once-per-process
flag the way the missing-index case is); the corpus-level signal
("N entries need a rebuild") is separate from, and does not name, which
individual query results were filtered.

## The loud counterpart: provenance mismatches throw

Contrast the three cases above with what happens when `openIndex()`
(`packages/memory-router/src/embed/index-store.ts`) detects that an
*existing* index was built under a different provider than the one now
configured: it throws immediately, synchronously, at open time
(`packages/memory-router/src/embed/index-store.ts:415-426`), carrying an
exact rebuild command
(`` `rm -rf '<dir>/.memory-router' && memory-router index '<dir>'` ``,
built by `rebuildCommandFor` in
`packages/memory-router/src/embed/indexer.ts:39-45`). A legacy index with
no recorded provenance at all, but whose rows already carry a different
model tag than the active configuration, throws the same way rather than
silently re-stamping itself with the active config
(`packages/memory-router/src/embed/index-store.ts:428-457`). Both throws
propagate out of `openIndex()`, so `semanticSearch()` and `rebuildIndex()`
do **not** catch them into a `[]`/report return the way the three no-op
cases above are handled; they surface as a real, unhandled error to
whichever caller invoked them. Design intent, stated at
`packages/memory-router/src/embed/index-store.ts:44-79`: a provider
mismatch means the two embedding spaces are never comparable, so a silent
`[]` here would look identical to "nothing indexed yet" while actually
meaning "your index and your configuration disagree", a state worth
failing loudly for, unlike the three genuinely-unconfigured states this
doc opens with.

Native-dependency note: `packages/memory-router/src/embed/index-store.ts`
loads `better-sqlite3` and `sqlite-vec` unconditionally at module load
(`require('better-sqlite3')`, `sqliteVec.load(db)`); see
[native-deps-and-ci-smoke.md](native-deps-and-ci-smoke.md) in this bundle
for how a native-addon ABI mismatch is caught before it reaches any of the
paths above.
