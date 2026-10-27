// The budgeted renderer (renderHitsBudgeted in src/render.ts) behind the
// UserPromptSubmit hook: per-hit form (whole body / description + best chunk
// + path / description + path), the thresholds that pick the form, the total
// byte budget and its env override, and the guarantee that the unbudgeted
// renderer PreToolUse uses is untouched. Hook-level wiring (chunk index from
// a real index into the injected text) lives in
// tests/chunk-index-threading.test.ts.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const {
  renderHitsAsContext,
  renderHitsBudgeted,
  ladderFor,
  resolveInjectBudget,
  injectBytes,
  DEFAULT_INJECT_BUDGET_BYTES,
  SHORT_BODY_MAX_CHARS,
  FEEDBACK_BODY_MAX_CHARS,
  NEIGHBOUR_CHUNK_MAX_CHARS,
} = require('../src/render');
const { chunkBody } = require('../src/embed/chunking');
const { checkMemoryReferences } = require('../src/verify-refs');

interface MemoryChunk {
  index: number;
  offset: number;
  text: string;
}

// --- builders ---------------------------------------------------------------

function mem(
  id: string,
  body: string,
  over: Partial<MemoryFrontmatter> = {},
  filePath = `/mem/${id}.md`,
): Memory {
  return {
    id,
    path: filePath,
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

// A paragraph of exactly `len` characters, led by `marker` so a test can tell
// which chunk a piece of output came from.
function para(marker: string, len: number): string {
  const text = `${marker} `;
  return text + 'x'.repeat(Math.max(0, len - text.length));
}

// A body of `n` sections of ~`len` chars each. Sections are wider than half
// the chunk target, so the chunker keeps every one in a chunk of its own.
function sections(n: number, len = 1100): string {
  return Array.from({ length: n }, (_, i) => para(`SECTION${i + 1}`, len)).join('\n\n');
}

function longMemory(id = 'long', over: Partial<MemoryFrontmatter> = {}): Memory {
  return mem(id, sections(5), over);
}

function setEnv(name: string, value: string | undefined): () => void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
}

// Captures process.stderr.write for the duration of fn.
function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
  const orig = process.stderr.write.bind(process.stderr);
  let stderr = '';
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
    stderr += String(chunk);
    return true;
  };
  try {
    return { result: fn(), stderr };
  } finally {
    (process.stderr as { write: unknown }).write = orig;
  }
}

// Frozen copy of the renderer as it was before the budget existed. The
// PreToolUse path must keep producing exactly this.
function legacyRender(hits: GateHit[]): string {
  if (hits.length === 0) return '';
  const header =
    hits.length === 1
      ? '**memory-router** \u2014 1 relevant memory applies:'
      : `**memory-router** \u2014 ${hits.length} relevant memories apply:`;
  const blocks = hits.map((h) => {
    const name = h.memory.frontmatter.name;
    const gateLabel = `${h.gate} · ${h.score.toFixed(2)}`;
    const body = h.memory.body.trim();
    const staleness = checkMemoryReferences(h.memory.frontmatter.verify);
    const stalePrefix = staleness.stale
      ? `> ⚠️ **stale:** ${staleness.reason}\n>\n> This memory references something that no longer exists. Verify before acting.\n\n`
      : '';
    return `### ${name}  _(${gateLabel})_\n${stalePrefix}${body}`;
  });
  return [header, ...blocks].join('\n\n');
}

