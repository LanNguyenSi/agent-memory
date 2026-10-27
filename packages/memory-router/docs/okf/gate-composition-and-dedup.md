---
type: invariant
title: Three resolvers, two dedup rules
description: memory-router exports three resolvers that combine gate/signal hits into a ranked list; this maps each production call site to its resolver and gate set, and states how the two dedup/ranking functions underneath them differ.
tags: [gate-composition, dedup, resolveBlended, resolve, rankWithToolPrivilege]
timestamp: 2026-10-27T11:06:16Z
sources:
  - packages/memory-router/src/router.ts
  - packages/memory-router/src/render.ts
  - packages/memory-router/src/index.ts
  - packages/memory-router/src/hooks/pre-tool-use.ts
  - packages/memory-router/src/hooks/user-prompt-submit.ts
  - packages/memory-router/src/mcp/server.ts
  - packages/memory-router/src/cli.ts
  - packages/memory-router/src/eval/runner.ts
  - packages/memory-router/tests/blend.test.ts
---

# Three resolvers, two dedup rules

`packages/memory-router/src/router.ts` exports three resolvers (`resolve`,
`resolveConfidence`, `resolveBlended`; its `module.exports` at
`packages/memory-router/src/router.ts:568-574`), and it is easy to assume
there is one canonical way memory-router combines gate hits. There is not:
the call sites in the table below pick different resolvers, for different
reasons, and the two dedup/ranking functions underneath them
(`dedupeAndRank`, `rankWithToolPrivilege`) apply the same tie-break rule but
allocate result slots differently.

## Which caller uses which resolver

| Call site | Resolver | Gate set |
|---|---|---|
| `PreToolUse` hook (`packages/memory-router/src/hooks/pre-tool-use.ts:30`) | `resolve(ctx, memories, { gates: [toolGate] })` | Tool Gate only, explicitly overriding `DEFAULT_GATES` |
| `memory-router test` CLI verb, no `--semantic` | `resolve(ctx, memories, { maxHits })` (default `opts.gates`) | `DEFAULT_GATES = [topicGate, toolGate]` |
| `memory-router test --semantic` | `resolve(...)` then `resolveConfidence(...)`, merged via `dedupeAndRank` (`packages/memory-router/src/cli.ts:783-797`) | Topic + Tool (sync) plus Confidence (async), as two separate calls |
| `UserPromptSubmit` hook, MCP `memory_resolve`, `memory-router eval` | `resolveBlended(ctx, memories, memoryDir)` | Semantic score (dominant) + Topic Gate (boost) + recency/type modifiers, plus Tool Gate only when `ctx.tool` is set |

The two hook callers also differ in how they render their hits, not only in
which resolver produced them: `UserPromptSubmit` renders through
`renderHitsBudgeted` (`packages/memory-router/src/hooks/user-prompt-submit.ts:64`,
`packages/memory-router/src/render.ts:386`), which injects short memories
whole and long ones as description + matching chunk + path (a long
`type: feedback` memory's excerpt also carries its `How to apply` paragraph
when the matched chunk misses it) under a byte
budget, while `PreToolUse` renders through the unbudgeted
`renderHitsAsContext` (`packages/memory-router/src/hooks/pre-tool-use.ts:31`,
`packages/memory-router/src/render.ts:135`) and so always injects each hit's
full body.

Two things worth stating explicitly:

- `DEFAULT_GATES` (`packages/memory-router/src/router.ts:26`) is **not**
  what the `PreToolUse` hook runs. It passes its own `{ gates: [toolGate]
  }`, dropping the Topic Gate entirely, since a pending tool call has no
  prompt text for the Topic Gate's keyword match to run against.
  `DEFAULT_GATES` is used by every `resolve()` call that passes no `gates`
  option (`packages/memory-router/src/router.ts:59`): among them the `test`
  CLI verb's `resolve(ctx, memories, { maxHits })` call
  (`packages/memory-router/src/cli.ts:783`), run whether or not
  `--semantic` is also passed, and `resolveBlended`'s own degraded
  fallback (`packages/memory-router/src/router.ts:333-334`, `resolve(ctx, memories, { maxHits })`;
  since schema v4 a keyword-admitted memory may take the first slots ahead of that
  output (see score-blend-resolver.md)). That fallback shapes the
  `UserPromptSubmit` hook's injected context, MCP `memory_resolve`'s
  result, and `memory-router eval`'s scored output on every degraded run
  (see [score-blend-resolver.md](score-blend-resolver.md) in this bundle
  for the branches), and `packages/memory-router/tests/blend.test.ts:473`
  pins that degraded output equal to `resolve()`'s own. `PreToolUse`'s
  `{ gates: [toolGate] }` is the only `resolve()` call that overrides the
  gate set (`rg -n 'gates:' packages/memory-router/src` finds it and no
  other at the time of writing).
- `resolveConfidence` (`packages/memory-router/src/router.ts:68-89`) is the
  narrowest of the three resolvers this module exports: the Confidence
  Gate run in isolation, with its own `maxHits` default (`3`, vs.
  `resolve`'s and `resolveBlended`'s `5`). Its only call site under
  `packages/memory-router/src` is the `test --semantic` path
  (`packages/memory-router/src/cli.ts:788`), per
  `rg -n 'resolveConfidence\b' packages/memory-router/src`, which also
  shows the package entry point re-exporting it
  (`packages/memory-router/src/index.ts:30`); `resolveBlended` does not
  call it and runs its own semantic search.

## Two dedup functions, one shared tie-break, different slot allocation

`dedupeAndRank` (`packages/memory-router/src/router.ts:91-98`) is the
simpler of the two: keep the highest-scoring hit per `memory.id` across
every input hit, sort the survivors descending by score, and slice to
`maxHits`. `resolve()` uses it internally, and `cli.ts`'s `test --semantic`
path uses it directly to merge the sync gates' hits with the confidence
gate's hits into one ranked list.

`rankWithToolPrivilege` (`packages/memory-router/src/router.ts:545-566`),
called only from `resolveBlended`
(`rg -n 'rankWithToolPrivilege\(' packages/memory-router/src`), starts
from the same per-id "highest score wins" merge, but then partitions the
merged hits into two buckets (memories the Tool Gate matched, everything
else), sorts each bucket separately by score, and concatenates
tool-privileged hits ahead of the rest before slicing to `maxHits`. The
practical difference: under plain `dedupeAndRank`, a memory the Tool Gate
matched (a deterministic `1.0` hit) can be pushed out of the result by
enough higher-scoring blend hits; under `rankWithToolPrivilege`, a
blend-scored hit cannot displace it, because tool-matched hits are placed
ahead of all other hits before the `maxHits` slice
(`packages/memory-router/src/router.ts:562-565`).
Attribution for a memory hit by both paths is unaffected by this
difference (whichever hit has the higher score still wins the
`gate`/`score`/`reason` fields, in both functions); what differs is which
memories make the final cut.

This split matters for MCP `memory_resolve`, which builds `ctx` with an
optional `tool` next to the prompt
(`packages/memory-router/src/mcp/server.ts:117-125`). The `UserPromptSubmit`
hook (`packages/memory-router/src/hooks/user-prompt-submit.ts:40`) and
`memory-router eval` (`packages/memory-router/src/eval/runner.ts:345`)
build `ctx` with no `tool` field. For a prompt that scored many memories
highly while a pending command also matched a memory, the Tool Gate hit
keeps its slot regardless of the blend score distribution.
