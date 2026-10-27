// Property test for the budget rule of renderHitsBudgeted (src/render.ts).
//
// Seeded random hit sets (1 to 6 hits: tiny bodies with long descriptions,
// short bodies whose excerpt form is larger than the whole body, bodies
// around the whole-body limits, long multi-section bodies, multi-byte text,
// fenced blocks including one longer than the chunker's cap) are rendered at
// every boundary budget: the exact size of every output the rule could pick
// for the set, and one byte either side. Each output is checked against the
// properties the rule promises, and compared with a brute-force oracle that
// enumerates every kept prefix of the ranked hits and every combination of
// rungs on their ladders:
//
// P1 the output fits the budget, unless only the top hit is left, in the
//    smallest rung of its ladder;
// P2 the top hit is never dropped;
// P3 hits are dropped only from the bottom, and only when no output that
//    keeps them fits with the top hit in its form and every other kept hit
//    at its smallest rung;
// P4 best-first: among the outputs that fit, the top hit's rung decides
//    first (fuller wins), then the number of hits kept (more wins), then the
//    rung of hit 2, hit 3 and so on (fuller wins);
// P5 no hit is rendered larger than its start form: its rung is on its
//    ladder, and every rung down a ladder is smaller in bytes than the one
//    above it.
//
// The oracle builds the ladders itself from the size of each form's block
// (blockFor) and assembles candidate outputs itself (header, blocks, footer),
// so it shares no allocation code with the renderer.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderHitsBudgeted,
  blockFor,
  ladderFor,
  injectBytes,
  SHORT_BODY_MAX_CHARS,
  FEEDBACK_BODY_MAX_CHARS,
} = require('../src/render');

type Form = 'whole' | 'excerpt' | 'minimal';
const FORMS: Form[] = ['whole', 'excerpt', 'minimal'];

interface Rung {
  form: Form;
  block: string;
  bytes: number;
}

interface Candidate {
  // Rung index (0 = fullest) per kept hit; its length is the kept count.
  idx: number[];
  // Size in bytes without the budget digits the footer prints.
  base: number;
}

// --- seeded generator ----------------------------------------------------------

// mulberry32: small, fast, deterministic.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const int = (r: Rand, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

// ASCII and multi-byte words (2, 3 and 4 bytes per character in UTF-8).
const WORDS = ['rule', 'deploy', 'branch', 'merge', 'Größe', 'Straße', 'naïve', '€', '日本語', 'ok🙂', 'x'];

function words(r: Rand, minChars: number): string {
  let s = '';
  while (s.length < minChars) s += (s === '' ? '' : ' ') + pick(r, WORDS);
  return s;
}

function paragraphs(r: Rand, count: number, lo: number, hi: number): string {
  return Array.from({ length: count }, () => words(r, int(r, lo, hi))).join('\n\n');
}

function fencedBody(r: Rand): string {
  const marker = r() < 0.7 ? '```' : '~~~';
  // Sometimes a fence longer than the chunker's 3,000-char cap, which the
  // chunker splits (and the renderer reopens / closes).
  const lineCount = r() < 0.3 ? 130 : int(r, 2, 12);
  const lines = Array.from({ length: lineCount }, (_, i) => `echo ${i} ${words(r, int(r, 5, 25))}`);
  return [words(r, int(r, 50, 900)), `${marker}sh\n${lines.join('\n')}\n${marker}`, words(r, int(r, 20, 700))].join('\n\n');
}

function body(r: Rand, limit: number): string {
  const kind = r();
  if (kind < 0.04) return '';
  if (kind < 0.24) return words(r, int(r, 1, 40));
  if (kind < 0.44) return paragraphs(r, int(r, 1, 3), 20, 600);
  if (kind < 0.56) return words(r, int(r, limit - 40, limit + 40));
  if (kind < 0.8) {
    const secs = paragraphs(r, int(r, 2, 5), 200, 1400);
    return r() < 0.4 ? `## Heading ${words(r, 5)}\n\n${secs}` : secs;
  }
  if (kind < 0.92) return fencedBody(r);
  return Array.from({ length: int(r, 3, 40) }, () => `- ${words(r, int(r, 10, 120))}`).join('\n');
}

function description(r: Rand): string | undefined {
  const kind = r();
  if (kind < 0.1) return undefined;
  if (kind < 0.15) return '';
  if (kind < 0.6) return words(r, int(r, 5, 150));
  return words(r, int(r, 300, 2500));
}