// Splits rendered output into its `### ` blocks keyed by memory id (the
// builders put the id in the heading name).
function blocksOf(out: string): Map<string, string> {
  const map = new Map<string, string>();
  const parts = out.split(/\n\n(?=### )/);
  for (const part of parts) {
    const m = /### Name of (\S+) /.exec(part);
    if (m) map.set(m[1], part);
  }
  return map;
}

type Form = 'whole' | 'excerpt' | 'minimal';
function formOf(block: string): Form {
  if (!block.includes('_Full memory:')) return 'whole';
  return block.includes('_Excerpt (') ? 'excerpt' : 'minimal';
}

function fenceLines(out: string): number {
  return out.split('\n').filter((l) => /^\s*(?:`{3,}|~{3,})/.test(l)).length;
}

// --- per-hit form -----------------------------------------------------------

test('short memory: injected whole, byte-identical to the unbudgeted block, no path line', () => {
  const m = mem('short', 'A short rule.\n\n**Why:** because.', { type: 'project' });
  const out = renderHitsBudgeted([hit(m)]);
  assert.equal(out, renderHitsAsContext([hit(m)]));
  assert.ok(!out.includes('_Full memory:'));
});

test('short memory threshold: a body of exactly the limit is whole, one char more is excerpted', () => {
  const atLimit = mem('atlimit', 'a'.repeat(SHORT_BODY_MAX_CHARS));
  const over = mem('over', `${'a'.repeat(SHORT_BODY_MAX_CHARS - 1)}\n\nb`);
  assert.equal(over.body.trim().length, SHORT_BODY_MAX_CHARS + 2);
  assert.equal(formOf(renderHitsBudgeted([hit(atLimit)])), 'whole');
  assert.equal(formOf(renderHitsBudgeted([hit(over)])), 'excerpt');
});

test('short memory threshold ignores the surrounding whitespace of the body', () => {
  const m = mem('padded', `\n\n${'a'.repeat(SHORT_BODY_MAX_CHARS)}\n\n\n`);
  assert.equal(formOf(renderHitsBudgeted([hit(m)])), 'whole');
});

test('short feedback memory: whole body above the general limit, rule + Why + How to apply intact', () => {
  const body = `Never do the thing.\n\n**Why:** ${'w'.repeat(1500)}\n\n**How to apply:** ${'h'.repeat(1000)}`;
  assert.ok(body.length > SHORT_BODY_MAX_CHARS && body.length <= FEEDBACK_BODY_MAX_CHARS);
  const feedback = mem('fb', body, { type: 'feedback' });
  const project = mem('pj', body, { type: 'project' });
  const fbOut = renderHitsBudgeted([hit(feedback)]);
  assert.equal(formOf(fbOut), 'whole');
  assert.ok(fbOut.includes('**Why:**') && fbOut.includes('**How to apply:**'));
  assert.ok(fbOut.endsWith('h'.repeat(1000)), 'the last line of the rule survives');
  // Same body, other type: the general limit applies.
  assert.equal(formOf(renderHitsBudgeted([hit(project)])), 'excerpt');
});

test('feedback threshold boundary: exactly the feedback limit is whole, beyond it is excerpted', () => {
  const at = mem('fbat', 'a'.repeat(FEEDBACK_BODY_MAX_CHARS), { type: 'feedback' });
  const over = mem('fbover', `${'a'.repeat(FEEDBACK_BODY_MAX_CHARS - 1)}\n\nb`, { type: 'feedback' });
  assert.equal(formOf(renderHitsBudgeted([hit(at)])), 'whole');
  assert.equal(formOf(renderHitsBudgeted([hit(over)])), 'excerpt');
});

test('long memory with a known best chunk: description + that chunk + absolute path, nothing else of the body', () => {
  const m = mem('long', sections(5), {}, '/abs/dir/long.md');
  const chunks = chunkBody(m.body);
  assert.equal(chunks.length, 5);
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: 2 })]);
  assert.match(out, /### Name of long  _\(confidence · 0\.80\)_/);
  assert.ok(out.includes('Description of long'));
  assert.ok(out.includes(chunks[2].text), 'the best chunk, whole');
  assert.match(out, /_Excerpt \(chunk 3 of 5\):_/);
  for (const other of [0, 1, 3, 4]) {
    assert.ok(!out.includes(`SECTION${other + 1} `), `chunk ${other} must not be injected`);
  }
  assert.ok(out.includes('_Full memory:_ `/abs/dir/long.md`'));
  assert.ok(out.length < m.body.length / 2);
});

test('the path line is absolute even when the loaded path is relative', () => {
  const m = mem('rel', sections(3), {}, 'relative/rel.md');
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: 0 })]);
  assert.ok(out.includes(`_Full memory:_ \`${path.resolve('relative/rel.md')}\``));
});

test('short best chunk: the immediately following chunk is injected too', () => {
  // Two long paragraphs force the first (short) paragraph into its own chunk
  // only when a long one cannot join it, so build chunks of known sizes.
  const body = [para('SHORTA', 300), para('LONGB', 1450), para('LONGC', 1450)].join('\n\n');
  const m = mem('nb2', body);
  const chunks = chunkBody(m.body);
  assert.equal(chunks.length, 3, 'fixture: one chunk per paragraph');
  assert.ok(chunks[0].text.length < NEIGHBOUR_CHUNK_MAX_CHARS);
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: 0 })]);
  assert.ok(out.includes(chunks[0].text) && out.includes(chunks[1].text));
  assert.ok(!out.includes('LONGC'), 'only the immediate neighbour');
  assert.match(out, /_Excerpt \(chunks 1-2 of 3\):_/);
});

test('long best chunk gets no neighbour; a short LAST chunk has none to add', () => {
  const longBest = mem('lb', [para('LONGA', 1450), para('LONGB', 1450), para('LONGC', 1450)].join('\n\n'));
  const outLong = renderHitsBudgeted([hit(longBest, 0.8, { chunkIndex: 0 })]);
  assert.ok(outLong.includes('LONGA') && !outLong.includes('LONGB'));

  const shortLast = mem('sl', [para('LONGA', 1450), para('LONGB', 1450), para('TAIL', 300)].join('\n\n'));
  const chunks = chunkBody(shortLast.body);
  const lastIdx = chunks.length - 1;
  assert.ok(chunks[lastIdx].text.length < NEIGHBOUR_CHUNK_MAX_CHARS);
  const out = renderHitsBudgeted([hit(shortLast, 0.8, { chunkIndex: lastIdx })]);
  assert.ok(out.includes('TAIL'));
  assert.match(out, new RegExp(`_Excerpt \\(chunk ${lastIdx + 1} of ${chunks.length}\\):_`));
});

test('neighbour threshold boundary: a best chunk one char under the limit gets its neighbour, one of exactly the limit does not', () => {
  const build = (len: number): { m: Memory; chunks: MemoryChunk[] } => {
    const m = mem(`nbb${len}`, [para('BESTA', len), para('NEXTB', 1450), para('LASTC', 1450)].join('\n\n'));
    return { m, chunks: chunkBody(m.body) };
  };
  const under = build(NEIGHBOUR_CHUNK_MAX_CHARS - 1);
  assert.equal(under.chunks.length, 3, 'fixture: one chunk per paragraph');
  assert.equal(under.chunks[0].text.length, NEIGHBOUR_CHUNK_MAX_CHARS - 1);
  const outUnder = renderHitsBudgeted([hit(under.m, 0.8, { chunkIndex: 0 })]);
  assert.match(outUnder, /_Excerpt \(chunks 1-2 of 3\):_/);
  assert.ok(outUnder.includes('NEXTB '), 'the neighbour is injected');

  const at = build(NEIGHBOUR_CHUNK_MAX_CHARS);
  assert.equal(at.chunks.length, 3);
  assert.equal(at.chunks[0].text.length, NEIGHBOUR_CHUNK_MAX_CHARS);
  const outAt = renderHitsBudgeted([hit(at.m, 0.8, { chunkIndex: 0 })]);
  assert.match(outAt, /_Excerpt \(chunk 1 of 3\):_/);
  assert.ok(!outAt.includes('NEXTB '), 'no neighbour at exactly the limit');
});

test('hit without chunk info: description + FIRST chunk + path', () => {
  const m = longMemory('nochunk');
  const out = renderHitsBudgeted([hit(m)]);
  assert.ok(out.includes('Description of nochunk'));
  assert.ok(out.includes('SECTION1 '));
  assert.ok(!out.includes('SECTION2 ') && !out.includes('SECTION5 '));
  assert.match(out, /_Excerpt \(chunk 1 of 5\):_/);
  assert.ok(out.includes('_Full memory:_ `/mem/nochunk.md`'));
});

