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
  assert.ok(out.includes('_Full memory: /abs/dir/long.md_'));
  assert.ok(out.length < m.body.length / 2);
});

test('the path line is absolute even when the loaded path is relative', () => {
  const m = mem('rel', sections(3), {}, 'relative/rel.md');
  const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: 0 })]);
  assert.ok(out.includes(`_Full memory: ${path.resolve('relative/rel.md')}_`));
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

test('hit without chunk info: description + FIRST chunk + path', () => {
  const m = longMemory('nochunk');
  const out = renderHitsBudgeted([hit(m)]);
  assert.ok(out.includes('Description of nochunk'));
  assert.ok(out.includes('SECTION1 '));
  assert.ok(!out.includes('SECTION2 ') && !out.includes('SECTION5 '));
  assert.match(out, /_Excerpt \(chunk 1 of 5\):_/);
  assert.ok(out.includes('_Full memory: /mem/nochunk.md_'));
});

test('a chunk index the body no longer has falls back to the first chunk', () => {
  const m = longMemory('stalechunk');
  for (const idx of [99, -1]) {
    const out = renderHitsBudgeted([hit(m, 0.8, { chunkIndex: idx })]);
    assert.match(out, /_Excerpt \(chunk 1 of 5\):_/, `chunkIndex ${idx}`);
  }
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

test('dropping happens only after every remaining hit is in its minimal form', () => {
  const hits = threeShort();
  let sawDrop = false;
  for (let budget = 12000; budget >= 1; budget -= 13) {
    const out = renderHitsBudgeted(hits, { budgetBytes: budget });
    const blocks = [...blocksOf(out).entries()];
    const forms = blocks.map(([, b]) => formOf(b));
    assert.equal(blocks[0][0], 'h1', `top hit present at budget ${budget}`);
    const rank: Record<Form, number> = { whole: 0, excerpt: 1, minimal: 2 };
    for (let i = 1; i < forms.length; i++) {
      assert.ok(rank[forms[i]] >= rank[forms[i - 1]], `lower hit never fuller than a higher one (budget ${budget})`);
    }
    if (blocks.length < hits.length) {
      sawDrop = true;
      assert.ok(forms.every((f) => f === 'minimal'), `a drop only after all kept hits are minimal (budget ${budget})`);
      assert.deepEqual(blocks.map(([id]) => id), ['h1', 'h2', 'h3'].slice(0, blocks.length), 'dropped hits are the lowest-ranked suffix');
    }
    if (blocks.length > 1) {
      assert.ok(injectBytes(out) <= budget, `within budget ${budget} unless only the top hit remains`);
    }
  }
  assert.ok(sawDrop, 'the sweep reached the drop phase');
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
