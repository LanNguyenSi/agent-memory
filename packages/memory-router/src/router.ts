const { statSync } = require('node:fs');
const { toolGate } = require('./gates/tool');
const { topicGate } = require('./gates/topic');
const {
  computeAmbiguity,
  confidenceThreshold,
  loadBlendWeights,
  typeModifier,
  recencyModifier,
} = require('./gates/confidence');
const { semanticSearch } = require('./embed/indexer');

// Only sync gates live in the default set. The Confidence Gate is an async
// resolver (semantic search hits the OpenAI API) so it's exposed separately
// as `resolveConfidence` — callers that can't await leave it out.
const DEFAULT_GATES: Gate[] = [topicGate, toolGate];

function resolve(
  ctx: RouterContext,
  memories: Memory[],
  opts: ResolveOptions = {},
): GateHit[] {
  const gates = opts.gates ?? DEFAULT_GATES;
  const maxHits = opts.maxHits ?? 5;

  const raw: GateHit[] = [];
  for (const gate of gates) raw.push(...gate.evaluate(ctx, memories));

  return dedupeAndRank(raw, maxHits);
}

async function resolveConfidence(
  ctx: RouterContext,
  memories: Memory[],
  memoryDir: string,
  opts: { maxHits?: number } = {},
): Promise<GateHit[]> {
  if (!ctx.prompt) return [];
  const ambiguity = computeAmbiguity(ctx.prompt);
  const threshold = confidenceThreshold(ambiguity);
  const maxHits = opts.maxHits ?? 3;

  const matches = await semanticSearch(ctx.prompt, memories, memoryDir, maxHits);
  const hits: GateHit[] = matches
    .filter((m: { score: number }) => m.score >= threshold)
    .map((m: { memory: Memory; score: number }) => ({
      memory: m.memory,
      gate: 'confidence' as const,
      score: m.score,
      reason: `semantic match (ambiguity=${ambiguity.toFixed(2)}, threshold=${threshold.toFixed(2)})`,
    }));
  return hits;
}

function dedupeAndRank(hits: GateHit[], maxHits: number): GateHit[] {
  const best = new Map<string, GateHit>();
  for (const hit of hits) {
    const prev = best.get(hit.memory.id);
    if (!prev || hit.score > prev.score) best.set(hit.memory.id, hit);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, maxHits);
}

// Test seam for resolveBlended: lets tests substitute the semantic-search
// entry point and pin its exact call shape / a controlled score set without
// touching the real embedding stack. Default is the real semanticSearch
// required above; every production caller (hook, MCP server, eval runner)
// never passes this.
interface ResolveBlendedDeps {
  semanticSearch: (
    prompt: string,
    memories: Memory[],
    memoryDir: string,
    k: number,
  ) => Promise<{ memory: Memory; score: number }[]>;
}