function randomHit(r: Rand, i: number): GateHit {
  const type = r() < 0.3 ? 'feedback' : 'project';
  const limit = type === 'feedback' ? FEEDBACK_BODY_MAX_CHARS : SHORT_BODY_MAX_CHARS;
  const frontmatter: MemoryFrontmatter = {
    name: r() < 0.2 ? `h${i} Übersicht` : `h${i}`,
    description: description(r) as string,
    type,
  };
  if (r() < 0.08) frontmatter.verify = [{ kind: 'path', value: '/definitely/not/here/anywhere' }];
  const h: GateHit = {
    memory: { id: `h${i}`, path: `/mem/h${i}.md`, frontmatter, body: body(r, limit) },
    gate: pick(r, ['confidence', 'keyword', 'topic'] as const),
    score: Math.round((0.95 - i * 0.05) * 100) / 100,
    reason: 'property',
  };
  if (r() < 0.6) {
    h.chunkIndex = int(r, 0, 5);
    if (r() < 0.25) h.chunkOffset = r() < 0.5 ? 0 : int(r, 1, 4000);
  }
  return h;
}

// --- oracle ----------------------------------------------------------------------

function startForm(h: GateHit): Form {
  const limit = h.memory.frontmatter.type === 'feedback' ? FEEDBACK_BODY_MAX_CHARS : SHORT_BODY_MAX_CHARS;
  return h.memory.body.trim().length <= limit ? 'whole' : 'excerpt';
}

// The start form, then each shorter form only when its block is smaller in
// bytes than the last rung kept.
function oracleLadder(h: GateHit): Rung[] {
  const rungs: Rung[] = [];
  for (const form of FORMS.slice(FORMS.indexOf(startForm(h)))) {
    const block = blockFor(h, form);
    const bytes = injectBytes(block);
    if (rungs.length === 0 || bytes < rungs[rungs.length - 1].bytes) rungs.push({ form, block, bytes });
  }
  return rungs;
}

function header(kept: number): string {
  return kept === 1
    ? '**memory-router** \u2014 1 relevant memory applies:'
    : `**memory-router** \u2014 ${kept} relevant memories apply:`;
}

function footer(omitted: number, budget: number | string): string {
  return `_${omitted} lower-ranked ${omitted === 1 ? 'memory' : 'memories'} left out to stay within the ${budget} byte injection budget._`;
}

function assembleOracle(ladders: Rung[][], idx: number[], budget: number): string {
  const parts = [header(idx.length), ...idx.map((r, i) => ladders[i][r].block)];
  if (idx.length < ladders.length) parts.push(footer(ladders.length - idx.length, budget));
  return parts.join('\n\n');
}

function sizeAt(c: Candidate, n: number, budget: number): number {
  return c.base + (c.idx.length < n ? String(budget).length : 0);
}

function candidatesOf(ladders: Rung[][]): Candidate[] {
  const n = ladders.length;
  const out: Candidate[] = [];
  const walk = (idx: number[], blockBytes: number): void => {
    const k = idx.length;
    if (k > 0) {
      const footerBytes = k < n ? injectBytes(footer(n - k, '')) + 2 : 0;
      out.push({ idx: idx.slice(), base: injectBytes(header(k)) + blockBytes + 2 * k + footerBytes });
    }
    if (k === n) return;
    for (let r = 0; r < ladders[k].length; r++) {
      idx.push(r);
      walk(idx, blockBytes + ladders[k][r].bytes);
      idx.pop();
    }
  };
  walk([], 0);
  // Best first: the top hit's rung (fuller wins), then the kept count (more
  // wins), then the rungs of hit 2, 3, ... (fuller wins).
  return out.sort((a, b) => {
    if (a.idx[0] !== b.idx[0]) return a.idx[0] - b.idx[0];
    if (a.idx.length !== b.idx.length) return b.idx.length - a.idx.length;
    for (let i = 1; i < a.idx.length; i++) if (a.idx[i] !== b.idx[i]) return a.idx[i] - b.idx[i];
    return 0;
  });
}

// The exact size of every candidate output, and one byte either side. The
// footer prints the budget, so a candidate with a footer has one exact size
// per digit count of the budget.
function boundaryBudgets(cands: Candidate[], n: number): number[] {
  const set = new Set<number>([1, 2, 10_000_000]);
  for (const c of cands) {
    const exact: number[] = [];
    if (c.idx.length === n) exact.push(c.base);
    else for (let d = 1; d <= 8; d++) if (String(c.base + d).length === d) exact.push(c.base + d);
    for (const s of exact) for (const b of [s - 1, s, s + 1]) if (b >= 1) set.add(b);
  }
  return [...set].sort((a, b) => a - b);
}

