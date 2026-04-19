const { scoreTopics } = require('../topic-patterns');

// Matches the imperative urgency of a feedback memory. "never", "must",
// "always" → hard-rule / critical. Otherwise → normal.
const CRITICAL_RE = /\b(never|must\s+never|must|always|critical|will\s+destroy|production|overwrites?|silently\s+(drops?|lose?s?)|data\s+loss|blocker)\b/i;

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
    out.severity = CRITICAL_RE.test(haystack) ? 'critical' : 'normal';
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
