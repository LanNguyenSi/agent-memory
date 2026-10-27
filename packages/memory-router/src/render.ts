// Renders gate hits as a single markdown block that Claude Code injects as
// `hookSpecificOutput.additionalContext`. The model sees this as system
// context alongside the user's prompt (UserPromptSubmit) or just before
// executing a tool (PreToolUse).
//
// Two entry points, deliberately separate:
//
// - renderHitsAsContext(hits): every hit's full body, no budget. This is the
//   original renderer with an unchanged output; the PreToolUse hook
//   (src/hooks/pre-tool-use.ts) and the public export keep calling it and
//   never reach the budgeted path below, so tuning that path cannot change
//   their output (tests/render-budget.test.ts pins the output against a
//   frozen copy of the original implementation). Tool-gate hits are few and
//   rule-shaped, so the full body is right there.
//
// - renderHitsBudgeted(hits, opts): the UserPromptSubmit renderer. A long
//   memory costs its whole body in the first form, and the measured cost of
//   that was a mean of 21 KB and a worst case of 116 KB per prompt. The
//   budgeted form injects what the agent needs to act on and where to read
//   the rest: the description, the chunk that matched the prompt (plus its
//   following neighbour when that chunk is short), and the memory's absolute
//   path. Short memories, and feedback memories up to a higher limit, are
//   still injected whole so a rule with its "Why" and "How to apply" lines is
//   never cut, and a feedback memory that is excerpted keeps its
//   "How to apply" paragraph even when the matched chunk misses it. The whole
//   injection is held to a byte budget.

const { resolve: resolvePath } = require('node:path');
const { checkMemoryReferences } = require('./verify-refs');
const { chunkBody } = require('./embed/chunking');

// Default total size of one budgeted injection, in bytes of the rendered
// UTF-8 string (16 KiB). Overridable per process with INJECT_BUDGET_ENV.
const DEFAULT_INJECT_BUDGET_BYTES = 16384;
const INJECT_BUDGET_ENV = 'MEMORY_ROUTER_INJECT_BUDGET';

// A memory whose trimmed body is at most this many characters is injected
// whole. About the size of one chunk (CHUNK_TARGET_CHARS is 1,500): there is
// little to gain from excerpting something that small.
const SHORT_BODY_MAX_CHARS = 2000;

// Same rule for `type: feedback`, with a higher limit: a feedback memory is a
// rule plus its "Why" and "How to apply", and an excerpt can cut exactly the
// line that makes it actionable. Measured on a 600-file corpus copy: the
// feedback bodies had a median of 1,728 chars, a 75th percentile of 2,501 and
// a 90th of 3,593; 3,000 keeps 84% of them whole (the sum over five hits is
// still held by the budget below).
const FEEDBACK_BODY_MAX_CHARS = 3000;

// When the best chunk is shorter than this, the chunk that follows it is
// injected too: a short chunk is typically a heading plus one rule and its
// explanation continues in the next chunk. Chunks are 1,235 chars at the
// median; the 600 cut sits at the 11th percentile.
const NEIGHBOUR_CHUNK_MAX_CHARS = 600;

// Cap, in characters, on the `**How to apply:**` paragraph appended to the
// excerpt of a long feedback memory: the actionable rule lives on that line
// and the best chunk usually misses it. About two thirds of a median chunk
// (1,235 chars): a rule paragraph longer than that belongs to the file
// behind the path line, not to every prompt.
const HOW_TO_APPLY_MAX_CHARS = 1000;

// Stands in for the part of a `**How to apply:**` paragraph past the cap.
const HOW_TO_APPLY_TRUNCATED = ' [...]';

// How much of a hit is rendered. Higher levels are shorter.
const LEVEL_WHOLE = 0; // heading, stale prefix, whole body
const LEVEL_EXCERPT = 1; // heading, stale prefix, description, chunk(s), path
const LEVEL_MINIMAL = 2; // heading, stale prefix, description, path

