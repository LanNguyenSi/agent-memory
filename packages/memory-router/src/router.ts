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
// - topicBoost: the (deterministic) Topic Gate's match is no longer a
//   standalone full-score hit; it can only nudge a memory's score, never
//   flood it to 1.0 and shadow everything else.
// - typeModifier / recencyModifier: small tie-breaking modifiers (memory
//   `type`, file mtime decay). See src/gates/confidence.ts for the weight
//   defaults (env-overridable, explicitly UNCALIBRATED until mm-v1-T008).
// A memory with neither a semantic score nor a topic match contributes
// nothing and is excluded — the modifiers alone can never surface an
// otherwise-silent memory, only shape the ranking of one some other signal
// already selected. Without an index/provider, this degrades to exactly the
// same *set* of memories the old topic-only sync path selected (only the
// score value differs: a blended score instead of a flat 1.0).
//
// A semantic-search failure (network/API error) is caught here, not left to
// the caller: the blend still returns topic/recency/type-only scoring
// rather than throwing, so hook/MCP/eval callers each keep their own outer
// try/catch as a defensive-in-depth layer, not as the only thing standing
// between a flaky embeddings endpoint and a blocked prompt.
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

  const topicHits: GateHit[] = topicGate.evaluate(ctx, memories);
  const topicById = new Map<string, GateHit>(topicHits.map((h) => [h.memory.id, h]));

  // Wider than maxHits on purpose: a memory that ranks outside the raw
  // semantic top-k can still win a slot once topic/recency/type are folded
  // in, so the candidate pool going into the blend is deliberately more
  // generous than the final cap.
  const semanticK = Math.max(maxHits, 10);
  let semanticHits: { memory: Memory; score: number }[] = [];
  try {
    semanticHits = await deps.semanticSearch(ctx.prompt, memories, memoryDir, semanticK);
  } catch (err: unknown) {
    process.stderr.write(
      `memory-router: semantic search failed, degrading to topic/recency/type only: ${String(err)}\n`,
    );
  }
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
    if (semanticScore > 0) reasonParts.push(`semantic match (score=${semanticScore.toFixed(2)})`);
    if (topicHit) reasonParts.push(topicHit.reason);

    blended.push({
      memory,
      gate: semanticScore > 0 ? 'confidence' : 'topic',
      score,
      reason: reasonParts.join('; '),
    });
  }

  return dedupeAndRank([...blended, ...toolHits], maxHits);
}

module.exports = {
  resolve,
  resolveConfidence,
  resolveBlended,
  dedupeAndRank,
  DEFAULT_GATES,
};
