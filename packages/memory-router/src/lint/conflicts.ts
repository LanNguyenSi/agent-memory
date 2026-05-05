// Memory-corpus conflict linter.
//
// Two `feedback` memories that share a topic and disagree (e.g. one says
// "ALWAYS amend commits", another "NEVER amend commits") will both be
// injected by the router under the same prompt. Claude then has to guess
// which rule wins. This linter catches the conflict at authoring time
// instead of waiting for a runtime collision in production.
//
// Heuristics, cheap-to-expensive:
//   1. Topic overlap among `feedback` memories. Two feedback memories
//      sharing a topic is INFO-level: complementary advice is normal, the
//      author just needs to confirm it isn't actually a clash.
//   2. Conflicting directives. For each topic-overlap pair, scan the first
//      lines of both bodies for explicit imperatives (`ALWAYS`, `NEVER`,
//      `don't`, `must`, `must not`, ...). When the pair has opposite
//      polarity AND the surrounding subjects share substantial vocabulary,
//      elevate to HIGH (probable real conflict).
//   3. (Future, behind `--semantic`) Embedding-cosine of body+name pairs
//      sharing a topic. Tracked as a separate task so this PR ships the
//      regex-only signal first.
//
// Why only `feedback` memories: `project` memories are bound to a moment
// in time and can legitimately disagree across history (one was true in
// April, another in May). `reference` memories are pointers, not rules.
// `user` memories describe one person and are unlikely to contradict
// without intent. Restricting to `feedback` keeps false-positive rate low.

const { loadMemoriesFromDir } = require('../memory/loader');

export type ConflictSeverity = 'info' | 'high';

export interface ConflictHit {
  severity: ConflictSeverity;
  // Topic that both memories share. A single pair may share multiple
  // topics; we pick the first overlap so the report stays readable.
  topic: string;
  reason: string;
  a: { path: string; memoryId: string; firstLine: string };
  b: { path: string; memoryId: string; firstLine: string };
}

export interface ConflictReport {
  hits: ConflictHit[];
  scannedCount: number;
  feedbackCount: number;
}

// Markers split by where on the line they're allowed to fire.
//
// ALL-CAPS variants ("ALWAYS", "NEVER", "MUST NOT") are rare in
// descriptive prose and almost always signal a real imperative. Match
// them anywhere on the first body line.
//
// Lowercase variants ("always", "never", "prefer", "avoid") show up in
// regular sentences too ("Stale branches never reach production"). Match
// them only against the leading window (the first two tokens of the
// trimmed line) so mid-sentence usage doesn't fake a directive.
const ALLCAPS_POSITIVE_PATTERNS = [
  /\bALWAYS\b/,
  /\bMUST(?!\s+NOT)\b/,
  /\bDO\b(?!\s+NOT)/,
];

const ALLCAPS_NEGATIVE_PATTERNS = [
  /\bNEVER\b/,
  /\bMUST\s+NOT\b/,
  /\bDO\s+NOT\b/,
  /\bDON'T\b/,
];

const LOWER_POSITIVE_PATTERNS = [
  /\balways\b/i,
  /\bmust(?!\s+not)\b/i,
  /\bprefer\b/i,
  /\brequire(?:d|s)?\b/i,
];

const LOWER_NEGATIVE_PATTERNS = [
  /\bnever\b/i,
  /\bmust\s+not\b/i,
  /\bdo\s+not\b/i,
  /\bdon't\b/i,
  /\bavoid\b/i,
  /\bskip\b/i,
];

// First two whitespace-separated tokens of the trimmed line. Two is
// enough to cover the canonical leading-directive forms ("ALWAYS X",
// "You must X", "do not X", "don't X") without sweeping in a third
// content word that might be a polarity false-positive ("Stale branches
// never").
function leadingWindow(text: string): string {
  return text.trim().split(/\s+/).slice(0, 2).join(' ');
}