// Characters stripped from an env value before it is echoed to stderr, so a
// stray byte cannot corrupt the log line or the terminal showing it: C0
// controls and DEL, C1 controls (U+0080-U+009F, which include the 8-bit CSI
// introducer U+009B), and the bidi / format marks that reorder or hide text
// (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Resolves the injection budget: MEMORY_ROUTER_INJECT_BUDGET when it is a
// positive integer (bytes), else the default. An unset variable is the normal
// case and silent; a set but unusable value (empty, zero, negative, a
// fraction, not a number) falls back to the default and says so once on
// stderr, never on stdout.
function resolveInjectBudget(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => {
    process.stderr.write(m);
  },
): number {
  const raw = env[INJECT_BUDGET_ENV];
  if (raw === undefined) return DEFAULT_INJECT_BUDGET_BYTES;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  const shown = raw.replace(CONTROL_CHARS_RE, '').slice(0, 64);
  warn(
    `memory-router: ignoring invalid ${INJECT_BUDGET_ENV}="${shown}" (expected a positive integer number of bytes), using the default ${DEFAULT_INJECT_BUDGET_BYTES}\n`,
  );
  return DEFAULT_INJECT_BUDGET_BYTES;
}

function injectBytes(rendered: string): number {
  return Buffer.byteLength(rendered, 'utf8');
}

// The header text is user-visible and shared with PreToolUse, so it must not
// change; the dash is spelled as an escape (U+2014) to keep it exactly as
// before without a literal dash character in this file.
function headerFor(count: number): string {
  return count === 1
    ? '**memory-router** \u2014 1 relevant memory applies:'
    : `**memory-router** \u2014 ${count} relevant memories apply:`;
}

function headingFor(h: GateHit): string {
  const name = h.memory.frontmatter.name;
  const gateLabel = `${h.gate} · ${h.score.toFixed(2)}`;
  return `### ${name}  _(${gateLabel})_`;
}

// Consult frontmatter.verify: if any referenced path no longer exists, flag
// the block so the model treats the memory with skepticism. We never
// suppress, the agent should still see the rule, just with a loud "this
// might be outdated" marker.
function stalePrefixFor(h: GateHit): string {
  const staleness = checkMemoryReferences(h.memory.frontmatter.verify);
  return staleness.stale
    ? `> ⚠️ **stale:** ${staleness.reason}\n>\n> This memory references something that no longer exists. Verify before acting.\n\n`
    : '';
}

function renderHitsAsContext(hits: GateHit[]): string {
  if (hits.length === 0) return '';

  const blocks = hits.map((h) => {
    const body = h.memory.body.trim();
    return `${headingFor(h)}\n${stalePrefixFor(h)}${body}`;
  });

  return [headerFor(hits.length), ...blocks].join('\n\n');
}

// One chunk of a memory body as produced by chunkBody (src/embed/chunking.ts).
interface MemoryChunk {
  index: number;
  offset: number;
  text: string;
}

// Fence line, same shape the chunker treats as a fence boundary (see
// FENCE_RE in src/embed/chunking.ts), capturing the marker run.
const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/;

// Fence state of a line sequence: the marker of the fence that is open after
// the last line, or null. Mirrors the chunker's toggle (any fence line opens
// or closes).
function openFenceAfter(lines: string[], startMarker: string | null): string | null {
  let open = startMarker;
  for (const line of lines) {
    const m = FENCE_LINE_RE.exec(line);
    if (!m) continue;
    open = open === null ? m[1] : null;
  }
  return open;
}

// The chunker keeps a fenced block in one piece unless the block alone
// exceeds its hard cap, in which case it is split across chunks. A chunk cut
// that way starts or ends inside a fence; injecting it as is would leave an
// unbalanced fence that swallows everything after it in the context. Reopen
// the fence at the start and/or close it at the end so the excerpt is
// always balanced. A no-op for every chunk that does not straddle a fence.
function balanceFences(body: string, chunk: MemoryChunk): string {
  const lineBreak = body.lastIndexOf('\n', chunk.offset - 1);
  const completeLines =
    chunk.offset > 0 && lineBreak >= 0 ? body.slice(0, lineBreak + 1).split('\n') : [];
  const startMarker = openFenceAfter(completeLines, null);
  let text = chunk.text;
  if (startMarker !== null) text = `${startMarker}\n${text}`;
  const endMarker = openFenceAfter(text.split('\n'), null);
  if (endMarker !== null) text = `${text}\n${endMarker}`;
  return text;
}

