// Topic-frontmatter linter.
//
// Memory-router has a closed set of topics in `topic-patterns.ts` (5 today —
// `deployment`, `destructive_ops`, `workflow`, `security`, `testing`). Any
// other value in a memory's `topics:` frontmatter is silently ignored at
// runtime: the topic gate's `Set.has()` lookup misses, the memory never
// matches, and the author has no signal that they typo'd. This linter reads
// every memory in the configured dir and flags entries that reference an
// unknown topic, suggesting the closest known topic when the Levenshtein
// distance is small.
const { TOPIC_PATTERNS } = require('../topic-patterns');
const { loadMemoriesFromDir } = require('../memory/loader');

export interface UnknownTopicHit {
  path: string;
  memoryId: string;
  unknownTopic: string;
  suggestion: string | null;
}

export interface LintReport {
  hits: UnknownTopicHit[];
  scannedCount: number;
}

const SUGGESTION_MAX_DISTANCE = 2;

// Standard iterative Levenshtein. Strings are short (topic names) so the
// O(n*m) cost is irrelevant. Kept inline so the linter has zero deps.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function nearestKnownTopic(
  unknown: string,
  knownTopics: string[],
): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const known of knownTopics) {
    const d = levenshtein(unknown.toLowerCase(), known.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = known;
    }
  }
  return bestDistance <= SUGGESTION_MAX_DISTANCE ? best : null;
}

export function lintMemoryDirForUnknownTopics(dir: string): LintReport {
  const memories = loadMemoriesFromDir(dir);
  const knownTopics = Object.keys(TOPIC_PATTERNS);
  const knownSet = new Set<string>(knownTopics);

  const hits: UnknownTopicHit[] = [];

  for (const memory of memories) {
    const topics = memory.frontmatter.topics ?? [];
    for (const t of topics) {
      const value = String(t);
      if (knownSet.has(value)) continue;
      hits.push({
        path: memory.path,
        memoryId: memory.id,
        unknownTopic: value,
        suggestion: nearestKnownTopic(value, knownTopics),
      });
    }
  }

  return { hits, scannedCount: memories.length };
}

export function formatReportText(report: LintReport): string {
  if (report.hits.length === 0) {
    return `memory-router lint: ${report.scannedCount} memory file(s) scanned, no unknown topics found\n`;
  }
  const lines: string[] = [];
  for (const hit of report.hits) {
    const suggestion = hit.suggestion
      ? ` (did you mean '${hit.suggestion}'?)`
      : '';
    lines.push(
      `${hit.path}: unknown topic '${hit.unknownTopic}'${suggestion}`,
    );
  }
  lines.push('');
  lines.push(
    `memory-router lint: ${report.hits.length} unknown topic reference(s) across ${report.scannedCount} scanned memory file(s)`,
  );
  return lines.join('\n') + '\n';
}

module.exports = {
  lintMemoryDirForUnknownTopics,
  formatReportText,
  // Re-export for tests; private otherwise.
  __levenshtein: levenshtein,
  __nearestKnownTopic: nearestKnownTopic,
};