// mm-v1-T004: replaces the old "shadowed gates" resolver (sync topic/tool
// gates first, confidence gate only when they were silent — see `resolve` +
// `resolveConfidence` above, both left unchanged for their existing callers,
// see the module-level comment). That shadowing meant the Topic Gate's flat
// 1.0 score pre-empted the semantic path on almost every real prompt (three
// different prompts sharing a topic word produced an identical top-5,
// regardless of what each prompt actually meant): see the mm-v1-T004 task
// notes and the pre-blend eval baseline.
//
// resolveBlended() instead combines every signal into one score per memory:
//   score = semanticScore + topicBoost + typeModifier + recencyModifier
// - semanticScore: the dominant signal, a raw cosine similarity from
//   semanticSearch. Runs UNCONDITIONALLY whenever an index + provider are
//   available for `memoryDir` — semanticSearch itself no-ops (returns [],
//   no HTTP call, no throw) when either is missing, so there is no separate
//   availability probe here, and this call happens exactly once per prompt
//   (one query embedding, or a query-cache hit — see src/embed/indexer.ts).
//   A hit scoring below MEMORY_ROUTER_BLEND_MIN_SEMANTIC (fix-round 2,
//   default 0.5) is dropped before it ever reaches this formula — treated
//   as "no semantic score" below, not as a weak one.
// - topicBoost: the (deterministic) Topic Gate's match is no longer a
//   standalone full-score hit; it can only nudge a memory's score, never
//   flood it to 1.0 and shadow everything else.
// - typeModifier / recencyModifier: small tie-breaking modifiers (memory
//   `type`, file mtime decay). See src/gates/confidence.ts for the weight
//   defaults (env-overridable; topicBoost/candidateK calibrated in
//   mm-v1-T008, the relevance floor stays per-corpus — see
//   src/gates/confidence.ts and README "Calibration").
// A memory with neither a semantic score nor a topic match contributes
// nothing and is excluded — the modifiers alone can never surface an
// otherwise-silent memory, only shape the ranking of one some other signal
// already selected.
//
// Degraded mode (post-hoc fix, see task notes): when the semantic path
// contributes NOTHING for this prompt, whether because no index/provider is
// available (semanticSearch no-ops, see src/embed/indexer.ts), because of a
// caught semantic-search error below, or because every candidate scored
// below the relevance floor above, resolveBlended returns EXACTLY what
// resolve(ctx, memories, {maxHits}) (the old sync-only topic/tool path)
// would: the same hits, the same flat 1.0 gate scores, the same load-order
// ties. No topic boost, no recency/type modifier is applied in this case.
// An initial version of this blend applied those modifiers even when
// semantic contributed nothing; on a real corpus with more than `maxHits`
// topic candidates for one prompt, that re-ranked the degraded top-N by
// mtime/type and silently evicted the correct picks, measured against the
// real golden set (P/R/MRR regressed against the documented "identical to
// today's topic-only degradation" acceptance criterion). See the pinned
// regression test in tests/blend.test.ts.
//
// A semantic-search failure (network/API error) is caught here, not left to
// the caller: the blend still returns topic-only scoring rather than
// throwing, so hook/MCP/eval callers each keep their own outer try/catch as
// a defensive-in-depth layer, not as the only thing standing between a
// flaky embeddings endpoint and a blocked prompt.
async function resolveBlended(
  ctx: RouterContext,
  memories: Memory[],
  memoryDir: string,
  opts: ResolveOptions = {},
  deps: ResolveBlendedDeps = { semanticSearch },
): Promise<GateHit[]> {
  if (!ctx.prompt) return [];
  const maxHits = opts.maxHits ?? 5;
  const weights = loadBlendWeights();

  // Candidate pool width. At the calibrated default (5, mm-v1-T008) the
  // pool EQUALS the default cap: a memory outside the raw semantic
  // top-maxHits is not lifted into the result by topic/recency/type unless
  // the operator widens the pool via MEMORY_ROUTER_BLEND_CANDIDATE_K (then
  // Math.max keeps it never narrower than the cap). The wider-pool rescue
  // was measured to hurt on the golden set (weak semantic candidates
  // flooding the cap, see BLEND_DEFAULTS.candidateK in
  // src/gates/confidence.ts). Rounded defensively since an env override is
  // free-form text and the value below flows straight into a search "how
  // many rows" argument.
  const semanticK = Math.max(maxHits, Math.round(weights.candidateK));
  let semanticHits: { memory: Memory; score: number }[] = [];
  try {
    semanticHits = await deps.semanticSearch(ctx.prompt, memories, memoryDir, semanticK);
  } catch (err: unknown) {
    process.stderr.write(
      `memory-router: semantic search failed, degrading to topic/recency/type only: ${String(err)}\n`,
    );
  }

  // Relevance floor (mm-v1-T004 fix-round 2, HIGH): drop any semantic hit
  // scoring below MEMORY_ROUTER_BLEND_MIN_SEMANTIC (default 0.5, see
  // BLEND_DEFAULTS.minSemanticScore in src/gates/confidence.ts) BEFORE the
  // degradation guard below. A sub-floor cosine match is noise, not a real
  // signal; filtering it out here (rather than letting it into the blend at
  // a near-zero weight) means a corpus/provider that only ever returns weak
  // matches for a prompt degrades to the deterministic topic-only path
  // instead of quietly blending in scores that were never a real match. A
  // memory that also has an independent topic hit is unaffected by this
  // filter — the filter only removes the SEMANTIC contribution, topic
  // candidacy is evaluated separately below.
  semanticHits = semanticHits.filter((h) => h.score >= weights.minSemanticScore);

  // Semantic path contributed nothing (no index/provider, the caught error
  // above, or every candidate falling below the relevance floor):
  // degrade to EXACTLY the pre-blend sync-only resolver rather than running
  // any topic-boost/recency/type scoring, see the module comment above this
  // function for why.
  if (semanticHits.length === 0) return resolve(ctx, memories, { maxHits });

  const topicHits: GateHit[] = topicGate.evaluate(ctx, memories);
  const topicById = new Map<string, GateHit>(topicHits.map((h) => [h.memory.id, h]));
  const semanticById = new Map<string, number>(
    semanticHits.map((h) => [h.memory.id, h.score]),
  );

  // Tool Gate: unrelated to the prompt-semantic blend above, only relevant
  // when the caller also passed a tool call (e.g. MCP's memory_resolve).
  // Deterministic full-score hit, unchanged, so a tool-triggered resolution
  // keeps working exactly as it did before this change.
  const toolHits: GateHit[] = ctx.tool ? toolGate.evaluate(ctx, memories) : [];

  const candidateIds = new Set<string>([...semanticById.keys(), ...topicById.keys()]);
  const byId = new Map(memories.map((m) => [m.id, m]));
  const now = Date.now();

  const blended: GateHit[] = [];
  for (const id of candidateIds) {
    const memory = byId.get(id);
    if (!memory) continue;

    // .has(), not "score > 0": MEMORY_ROUTER_BLEND_MIN_SEMANTIC can be
    // overridden down to 0 (see the relevance-floor comment above and
    // envFloat's non-negative guard in src/gates/confidence.ts), which lets
    // a genuine zero-score semantic hit survive the floor filter. Gating
    // gate/reason attribution on "score > 0" would then mislabel that
    // candidate as a phantom topic hit (gate: 'topic', reason: '') even
    // though it has no topic match at all — it's semantic-originated (a
    // real semanticById entry), just weighted zero (mm-v1-T004 fix-round 2
    // LOW #9).
    const hasSemanticHit = semanticById.has(id);
    const semanticScore = semanticById.get(id) ?? 0;
    const topicHit = topicById.get(id);
    const topicBoost = topicHit ? weights.topicBoost : 0;

    // A stat failure (missing/unreadable file) must never cost a memory
    // its topic/semantic hit — treat it as "no recency signal" (age 0,
    // the modifier's max value) rather than throwing.
    let mtimeMs = now;
    try {
      mtimeMs = statSync(memory.path).mtimeMs;
    } catch {
      // fall through with mtimeMs = now
    }

    const score =
      semanticScore +
      topicBoost +
      typeModifier(memory.frontmatter.type, weights) +
      recencyModifier(mtimeMs, weights, now);

    const reasonParts: string[] = [];
    if (hasSemanticHit) reasonParts.push(`semantic match (score=${semanticScore.toFixed(2)})`);
    if (topicHit) reasonParts.push(topicHit.reason);

    blended.push({
      memory,
      gate: hasSemanticHit ? 'confidence' : 'topic',
      score,
      reason: reasonParts.join('; '),
    });
  }

  return rankWithToolPrivilege(blended, toolHits, maxHits);
}

