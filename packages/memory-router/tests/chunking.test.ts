// Unit tests for src/embed/chunking.ts, the markdown-aware body chunker
// behind schema v3's chunk embeddings. Every rule the module comment states
// is pinned here, plus the invariants every chunk must satisfy:
// `body.slice(offset, offset + text.length) === text` (so a caller can
// point a user at the matching region) and 0-based contiguous `index`.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chunkBody,
  CHUNK_TARGET_CHARS,
  CHUNK_MAX_CHARS,
} = require('../src/embed/chunking');

const FENCE = '```';

// Assert the universal chunk invariants: contiguous 0-based indices,
// increasing offsets, and text that slices back out of the body exactly.
function assertInvariants(body: string, chunks: { index: number; offset: number; text: string }[]): void {
  chunks.forEach((c, n) => {
    assert.equal(c.index, n, `chunk ${n} index`);
    assert.equal(
      body.slice(c.offset, c.offset + c.text.length),
      c.text,
      `chunk ${n} must slice back out of the body at its offset`,
    );
    if (n > 0) assert.ok(c.offset > chunks[n - 1].offset, 'offsets increase');
  });
}

test('exported constants: target about 1500, hard cap about 3000', () => {
  assert.equal(CHUNK_TARGET_CHARS, 1500);
  assert.equal(CHUNK_MAX_CHARS, 3000);
});

test('empty or whitespace-only body produces zero chunks (document vector only)', () => {
  assert.deepEqual(chunkBody(''), []);
  assert.deepEqual(chunkBody('   \n\n  \n'), []);
});

test('a body that fits in one chunk produces exactly one chunk at offset 0', () => {
  const body = '# Rule\n\nAlways run the tests before committing.';
  const chunks = chunkBody(body);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].index, 0);
  assert.equal(chunks[0].offset, 0);
  assert.equal(chunks[0].text, body);
  assertInvariants(body, chunks);
});

test('blank-line paragraphs merge into one chunk while under the target', () => {
  const para = 'x'.repeat(200);
  const body = [para, para, para].join('\n\n');
  const chunks = chunkBody(body);
  assert.equal(chunks.length, 1, `${body.length} chars is under the target`);
  assertInvariants(body, chunks);
});

test('merged chunks stop at the target: each chunk stays at or under it', () => {
  const para = 'lorem ipsum dolor sit amet '.repeat(10).trim(); // ~299 chars
  const body = Array.from({ length: 12 }, () => para).join('\n\n');
  const chunks = chunkBody(body);
  assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(
      c.text.length <= CHUNK_TARGET_CHARS,
      `chunk ${c.index} is ${c.text.length} chars, over the target`,
    );
  }
  assertInvariants(body, chunks);
});

test('headings are boundaries: a chunk never starts mid-heading-run', () => {
  // Each section is sized just under the target (1489 chars), so neither
  // the next section's heading line (12) nor its body can join it without
  // busting the target, and every chunk is exactly one section.
  const heading = (n: number) =>
    `## Section ${n}\n\n${'filler text for section '.repeat(59)}`;
  const body = [0, 1, 2, 3].map(heading).join('\n\n');
  const chunks = chunkBody(body);
  assert.equal(chunks.length, 4);
  for (const c of chunks) {
    assert.match(c.text, /^## Section \d/, `chunk ${c.index} starts at a heading`);
  }
  assertInvariants(body, chunks);
});

test('top-level list items at column 0 are boundaries; indented ones are not', () => {
  const item = (n: number) => `- item ${n}: ${'y'.repeat(400)}`;
  const body = [0, 1, 2, 3].map(item).join('\n');
  const chunks = chunkBody(body);
  assert.ok(chunks.length >= 2, `expected >= 2 chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.text.startsWith('- item '), `chunk ${c.index} starts at an item`);
  }
  // Indented continuation items never split: one parent item plus indented
  // children under the target stays one chunk.
  const nested = [
    '- parent',
    '  - child one',
    '  - child two',
    '  1. numbered child',
  ].join('\n');
  const nestedChunks = chunkBody(nested);
  assert.equal(nestedChunks.length, 1, 'indented markers are not boundaries');
  assert.equal(nestedChunks[0].text, nested);
});

test('ordered list items ("1. " at column 0) and "* " items are boundaries too', () => {
  const body = [
    `1. ${'a'.repeat(1600)}`,
    `2. ${'b'.repeat(1600)}`,
    `* ${'c'.repeat(1600)}`,
  ].join('\n');
  const chunks = chunkBody(body);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].text.startsWith('1. '));
  assert.ok(chunks[1].text.startsWith('2. '));
  assert.ok(chunks[2].text.startsWith('* '));
  assertInvariants(body, chunks);
});

test('a single piece longer than the cap splits at line boundaries', () => {
  // No blank lines, no headings, no list markers: one atomic piece whose
  // lines are 100 chars each.
  const body = Array.from(
    { length: 100 },
    (_, i) => `line ${i} ${'z'.repeat(90)}`,
  ).join('\n');
  const chunks = chunkBody(body);
  assert.ok(chunks.length >= 4, `expected >= 4 chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.text.length <= CHUNK_MAX_CHARS, `chunk ${c.index} busts the cap`);
    assert.ok(c.text.startsWith('line '), `chunk ${c.index} starts at a line`);
    assert.ok(c.text.endsWith('z'.repeat(90)), `chunk ${c.index} ends at a line`);
  }
  assertInvariants(body, chunks);
});

