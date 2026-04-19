const TOPIC_PATTERNS: Record<Topic, RegExp[]> = {
  deployment: [
    /\bdeploy(?:ing|ed|ment)?\b/i,
    /\brelease\b/i,
    /\bpush(?:ing)?\s+to\s+prod\b/i,
    /\bmigrat(?:e|ion|ing)\b/i,
    /\brollback\b/i,
    /\bdocker[-\s]?compose\b/i,
  ],
  destructive_ops: [
    /\brm\s+-rf\b/i,
    /\bforce[-\s]?push\b/i,
    /\bpush\s+--force\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bdrop\s+table\b/i,
    /\btruncate\s+table\b/i,
  ],
  workflow: [
    /\bPRs?\b/i,
    /\bpull\s+request\b/i,
    /\breview(?:er|ing)?\b/i,
    /\bmerg(?:e|ing|ed)\b/i,
    /\brebase\b/i,
    /\bbranch\b/i,
    /\btasks?\b/i,
  ],
  security: [
    /\bsecret\b/i,
    /\btoken\b/i,
    /\bcredential\b/i,
    /\bauth(?:entication|orization)?\b/i,
    /\bCVE\b/,
  ],
  testing: [
    /\btests?\b/i,
    /\bvitest\b/i,
    /\bjest\b/i,
    /\bspec\b/i,
    /\bmock\b/i,
  ],
};

function matchedTopics(prompt: string): Set<Topic> {
  const hits = new Set<Topic>();
  for (const [topic, patterns] of Object.entries(TOPIC_PATTERNS) as [
    Topic,
    RegExp[],
  ][]) {
    if (patterns.some((p) => p.test(prompt))) hits.add(topic);
  }
  return hits;
}

const topicGate: Gate = {
  name: 'topic',
  evaluate(ctx: RouterContext, memories: Memory[]): GateHit[] {
    if (!ctx.prompt) return [];
    const topics = matchedTopics(ctx.prompt);
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
