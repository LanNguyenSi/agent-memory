---
type: invariant
title: Score-blend resolver, degraded mode, and confidence-floor provenance
description: Where the blend formula and calibration tables actually live (pointer), the exact trigger for degraded mode including that its semantic-search catch is not scoped to network/API errors, and the four-state provenance tag that decides whether an all-below-floor run gets a stderr hint.
tags: [score-blend, degraded-mode, relevance-floor, confidence-floor-provenance, resolveBlended]
timestamp: 2026-09-27T14:48:54Z
sources:
  - packages/memory-router/src/router.ts
  - packages/memory-router/src/gates/confidence.ts
  - packages/memory-router/src/embed/provider.ts
  - packages/memory-router/README.md
  - packages/memory-router/docs/scoring.md
  - packages/memory-router/tests/blend.test.ts
  - packages/memory-router/tests/floor-drop-hint.test.ts
---

# Score-blend resolver, degraded mode, and confidence-floor provenance

The blend formula itself, the calibration measurement tables, the degrade
trigger's plain-language description, and the floor-drop hint's behavior
are already documented in [README.md "How it works"](../../README.md#how-it-works),
[README.md "Calibration"](../../README.md#calibration), and
[docs/scoring.md](../scoring.md) ("Degradation and the Tool Gate",
"Model-conditional relevance floor default"). This doc does not restate
any of that in prose; it adds the code-level anchors and one correction
those docs don't carry: the one function every caller runs through, the
exact `router.ts` line ranges for each degrade branch, the four concrete
`minSemanticScoreSource` tag values behind the hint's decision, and that
the degrade catch actually swallows any throw from `semanticSearch`, not
only a network/API error.

## The chokepoint

Every caller that wants the blend (`UserPromptSubmit`, `memory_resolve`,
`memory-router eval`) goes through exactly one function:
`resolveBlended()` in `packages/memory-router/src/router.ts:158-313`. There
is no second implementation of the formula; `resolveDefaultMinSemanticScoreDetail`
and `loadBlendWeights` (`packages/memory-router/src/gates/confidence.ts`)
are read fresh on every call, not cached across calls, so a
`MEMORY_ROUTER_BLEND_*` env change or a switched embedding model takes
effect on the very next prompt.

## Degraded-mode trigger

`resolveBlended` returns `resolve(ctx, memories, { maxHits })` (the old
sync topic/tool-only path, flat `1.0` scores, load-order ties) the moment
`semanticHits.length === 0` after the floor filter
(`packages/memory-router/src/router.ts:243-248`). That happens in three
ways:

1. `deps.semanticSearch(...)` returns `[]` for one of five reasons; see
   [semantic-search-silent-noop.md](semantic-search-silent-noop.md) in
   this bundle for the complete breakdown, including which of those five
   is a genuine misconfiguration (`resolveProviderConfig` in
   `packages/memory-router/src/embed/provider.ts`) rather than an
   unconfigured machine.
2. `deps.semanticSearch(...)` throws; the `catch` block
   (`packages/memory-router/src/router.ts:181-187`) writes one stderr
   line and leaves `semanticHits` at its initial `[]` regardless of what
   the throw actually was. This is not scoped to a network/API error: the
   same catch also swallows an embedding-index provenance mismatch, a
   legacy-provenance mismatch, and a query-dimension mismatch, everything
   [semantic-search-silent-noop.md](semantic-search-silent-noop.md)'s "loud
   counterpart" section lists as a throw source, so a real configuration
   error and an unconfigured corpus both degrade identically here.
3. Every raw semantic candidate scored below
   `weights.minSemanticScore` and was filtered out
   (`packages/memory-router/src/router.ts:201-202`).

In every one of these three cases the function returns early with no topic
boost, no recency/type modifier applied: not "the same memories with a
slightly different score", but byte-for-byte the same `GateHit[]`
`resolve()` would have produced on its own. An earlier version applied the
modifiers even in this case; the regression that caused (weak topic
candidates beyond `maxHits` silently evicting the correct picks on a real
corpus) is pinned by the fixed-and-tested case in
`packages/memory-router/tests/blend.test.ts`.

## Confidence-floor provenance

`weights.minSemanticScoreSource` (`packages/memory-router/src/gates/confidence.ts`,
`BlendWeights` field, resolved by `resolveDefaultMinSemanticScoreDetail` and
`loadBlendWeights`) is a 4-state tag, not a boolean "was this calibrated":

| Source | Set when | Meaning |
|---|---|---|
| `env` | `MEMORY_ROUTER_BLEND_MIN_SEMANTIC` is set and valid | Operator's own explicit choice; always wins regardless of provider/model. |
| `map` | Provider is Ollama and the normalized model name has an `OLLAMA_MODEL_FLOOR_DEFAULTS` entry (today only `bge-m3`) | A number specifically calibrated against this model's cosine band. |
| `provider` | Provider is OpenAI (or unresolvable, e.g. misconfigured `openai` with no key) | OpenAI's own deliberate, documented `0.5` default, not a calibration gap. |
| `fallback` | Provider is Ollama and the model has no map entry (every Ollama model besides `bge-m3`, including the Ollama default `nomic-embed-text`) | The generic, uncalibrated Ollama provider default, only ever measured against `bge-m3`'s band. |

`resolveBlended` reads this tag, not the numeric floor value, to decide
whether an all-candidates-dropped run is worth a one-time stderr hint
(`packages/memory-router/src/router.ts:231-241`): the hint fires only when
`minSemanticScoreSource === 'fallback'` *and* at least one raw semantic
candidate existed *and* every one of them was filtered out. It is
deliberately silent for `env` (the operator already chose this floor),
`map` (a real calibration, not a gap), and `provider` (OpenAI's own
default, not an uncalibrated fallback), so the same numeric floor value
(`0.78`, shared today by the `map` and `fallback` cases) can be silent or
loud purely depending on which model produced it. The hint fires at most
once per process (`floorDropHintEmitted`,
`packages/memory-router/src/router.ts:26`), the same once-per-process
shape [docs/scoring.md](../scoring.md#model-conditional-relevance-floor-default)
documents for the hint itself; this doc adds only the four-state gate
(the tag values above) that decides whether it fires at all. The exact
gate and hint wording are pinned by
`packages/memory-router/tests/floor-drop-hint.test.ts`.
