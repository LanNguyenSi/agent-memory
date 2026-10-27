---
type: invariant
title: Score-blend resolver, degraded mode, and confidence-floor provenance
description: Pointer doc plus code anchors. Which function the blend callers run through, the router.ts lines behind each degraded-mode branch, and which confidence.ts branch sets each minSemanticScoreSource tag value that gates the floor-drop hint.
tags: [score-blend, degraded-mode, relevance-floor, confidence-floor-provenance, resolveBlended]
timestamp: 2026-10-26T21:32:26Z
sources:
  - packages/memory-router/src/router.ts
  - packages/memory-router/src/gates/confidence.ts
  - packages/memory-router/src/hooks/user-prompt-submit.ts
  - packages/memory-router/src/mcp/server.ts
  - packages/memory-router/src/eval/runner.ts
  - packages/memory-router/README.md
  - packages/memory-router/docs/scoring.md
  - packages/memory-router/tests/blend.test.ts
  - packages/memory-router/tests/floor-drop-hint.test.ts
---

# Score-blend resolver, degraded mode, and confidence-floor provenance

The blend formula, the calibration tables, what degraded mode produces, and
the floor-drop hint's behavior are documented in
[README.md "How it works"](../../README.md#how-it-works),
[README.md "Calibration"](../../README.md#calibration), and
[docs/scoring.md](../scoring.md) ("Degradation and the Tool Gate",
"Model-conditional relevance floor default"). This doc adds code anchors
for those behaviors: the function the blend callers run through, the
`router.ts` lines behind each degraded-mode branch, and the `confidence.ts`
branch that sets each `minSemanticScoreSource` tag value.

## The blend entry point

The call sites among the hits of
`rg -n 'resolveBlended\(' packages/memory-router/src` at the time of
writing (comments and the definition set aside) are the
`UserPromptSubmit` hook
(`packages/memory-router/src/hooks/user-prompt-submit.ts:54`), MCP
`memory_resolve` (`packages/memory-router/src/mcp/server.ts:133`), and
`memory-router eval` (`packages/memory-router/src/eval/runner.ts:66`);
each calls `resolveBlended()`
(`packages/memory-router/src/router.ts:192-438`).
`resolveBlended()` calls `loadBlendWeights()` on every invocation that
has a prompt (`packages/memory-router/src/router.ts:199-201`), and the
comment above `loadBlendWeights()`
(`packages/memory-router/src/gates/confidence.ts:313-316`) states it is
read fresh, not memoized, so a `MEMORY_ROUTER_BLEND_*` env change applies
from the next call.

## Degraded-mode branches

An unset `ctx.prompt` returns `[]` before any semantic work
(`packages/memory-router/src/router.ts:199`). Otherwise `resolveBlended`
returns `resolve(ctx, memories, { maxHits })` when `semanticHits` is empty
after the floor filter (`packages/memory-router/src/router.ts:328-330`) -
since schema v4 with one exception: when the keyword gate admitted
memories despite the silent semantic path, those take the FIRST slots and
the rest of the output is that same `resolve()` output deduplicated
against them (`packages/memory-router/src/router.ts:330-351`); with no
admissions the branch is byte-identical pre-keyword behavior. The
branches that leave `semantic` empty, read from
`rg -n 'semanticHits' packages/memory-router/src/router.ts`:

1. `deps.semanticSearch(...)` returns no semantic hits - the seam's
   result is either a bare `[]` (pre-v4 shape, kept for test doubles) or a
   `{ semantic: [], keyword }` outcome from `blendedSearch()`
   (`packages/memory-router/src/router.ts:222-228`); the conditions under
   which the semantic half is empty are listed in
   [semantic-search-silent-noop.md](semantic-search-silent-noop.md).
2. `deps.semanticSearch(...)` throws, and the `catch` block
   (`packages/memory-router/src/router.ts:221-234`) leaves `semanticHits`
   at its initial `[]` (`packages/memory-router/src/router.ts:214`). The
   catch does not inspect the error, so it covers every throw source that
   [semantic-search-silent-noop.md](semantic-search-silent-noop.md) lists,
   not only a network/API failure (the comment above `resolveBlended`,
   `packages/memory-router/src/router.ts:187`, names only that case).
3. Every raw semantic candidate scores below `weights.minSemanticScore`
   and is filtered out (`packages/memory-router/src/router.ts:248-249`).

What the degraded output is, and that it matches `resolve()`, is stated in
[docs/scoring.md "Degradation and the Tool Gate"](../scoring.md#degradation-and-the-tool-gate)
and pinned by `packages/memory-router/tests/blend.test.ts:473` (no
index/provider) and `packages/memory-router/tests/blend.test.ts:449` (a
thrown search).

## Schema v4 keyword admissions and the keyword boost

The keyword config is read fresh per call like the blend weights:
`loadKeywordConfig()` (`packages/memory-router/src/router.ts:296`,
implemented in `packages/memory-router/src/embed/keyword.ts`);
`MEMORY_ROUTER_KEYWORD=off` drops every keyword candidate right there
(`packages/memory-router/src/router.ts:297`) so all keyword logic below
is inert. Admission loop (`packages/memory-router/src/router.ts:305-313`):
only memories with NO above-floor semantic hit, at most
`KEYWORD_MAX_HITS` (2) per prompt, best bm25 first; the predicate (strong
shape admits unconditionally, plain words need corroboration: a
corroboration cosine >= `MEMORY_ROUTER_KEYWORD_CORROBORATION` OR >= 2
qualifying matched terms) lives in keyword.ts. Admitted candidates blend
at `minSemanticScore + 0.01` with gate `keyword`
(`packages/memory-router/src/router.ts:398-415`); candidates that already
have an above-floor semantic hit instead get a flat
`keywordBoost` (`MEMORY_ROUTER_KEYWORD_BOOST`, default 0.02) added to
their blended input score and a keyword reason appended, keeping gate
`confidence` (`packages/memory-router/src/router.ts:416-420`) - the
calibrated weights, floors and candidateK are untouched by both.

## Confidence-floor provenance

`weights.minSemanticScoreSource` (`BlendWeights` field,
`packages/memory-router/src/gates/confidence.ts:106`) takes one of the
values in its type union. The branch that sets each:

| Source | Set by |
|---|---|
| `env` | `loadBlendWeights()`, when `envFloatResolved` accepted `MEMORY_ROUTER_BLEND_MIN_SEMANTIC` (`packages/memory-router/src/gates/confidence.ts:298-307`, `:338`) |
| `provider` | `resolveDefaultMinSemanticScoreDetail()`, when no provider config resolves or it is OpenAI (`packages/memory-router/src/gates/confidence.ts:257-267`) |
| `map` | the same function, when the normalized Ollama model name is an own key of `OLLAMA_MODEL_FLOOR_DEFAULTS` (`packages/memory-router/src/gates/confidence.ts:175-177`, `:275-276`) |
| `fallback` | the same function, for an Ollama model with no such key (`packages/memory-router/src/gates/confidence.ts:277`) |

`resolveBlended` reads this tag, not the numeric floor, to decide whether
to print the floor-drop hint (`packages/memory-router/src/router.ts:278-288`):
it prints only when `floorDropHintEmitted`
(`packages/memory-router/src/router.ts:37`) is still unset, the tag is
`'fallback'`, at least one raw candidate existed, and none passed the
floor. Which cases stay silent, and the once-per-process behavior, are
described in
[docs/scoring.md "Model-conditional relevance floor default"](../scoring.md#model-conditional-relevance-floor-default);
the hint's conditions and wording are pinned by
`packages/memory-router/tests/floor-drop-hint.test.ts`.