test('a chunk index the body no longer has falls back to the first chunk', () => {
  const m = longMemory('stalechunk');
  for (const idx of [99, -1]) {
    const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: idx })]);
    assert.match(out, /_Excerpt \(chunk 1 of 5\):_/, `chunkIndex ${idx}`);
  }
});

// --- index older than the file: the stored offset guards the stored index ----------

function editedSections(): string {
  // SECTION2 removed and SECTION1 shortened: chunk index 2 now holds
  // SECTION4, starting at a different offset than the old chunk 2.
  return [para('SECTION1', 1000), para('SECTION3', 1100), para('SECTION4', 1100), para('SECTION5', 1100)].join('\n\n');
}

test('chunk index + offset recorded for an old body, applied to an edited body: first chunk, not the misaligned one', () => {
  const oldBody = sections(5);
  const oldChunk: MemoryChunk = chunkBody(oldBody)[2];
  const edited = mem('edited', editedSections());
  const editedChunks = chunkBody(edited.body);
  assert.equal(editedChunks.length, 4);
  assert.ok(editedChunks[2].text.startsWith('SECTION4 '), 'fixture: index 2 is another region now');
  assert.notEqual(editedChunks[2].offset, oldChunk.offset, 'fixture: the offsets differ');
  const out = renderHitsBudgeted([hit(edited, 0.8, { chunkIndex: oldChunk.index, chunkOffset: oldChunk.offset })]);
  assert.match(out, /_Excerpt \(chunk 1 of 4\):_/);
  assert.ok(out.includes('SECTION1 ') && !out.includes('SECTION4 '));
});

test('chunk index + offset recorded for the current body: the matched chunk', () => {
  const m = mem('unchanged', sections(5));
  const chunk: MemoryChunk = chunkBody(m.body)[2];
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: chunk.index, chunkOffset: chunk.offset })]);
  assert.match(out, /_Excerpt \(chunk 3 of 5\):_/);
  assert.ok(out.includes('SECTION3 ') && !out.includes('SECTION1 '));
});

test('the offset check: index alone is trusted when no offset is known, offset 0 is a known offset', () => {
  const edited = mem('trust', editedSections());
  // No offset recorded: the renderer cannot tell, it keeps using the index.
  const trusting = renderHitsBudgeted([hit(edited, 0.8, { chunkIndex: 2 })]);
  assert.match(trusting, /_Excerpt \(chunk 3 of 4\):_/);
  // Offset 0 is a real offset: a recorded (index 2, offset 0) never matches
  // chunk 2 of this body, so it falls back to the first chunk.
  const zero = renderHitsBudgeted([hit(edited, 0.8, { chunkIndex: 2, chunkOffset: 0 })]);
  assert.match(zero, /_Excerpt \(chunk 1 of 4\):_/);
  // And (index 0, offset 0) on any body is the first chunk either way.
  const first = renderHitsBudgeted([hit(edited, 0.8, { chunkIndex: 0, chunkOffset: 0 })]);
  assert.match(first, /_Excerpt \(chunk 1 of 4\):_/);
});

test('a missing or non-string description is left out, not rendered as "undefined"', () => {
  const m = longMemory('nodesc');
  (m.frontmatter as unknown as { description?: unknown }).description = undefined;
  const out = renderHitsBudgeted([hit(m)]);
  assert.ok(!out.includes('undefined'));
  assert.ok(out.includes('SECTION1 ') && out.includes('_Full memory:'));
});

test('a stale memory keeps its warning in every form (whole, excerpt, minimal)', () => {
  const verify: MemoryReference[] = [{ kind: 'path', value: '/definitely/not/here/anywhere' }];
  const whole = hit(mem('sw', 'tiny body', { verify }));
  const excerpt = hit(mem('se', sections(5), { verify }));
  const minimal = hit(mem('sm', sections(5), { verify }));
  assert.match(renderHitsBudgeted([whole]), /⚠️ \*\*stale:\*\*/);
  assert.match(renderHitsBudgeted([excerpt]), /⚠️ \*\*stale:\*\*/);
  const out = renderHitsBudgeted([minimal], { budgetBytes: 1 });
  assert.equal(formOf(out), 'minimal');
  assert.match(out, /⚠️ \*\*stale:\*\*/);
});

test('no hits renders the empty string', () => {
  assert.equal(renderHitsBudgeted([]), '');
  assert.equal(renderHitsBudgeted([], { budgetBytes: 10 }), '');
});

// --- code fences ------------------------------------------------------------

test('best chunk holding a fenced block: the fence is kept whole and balanced', () => {
  const code = ['```bash', 'git push origin feature', 'git status', '```'].join('\n');
  const body = [para('INTRO', 1100), `${para('RULE', 200)}\n${code}\n${para('AFTER', 300)}`, para('TAIL', 1400)].join('\n\n');
  const m = mem('fence', body);
  const chunks = chunkBody(m.body);
  const idx = chunks.findIndex((c: MemoryChunk) => c.text.includes('git push origin feature'));
  assert.ok(idx >= 0);
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: idx })]);
  assert.ok(out.includes(code), 'the whole fenced block');
  assert.equal(fenceLines(out) % 2, 0, 'no unbalanced fence');
});