interface PreparedHit {
  heading: string;
  stalePrefix: string;
  description: string;
  path: string;
  body: string;
  // Level a hit starts at before any budget pressure.
  startLevel: number;
  chunkIndex: number | undefined;
  chunkOffset: number | undefined;
  blocks: Map<number, string>;
  // The levels this hit can take, fullest first (see ladderOf). Computed on
  // first use, which only happens under budget pressure.
  ladder: number[] | undefined;
  hit: GateHit;
}

function prepareHit(h: GateHit): PreparedHit {
  const body = h.memory.body.trim();
  const limit =
    h.memory.frontmatter.type === 'feedback' ? FEEDBACK_BODY_MAX_CHARS : SHORT_BODY_MAX_CHARS;
  const rawDescription = h.memory.frontmatter.description;
  return {
    heading: headingFor(h),
    stalePrefix: stalePrefixFor(h),
    description: typeof rawDescription === 'string' ? rawDescription.trim() : '',
    path: resolvePath(h.memory.path),
    body,
    startLevel: body.length <= limit ? LEVEL_WHOLE : LEVEL_EXCERPT,
    chunkIndex: h.chunkIndex,
    chunkOffset: h.chunkOffset,
    blocks: new Map(),
    ladder: undefined,
    hit: h,
  };
}

// Line-start markers of the two rule paragraphs of a feedback memory.
const HOW_TO_APPLY_RE = /^\s*\*\*How to apply:\*\*/;
const WHY_RE = /^\s*\*\*Why:\*\*/;
// A markdown heading line, same shape the chunker treats as a boundary
// (HEADING_RE in src/embed/chunking.ts).
const HEADING_LINE_RE = /^#{1,6}(\s|$)/;

// The `**How to apply:**` paragraph of a body: the line carrying the marker
// and the lines continuing it, up to the next blank line, `**Why:**` line or
// heading line, or the end of the body. Empty string when there is no
// marker line. The `**Why:**` paragraph is out of scope: the marker only
// ends the paragraph, it is never appended.
function howToApplyParagraph(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => HOW_TO_APPLY_RE.test(l));
  if (start === -1) return '';
  const paragraph = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || WHY_RE.test(line) || HEADING_LINE_RE.test(line)) break;
    paragraph.push(line);
  }
  return paragraph.join('\n');
}

// Cut a paragraph at HOW_TO_APPLY_MAX_CHARS characters, keeping the total
// (marker included) within the cap.
function capHowToApply(paragraph: string): string {
  if (paragraph.length <= HOW_TO_APPLY_MAX_CHARS) return paragraph;
  const kept = HOW_TO_APPLY_MAX_CHARS - HOW_TO_APPLY_TRUNCATED.length;
  return `${paragraph.slice(0, kept).trimEnd()}${HOW_TO_APPLY_TRUNCATED}`;
}

// The excerpt of a hit: its best chunk, the following chunk too when the best
// one is short, always whole chunks. A `type: feedback` hit additionally
// keeps its `**How to apply:**` paragraph (capped) when that paragraph is
// not already part of the picked chunks: it is the actionable rule, and an
// excerpt cut to the chunk the prompt matched typically drops it. Whether it
// is already there is decided by containment in the picked chunk text, never
// by offsets inferred from line numbers. The chunks come from the same
// chunkBody(memory.body) call the indexer embeds, so while the index is
// current chunk i here is the text that was embedded as chunk i. An index
// older than the file breaks that: after an edit chunk i can be another
// region. The offset the search recorded for the chunk is the guard: when it
// is known and differs from the offset of chunk i in the current body, the
// index is stale for this memory and the excerpt falls back to the first
// chunk. An absent index, one the body no longer has, and a stale one all
// land on the first chunk. A hit whose offset is unknown (a keyword row the
// store could not name an offset for) is trusted by index alone.
function excerptFor(p: PreparedHit): string {
  const raw = p.hit.memory.body;
  const chunks: MemoryChunk[] = chunkBody(raw);
  if (chunks.length === 0) return '';
  let idx =
    p.chunkIndex !== undefined && p.chunkIndex >= 0 && p.chunkIndex < chunks.length
      ? p.chunkIndex
      : 0;
  if (p.chunkOffset !== undefined && chunks[idx].offset !== p.chunkOffset) idx = 0;
  const picked = [chunks[idx]];
  if (chunks[idx].text.length < NEIGHBOUR_CHUNK_MAX_CHARS && idx + 1 < chunks.length) {
    picked.push(chunks[idx + 1]);
  }
  const label =
    picked.length === 1
      ? `chunk ${idx + 1} of ${chunks.length}`
      : `chunks ${idx + 1}-${idx + 2} of ${chunks.length}`;
  const text = picked.map((c) => balanceFences(raw, c)).join('\n\n');
  if (p.hit.memory.frontmatter.type === 'feedback') {
    const paragraph = howToApplyParagraph(raw);
    if (paragraph !== '' && !text.includes(paragraph)) {
      return `_Excerpt (${label}):_\n${text}\n\n${capHowToApply(paragraph)}`;
    }
  }
  return `_Excerpt (${label}):_\n${text}`;
}