function detectPolarity(text: string): 'positive' | 'negative' | 'mixed' | null {
  const leading = leadingWindow(text);

  const leadingHasPositive =
    ALLCAPS_POSITIVE_PATTERNS.some((re) => re.test(leading)) ||
    LOWER_POSITIVE_PATTERNS.some((re) => re.test(leading));
  const leadingHasNegative =
    ALLCAPS_NEGATIVE_PATTERNS.some((re) => re.test(leading)) ||
    LOWER_NEGATIVE_PATTERNS.some((re) => re.test(leading));

  // ALL-CAPS imperatives still count when they show up later in the
  // line: "Cut a fresh branch, ALWAYS rebase before push" is a
  // directive even though "Cut" isn't.
  const anywhereCapsPositive = ALLCAPS_POSITIVE_PATTERNS.some((re) => re.test(text));
  const anywhereCapsNegative = ALLCAPS_NEGATIVE_PATTERNS.some((re) => re.test(text));

  // After-leading slice for the descriptive-rest scan: detect mixed when
  // a leading directive is contradicted by a marker later on the line
  // ("always run tests but never on prod" is mixed; the leading "always"
  // sets polarity, the trailing "never" qualifies it).
  const rest = text.slice(leading.length);
  const restHasOppositePositive =
    anywhereCapsPositive || LOWER_POSITIVE_PATTERNS.some((re) => re.test(rest));
  const restHasOppositeNegative =
    anywhereCapsNegative || LOWER_NEGATIVE_PATTERNS.some((re) => re.test(rest));

  if (leadingHasPositive && leadingHasNegative) return 'mixed';
  if (leadingHasPositive) return restHasOppositeNegative ? 'mixed' : 'positive';
  if (leadingHasNegative) return restHasOppositePositive ? 'mixed' : 'negative';

  // No leading directive. ALL-CAPS can still classify when it shows up
  // anywhere ("Cut a fresh branch, ALWAYS rebase").
  if (anywhereCapsPositive && anywhereCapsNegative) return 'mixed';
  if (anywhereCapsPositive) return 'positive';
  if (anywhereCapsNegative) return 'negative';
  return null;
}

// Extract the first non-blank line of the body, capped at 200 chars so
// reports stay grep-friendly.
function firstLine(body: string): string {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    return trimmed.length > 200 ? trimmed.slice(0, 200) + '...' : trimmed;
  }
  return '';
}

// Polarity markers that must NOT count as subject vocabulary. Including
// them inflates the union and pushes the canonical pair "ALWAYS amend
// commits" vs "NEVER amend commits" below the overlap threshold despite
// having identical subjects. Lowercase here matches the post-lowercase
// tokenization below.
const POLARITY_TOKENS = new Set<string>([
  'always',
  'never',
  'must',
  'avoid',
  'skip',
  'prefer',
  'require',
  'required',
  'requires',
  "don't",
  'dont',
]);

