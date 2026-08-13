const {
  loadVocabulary,
  matchedTopicsForVocabulary,
} = require('../vocab/loader');

const topicGate: Gate = {
  name: 'topic',
  evaluate(ctx: RouterContext, memories: Memory[]): GateHit[] {
    if (!ctx.prompt) return [];
    // The Gate interface has no memoryDir slot, and hooks/** (which set
    // this env var before invoking us) is out of scope for this change —
    // read it the same way mcp/server.ts and both hook binaries already do.
    // loadVocabulary never throws: missing/invalid topics.yml degrades to
    // the built-in default (see src/vocab/loader.ts) so a broken corpus
    // file can never crash the UserPromptSubmit hook.
    const vocabulary = loadVocabulary(process.env.MEMORY_ROUTER_DIR);
    const topics = new Set<Topic>(
      matchedTopicsForVocabulary(ctx.prompt, vocabulary),
    );
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
