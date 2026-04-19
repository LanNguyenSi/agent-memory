const { scoreTopics } = require('../topic-patterns');

// Imperative-urgency signals. Each is strong on its own; we still require two
// distinct hits in the haystack before flipping to `critical` (see
// proposeFrontmatter below) so phrases like "nothing critical" or "we must"
// in passing don't over-promote a routine feedback memory.
//
// Deliberately excluded: bare `must`, `always`, `production`. Too generic —
// "you must ensure" or "always in production" are descriptive, not
// prescriptive. If needed, author tags severity manually.
const CRITICAL_SIGNALS: RegExp[] = [
  /\bnever\b/i,
  /\bmust\s+never\b/i,
  /\bmust\s+not\b/i,
  /\bsilently\s+(drops?|lose?s?|fails?)\b/i,
  /\bdata\s+loss\b/i,
  /\bwill\s+destroy\b/i,
  /\bdestructive\b/i,
  /\bblocker\b/i,
  /\boverwrites?\b/i,
];

// Inline code snippets that *look* like shell commands the user might run
// accidentally. We never auto-generate a command_pattern — too risky — but
// surface suggestions via the CLI's stderr hint channel.
const DANGEROUS_COMMAND_HINT_RE =
  /`((?:git\s+(?:push|reset|rebase)\s+[^`]+|rm\s+-rf[^`]+|drop\s+table[^`]+))`/gi;

// Keep at most this many tags per file — more than two and the Topic Gate
// fires on almost every prompt, defeating the enforcement goal.
const MAX_TOPICS = 2;
// Minimum weighted score required to earn a tag. Weights: name 3x, desc 2x,
// body 1x (see topic-patterns.ts). A single body mention scores 1 and is
// rejected; a hit in the name or two body mentions would clear the bar.
const TOPIC_SCORE_THRESHOLD = 3;

interface HeuristicInput {
  id: string;
  name: string;
  description: string;
  body: string;
  type: MemoryType;
}

interface Proposal {
  topics?: Topic[];
  severity?: Severity;
  commandHints?: string[];
}

function proposeFrontmatter(input: HeuristicInput): Proposal {
  const out: Proposal = {};

  // User profile memories are loaded via MEMORY.md on every session — they
  // don't need topic-based gating, and tagging them would inject the profile
  // into additionalContext as noise on every matching prompt.
  if (input.type !== 'user') {
    const scored = scoreTopics(input.name, input.description, input.body);
    const kept = scored
      .filter((s: { score: number }) => s.score >= TOPIC_SCORE_THRESHOLD)
      .slice(0, MAX_TOPICS)
      .map((s: { topic: Topic }) => s.topic);
    if (kept.length > 0) out.topics = kept;
  }

  if (input.type === 'feedback') {
    const haystack = `${input.name}\n${input.description}\n${input.body}`;
    const criticalHits = CRITICAL_SIGNALS.filter((re) => re.test(haystack)).length;
    // Two distinct signals required: a single "never" in a long body is
    // usually a warning in passing, not the rule itself.
    out.severity = criticalHits >= 2 ? 'critical' : 'normal';
  }

  const hints = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = DANGEROUS_COMMAND_HINT_RE.exec(input.body)) !== null) {
    hints.add(match[1].trim());
  }
  if (hints.size > 0) out.commandHints = [...hints];

  return out;
}

module.exports = { proposeFrontmatter };
