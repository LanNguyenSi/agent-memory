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
//   never cut. The whole injection is held to a byte budget.

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

// How much of a hit is rendered. Higher levels are shorter.
const LEVEL_WHOLE = 0; // heading, stale prefix, whole body
const LEVEL_EXCERPT = 1; // heading, stale prefix, description, chunk(s), path
const LEVEL_MINIMAL = 2; // heading, stale prefix, description, path

// Control characters stripped from an env value before it is echoed to
// stderr, so a stray byte cannot corrupt the log line.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;

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
  blocks: Map<number, string>;
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
    blocks: new Map(),
    hit: h,
  };
}

// The excerpt of a hit: its best chunk, the following chunk too when the best
// one is short, always whole chunks. A chunk index the body no longer has
// (index built before the file changed) and an absent index both fall back
// to the first chunk. The text comes from the same chunkBody(memory.body)
// call the indexer embeds, so chunk i here is the text that was embedded as
// chunk i.
function excerptFor(p: PreparedHit): string {
  const raw = p.hit.memory.body;
  const chunks: MemoryChunk[] = chunkBody(raw);
  if (chunks.length === 0) return '';
  const idx =
    p.chunkIndex !== undefined && p.chunkIndex >= 0 && p.chunkIndex < chunks.length
      ? p.chunkIndex
      : 0;
  const picked = [chunks[idx]];
  if (chunks[idx].text.length < NEIGHBOUR_CHUNK_MAX_CHARS && idx + 1 < chunks.length) {
    picked.push(chunks[idx + 1]);
  }
  const label =
    picked.length === 1
      ? `chunk ${idx + 1} of ${chunks.length}`
      : `chunks ${idx + 1}-${idx + 2} of ${chunks.length}`;
  return `_Excerpt (${label}):_\n${picked.map((c) => balanceFences(raw, c)).join('\n\n')}`;
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
    parts.push(`_Full memory: ${p.path}_`);
    block = `${p.heading}\n${p.stalePrefix}${parts.join('\n\n')}`;
  }
  p.blocks.set(level, block);
  return block;
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
// FEEDBACK_BODY_MAX_CHARS for feedback), else description + best chunk + path.
// Over budget: shorten the lowest-ranked hits first (whole, then excerpt,
// then description + path only), one level at a time, then drop the
// lowest-ranked hits. The top hit is never dropped: when even its minimal
// form is over the budget it is emitted in that form anyway. Shortening works
// on whole blocks and whole chunks, never on character offsets.
function renderHitsBudgeted(hits: GateHit[], opts: { budgetBytes?: number } = {}): string {
  if (hits.length === 0) return '';

  const requested = opts.budgetBytes;
  const budget =
    typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0
      ? requested
      : resolveInjectBudget();

  const prepared = hits.map(prepareHit);
  const levels = prepared.map((p) => p.startLevel);
  let kept = prepared.length;
  let size = injectBytes(assemble(prepared, levels, kept, budget));

  for (let i = prepared.length - 1; i >= 0 && size > budget; i--) {
    while (levels[i] < LEVEL_MINIMAL && size > budget) {
      levels[i]++;
      size = injectBytes(assemble(prepared, levels, kept, budget));
    }
  }
  while (size > budget && kept > 1) {
    kept--;
    size = injectBytes(assemble(prepared, levels, kept, budget));
  }

  return assemble(prepared, levels, kept, budget);
}

module.exports = {
  renderHitsAsContext,
  renderHitsBudgeted,
  resolveInjectBudget,
  injectBytes,
  DEFAULT_INJECT_BUDGET_BYTES,
  INJECT_BUDGET_ENV,
  SHORT_BODY_MAX_CHARS,
  FEEDBACK_BODY_MAX_CHARS,
  NEIGHBOUR_CHUNK_MAX_CHARS,
};
