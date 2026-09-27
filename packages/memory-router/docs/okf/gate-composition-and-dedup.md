---
type: invariant
title: Three resolvers, two dedup rules
description: memory-router has three distinct ways to combine gate/signal hits into a ranked list, used by three different call sites; this maps each call site to its resolver and states the one real difference between the two dedup/ranking functions underneath them.
tags: [gate-composition, dedup, resolveBlended, resolve, rankWithToolPrivilege]
timestamp: 2026-09-27T14:18:37Z
sources:
  - packages/memory-router/src/router.ts
  - packages/memory-router/src/gates/topic.ts
  - packages/memory-router/src/gates/tool.ts
  - packages/memory-router/src/hooks/pre-tool-use.ts
  - packages/memory-router/src/hooks/user-prompt-submit.ts
  - packages/memory-router/src/mcp/server.ts
  - packages/memory-router/src/cli.ts
  - packages/memory-router/src/eval/runner.ts
  - packages/memory-router/README.md
  - packages/memory-router/docs/scoring.md
---

# Three resolvers, two dedup rules

`packages/memory-router/src/router.ts` exports three top-level resolvers
(`resolve`, `resolveConfidence`, `resolveBlended`), and it is easy to assume
there is one canonical way memory-router combines gate hits. There is not:
three production call sites each pick a different resolver, for different
reasons, and the two dedup/ranking functions underneath them
(`dedupeAndRank`, `rankWithToolPrivilege`) apply the same tie-break rule but
allocate result slots differently.

## Which caller uses which resolver

| Call site | Resolver | Gate set |
|---|---|---|
| `PreToolUse` hook (`packages/memory-router/src/hooks/pre-tool-use.ts`) | `resolve(ctx, memories, { gates: [toolGate] })` | Tool Gate only, explicitly overriding `DEFAULT_GATES` |
| `memory-router test` CLI verb, no `--semantic` | `resolve(ctx, memories, { maxHits })` (default `opts.gates`) | `DEFAULT_GATES = [topicGate, toolGate]` |
| `memory-router test --semantic` | `resolve(...)` then `resolveConfidence(...)`, merged via `dedupeAndRank` (`packages/memory-router/src/cli.ts:753-766`) | Topic + Tool (sync) plus Confidence (async), as two separate calls |
| `UserPromptSubmit` hook, MCP `memory_resolve`, `memory-router eval` | `resolveBlended(ctx, memories, memoryDir, opts)` | Semantic score (dominant) + Topic Gate (boost) + recency/type modifiers, plus Tool Gate only when `ctx.tool` is set |

Two things worth stating explicitly:

- `DEFAULT_GATES` (`packages/memory-router/src/router.ts:16`) is **not**
  what the `PreToolUse` hook runs. It passes its own `{ gates: [toolGate]
  }`, dropping the Topic Gate entirely, since a pending tool call has no
  prompt text for the Topic Gate's keyword match to run against.
  `DEFAULT_GATES` is reached by every call that passes no `gates` option:
  that is the `test` CLI verb's `resolve(ctx, memories, { maxHits })` call
  (`packages/memory-router/src/cli.ts:753`), run unconditionally whether or
  not `--semantic` is also passed, and `resolveBlended`'s own degraded
  fallback (`packages/memory-router/src/router.ts:248`, `return
  resolve(ctx, memories, { maxHits })`). That fallback is not a rare
  corner case: it is what shapes the `UserPromptSubmit` hook's injected
  context, MCP `memory_resolve`'s result, and `memory-router eval`'s
  scored output on every degraded run (no usable embedding index/provider,
  a semantic-search failure, or an all-below-floor result; see
  [score-blend-resolver.md](score-blend-resolver.md) in this bundle), and
  `tests/blend.test.ts:473` pins that degraded output equal to `resolve()`'s
  own. `PreToolUse`'s explicit `{ gates: [toolGate] }` override is the only
  path that never reaches `DEFAULT_GATES`.
- `resolveConfidence` (`packages/memory-router/src/router.ts:58-79`) is the
  narrowest of the three resolvers this module exports: the Confidence
  Gate run in isolation, with its own `maxHits` default (`3`, vs.
  `resolve`'s and `resolveBlended`'s `5`). Its only production caller is
  the `test --semantic` path in `cli.ts`; `resolveBlended` does not call it
  and has its own independent semantic-search integration.

## Two dedup functions, one shared tie-break, different slot allocation

`dedupeAndRank` (`packages/memory-router/src/router.ts:81-88`) is the
simpler of the two: keep the highest-scoring hit per `memory.id` across
every input hit, sort the survivors descending by score, and slice to
`maxHits`. `resolve()` uses it internally, and `cli.ts`'s `test --semantic`
path uses it directly to merge the sync gates' hits with the confidence
gate's hits into one ranked list.

`rankWithToolPrivilege` (`packages/memory-router/src/router.ts:327-348`),
used only by `resolveBlended`, starts from the exact same per-id
"highest score wins" merge, but then partitions the merged hits into two
buckets (memories the Tool Gate matched, everything else), sorts each
bucket separately by score, and concatenates tool-privileged hits ahead of
the rest before slicing to `maxHits`. The practical difference: under plain
`dedupeAndRank`, a memory the Tool Gate matched (a deterministic, always
security-relevant `1.0` hit) can be pushed out of the result by enough
higher-scoring blend hits; under `rankWithToolPrivilege`, it cannot, no
matter how many blend-scored memories outscore it, because slot allocation
gives every deduped tool hit a slot first. Attribution for a memory hit by
both paths is unaffected by this difference (whichever hit has the higher
score still wins the `gate`/`score`/`reason` fields, in both functions);
only which memories make the final cut differs.

This split exists because among `resolveBlended`'s three production
callers, only MCP `memory_resolve` (`packages/memory-router/src/mcp/server.ts`)
can ever pass a `ctx.tool` alongside a `ctx.prompt` at the same time; the
`UserPromptSubmit` hook and `memory-router eval` each construct `ctx` with
no `tool` field (`packages/memory-router/src/hooks/user-prompt-submit.ts`,
`packages/memory-router/src/eval/runner.ts`). So only that one call site
needs a rule for "a real prompt scored a lot of memories highly, but a
pending destructive command also matched a memory": the Tool Gate hit must
survive the cap regardless of the blend score distribution that prompt
happened to produce.