function blockAt(p: PreparedHit, level: number): string {
  const cached = p.blocks.get(level);
  if (cached !== undefined) return cached;
  let block: string;
  if (level === LEVEL_WHOLE) {
    block = `${p.heading}\n${p.stalePrefix}${p.body}`;
  } else {
    const parts: string[] = [];
    if (p.description !== '') parts.push(p.description);
    if (level === LEVEL_EXCERPT) {
      const excerpt = excerptFor(p);
      if (excerpt !== '') parts.push(excerpt);
    }
    // The path sits in backticks so a copy of the line takes the path alone,
    // not an emphasis underscore glued to the `.md` extension.
    parts.push(`_Full memory:_ \`${p.path}\``);
    block = `${p.heading}\n${p.stalePrefix}${parts.join('\n\n')}`;
  }
  p.blocks.set(level, block);
  return block;
}

// The levels a hit can take, fullest first: its start level, then each
// shorter level only when its block is smaller in bytes than the last rung
// kept, so every step down the ladder makes the output smaller. A shorter
// level is not always smaller: the excerpt and minimal forms add the
// description, a label and the path, so for a short body with a long
// description they can be larger than the whole body, and such a rung is left
// out (a ladder can be just [whole]).
function ladderOf(p: PreparedHit): number[] {
  if (p.ladder !== undefined) return p.ladder;
  const ladder = [p.startLevel];
  let lastBytes = injectBytes(blockAt(p, p.startLevel));
  for (let level = p.startLevel + 1; level <= LEVEL_MINIMAL; level++) {
    const bytes = injectBytes(blockAt(p, level));
    if (bytes < lastBytes) {
      ladder.push(level);
      lastBytes = bytes;
    }
  }
  p.ladder = ladder;
  return ladder;
}

function assemble(prepared: PreparedHit[], levels: number[], kept: number, budget: number): string {
  const blocks: string[] = [];
  for (let i = 0; i < kept; i++) blocks.push(blockAt(prepared[i], levels[i]));
  const omitted = prepared.length - kept;
  const footer =
    omitted > 0
      ? [
          `_${omitted} lower-ranked ${omitted === 1 ? 'memory' : 'memories'} left out to stay within the ${budget} byte injection budget._`,
        ]
      : [];
  return [headerFor(kept), ...blocks, ...footer].join('\n\n');
}