// Expected injected text for a chunk of a body: the chunk, wrapped in the
// fence marker it starts inside (reopened) and/or ends inside (closed).
function expectedBalanced(body: string, chunk: MemoryChunk, marker: string): string {
  const fenceLine = /^\s*(?:`{3,}|~{3,})/;
  const count = (text: string): number => text.split('\n').filter((l) => fenceLine.test(l)).length;
  const startsOpen = count(body.slice(0, chunk.offset)) % 2 === 1;
  const text = startsOpen ? `${marker}\n${chunk.text}` : chunk.text;
  return count(text) % 2 === 1 ? `${text}\n${marker}` : text;
}

function excerptOf(out: string): string {
  const start = out.indexOf(':_\n');
  const end = out.indexOf('\n\n_Full memory:');
  return out.slice(start + 3, end);
}

test('a fenced block longer than the chunk cap is split by the chunker: every injected piece is reopened/closed so the fences balance', () => {
  const lines = Array.from({ length: 220 }, (_, i) => `echo line ${i} ${'y'.repeat(20)}`);
  const body = `${para('INTRO', 200)}\n\n\`\`\`bash\n${lines.join('\n')}\n\`\`\`\n\n${para('OUTRO', 200)}`;
  const m = mem('bigfence', body);
  const chunks = chunkBody(m.body);
  const unbalanced = chunks
    .map((c: MemoryChunk, i: number) => ({ i, n: (c.text.match(/^```/gm) ?? []).length }))
    .filter((c: { n: number }) => c.n % 2 === 1);
  assert.ok(unbalanced.length >= 2, 'fixture: the chunker splits the fence across chunks');
  let reopened = 0;
  let closed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: i })]);
    assert.equal(fenceLines(out) % 2, 0, `chunk ${i}: balanced fences in the injected text`);
    const excerpt = excerptOf(out);
    assert.ok(excerpt.startsWith(chunks[i].text) || excerpt.startsWith('```\n'), `chunk ${i}`);
    // Structure, not just parity: a chunk cut inside the fence gets its
    // opening marker back at the start and a closing one at the end.
    const expected = expectedBalanced(m.body, chunks[i], '```');
    assert.ok(excerpt.startsWith(expected), `chunk ${i}: excerpt starts with the balanced chunk`);
    if (excerpt.startsWith('```\n') && !chunks[i].text.startsWith('```')) reopened++;
    if (expected.endsWith('\n```') && !chunks[i].text.endsWith('```')) closed++;
  }
  assert.ok(reopened >= 1, 'fixture exercised the reopen path');
  assert.ok(closed >= 1, 'fixture exercised the close path');
});

test('a tilde fence is balanced with its own marker', () => {
  const lines = Array.from({ length: 220 }, (_, i) => `echo line ${i} ${'y'.repeat(20)}`);
  const body = `${para('INTRO', 200)}\n\n~~~sh\n${lines.join('\n')}\n~~~\n\n${para('OUTRO', 200)}`;
  const m = mem('tilde', body);
  const chunks = chunkBody(m.body);
  for (let i = 0; i < chunks.length; i++) {
    const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: i })]);
    assert.equal(fenceLines(out) % 2, 0, `chunk ${i}`);
    assert.ok(!/^```/m.test(out), 'no backtick fence invented for a tilde block');
  }
});

// --- total budget -----------------------------------------------------------

function threeShort(): GateHit[] {
  // Three whole-eligible memories (body just under the general limit) so the
  // first shortening step is whole -> excerpt.
  const body = (tag: string): string => [para(`${tag}A`, 950), para(`${tag}B`, 950)].join('\n\n');
  return ['h1', 'h2', 'h3'].map((id, i) => hit(mem(id, body(id.toUpperCase())), 0.9 - i * 0.1, { chunkIndex: 0 }));
}

test('under budget: every hit keeps its form and the output is not touched', () => {
  const hits = threeShort();
  const big = renderHitsBudgeted(hits, { budgetBytes: 1_000_000 });
  assert.deepEqual([...blocksOf(big).values()].map(formOf), ['whole', 'whole', 'whole']);
  assert.ok(!big.includes('left out'));
});

test('over budget by one byte: only the LOWEST-ranked hit is shortened, one step, top hits untouched', () => {
  const hits = threeShort();
  const full = renderHitsBudgeted(hits, { budgetBytes: 1_000_000 });
  const out = renderHitsBudgeted(hits, { budgetBytes: injectBytes(full) - 1 });
  const forms = [...blocksOf(out).values()].map(formOf);
  assert.deepEqual(forms, ['whole', 'whole', 'excerpt']);
  const fullBlocks = blocksOf(full);
  const outBlocks = blocksOf(out);
  assert.equal(outBlocks.get('h1'), fullBlocks.get('h1'));
  assert.equal(outBlocks.get('h2'), fullBlocks.get('h2'));
  assert.ok(injectBytes(out) <= injectBytes(full) - 1);
});

test('budget pressure keeps shortening the lowest hit before touching the next one', () => {
  const hits = threeShort();
  const full = renderHitsBudgeted(hits, { budgetBytes: 1_000_000 });
  const step1 = renderHitsBudgeted(hits, { budgetBytes: injectBytes(full) - 1 });
  const step2 = renderHitsBudgeted(hits, { budgetBytes: injectBytes(step1) - 1 });
  assert.deepEqual([...blocksOf(step2).values()].map(formOf), ['whole', 'whole', 'minimal']);
  const step3 = renderHitsBudgeted(hits, { budgetBytes: injectBytes(step2) - 1 });
  // The lowest hit is out of shorter forms: the middle one is next.
  assert.deepEqual([...blocksOf(step3).values()].map(formOf), ['whole', 'excerpt', 'minimal']);
});

test('far over budget: lowest hits are dropped, the top hit is kept, a note says how many', () => {
  const hits = threeShort();
  const out = renderHitsBudgeted(hits, { budgetBytes: 1 });
  const blocks = blocksOf(out);
  assert.deepEqual([...blocks.keys()], ['h1']);
  assert.equal(formOf(blocks.get('h1') as string), 'minimal');
  assert.match(out, /1 relevant memory applies/);
  assert.match(out, /2 lower-ranked memories left out to stay within the 1 byte injection budget/);
  assert.ok(injectBytes(out) > 1, 'the minimal top hit is emitted even though it exceeds the budget');
});

test('budget sweep: the top hit is shortened only once every lower hit is gone, and the output always fits when it can', () => {
  const hits = threeShort();
  const rank: Record<Form, number> = { whole: 0, excerpt: 1, minimal: 2 };
  let sawDrop = false;
  let sawShortTop = false;
  for (let budget = 12000; budget >= 1; budget -= 13) {
    const out = renderHitsBudgeted(hits, { budgetBytes: budget });
    const blocks = [...blocksOf(out).entries()];
    const forms = blocks.map(([, b]) => formOf(b));
    assert.equal(blocks[0][0], 'h1', `top hit present at budget ${budget}`);
    for (let i = 1; i < forms.length; i++) {
      assert.ok(rank[forms[i]] >= rank[forms[i - 1]], `lower hit never fuller than a higher one (budget ${budget})`);
    }
    if (blocks.length < hits.length) {
      sawDrop = true;
      assert.deepEqual(blocks.map(([id]) => id), ['h1', 'h2', 'h3'].slice(0, blocks.length), 'dropped hits are the lowest-ranked suffix');
    }
    if (forms[0] !== 'whole') {
      sawShortTop = true;
      assert.equal(blocks.length, 1, `the top hit is shortened only when it is the last one standing (budget ${budget})`);
    }
    if (blocks.length > 1 || forms[0] !== 'minimal') {
      assert.ok(injectBytes(out) <= budget, `within budget ${budget} unless only the minimal top hit remains`);
    }
  }
  assert.ok(sawDrop, 'the sweep reached the drop phase');
  assert.ok(sawShortTop, 'the sweep reached the top-hit shortening phase');
});

test('budget sweep: a budget equal to the size of an output that fits reproduces that output (no off-by-one at the boundary)', () => {
  const hits = threeShort();
  let checked = 0;
  for (let budget = 12000; budget >= 300; budget -= 7) {
    const out = renderHitsBudgeted(hits, { budgetBytes: budget });
    const size = injectBytes(out);
    // The footer prints the budget, so only budgets with the same digit
    // count give the same text; skip the sizes where the number of digits
    // changes.
    if (size > budget || String(size).length !== String(budget).length) continue;
    const again = renderHitsBudgeted(hits, { budgetBytes: size });
    assert.deepEqual(
      [...blocksOf(again).entries()].map(([id, b]) => [id, formOf(b)]),
      [...blocksOf(out).entries()].map(([id, b]) => [id, formOf(b)]),
      `budget ${size} (the exact size of the output at ${budget}) keeps the same forms`,
    );
    checked++;
  }
  assert.ok(checked > 50, 'the sweep exercised many boundaries');
});

test('exactly at the budget: every hit keeps its unbudgeted form, nothing is shortened or dropped', () => {
  const hits = threeShort();
  const full = renderHitsBudgeted(hits, { budgetBytes: 1_000_000 });
  const exact = renderHitsBudgeted(hits, { budgetBytes: injectBytes(full) });
  assert.equal(exact, full);
  assert.deepEqual([...blocksOf(exact).values()].map(formOf), ['whole', 'whole', 'whole']);
  // Same at the excerpt level: long memories, budget equal to their excerpt render.
  const longHits = ['e1', 'e2'].map((id, i) => hit(longMemory(id), 0.9 - i * 0.1, { chunkIndex: 1 }));
  const excerptRender = renderHitsBudgeted(longHits, { budgetBytes: 1_000_000 });
  const excerptExact = renderHitsBudgeted(longHits, { budgetBytes: injectBytes(excerptRender) });
  assert.equal(excerptExact, excerptRender);
  assert.deepEqual([...blocksOf(excerptExact).values()].map(formOf), ['excerpt', 'excerpt']);
});

test('after drops, a top hit that fits the budget exactly keeps its whole form', () => {
  const tiny = hit(mem('t1', 'short rule'), 0.9);
  const lower = [hit(longMemory('t2'), 0.8, { chunkIndex: 1 }), hit(longMemory('t3'), 0.7, { chunkIndex: 1 })];
  const roomy = renderHitsBudgeted([tiny, ...lower], { budgetBytes: 200 });
  assert.equal(formOf(blocksOf(roomy).get('t1') as string), 'whole');
  assert.deepEqual([...blocksOf(roomy).keys()], ['t1'], 'fixture: both lower hits are dropped');
  const exact = injectBytes(roomy);
  assert.equal(String(exact).length, String(200).length, 'fixture: same digit count as the budget');
  const out = renderHitsBudgeted([tiny, ...lower], { budgetBytes: exact });
  assert.equal(formOf(blocksOf(out).get('t1') as string), 'whole', 'size equal to the budget is a fit');
  assert.equal(out.length, roomy.length);
});

// --- budget order: the top hit is the last to be shortened -----------------------

function longWithDescription(id: string, descLen: number): Memory {
  return mem(id, sections(5), { description: `${id} ${'d'.repeat(descLen)}` });
}

test('five long memories with 250-char descriptions at 2500 bytes: the top hit keeps its excerpt because it alone fits', () => {
  const hits = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id, i) =>
    hit(longWithDescription(id, 250), 0.9 - i * 0.05, { chunkIndex: 1 }),
  );
  const topAlone = renderHitsBudgeted([hits[0]], { budgetBytes: 1_000_000 });
  assert.equal(formOf(topAlone), 'excerpt');
  assert.ok(injectBytes(topAlone) < 2500, 'fixture: the top hit with its excerpt fits the budget alone');
  const out = renderHitsBudgeted(hits, { budgetBytes: 2500 });
  const blocks = blocksOf(out);
  assert.equal(formOf(blocks.get('m1') as string), 'excerpt', 'the top hit keeps its excerpt');
  assert.ok((blocks.get('m1') as string).includes('SECTION2 '), 'with the matching chunk text');
  assert.ok(blocks.size < hits.length, 'lower hits were given up for it');
  for (const [id, b] of blocks) {
    if (id !== 'm1') assert.equal(formOf(b), 'minimal', `${id} is description + path only`);
  }
  assert.ok(injectBytes(out) <= 2500);
  assert.match(out, /lower-ranked memor(?:y|ies) left out/);
});

test('when even the top hit with its excerpt does not fit, the lower hits are dropped first and only then the top hit loses its excerpt', () => {
  const hits = ['m1', 'm2', 'm3'].map((id, i) =>
    hit(longWithDescription(id, 250), 0.9 - i * 0.05, { chunkIndex: 1 }),
  );
  const topExcerpt = injectBytes(renderHitsBudgeted([hits[0]], { budgetBytes: 1_000_000 }));
  const out = renderHitsBudgeted(hits, { budgetBytes: topExcerpt - 1 });
  const blocks = blocksOf(out);
  assert.deepEqual([...blocks.keys()], ['m1'], 'every lower hit is gone');
  assert.equal(formOf(blocks.get('m1') as string), 'minimal');
  assert.match(out, /2 lower-ranked memories left out/);
});

function minimalBytes(h: GateHit): number {
  return injectBytes(renderHitsBudgeted([h], { budgetBytes: 1 }));
}
function excerptBytes(h: GateHit): number {
  return injectBytes(renderHitsBudgeted([h], { budgetBytes: 1_000_000 }));
}

// Smallest budget at which `hits` render with exactly the forms `forms`
// (and no other hit kept).
function firstBudgetWithForms(hits: GateHit[], forms: Form[]): number {
  for (let budget = 1; budget < 40_000; budget++) {
    const out = renderHitsBudgeted(hits, { budgetBytes: budget });
    const got = [...blocksOf(out).values()].map(formOf);
    if (got.length === forms.length && got.every((f, i) => f === forms[i])) return budget;
  }
  throw new Error('no budget produces the requested forms');
}

test('room freed by a drop is given back to the kept hits: a lower hit is raised to its excerpt when that still fits', () => {
  // r3 has a 2,000-char description, so dropping it frees far more than
  // raising r2 from description + path to its excerpt costs.
  const [a, b] = ['r1', 'r2'].map((id, i) => hit(longWithDescription(id, 300), 0.9 - i * 0.05, { chunkIndex: 1 }));
  const c = hit(longWithDescription('r3', 2000), 0.8, { chunkIndex: 1 });
  // Room for both excerpts and the footer, but not for r3 in any form.
  const budget = injectBytes(renderHitsBudgeted([a, b], { budgetBytes: 1_000_000 })) + 200;
  assert.ok(minimalBytes(c) > 200, 'fixture: r3 does not fit even in its minimal form');
  const out = renderHitsBudgeted([a, b, c], { budgetBytes: budget });
  const blocks = blocksOf(out);
  assert.deepEqual([...blocks.keys()], ['r1', 'r2'], 'r3 was dropped');
  assert.deepEqual([...blocks.values()].map(formOf), ['excerpt', 'excerpt'], 'r2 is raised back to its excerpt');
  assert.match(out, /1 lower-ranked memory left out/);
  assert.ok(injectBytes(out) <= budget);

  // Raising is allowed to land exactly on the budget: rendering again with a
  // budget equal to this output's size (same digit count, so the footer text
  // is the same) gives the same forms.
  const exact = injectBytes(out);
  assert.equal(String(exact).length, String(budget).length, 'fixture: the footer prints the same number of digits');
  const again = renderHitsBudgeted([a, b, c], { budgetBytes: exact });
  assert.deepEqual([...blocksOf(again).values()].map(formOf), ['excerpt', 'excerpt']);
  assert.equal(again.length, out.length);
});

// The fixture shared by the raise-pass tests below: a hit "b" whose
// description makes its excerpt form larger than its whole body, "a" ahead of
// it and a long "c" behind it whose 5,000-char description cannot fit.
function raiseFixture(): { a: GateHit; b: GateHit; c: GateHit } {
  const a = hit(mem('a1', 'Rule one. '.repeat(30), { description: 'desc a1' }), 0.9);
  const b = hit(mem('b2', 'Rule two body. '.repeat(70), { description: 'd'.repeat(300) }), 0.8);
  const c = hit(
    mem('c3', ('Para. '.repeat(250) + '\n\n').repeat(4), { description: 'e'.repeat(5000) }),
    0.7,
  );
  return { a, b, c };
}

function footerFor(budget: number): string {
  return `\n\n_1 lower-ranked memory left out to stay within the ${budget} byte injection budget._`;
}

test('room freed by a drop restores a short hit to its whole body even when its excerpt form would not fit', () => {
  const { a, b, c } = raiseFixture();
  // The two whole bodies plus the one-memory footer, to the byte. Dropping c3
  // frees its room; b2's excerpt form (description, label and path on top of
  // the same text) is larger than its whole body and does not fit in it, but
  // the whole body does and must be restored.
  const budget = injectBytes(renderHitsBudgeted([a, b], { budgetBytes: 1_000_000 })) + injectBytes(footerFor(9999));
  assert.equal(String(budget).length, 4, 'fixture: the footer prints four digits');
  const out = renderHitsBudgeted([a, b, c], { budgetBytes: budget });
  const blocks = blocksOf(out);
  assert.deepEqual([...blocks.keys()], ['a1', 'b2'], 'c3 was dropped');
  assert.deepEqual([...blocks.values()].map(formOf), ['whole', 'whole'], 'b2 gets its whole body back');
  assert.equal(injectBytes(out), budget, 'the output lands on the budget exactly');

  // One byte less and b2 cannot stay whole: it goes to minimal, not to the
  // larger excerpt.
  const tighter = renderHitsBudgeted([a, b, c], { budgetBytes: budget - 1 });
  assert.deepEqual([...blocksOf(tighter).values()].map(formOf), ['whole', 'minimal']);
  assert.ok(injectBytes(tighter) <= budget - 1);
});

test('a hit that starts whole is never shortened to an excerpt that is not smaller than its whole body', () => {
  const { b } = raiseFixture();
  // Short body, long description: the excerpt form is the larger of the two.
  assert.deepEqual(ladderFor(b), ['whole', 'minimal']);
  // A body of two 950-char sections: the excerpt (one section) is smaller.
  const twoSections = hit(mem('two', [para('TWOA', 950), para('TWOB', 950)].join('\n\n')), 0.8, { chunkIndex: 0 });
  assert.deepEqual(ladderFor(twoSections), ['whole', 'excerpt', 'minimal']);
  // A hit that starts as an excerpt has no whole rung.
  assert.deepEqual(ladderFor(hit(longMemory('long'), 0.8, { chunkIndex: 1 })), ['excerpt', 'minimal']);

  // The shortened output never contains an excerpt for the whole-start hit,
  // at any budget.
  const { a, c } = raiseFixture();
  for (let budget = 1; budget < 1700; budget += 7) {
    const out = renderHitsBudgeted([a, b, c], { budgetBytes: budget });
    const blocks = blocksOf(out);
    const forB = blocks.get('b2');
    if (forB !== undefined) assert.notEqual(formOf(forB), 'excerpt', `budget ${budget}`);
  }
});

test('room is given back top-down: a lower hit takes only the room the hits above it could not use', () => {
  const big = (id: string, score: number): GateHit =>
    hit(longWithDescription(id, 100), score, { chunkIndex: 1 });
  // c1 has a 610-char first chunk (no neighbour is added at that size), so
  // lifting it from description + path to its excerpt is cheap.
  const smallBody = [para('TINYA', 610), para('BIGB', 1450), para('BIGC', 1450)].join('\n\n');
  assert.equal(chunkBody(smallBody)[0].text.length, 610);
  const small = hit(mem('c1', smallBody, { description: `c1 ${'d'.repeat(100)}` }), 0.8, { chunkIndex: 0 });
  const dropMe = hit(longWithDescription('d1', 2000), 0.7, { chunkIndex: 1 });
  const a = big('a1', 0.95);
  const b = big('b1', 0.9);
  const hits = [a, b, small, dropMe];
  const gapB = excerptBytes(b) - minimalBytes(b);
  const gapSmall = excerptBytes(small) - minimalBytes(small);
  const tight = firstBudgetWithForms([a, b, small], ['excerpt', 'minimal', 'minimal']);

  // Room for the cheap lift only: b1 cannot be lifted, so the pass moves on
  // and c1 is lifted into the room b1 could not use.
  const slack = 800;
  assert.ok(gapSmall < slack && slack < gapB, `fixture: the cheap lift (${gapSmall}) fits the slack, the dear one (${gapB}) does not`);
  const cheap = renderHitsBudgeted(hits, { budgetBytes: tight + slack });
  const cheapBlocks = blocksOf(cheap);
  assert.deepEqual([...cheapBlocks.keys()], ['a1', 'b1', 'c1'], 'd1 was dropped');
  assert.deepEqual([...cheapBlocks.values()].map(formOf), ['excerpt', 'minimal', 'excerpt']);
  assert.ok(injectBytes(cheap) <= tight + slack);

  // Room for either lift but not both: the higher-ranked hit gets it, not the
  // cheaper lower one.
  // The one-memory footer the dropped d1 leaves is part of the output.
  const footer = injectBytes(footerFor(tight + gapB + 200));
  const either = gapB + footer + 1;
  assert.ok(either < gapB + footer + gapSmall, 'fixture: the two lifts do not both fit');
  assert.equal(String(tight + either).length, String(tight + gapB + 200).length, 'fixture: same footer digits');
  const picked = renderHitsBudgeted(hits, { budgetBytes: tight + either });
  const pickedBlocks = blocksOf(picked);
  assert.deepEqual([...pickedBlocks.keys()], ['a1', 'b1', 'c1'], 'd1 was dropped');
  assert.deepEqual([...pickedBlocks.values()].map(formOf), ['excerpt', 'excerpt', 'minimal']);
  assert.ok(injectBytes(picked) <= tight + either);
});

test('the budget is counted in UTF-8 bytes, not characters', () => {
  const body = (tag: string): string => [para(`${tag}A`, 950), para(`${tag}B`, 950)].join('\n\n');
  const m = mem('utf', body('ÄÖÜ').replace(/x/g, 'ß'));
  const h = hit(m, 0.8, { chunkIndex: 0 });
  const full = renderHitsBudgeted([h], { budgetBytes: 1_000_000 });
  assert.ok(injectBytes(full) > full.length, 'fixture is multi-byte');
  // A budget between the char count and the byte count of the whole form
  // must still shorten: counting characters would call it a fit.
  const budget = injectBytes(full) - 1;
  assert.ok(budget >= full.length);
  const out = renderHitsBudgeted([h], { budgetBytes: budget });
  assert.equal(formOf(out), 'excerpt');
});

// --- env ------------------------------------------------------------------

test('resolveInjectBudget: unset is the 16 KiB default and silent', () => {
  const warnings: string[] = [];
  assert.equal(resolveInjectBudget({}, (m: string) => warnings.push(m)), 16384);
  assert.equal(DEFAULT_INJECT_BUDGET_BYTES, 16384);
  assert.deepEqual(warnings, []);
});

test('resolveInjectBudget: a positive integer is used as-is (surrounding whitespace allowed), silently', () => {
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
  };
  assert.equal(resolveInjectBudget({ MEMORY_ROUTER_INJECT_BUDGET: '4096' }, warn), 4096);
  assert.equal(resolveInjectBudget({ MEMORY_ROUTER_INJECT_BUDGET: ' 8000 ' }, warn), 8000);
  assert.equal(resolveInjectBudget({ MEMORY_ROUTER_INJECT_BUDGET: '1' }, warn), 1);
  assert.deepEqual(warnings, []);
});

for (const bad of ['', '0', '-5', '1.5', 'abc', '1e3', '12abc', '0x10', '99999999999999999999']) {
  test(`resolveInjectBudget: invalid value ${JSON.stringify(bad)} falls back to the default with exactly one stderr note`, () => {
    const warnings: string[] = [];
    const v = resolveInjectBudget({ MEMORY_ROUTER_INJECT_BUDGET: bad }, (m: string) => warnings.push(m));
    assert.equal(v, 16384);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /MEMORY_ROUTER_INJECT_BUDGET/);
    assert.match(warnings[0], /16384/);
    assert.ok(warnings[0].endsWith('\n'));
  });
}

test('resolveInjectBudget: control characters in a bad value are not echoed to stderr', () => {
  const warnings: string[] = [];
  resolveInjectBudget({ MEMORY_ROUTER_INJECT_BUDGET: 'a\u001b[31mb\nc' }, (m: string) => warnings.push(m));
  assert.equal(warnings.length, 1);
  assert.ok(!/\u001b/.test(warnings[0]));
  assert.equal(warnings[0].split('\n').length, 2, 'one line plus the trailing newline');
});

for (const [name, ch] of [
  ['C1 control U+0080', '\u0080'],
  ['C1 CSI U+009B', '\u009b'],
  ['C1 control U+009F', '\u009f'],
  ['LRM U+200E', '\u200e'],
  ['RLM U+200F', '\u200f'],
  ['LRE U+202A', '\u202a'],
  ['RLO U+202E', '\u202e'],
  ['LRI U+2066', '\u2066'],
  ['PDI U+2069', '\u2069'],
]) {
  test(`resolveInjectBudget: ${name} in a bad value is not echoed to stderr`, () => {
    const warnings: string[] = [];
    resolveInjectBudget({ MEMORY_ROUTER_INJECT_BUDGET: `ab${ch}cd` }, (m: string) => warnings.push(m));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('abcd'), 'the visible text survives, joined');
    assert.ok(!warnings[0].includes(ch));
  });
}

test('resolveInjectBudget: printable non-ASCII next to the stripped ranges is echoed unchanged', () => {
  const warnings: string[] = [];
  // U+00A0 (just above C1), U+00E9, U+2010 and U+202F (outside the bidi ranges).
  resolveInjectBudget({ MEMORY_ROUTER_INJECT_BUDGET: 'x\u00a0\u00e9\u2010\u202fy' }, (m: string) => warnings.push(m));
  assert.ok(warnings[0].includes('x\u00a0\u00e9\u2010\u202fy'));
});

test('renderHitsBudgeted reads MEMORY_ROUTER_INJECT_BUDGET when no budget is passed', () => {
  const hits = threeShort();
  const full = renderHitsBudgeted(hits, { budgetBytes: 1_000_000 });
  const restore = setEnv('MEMORY_ROUTER_INJECT_BUDGET', String(injectBytes(full) - 1));
  try {
    const { result: out, stderr } = captureStderr(() => renderHitsBudgeted(hits));
    assert.equal(stderr, '');
    assert.deepEqual([...blocksOf(out).values()].map(formOf), ['whole', 'whole', 'excerpt']);
  } finally {
    restore();
  }
});

test('renderHitsBudgeted: unset env uses the 16 KiB default', () => {
  const hits = Array.from({ length: 5 }, (_, i) => hit(mem(`d${i}`, sections(8, 1400)), 0.9 - i * 0.05, { chunkIndex: 1 }));
  const restore = setEnv('MEMORY_ROUTER_INJECT_BUDGET', undefined);
  try {
    const { result: out, stderr } = captureStderr(() => renderHitsBudgeted(hits));
    assert.equal(stderr, '');
    assert.ok(injectBytes(out) <= DEFAULT_INJECT_BUDGET_BYTES);
    assert.ok(injectBytes(out) > 1000);
  } finally {
    restore();
  }
});

for (const bad of ['', '0', '-5', '1.5', 'abc']) {
  test(`renderHitsBudgeted: invalid env ${JSON.stringify(bad)} renders with the default budget and notes it on stderr`, () => {
    const hits = threeShort();
    const restore = setEnv('MEMORY_ROUTER_INJECT_BUDGET', bad);
    try {
      const { result: out, stderr } = captureStderr(() => renderHitsBudgeted(hits));
      assert.match(stderr, /MEMORY_ROUTER_INJECT_BUDGET/);
      assert.equal(stderr.trim().split('\n').length, 1);
      // Default budget (16 KiB) is roomy enough for three ~1.9 KB bodies.
      assert.deepEqual([...blocksOf(out).values()].map(formOf), ['whole', 'whole', 'whole']);
    } finally {
      restore();
    }
  });
}

test('an explicit budgetBytes option wins over the env var, and an invalid option falls back to env/default', () => {
  const hits = threeShort();
  const restore = setEnv('MEMORY_ROUTER_INJECT_BUDGET', '1');
  try {
    const roomy = renderHitsBudgeted(hits, { budgetBytes: 1_000_000 });
    assert.equal(blocksOf(roomy).size, 3);
    const { result: fallback } = captureStderr(() => renderHitsBudgeted(hits, { budgetBytes: -3 }));
    assert.equal(blocksOf(fallback).size, 1, 'the env budget of 1 byte applies');
  } finally {
    restore();
  }
});

// --- PreToolUse stays on the unbudgeted renderer ------------------------------

test('renderHitsAsContext output equals the frozen pre-budget renderer, for long, stale and multi-hit input', () => {
  const stale = mem('stale', sections(6), { verify: [{ kind: 'path', value: '/definitely/not/here/anywhere' }] });
  const hits = [
    hit(longMemory('a')),
    hit(mem('b', 'tiny'), 0.5),
    hit(stale, 0.4, { chunkIndex: 3 }),
    { memory: longMemory('c', { type: 'feedback' }), gate: 'tool' as const, score: 1, reason: 'x' },
  ];
  assert.equal(renderHitsAsContext(hits), legacyRender(hits));
  assert.equal(renderHitsAsContext([hits[0]]), legacyRender([hits[0]]));
  assert.equal(renderHitsAsContext([]), '');
  // And the budgeted renderer is NOT the same thing for long input.
  assert.notEqual(renderHitsBudgeted(hits), legacyRender(hits));
});

test('the pre-tool-use hook injects the full body of a long memory, byte-identical to the unbudgeted renderer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-pretool-'));
  try {
    const body = sections(6, 1500);
    fs.writeFileSync(
      path.join(dir, 'long_rule.md'),
      `---\nname: Long rule\ndescription: a long rule\ntype: feedback\ntriggers:\n  command_pattern: "dangerous-cmd"\n---\n\n${body}\n`,
    );
    const res = spawnSync('node', [path.join(__dirname, '..', 'dist', 'hooks', 'pre-tool-use.js')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'run dangerous-cmd now' } }),
      env: { ...process.env, MEMORY_ROUTER_DIR: dir, MEMORY_ROUTER_INJECT_BUDGET: '500' },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext as string;
    const memory: Memory = {
      id: 'long_rule',
      path: path.join(dir, 'long_rule.md'),
      frontmatter: { name: 'Long rule', description: 'a long rule', type: 'feedback' },
      body: `\n${body}\n`,
    };
    assert.equal(ctx, legacyRender([{ memory, gate: 'tool', score: 1, reason: 'x' }]));
    assert.ok(ctx.includes('SECTION6 '), 'the last section of the full body is present');
    assert.ok(!ctx.includes('_Full memory:'));
    assert.ok(injectBytes(ctx) > 500, 'the budget env does not apply to PreToolUse');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
