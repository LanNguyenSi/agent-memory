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
//   3. (Behind `--semantic`) Embedding-cosine of body+name pairs sharing a
//      topic. Catches paraphrased subjects the regex-only Jaccard step
//      misses ("always squash before merge" vs "never squash, use
//      fast-forward only": no shared content tokens, opposite polarity,
//      but semantically the same subject). Opposite-polarity INFO pairs get
//      upgraded to HIGH when cosine similarity is above the threshold.
//      Skips fail-open with a stderr warning when OPENAI_API_KEY is unset
//      so CI without secrets does not break.
//
// Why only `feedback` memories: `project` memories are bound to a moment
// in time and can legitimately disagree across history (one was true in
// April, another in May). `reference` memories are pointers, not rules.
// `user` memories describe one person and are unlikely to contradict
// without intent. Restricting to `feedback` keeps false-positive rate low.

const { existsSync } = require('node:fs');
const { loadMemoriesFromDir } = require('../memory/loader');
const { resolveProviderConfig, embedBatch } = require('../embed/provider');
const { openIndex } = require('../embed/index-store');
const { indexPath, EMBED_DIMENSIONS } = require('../embed/indexer');

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
// "Anywhere" patterns are rare in descriptive prose (ALL-CAPS imperatives
// like ALWAYS, NEVER; formal-register markers like "mandatory",
// "prohibited", "cannot"). They classify the line as a directive no
// matter where on the line they appear.
//
// "Leading" patterns are common-prose words ("always", "never", "prefer",
// "avoid") that fake a directive when read out of context ("Stale
// branches never reach production"). They only fire against the leading
// window: the first two whitespace-separated tokens of the trimmed
// line.
const ANYWHERE_POSITIVE_PATTERNS = [
  /\bALWAYS\b/,
  /\bMUST(?!\s+NOT)\b/,
  /\bDO\b(?!\s+NOT)/,
  /\bmandator(?:y|ily)\b/i,
  /\bmandate(?:d|s)?\b/i,
  /\bcompulsor(?:y|ily)\b/i,
];

const ANYWHERE_NEGATIVE_PATTERNS = [
  /\bNEVER\b/,
  /\bMUST\s+NOT\b/,
  /\bDO\s+NOT\b/,
  /\bDON'T\b/,
  /\bprohibit(?:ed|s)?\b/i,
  /\bforbid(?:den|s)?\b/i,
  /\bdisallow(?:ed|s)?\b/i,
  /\bcannot\b/i,
];

const LEADING_POSITIVE_PATTERNS = [
  /\balways\b/i,
  /\bmust(?!\s+not)\b/i,
  /\bprefer\b/i,
  /\brequire(?:d|s)?\b/i,
];

