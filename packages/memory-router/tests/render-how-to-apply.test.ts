// The `**How to apply:**` paragraph of a long feedback memory survives
// excerpting (excerptFor in src/render.ts): the excerpt of a `type: feedback`
// hit appends the paragraph (capped at HOW_TO_APPLY_MAX_CHARS) when the
// picked chunks do not already hold it, and nothing else about the rendered
// block changes. Non-feedback hits, whole and minimal forms, and feedback
// hits without such a paragraph render exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderHitsAsContext,
  renderHitsBudgeted,
  blockFor,
  ladderFor,
  injectBytes,
  FEEDBACK_BODY_MAX_CHARS,
  HOW_TO_APPLY_MAX_CHARS,
  HOW_TO_APPLY_TRUNCATED,
} = require('../src/render');
const { chunkBody } = require('../src/embed/chunking');

// --- builders (same shapes as tests/render-budget.test.ts) -------------------

function mem(id: string, body: string, over: Partial<MemoryFrontmatter> = {}): Memory {
  return {
    id,
    path: `/mem/${id}.md`,
    frontmatter: {
      name: `Name of ${id}`,
      description: `Description of ${id}`,
      type: 'project',
      ...over,
    },
    body,
  };
}

function hit(memory: Memory, score = 0.8, extra: Partial<GateHit> = {}): GateHit {
  return { memory, gate: 'confidence', score, reason: 'test', ...extra };
}

function para(marker: string, len: number): string {
  const text = `${marker} `;
  return text + 'x'.repeat(Math.max(0, len - text.length));
}

function sections(n: number, len = 1100): string {
  return Array.from({ length: n }, (_, i) => para(`SECTION${i + 1}`, len)).join('\n\n');
}

const HTA = '**How to apply:** run the lint gate before every merge.';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// --- (a) outside the best chunk: the paragraph is appended --------------------

test('long feedback, How to apply outside the best chunk: the excerpt keeps the paragraph', () => {
  const body = `${sections(3)}\n\n${HTA}`;
  const m = mem('htaOut', body, { type: 'feedback' });
  const chunks = chunkBody(m.body);
  assert.ok(m.body.trim().length > FEEDBACK_BODY_MAX_CHARS, 'fixture: long enough to excerpt');
  assert.ok(!chunks[0].text.includes('**How to apply:'), 'fixture: the best chunk misses it');
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: 0 })]);
  assert.match(out, /_Excerpt \(chunk 1 of \d+\):_/);
  assert.ok(out.includes(HTA), 'the paragraph is in the injected text');
  const htaAt = out.indexOf(HTA);
  assert.ok(htaAt > out.indexOf('SECTION1 '), 'appended after the picked chunk');
  assert.ok(htaAt < out.indexOf('_Full memory:_'), 'before the path line');
  assert.equal(countOccurrences(out, '**How to apply:'), 1, 'appended once');
});

test('the minimal form never carries the paragraph', () => {
  const m = mem('htaMin', `${sections(3)}\n\n${HTA}`, { type: 'feedback' });
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: 0 })], { budgetBytes: 1 });
  assert.ok(out.includes('_Full memory:_') && !out.includes('_Excerpt ('), 'fixture: minimal');
  assert.ok(!out.includes('**How to apply:'));
});

// --- (b) already inside the picked chunk: exactly once -------------------------

test('long feedback, How to apply inside the picked chunk: it appears exactly once', () => {
  // Same body as the previous test: the paragraph merges into the last
  // chunk (both fit the chunk target). Picking that chunk must not append
  // the paragraph a second time.
  const body = `${sections(3)}\n\n${HTA}`;
  const m = mem('htaIn', body, { type: 'feedback' });
  const chunks = chunkBody(m.body);
  assert.equal(chunks.length, 3, 'fixture: the paragraph merged into the last chunk');
  assert.ok(chunks[2].text.includes(HTA));
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: 2 })]);
  assert.match(out, /_Excerpt \(chunk 3 of 3\):_/, 'the picked chunk holds the paragraph');
  assert.ok(out.includes('SECTION3 '));
  assert.equal(countOccurrences(out, '**How to apply:'), 1);
});

test('a short best chunk pulls in the neighbour holding the paragraph: still exactly once', () => {
  // SHORT (300) + SEC2 (1,250) exceeds the chunk target, so SHORT is its own
  // chunk and pulls SEC2 (which carries the paragraph) in as its neighbour.
  const body = `${para('SHORT', 300)}\n\n${para('SEC2', 1250)}\n\n${HTA}\n\n${para('SEC4', 1450)}`;
  const m = mem('htaNb', body, { type: 'feedback' });
  const chunks = chunkBody(m.body);
  assert.equal(chunks.length, 3, 'fixture: SHORT is its own chunk');
  assert.ok(chunks[0].text.length < 600, 'fixture: short best chunk takes its neighbour');
  assert.ok(chunks[1].text.includes(HTA), 'fixture: the neighbour holds the paragraph');
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: 0 })]);
  assert.match(out, /_Excerpt \(chunks 1-2 of 3\):_/);
  assert.equal(countOccurrences(out, '**How to apply:'), 1);
});

// --- (c) long feedback without a How-to-apply paragraph: byte-identical --------

