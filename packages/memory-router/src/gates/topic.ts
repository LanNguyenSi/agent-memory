const { singleLine } = require('../debug');
const {
  loadVocabularyResult,
  matchedTopicsForVocabulary,
} = require('../vocab/loader');

const topicGate: Gate = {
  name: 'topic',
  evaluate(ctx: RouterContext, memories: Memory[]): GateHit[] {
    if (!ctx.prompt) return [];
    // ctx.memoryDir (threaded by every caller that knows its own corpus dir
    // today: cli.ts's `test`/`eval` verbs, src/eval/runner.ts) wins over the
    // MEMORY_ROUTER_DIR env var. The env var stays as the fallback ONLY for
    // callers that can't thread a dir — today that's hooks/** (out of scope
    // for this change) and mcp/server.ts, both of which already set/read
    // this same env var. loadVocabularyResult never throws: missing/invalid
    // topics.yml degrades to the built-in default (see src/vocab/loader.ts)
    // so a broken corpus file can never crash the UserPromptSubmit hook.
    const memoryDir = ctx.memoryDir ?? process.env.MEMORY_ROUTER_DIR;
    const { vocabulary, error } = loadVocabularyResult(memoryDir);
    if (error) {
      // Unconditional (not gated behind MEMORY_ROUTER_DEBUG=1) — same
      // convention as gates/tool.ts's unsafe-command_pattern rejection
      // notice: one plain `memory-router: ` prefixed stderr line so a
      // degrade to the built-in default is never silently invisible in
      // production. stdout stays untouched (reserved for the hook's
      // additionalContext contract). Distinct from debug.ts's bracketed
      // `[memory-router]` convention, which stays opt-in via the env flag.
      process.stderr.write(
        `memory-router: invalid topics.yml, falling back to the built-in default vocabulary: ${singleLine(error)}\n`,
      );
    }
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