// Tokenize a line to lowercase, alphanumeric-only words of >=4 chars,
// excluding polarity markers. Short and punctuation-heavy tokens (the, a,
// do, not) are excluded so the Jaccard signal is dominated by content
// words about the *subject*, not the imperative form.
function contentTokens(line: string): Set<string> {
  const tokens = line
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !POLARITY_TOKENS.has(t));
  return new Set<string>(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Two feedback memories form a HIGH-severity conflict iff:
//   - they share at least one topic (already enforced upstream), AND
//   - their first body lines have opposite polarities, AND
//   - the surrounding subject vocabulary overlaps (Jaccard >= threshold).
// The Jaccard floor keeps "ALWAYS amend commits" vs "NEVER deploy on Friday"
// from being flagged as a conflict just because they share `workflow`.
//
// 0.15 is a permissive floor that only works because polarity detection
// was tightened to leading-window matching: descriptive mid-sentence
// "never"/"always" no longer fake an opposite-imperative pair, so the
// Jaccard signal can be looser without flooding HIGH.
const SUBJECT_OVERLAP_THRESHOLD = 0.15;

interface FeedbackMemory {
  path: string;
  id: string;
  topics: string[];
  firstLine: string;
}

function classifyFeedbackMemories(memories: Memory[]): FeedbackMemory[] {
  const out: FeedbackMemory[] = [];
  for (const m of memories) {
    if (m.frontmatter.type !== 'feedback') continue;
    const topics = Array.isArray(m.frontmatter.topics)
      ? m.frontmatter.topics.map((t) => String(t)).filter((t) => t.length > 0)
      : [];
    if (topics.length === 0) continue;
    out.push({
      path: m.path,
      id: m.id,
      topics,
      firstLine: firstLine(m.body),
    });
  }
  return out;
}

export function lintMemoryDirForConflicts(dir: string): ConflictReport {
  const memories = loadMemoriesFromDir(dir);
  const feedbackMemories = classifyFeedbackMemories(memories);

  const hits: ConflictHit[] = [];
  // De-duplicate hits when a pair shares multiple topics. The first topic
  // wins for readability and the pair is recorded once.
  const reportedPairs = new Set<string>();

  for (let i = 0; i < feedbackMemories.length; i++) {
    for (let j = i + 1; j < feedbackMemories.length; j++) {
      const a = feedbackMemories[i];
      const b = feedbackMemories[j];

      // Find all shared topics; skip if there's no overlap.
      const aTopics = new Set<string>(a.topics);
      const sharedTopics = b.topics.filter((t) => aTopics.has(t));
      if (sharedTopics.length === 0) continue;

      const pairKey = a.path < b.path ? `${a.path}|${b.path}` : `${b.path}|${a.path}`;
      if (reportedPairs.has(pairKey)) continue;
      reportedPairs.add(pairKey);

      const topic = sharedTopics[0];
      const polarityA = detectPolarity(a.firstLine);
      const polarityB = detectPolarity(b.firstLine);

      // High-severity check: opposite imperatives on a topic the pair shares.
      // 'mixed' means a single line uses both polarities (e.g. "do X but
      // never Y"): too noisy to compare, skip.
      const opposite =
        (polarityA === 'positive' && polarityB === 'negative') ||
        (polarityA === 'negative' && polarityB === 'positive');

      if (opposite) {
        const overlap = jaccard(contentTokens(a.firstLine), contentTokens(b.firstLine));
        if (overlap >= SUBJECT_OVERLAP_THRESHOLD) {
          hits.push({
            severity: 'high',
            topic,
            reason: `opposite imperatives (${polarityA}/${polarityB}) and subject vocabulary overlap ${(overlap * 100).toFixed(0)}%`,
            a: { path: a.path, memoryId: a.id, firstLine: a.firstLine },
            b: { path: b.path, memoryId: b.id, firstLine: b.firstLine },
          });
          continue;
        }
      }

      // Info-level: same topic, no detected contradiction. Worth one human
      // glance per pair when the corpus grows.
      hits.push({
        severity: 'info',
        topic,
        reason: 'two feedback memories share this topic',
        a: { path: a.path, memoryId: a.id, firstLine: a.firstLine },
        b: { path: b.path, memoryId: b.id, firstLine: b.firstLine },
      });
    }
  }

  return {
    hits,
    scannedCount: memories.length,
    feedbackCount: feedbackMemories.length,
  };
}

export function formatConflictReportText(report: ConflictReport): string {
  const high = report.hits.filter((h) => h.severity === 'high');
  const info = report.hits.filter((h) => h.severity === 'info');

  if (report.hits.length === 0) {
    return `memory-router lint: ${report.feedbackCount} feedback memor(y/ies) scanned across ${report.scannedCount} total file(s); no topic-conflicts detected\n`;
  }

  const lines: string[] = [];
  if (high.length > 0) {
    lines.push(`HIGH (${high.length}): probable contradictory directives`);
    for (const hit of high) {
      lines.push(`  topic: ${hit.topic}`);
      lines.push(`  reason: ${hit.reason}`);
      lines.push(`  - ${hit.a.path}`);
      lines.push(`    "${hit.a.firstLine}"`);
      lines.push(`  - ${hit.b.path}`);
      lines.push(`    "${hit.b.firstLine}"`);
      lines.push('');
    }
  }

  if (info.length > 0) {
    lines.push(`INFO (${info.length}): topic-overlap, manually confirm complementary`);
    for (const hit of info) {
      lines.push(`  topic: ${hit.topic}`);
      lines.push(`  - ${hit.a.path}`);
      lines.push(`  - ${hit.b.path}`);
      lines.push('');
    }
  }

  lines.push(
    `memory-router lint: ${high.length} HIGH + ${info.length} INFO conflict signal(s) across ${report.feedbackCount} feedback memor(y/ies)`,
  );
  return lines.join('\n') + '\n';
}

module.exports = {
  lintMemoryDirForConflicts,
  formatConflictReportText,
  // Re-export for tests; private otherwise.
  __detectPolarity: detectPolarity,
  __firstLine: firstLine,
  __jaccard: jaccard,
  __contentTokens: contentTokens,
};
