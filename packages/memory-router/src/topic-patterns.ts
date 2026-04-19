// Shared topic → keyword patterns used by both the Topic Gate (runtime
// matching against user prompts) and the Tag CLI (offline matching against
// memory name/description/body). Single source of truth — drift between the
// two surfaces would mean a memory tagged "workflow" never fires on a
// workflow prompt.

const TOPIC_PATTERNS: Record<Topic, RegExp[]> = {
  deployment: [
    /\bdeploy(?:ing|ed|ment)?\b/i,
    /\brelease\b/i,
    /\bpush(?:ing)?\s+to\s+prod\b/i,
    /\bmigrat(?:e|ion|ing)\b/i,
    /\brollback\b/i,
    /\bdocker[-\s]?compose\b/i,
    /\bVPS\b/,
    /\b\.env\b/,
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

// Runtime matcher: any single regex hit is enough — we want the Topic Gate
// to fire permissively on a user prompt.
function matchedTopics(text: string): Topic[] {
  const hits: Topic[] = [];
  for (const [topic, patterns] of Object.entries(TOPIC_PATTERNS) as [
    Topic,
    RegExp[],
  ][]) {
    if (patterns.some((p) => p.test(text))) hits.push(topic);
  }
  return hits;
}

// Offline tagger: weighted score per topic so a memory that merely mentions
// "test" in passing doesn't get tagged `testing`. Name matches are 3x, the
// description 2x, body 1x — a topic has to appear in the "what is this about"
// signal (title/desc) or repeat in the body to earn a tag. Returns topics
// sorted by descending score.
interface TopicScore {
  topic: Topic;
  score: number;
}

function scoreTopics(
  name: string,
  description: string,
  body: string,
): TopicScore[] {
  const result: TopicScore[] = [];
  for (const [topic, patterns] of Object.entries(TOPIC_PATTERNS) as [
    Topic,
    RegExp[],
  ][]) {
    const nameHits = countMatches(patterns, name);
    const descHits = countMatches(patterns, description);
    const bodyHits = countMatches(patterns, body);
    const score = nameHits * 3 + descHits * 2 + bodyHits;
    if (score > 0) result.push({ topic, score });
  }
  result.sort((a, b) => b.score - a.score);
  return result;
}

function countMatches(patterns: RegExp[], text: string): number {
  let total = 0;
  for (const p of patterns) {
    // Clone the regex with global flag so we count all matches, not just one.
    const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`;
    const g = new RegExp(p.source, flags);
    const m = text.match(g);
    if (m) total += m.length;
  }
  return total;
}

module.exports = { TOPIC_PATTERNS, matchedTopics, scoreTopics };
