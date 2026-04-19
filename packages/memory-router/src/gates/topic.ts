const { matchedTopics } = require('../topic-patterns');

const topicGate: Gate = {
  name: 'topic',
  evaluate(ctx: RouterContext, memories: Memory[]): GateHit[] {
    if (!ctx.prompt) return [];
    const topics = new Set<Topic>(matchedTopics(ctx.prompt));
    if (topics.size === 0) return [];

    const hits: GateHit[] = [];
    for (const memory of memories) {
      const memTopics = memory.frontmatter.topics ?? [];
      const matched = memTopics.filter((t) => topics.has(t));
      if (matched.length === 0) continue;
      hits.push({
        memory,
        gate: 'topic',
        score: 1.0,
        reason: `topic match: ${matched.join(', ')}`,
      });
    }
    return hits;
  },
};

module.exports = { topicGate };