// Budgeted renderer for the UserPromptSubmit hook (and the eval/test reports
// that show what it would inject). `hits` arrive ranked, best first.
//
// Per hit: whole body when it is short (SHORT_BODY_MAX_CHARS, or
// FEEDBACK_BODY_MAX_CHARS for feedback), else description + best chunk +
// path, with a feedback hit's "How to apply" paragraph appended (capped)
// when the picked chunks do not already hold it.
// That start form is the top rung of the hit's ladder; below it come the
// excerpt and the minimal form (description + path), each only when it is
// smaller in bytes than the rung above it (see ladderOf). A candidate output
// keeps a prefix of the ranked hits (the top hit always), each on a rung of
// its ladder, plus a one-line note on how many were left out.
//
// The rule: when every hit fits in its start form, that is the output.
// Otherwise, among the candidate outputs that fit the budget, the best one in
// this order wins:
//   1. the top hit's rung, fuller first;
//   2. then the number of hits kept, more first;
//   3. then the rung of hit 2, then of hit 3, and so on, fuller first.
// So the top hit keeps the fullest form at which any output fits (its start
// form whenever it fits alone); as many lower hits are kept as fit next to
// that top form with each of them on its smallest rung, so hits are dropped
// only from the bottom, only when they do not fit next to that top form; the
// kept hits below the top get the fullest rungs that fit, best-ranked first,
// so a lower hit only gets room the hits above it could not use. When no
// candidate fits, the top hit is emitted alone on its smallest rung, over the
// budget. Since every rung is smaller than the one above it, a hit is never
// rendered larger than its start form. Shortening works on whole blocks and
// whole chunks, never on character offsets.
function renderHitsBudgeted(hits: GateHit[], opts: { budgetBytes?: number } = {}): string {
  if (hits.length === 0) return '';

  const requested = opts.budgetBytes;
  const budget =
    typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0
      ? requested
      : resolveInjectBudget();

  const prepared = hits.map(prepareHit);
  const n = prepared.length;
  const levels = prepared.map((p) => p.startLevel);
  const fits = (kept: number): boolean => injectBytes(assemble(prepared, levels, kept, budget)) <= budget;
  if (fits(n)) return assemble(prepared, levels, n, budget);

  const ladders = prepared.map(ladderOf);
  const smallest = ladders.map((ladder) => ladder[ladder.length - 1]);
  for (let i = 1; i < n; i++) levels[i] = smallest[i];

  // 1 and 2: the top hit's rung, fullest first, and for the first rung at
  // which anything fits the largest number of hits that fits with every other
  // kept hit on its smallest rung. The top hit is never dropped.
  let kept: number | undefined;
  for (const rung of ladders[0]) {
    levels[0] = rung;
    for (let k = n; k >= 1 && kept === undefined; k--) {
      if (fits(k)) kept = k;
    }
    if (kept !== undefined) break;
  }
  // Nothing fits: the top hit alone, on its smallest rung (the last one tried).
  if (kept === undefined) return assemble(prepared, levels, 1, budget);

  // 3: the kept hits below the top, best-ranked first, each on the fullest
  // rung at which the output still fits with the hits below it on their
  // smallest rungs.
  for (let i = 1; i < kept; i++) {
    for (const rung of ladders[i]) {
      if (rung === smallest[i]) break;
      levels[i] = rung;
      if (fits(kept)) break;
      levels[i] = smallest[i];
    }
  }

  return assemble(prepared, levels, kept, budget);
}

// The forms the budgeted renderer may give a hit, fullest first, by name.
// Exported for tests that pin the ladder itself (see ladderOf).
function ladderFor(h: GateHit): Array<'whole' | 'excerpt' | 'minimal'> {
  const names = ['whole', 'excerpt', 'minimal'] as const;
  return ladderOf(prepareHit(h)).map((l) => names[l]);
}

// One hit's block in a named form, whether or not that form is on the hit's
// ladder. Exported for the property test that checks the budget rule against
// a brute-force oracle (tests/render-budget-property.test.ts).
function blockFor(h: GateHit, form: 'whole' | 'excerpt' | 'minimal'): string {
  const levels = { whole: LEVEL_WHOLE, excerpt: LEVEL_EXCERPT, minimal: LEVEL_MINIMAL };
  return blockAt(prepareHit(h), levels[form]);
}

module.exports = {
  renderHitsAsContext,
  renderHitsBudgeted,
  ladderFor,
  blockFor,
  resolveInjectBudget,
  injectBytes,
  DEFAULT_INJECT_BUDGET_BYTES,
  INJECT_BUDGET_ENV,
  SHORT_BODY_MAX_CHARS,
  FEEDBACK_BODY_MAX_CHARS,
  NEIGHBOUR_CHUNK_MAX_CHARS,
  HOW_TO_APPLY_MAX_CHARS,
  HOW_TO_APPLY_TRUNCATED,
};