test('one over-long line splits at sentence boundaries', () => {
  const sentence = 'this sentence is exactly forty-eight chars.'; // 43 chars
  const body = Array.from({ length: 300 }, () => sentence).join(' ');
  const chunks = chunkBody(body);
  assert.ok(chunks.length >= 4, `expected >= 4 chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.text.length <= CHUNK_MAX_CHARS, `chunk ${c.index} busts the cap`);
  }
  // Every cut but the last lands after a sentence-ending space.
  for (let n = 0; n < chunks.length - 1; n++) {
    const next = chunks[n + 1];
    assert.equal(
      body.slice(next.offset - 1, next.offset),
      ' ',
      `chunk ${n + 1} starts right after a sentence break`,
    );
  }
  assertInvariants(body, chunks);
});

test('a single huge word with no break at all is hard-cut at the cap', () => {
  const body = 'q'.repeat(CHUNK_MAX_CHARS * 2 + 17);
  const chunks = chunkBody(body);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].text.length, CHUNK_MAX_CHARS);
  assert.equal(chunks[1].text.length, CHUNK_MAX_CHARS);
  assert.equal(chunks[2].text.length, 17);
  assertInvariants(body, chunks);
});

test('a fenced code block is never split from the inside', () => {
  const block = [
    FENCE + 'ts',
    '- not a list boundary inside the fence',
    '',
    '# not a heading inside the fence',
    'const a = 1;',
    FENCE,
  ].join('\n');
  const body = `intro paragraph\n\n${block}\n\noutro paragraph`;
  const chunks = chunkBody(body);
  assert.equal(chunks.length, 1, 'the whole body stays one chunk');
  assert.ok(chunks[0].text.includes(block), 'the block survives intact');
  assertInvariants(body, chunks);
});

test('a fenced code block alone over the cap is the one case that splits it', () => {
  const lines = Array.from(
    { length: 80 },
    (_, i) => `const value${i} = ${'x'.repeat(60)};`,
  );
  const block = [FENCE + 'ts', ...lines, FENCE].join('\n');
  assert.ok(block.length > CHUNK_MAX_CHARS, 'fixture must exceed the cap');
  const chunks = chunkBody(block);
  assert.ok(chunks.length >= 2, `expected >= 2 chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.text.length <= CHUNK_MAX_CHARS, `chunk ${c.index} busts the cap`);
  }
  // Only the first chunk carries the opening fence, only the last the
  // closing one: the cut points sit between the block's lines.
  assert.ok(chunks[0].text.startsWith(FENCE));
  assert.ok(chunks[chunks.length - 1].text.endsWith(FENCE));
  assertInvariants(block, chunks);
});

test('offsets point at the marker: a string at char 10000 lands in a chunk whose offset is > 8000', () => {
  // The exact AC1 shape: the only match for a query sits deeper than the
  // document embed input's 8,000-char cut, so ONLY a chunk can find it.
  const filler = Array.from(
    { length: 120 },
    (_, i) => `filler paragraph ${i} ${'f'.repeat(80)}`,
  ).join('\n\n');
  const marker = 'the secret passphrase is zebra-quantum-flux';
  const body = `${filler}\n\n${marker}\n\n${filler}`;
  const markerAt = body.indexOf(marker);
  assert.ok(markerAt > 10_000, `fixture marker at ${markerAt}`);
  const chunks = chunkBody(body);
  const carrier = chunks.filter((c: { text: string }) => c.text.includes(marker));
  assert.equal(carrier.length, 1, 'exactly one chunk carries the marker');
  assert.ok(carrier[0].offset > 8000, 'the chunk starts past the doc cap');
  assertInvariants(body, chunks);
});
