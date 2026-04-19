const { toolGate } = require('./gates/tool');
const { topicGate } = require('./gates/topic');
const {
  computeAmbiguity,
  confidenceThreshold,
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

module.exports = { resolve, resolveConfidence, dedupeAndRank, DEFAULT_GATES };