const LEADING_NEGATIVE_PATTERNS = [
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
    ANYWHERE_POSITIVE_PATTERNS.some((re) => re.test(leading)) ||
    LEADING_POSITIVE_PATTERNS.some((re) => re.test(leading));
  const leadingHasNegative =
    ANYWHERE_NEGATIVE_PATTERNS.some((re) => re.test(leading)) ||
    LEADING_NEGATIVE_PATTERNS.some((re) => re.test(leading));

  // Anywhere-firing patterns count even mid-sentence: "Cut a fresh
  // branch, ALWAYS rebase before push" is a directive even though "Cut"
  // isn't, and "Code review is mandatory before merge" is one even
  // though "Code" isn't.
  const anywherePositive = ANYWHERE_POSITIVE_PATTERNS.some((re) => re.test(text));
  const anywhereNegative = ANYWHERE_NEGATIVE_PATTERNS.some((re) => re.test(text));

  // After-leading slice for the descriptive-rest scan: detect mixed when
  // a leading directive is contradicted by a marker later on the line
  // ("always run tests but never on prod" is mixed; the leading "always"
  // sets polarity, the trailing "never" qualifies it).
  const rest = text.slice(leading.length);
  const restHasOppositePositive =
    anywherePositive || LEADING_POSITIVE_PATTERNS.some((re) => re.test(rest));
  const restHasOppositeNegative =
    anywhereNegative || LEADING_NEGATIVE_PATTERNS.some((re) => re.test(rest));

  if (leadingHasPositive && leadingHasNegative) return 'mixed';
  if (leadingHasPositive) return restHasOppositeNegative ? 'mixed' : 'positive';
  if (leadingHasNegative) return restHasOppositePositive ? 'mixed' : 'negative';

  // No leading directive. Anywhere-firing patterns can still classify
  // when they show up later in the line.
  if (anywherePositive && anywhereNegative) return 'mixed';
  if (anywherePositive) return 'positive';
  if (anywhereNegative) return 'negative';
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
  'mandatory',
  'mandatorily',
  'mandate',
  'mandates',
  'mandated',
  'compulsory',
  'compulsorily',
  'prohibit',
  'prohibits',
  'prohibited',
  'forbid',
  'forbids',
  'forbidden',
  'disallow',
  'disallows',
  'disallowed',
  'cannot',
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

// `--semantic` upgrades INFO → HIGH when paraphrased pairs of opposite
// polarity have body+name embedding cosine similarity above this floor. 0.85
// is conservative: text-embedding-3-small produces similarities of ~0.7-0.8
// even for loosely related text on shared topics, so a true paraphrase pair
// (~0.88-0.95 in observed runs) clears it without dragging in unrelated
// same-topic advice.
const SEMANTIC_SIMILARITY_THRESHOLD = 0.85;

export interface ConflictOptions {
  // Test seam: substitute the embedding call so unit tests don't need
  // OPENAI_API_KEY or network.
  embedFn?: (texts: string[]) => Promise<number[][]>;
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

// Machine-readable variant for CI consumers. Trailing newline included so
// shell pipelines and `> file.json` flows match the text format's manners.
export function formatConflictReportJson(report: ConflictReport): string {
  return (
    JSON.stringify(
      {
        scannedCount: report.scannedCount,
        feedbackCount: report.feedbackCount,
        hits: report.hits,
      },
      null,
      2,
    ) + '\n'
  );
}

function buildPairEmbedInput(memory: Memory): string {
  // Match embed/indexer.ts buildEmbedInput: name + description + body.
  const parts = [memory.frontmatter.name, memory.frontmatter.description, memory.body];
  return parts.filter(Boolean).join('\n').slice(0, 8000);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// Async wrapper that runs the regex-only sweep first, then optionally
// upgrades opposite-polarity INFO pairs to HIGH via embedding cosine.
// Caller decides whether to enable the semantic pass via opts.semantic
// or by passing a non-null embedFn (tests).
export async function lintMemoryDirForConflictsWithSemantic(
  dir: string,
  opts: ConflictOptions & { semantic: boolean } = { semantic: false },
): Promise<ConflictReport> {
  const baseReport = lintMemoryDirForConflicts(dir);
  if (!opts.semantic) return baseReport;

  // Find INFO pairs that the regex-only step rejected because either the
  // first line had no detectable polarity or the Jaccard floor (25%)
  // wasn't met. Both are reasons a paraphrased pair could slip past.
  const candidates = baseReport.hits
    .map((hit, idx) => ({ hit, idx }))
    .filter(({ hit }) => hit.severity === 'info');

  // Resolve the embedder before doing any further work so a user who
  // explicitly enabled --semantic always gets a reason for an empty upgrade
  // pass instead of silent regex-only output. Test override > live provider
  // config. Fail-open with a one-line stderr warning when neither is
  // available.
  const cfg = resolveProviderConfig();
  if (!opts.embedFn && !cfg) {
    process.stderr.write(
      '[memory-router] --semantic skipped: OPENAI_API_KEY not set\n',
    );
    return baseReport;
  }

  // Re-detect polarities on the recorded first lines so we don't lose
  // information from the sync pass, and only embed pairs where both sides
  // make a directive (positive vs negative). Pairs without polarity stay
  // INFO: the embedding alone is not a strong-enough signal to flag two
  // descriptive memos as a HIGH conflict.
  const polarityCandidates = candidates.filter(({ hit }) => {
    const pa = detectPolarity(hit.a.firstLine);
    const pb = detectPolarity(hit.b.firstLine);
    return (
      (pa === 'positive' && pb === 'negative') ||
      (pa === 'negative' && pb === 'positive')
    );
  });

  if (polarityCandidates.length === 0) return baseReport;

  // Reload memories so we can build the embed input from full body+name.
  // The hits only carry first-line snippets, which is too narrow to embed.
  const allMemories = loadMemoriesFromDir(dir);
  const byMemoryId = new Map<string, Memory>(
    allMemories.map((m: Memory) => [m.id, m]),
  );

  const neededIds = new Set<string>();
  for (const { hit } of polarityCandidates) {
    neededIds.add(hit.a.memoryId);
    neededIds.add(hit.b.memoryId);
  }

  const embedByMemoryId = new Map<string, number[]>();

  // Cheap reuse path: if the live index covers any of these memories, pull
  // their stored embeddings directly. The index is keyed by memory id, so
  // a partial cover is fine: we only embed the misses below.
  if (cfg) {
    const idxPath = indexPath(dir);
    if (existsSync(idxPath)) {
      const store = openIndex({ path: idxPath, dimensions: EMBED_DIMENSIONS });
      try {
        for (const id of neededIds) {
          // Pass cfg.model so cross-model rows (or pre-v2 NULL rows) are
          // ignored. The matching memories will be embedded fresh below
          // under the active model.
          const emb = store.getEmbedding(id, cfg.model);
          if (emb) embedByMemoryId.set(id, emb);
        }
      } finally {
        store.close();
      }
    }
  }

  // Compute the misses on-the-fly. We do NOT persist these to the index:
  // the index is a Confidence Gate artifact and `memory-router lint` should
  // not have side-effects on it. If the user wants persistent embeddings
  // they run `memory-router index` separately.
  const missingIds = [...neededIds].filter((id) => !embedByMemoryId.has(id));
  if (missingIds.length > 0) {
    const inputs = missingIds.map((id) => {
      const m = byMemoryId.get(id);
      return m ? buildPairEmbedInput(m) : '';
    });
    const embedFn =
      opts.embedFn ??
      ((texts: string[]) =>
        embedBatch({
          apiKey: cfg!.apiKey,
          model: cfg!.model,
          baseUrl: cfg!.baseUrl,
          inputs: texts,
        }));
    const vectors = await embedFn(inputs);
    if (vectors.length !== missingIds.length) {
      // Fail-open: embedder returned a malformed batch. Don't upgrade
      // anything; the regex pass already gave a useful signal.
      process.stderr.write(
        `[memory-router] --semantic skipped: embedder returned ${vectors.length} vectors for ${missingIds.length} inputs\n`,
      );
      return baseReport;
    }
    missingIds.forEach((id, i) => embedByMemoryId.set(id, vectors[i]));
  }

  // Walk candidates, upgrade in-place on a copy of the hits array so the
  // base report stays untouched (callers may compare).
  const upgradedHits = baseReport.hits.slice();
  for (const { hit, idx } of polarityCandidates) {
    const va = embedByMemoryId.get(hit.a.memoryId);
    const vb = embedByMemoryId.get(hit.b.memoryId);
    if (!va || !vb) continue;
    const sim = cosineSimilarity(va, vb);
    if (sim >= SEMANTIC_SIMILARITY_THRESHOLD) {
      upgradedHits[idx] = {
        ...hit,
        severity: 'high',
        reason: `opposite imperatives + semantic similarity ${(sim * 100).toFixed(0)}% (--semantic)`,
      };
    }
  }

  return { ...baseReport, hits: upgradedHits };
}

module.exports = {
  lintMemoryDirForConflicts,
  lintMemoryDirForConflictsWithSemantic,
  formatConflictReportText,
  formatConflictReportJson,
  // Re-export for tests; private otherwise.
  __detectPolarity: detectPolarity,
  __firstLine: firstLine,
  __jaccard: jaccard,
  __contentTokens: contentTokens,
  __cosineSimilarity: cosineSimilarity,
  __SEMANTIC_SIMILARITY_THRESHOLD: SEMANTIC_SIMILARITY_THRESHOLD,
};