// Privileges deterministic Tool-Gate hits ahead of the maxHits cap
// (mm-v1-T004 fix-round 2, MEDIUM #2): a memory ctx.tool directly matched
// (score 1.0, see gates/tool.ts) must never be evicted from the result by
// blend-scored memories whose semantic+topicBoost+modifiers sum happens to
// exceed 1.0 — plain dedupeAndRank (highest score wins the slot) would let
// that happen on any prompt with more than maxHits strong blend candidates.
// Attribution (which gate/score/reason wins for a memory present in BOTH
// `blended` and `toolHits`) is unchanged from before this fix: whichever
// has the higher score, same as dedupeAndRank always did. Only SLOT
// ALLOCATION changes: every deduped tool hit fills a slot first, remaining
// slots go to the highest-ranked blend hits, then the combined list is
// capped at maxHits.
function rankWithToolPrivilege(
  blended: GateHit[],
  toolHits: GateHit[],
  maxHits: number,
): GateHit[] {
  const merged = new Map<string, GateHit>();
  for (const hit of [...blended, ...toolHits]) {
    const prev = merged.get(hit.memory.id);
    if (!prev || hit.score > prev.score) merged.set(hit.memory.id, hit);
  }

  const toolIds = new Set(toolHits.map((h) => h.memory.id));
  const privileged: GateHit[] = [];
  const rest: GateHit[] = [];
  for (const hit of merged.values()) {
    (toolIds.has(hit.memory.id) ? privileged : rest).push(hit);
  }
  privileged.sort((a, b) => b.score - a.score);
  rest.sort((a, b) => b.score - a.score);

  return [...privileged, ...rest].slice(0, maxHits);
}

module.exports = {
  resolve,
  resolveConfidence,
  resolveBlended,
  dedupeAndRank,
  DEFAULT_GATES,
};