// --- reading an output back --------------------------------------------------------

// The kept hits and the rung index of each (-1: a form not on its ladder),
// or a string saying why the output is not a prefix of the ranked hits.
function parse(out: string, hits: GateHit[], ladders: Rung[][]): { idx: number[] } | string {
  const m = /^\*\*memory-router\*\* \u2014 (\d+) relevant memor(?:y applies|ies apply):/.exec(out);
  if (!m) return 'no header';
  const kept = Number(m[1]);
  const fm = /\n\n_\d+ lower-ranked memor(?:y|ies) left out to stay within the \d+ byte injection budget\._$/.exec(out);
  const rest = fm ? out.slice(0, fm.index) : out;
  const parts = rest.split('\n\n### ');
  if (parts[0] !== header(kept)) return 'header and block count disagree';
  if (parts.length - 1 !== kept) return `header says ${kept}, found ${parts.length - 1} blocks`;
  if (kept < hits.length && !fm) return 'hits left out without a footer';
  const idx: number[] = [];
  for (let i = 0; i < kept; i++) {
    const block = `### ${parts[i + 1]}`;
    const r = ladders[i].findIndex((rung) => rung.block === block);
    if (r >= 0) {
      idx.push(r);
      continue;
    }
    if (FORMS.some((f) => blockFor(hits[i], f) === block)) {
      idx.push(-1);
      continue;
    }
    return `block ${i + 1} is not a form of hit ${i + 1} (a hit above it was dropped?)`;
  }
  return { idx };
}

// --- the property ----------------------------------------------------------------

interface Failure {
  seed: number;
  budget: number;
  property: string;
  detail: string;
}

// How often the oracle's pick fell into each case, so the test can show it
// reached every branch of the rule rather than passing on easy inputs.
interface Seen {
  allStart: number;
  dropped: number;
  topShortenedWithOthers: number;
  lowerLifted: number;
  overBudget: number;
}

function checkSet(seed: number, hits: GateHit[], failures: Failure[], seen: Seen): number {
  const n = hits.length;
  const ladders = hits.map(oracleLadder);
  const cands = candidatesOf(ladders);
  const smallest = ladders.map((l) => l.length - 1);
  const budgets = boundaryBudgets(cands, n);
  const fail = (budget: number, property: string, detail: string): void => {
    failures.push({ seed, budget, property, detail });
  };
  const formsOf = (idx: number[]): string =>
    idx.map((r, i) => (r < 0 ? 'off-ladder' : ladders[i][r].form)).join(',');
  for (const budget of budgets) {
    const out: string = renderHitsBudgeted(hits, { budgetBytes: budget });
    const size = injectBytes(out);
    const best = cands.find((c) => sizeAt(c, n, budget) <= budget);
    const expectedIdx = best ? best.idx : [smallest[0]];
    const expected = assembleOracle(ladders, expectedIdx, budget);
    if (!best) seen.overBudget++;
    else if (expectedIdx.length === n && expectedIdx.every((r) => r === 0)) seen.allStart++;
    else {
      if (expectedIdx.length < n) seen.dropped++;
      if (expectedIdx[0] > 0 && expectedIdx.length > 1) seen.topShortenedWithOthers++;
      if (expectedIdx.some((r, i) => i > 0 && r < smallest[i])) seen.lowerLifted++;
    }
    const parsed = parse(out, hits, ladders);
    if (typeof parsed === 'string') {
      fail(budget, parsed.startsWith('block 1 ') ? 'P2' : 'P3', parsed);
      continue;
    }
    const { idx } = parsed;
    const kept = idx.length;
    // P2: the top hit is there (parse matched block 1 against hit 1).
    if (kept < 1) fail(budget, 'P2', 'no hit kept');
    // P5: every kept hit is on a rung of its ladder, never above its start form.
    if (idx.some((r) => r < 0)) fail(budget, 'P5', `forms ${formsOf(idx)}`);
    if (idx.some((r) => r < 0)) continue;
    // P1: over the budget only as the lone top hit in its smallest rung.
    if (size > budget && !(kept === 1 && idx[0] === smallest[0])) {
      fail(budget, 'P1', `${size} bytes over ${budget} with ${kept} hit(s) [${formsOf(idx)}]`);
    }
    // P3: no output keeping more hits fits, with the top hit in its form and
    // every other kept hit at its smallest rung.
    for (let more = kept + 1; more <= n; more++) {
      const c = cands.find((x) => x.idx.length === more && x.idx[0] === idx[0] && x.idx.every((r, i) => i === 0 || r === smallest[i]));
      if (c && sizeAt(c, n, budget) <= budget) {
        fail(budget, 'P3', `kept ${kept} but ${more} fit (${sizeAt(c, n, budget)} bytes)`);
        break;
      }
    }
    // P4: the allocation is the oracle's best-first pick, to the byte.
    if (idx.join() !== expectedIdx.join()) {
      fail(budget, 'P4', `got [${formsOf(idx)}], best-first is [${formsOf(expectedIdx)}]`);
    } else if (out !== expected) {
      fail(budget, 'P4', 'same forms, different text');
    }
  }
  return budgets.length;
}

