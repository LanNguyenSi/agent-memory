const { matchedTopics } = require('../topic-patterns');

const topicGate: Gate = {
  name: 'topic',
  evaluate(ctx: RouterContext, memories: Memory[]): GateHit[] {
    if (!ctx.prompt) return [];
    const topics = new Set<Topic>(matchedTopics(ctx.prompt));
    if (topics.size === 0) return [];

    const hits: GateHit[] = [];
    for (const memory of memories) {
      // The loader passes `topics` through without shape validation (so lint
      // can still surface non-list values); this gate runs synchronously in
      // the user-prompt-submit hook, where a thrown TypeError would kill all
      // memory context. Treat anything that is not an array as no topics.
      const rawTopics = memory.frontmatter.topics;
      const memTopics = Array.isArray(rawTopics) ? rawTopics : [];
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
