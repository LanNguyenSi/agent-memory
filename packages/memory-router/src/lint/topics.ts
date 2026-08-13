// Topic-frontmatter linter.
//
// The valid topic set is loaded from `<dir>/topics.yml` when present,
// otherwise it's the built-in 5-topic default in `topic-patterns.ts` (see
// `src/vocab/loader.ts`). Any value in a memory's `topics:` frontmatter that
// isn't in the loaded vocabulary is silently ignored at runtime: the topic
// gate's `Set.has()` lookup misses, the memory never matches, and the
// author has no signal that they typo'd. This linter reads every memory in
// the configured dir and flags entries that reference an unknown topic,
// suggesting the closest known topic when the Levenshtein distance is
// small.
const { loadVocabularyResult } = require('../vocab/loader');
const { loadMemoriesFromDir } = require('../memory/loader');
const { singleLine } = require('../debug');

export interface UnknownTopicHit {
  path: string;
  memoryId: string;
  unknownTopic: string;
  suggestion: string | null;
}

export interface LintReport {
  hits: UnknownTopicHit[];
  scannedCount: number;
  /**
   * Set when `<dir>/topics.yml` exists but failed to load (YAML error,
   * missing/duplicate `name`, bad field shape). The scan below still ran
   * against the built-in default vocabulary in that case — never crashes,
   * never silently succeeds either.
   */
  vocabularyError?: string | null;
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
  const { vocabulary, error: vocabularyError } = loadVocabularyResult(dir);
  const knownTopics = vocabulary.topicNames;
  const knownSet = new Set<string>(knownTopics);

  const hits: UnknownTopicHit[] = [];

  for (const memory of memories) {
    const topics = memory.frontmatter.topics;
    // Unreachable for loader-loaded memories (the loader normalizes missing
    // topics to []); kept as defense for direct parseMemoryFile callers.
    if (topics === undefined || topics === null) continue;
    if (!Array.isArray(topics)) {
      // Frontmatter has `topics:` set to a scalar (string, number, …)
      // instead of a list. The runtime topic gate treats any non-array as
      // no topics (Array.isArray guard), so the memory silently never
      // matches. Surface it as a distinct hit instead of iterating string
      // characters.
      hits.push({
        path: memory.path,
        memoryId: memory.id,
        unknownTopic: `<non-list ${typeof topics}: ${JSON.stringify(topics)}>`,
        suggestion: null,
      });
      continue;
    }
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

  return { hits, scannedCount: memories.length, vocabularyError };
}

export function formatReportText(report: LintReport): string {
  // Surface an invalid topics.yml up front, even though the scan below
  // still ran (against the built-in default) rather than aborting.
  // Normalized to one line before interpolation: a YAML parse error ships a
  // multi-line caret-pointer snippet (see src/debug.ts's singleLine, which
  // debug()-gated diagnostics already use), and this line isn't gated by
  // MEMORY_ROUTER_DEBUG, so an un-normalized error would corrupt this
  // report's line structure by default.
  const prefix = report.vocabularyError
    ? `memory-router lint: invalid topics.yml, falling back to the built-in default vocabulary\n  ${singleLine(report.vocabularyError)}\n\n`
    : '';

  if (report.hits.length === 0) {
    return `${prefix}memory-router lint: ${report.scannedCount} memory file(s) scanned, no unknown topics found\n`;
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
  return prefix + lines.join('\n') + '\n';
}

module.exports = {
  lintMemoryDirForUnknownTopics,
  formatReportText,
  // Re-export for tests; private otherwise.
  __levenshtein: levenshtein,
  __nearestKnownTopic: nearestKnownTopic,
};
