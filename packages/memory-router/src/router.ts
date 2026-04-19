const { confidenceGate } = require('./gates/confidence');
const { toolGate } = require('./gates/tool');
const { topicGate } = require('./gates/topic');

const DEFAULT_GATES: Gate[] = [topicGate, toolGate, confidenceGate];

function resolve(
  ctx: RouterContext,
  memories: Memory[],
  opts: ResolveOptions = {},
): GateHit[] {
  const gates = opts.gates ?? DEFAULT_GATES;
  const maxHits = opts.maxHits ?? 5;

  const raw: GateHit[] = [];
  for (const gate of gates) raw.push(...gate.evaluate(ctx, memories));

  const best = new Map<string, GateHit>();
  for (const hit of raw) {
    const prev = best.get(hit.memory.id);
    if (!prev || hit.score > prev.score) best.set(hit.memory.id, hit);
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxHits);
}

module.exports = { resolve, DEFAULT_GATES };