function summary(failures: Failure[]): string {
  const by: Record<string, number> = {};
  for (const f of failures) by[f.property] = (by[f.property] ?? 0) + 1;
  const first = failures.slice(0, 5).map((f) => `seed ${f.seed} budget ${f.budget} ${f.property}: ${f.detail}`);
  return `${failures.length} violation(s) ${JSON.stringify(by)}\n${first.join('\n')}`;
}

const SETS = 500;

test(`budget rule: ${SETS} seeded hit sets at every boundary budget meet P1-P5 and match the brute-force best-first oracle`, () => {
  const failures: Failure[] = [];
  const seen: Seen = { allStart: 0, dropped: 0, topShortenedWithOthers: 0, lowerLifted: 0, overBudget: 0 };
  let checked = 0;
  const sizes = new Set<number>();
  for (let seed = 1; seed <= SETS; seed++) {
    const r = prng(seed);
    const hits = Array.from({ length: 1 + (seed % 6) }, (_, i) => randomHit(r, i));
    sizes.add(hits.length);
    checked += checkSet(seed, hits, failures, seen);
  }
  assert.deepEqual([...sizes].sort(), [1, 2, 3, 4, 5, 6], 'every set size from 1 to 6 hits');
  assert.ok(checked > 20_000, `checked ${checked} (set, budget) pairs`);
  for (const [name, count] of Object.entries(seen)) {
    assert.ok(count > 100, `the oracle's pick reached the case "${name}" (${count} times)`);
  }
  assert.equal(failures.length, 0, summary(failures));
});

test('budget rule: the generator reaches the shapes the rule has to handle', () => {
  let minimalNotSmaller = 0;
  let excerptNotSmaller = 0;
  let excerptStart = 0;
  let multiByte = 0;
  let splitFence = 0;
  for (let seed = 1; seed <= SETS; seed++) {
    const r = prng(seed);
    const hits = Array.from({ length: 1 + (seed % 6) }, (_, i) => randomHit(r, i));
    for (const h of hits) {
      const whole = injectBytes(blockFor(h, 'whole'));
      if (startForm(h) === 'excerpt') excerptStart++;
      else {
        if (injectBytes(blockFor(h, 'minimal')) >= whole) minimalNotSmaller++;
        if (injectBytes(blockFor(h, 'excerpt')) >= whole) excerptNotSmaller++;
      }
      if (Buffer.byteLength(h.memory.body) > h.memory.body.length) multiByte++;
      if (/(`{3}|~{3})[\s\S]{3000,}/.test(h.memory.body)) splitFence++;
    }
  }
  assert.ok(minimalNotSmaller > 20, `tiny body, long description: minimal not smaller than whole (${minimalNotSmaller})`);
  assert.ok(excerptNotSmaller > 50, `excerpt form not smaller than whole (${excerptNotSmaller})`);
  assert.ok(excerptStart > 50, `hits that start as an excerpt (${excerptStart})`);
  assert.ok(multiByte > 100, `multi-byte bodies (${multiByte})`);
  assert.ok(splitFence > 5, `fences longer than the chunker cap (${splitFence})`);
});

test('budget rule: the renderer ladder is the oracle ladder (strictly decreasing in bytes, from the start form)', () => {
  for (let seed = 1; seed <= SETS; seed++) {
    const r = prng(seed);
    const hits = Array.from({ length: 1 + (seed % 6) }, (_, i) => randomHit(r, i));
    for (const h of hits) {
      assert.deepEqual(
        ladderFor(h),
        oracleLadder(h).map((rung) => rung.form),
        `seed ${seed} ${h.memory.id}`,
      );
    }
  }
});