test('long feedback without a How to apply paragraph: the excerpt block is byte-identical to the pre-change render', () => {
  const m = mem('htaNone', sections(3), { type: 'feedback' });
  const chunks = chunkBody(m.body);
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: 0 })]);
  const expected =
    '**memory-router** \u2014 1 relevant memory applies:\n\n' +
    '### Name of htaNone  _(confidence · 0.80)_\n' +
    'Description of htaNone\n\n' +
    `_Excerpt (chunk 1 of ${chunks.length}):_\n${chunks[0].text}\n\n` +
    '_Full memory:_ `/mem/htaNone.md`';
  assert.equal(out, expected);
});

// --- (d) non-feedback: unchanged -------------------------------------------------

test('long project memory with a How to apply line: nothing is appended', () => {
  const body = `${sections(2)}\n\n${HTA}`;
  const m = mem('htaProj', body, { type: 'project' });
  const chunks = chunkBody(m.body);
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: 0 })]);
  assert.match(out, /_Excerpt \(chunk 1 of \d+\):_/, 'fixture: still excerpted');
  const expected =
    '**memory-router** \u2014 1 relevant memory applies:\n\n' +
    '### Name of htaProj  _(confidence · 0.80)_\n' +
    'Description of htaProj\n\n' +
    `_Excerpt (chunk 1 of ${chunks.length}):_\n${chunks[0].text}\n\n` +
    '_Full memory:_ `/mem/htaProj.md`';
  assert.equal(out, expected, 'byte-identical to the render without the append');
});

// --- (e) paragraph longer than the cap: truncated with the marker ----------------

test('How to apply paragraph past the cap: truncated to the cap with the marker', () => {
  const paragraph = `**How to apply:** ${'h'.repeat(2000)}`;
  const m = mem('htaCap', `${sections(2)}\n\n${paragraph}`, { type: 'feedback' });
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: 0 })]);
  const from = out.lastIndexOf('\n\n**How to apply:**') + 2;
  const to = out.indexOf('\n\n_Full memory:_');
  const appended = out.slice(from, to);
  assert.ok(!out.includes(paragraph), 'the full paragraph is not injected');
  assert.ok(appended.endsWith(HOW_TO_APPLY_TRUNCATED), 'the truncation marker is present');
  assert.equal(appended.length, HOW_TO_APPLY_MAX_CHARS, 'the cap bounds the paragraph');
  assert.equal(appended, paragraph.slice(0, HOW_TO_APPLY_MAX_CHARS - HOW_TO_APPLY_TRUNCATED.length) + HOW_TO_APPLY_TRUNCATED);
});

// --- (f) short feedback (whole): unchanged ---------------------------------------

test('short feedback memory with a How to apply line: injected whole, the line appears once', () => {
  const body = `Never do the thing.\n\n**Why:** ${'w'.repeat(1500)}\n\n${HTA}`;
  const m = mem('htaWhole', body, { type: 'feedback' });
  assert.ok(m.body.trim().length <= FEEDBACK_BODY_MAX_CHARS, 'fixture: whole-eligible');
  const out = renderHitsBudgeted([hit(m)]);
  assert.equal(out, renderHitsAsContext([hit(m)]), 'byte-identical to the whole-body block');
  assert.equal(countOccurrences(out, '**How to apply:'), 1);
});

// --- paragraph boundaries ----------------------------------------------------------

test('the paragraph ends at the next blank line: continuation lines come with it, later ones do not', () => {
  const body = [
    sections(3),
    `**How to apply:** always run the gate.\nThen read the report it writes.`,
    'Some other paragraph, not part of the rule.',
    HTA,
  ].join('\n\n');
  const m = mem('htaBlank', body, { type: 'feedback' });
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: 0 })]);
  assert.ok(out.includes('**How to apply:** always run the gate.\nThen read the report it writes.'));
  assert.ok(!out.includes('not part of the rule'), 'the next paragraph is not appended');
});

test('the paragraph stops at a following Why line or heading: neither is appended', () => {
  const bodyA = [sections(3), `**How to apply:** always run the gate.\n**Why:** because it has teeth.`].join('\n\n');
  const outA = renderHitsBudgeted([hit(mem('htaWhy', bodyA, { type: 'feedback' }), 0.8, { chunkIndex: 0 })]);
  assert.ok(outA.includes('**How to apply:** always run the gate.'));
  assert.ok(!outA.includes('**Why:** because it has teeth'), 'the Why line is not appended');

  const bodyB = [sections(3), `**How to apply:** always run the gate.\n## Next section`, 'Tail text.'].join('\n\n');
  const outB = renderHitsBudgeted([hit(mem('htaHead', bodyB, { type: 'feedback' }), 0.8, { chunkIndex: 0 })]);
  assert.ok(outB.includes('**How to apply:** always run the gate.'));
  assert.ok(!outB.includes('## Next section') && !outB.includes('Tail text.'), 'the heading section is not appended');
});

// --- the ladder stays strictly decreasing -------------------------------------------

test('an excerpt made larger than the whole body by the append is no rung of the ladder', () => {
  const body = `${para('SEC1', 1100)}\n\n**How to apply:** ${'a'.repeat(800)}`;
  assert.ok(body.length <= FEEDBACK_BODY_MAX_CHARS, 'fixture: starts whole');
  const h = hit(mem('htaLadder', body, { type: 'feedback' }), 0.8, { chunkIndex: 0 });
  const whole = injectBytes(blockFor(h, 'whole'));
  const excerpt = injectBytes(blockFor(h, 'excerpt'));
  assert.ok(excerpt > whole, 'fixture: the append made the excerpt the larger form');
  assert.deepEqual(ladderFor(h), ['whole', 'minimal'], 'the excerpt rung is dropped');
});
