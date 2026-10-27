// The chunk index travels from the search layer onto the GateHit and from
// there into the injected text:
//   blendedSearch (semantic winner chunk / best-bm25 FTS row)
//     -> resolveBlended (GateHit.chunkIndex)
//       -> renderHitsBudgeted (the excerpt the UserPromptSubmit hook injects)
//
// Three layers, each pinned where the data changes hands:
// - resolveBlended with a controlled search outcome: which chunk index wins
//   when semantic and keyword both know one, and that hits with no chunk
//   information keep the plain four-field shape;
// - the real search layer on a real index: a keyword hit carries the chunk
//   that holds the identifier;
// - the real UserPromptSubmit hook binary on a real index: the injected text
//   is the matching chunk (semantic and keyword paths), not the whole body;
// - chunk alignment: the text the renderer injects for chunk i is exactly the
//   text the indexer embedded for chunk i.
//
// Embeddings are stubbed at the fetch layer (as in tests/embed-chunks.test.ts)
// and the hook's query vector is seeded into the index's query cache, so
// nothing touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { resolveBlended } = require('../src/router');
const { openIndex } = require('../src/embed/index-store');
const { rebuildIndex, blendedSearch, indexPath } = require('../src/embed/indexer');
const { chunkBody } = require('../src/embed/chunking');
const { loadMemoriesFromDir } = require('../src/memory/loader');
const { renderHitsBudgeted } = require('../src/render');

const MODEL = 'text-embedding-3-small';
const ON = [1, 0];
const OFF = [0, 1];
const FLOOR = 0.5;
const distDir = path.join(__dirname, '..', 'dist', 'hooks');

interface MemoryChunk {
  index: number;
  offset: number;
  text: string;
}

function para(marker: string, len: number): string {
  const text = `${marker} `;
  return text + 'x'.repeat(Math.max(0, len - text.length));
}

function sections(n: number, len = 1100): string {
  return Array.from({ length: n }, (_, i) => para(`SECTION${i + 1}`, len)).join('\n\n');
}

// --- router level -----------------------------------------------------------

const NOVOCAB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-chunkthread-novocab-'));
test.after(() => {
  fs.rmSync(NOVOCAB_DIR, { recursive: true, force: true });
});

let prevFloor: string | undefined;
test.beforeEach(() => {
  prevFloor = process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
  process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC = String(FLOOR);
});
test.afterEach(() => {
  if (prevFloor === undefined) delete process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
  else process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC = prevFloor;
});

function fakeMemory(id: string): Memory {
  return {
    id,
    path: `/nonexistent/${id}.md`,
    frontmatter: { name: id, description: `desc for ${id}`, type: 'feedback' },
    body: `body for ${id}`,
  };
}

interface SeamSemantic {
  id: string;
  score: number;
  chunk?: { index: number; offset: number };
}
interface SeamKeyword {
  id: string;
  chunkIndex?: number;
}

function seam(semantic: SeamSemantic[], keyword: SeamKeyword[] = []) {
  return async (_p: string, memories: Memory[]) => ({
    semantic: semantic.map((s) => ({
      memory: memories.find((m) => m.id === s.id)!,
      score: s.score,
      ...(s.chunk ? { chunk: s.chunk } : {}),
    })),
    keyword: keyword.map((k) => ({
      memory: memories.find((m) => m.id === k.id)!,
      idTerms: ['zq7k29xd'],
      bm25: -2,
      ...(k.chunkIndex !== undefined ? { chunkIndex: k.chunkIndex } : {}),
    })),
  });
}

const PROMPT = 'an unrelated prompt with no topic keywords at all';

async function resolveWith(
  memories: Memory[],
  semantic: SeamSemantic[],
  keyword: SeamKeyword[] = [],
): Promise<GateHit[]> {
  const ctx: RouterContext = { prompt: PROMPT, memoryDir: NOVOCAB_DIR };
  return resolveBlended(ctx, memories, '/fake/dir', {}, { semanticSearch: seam(semantic, keyword) });
}

test('resolveBlended: the winning semantic chunk index lands on the GateHit', async () => {
  const hits = await resolveWith(
    [fakeMemory('a')],
    [{ id: 'a', score: 0.9, chunk: { index: 4, offset: 1234 } }],
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunkIndex, 4);
});

test('resolveBlended: a semantic hit whose document vector won (no chunk) carries no chunk index', async () => {
  const hits = await resolveWith([fakeMemory('a')], [{ id: 'a', score: 0.9 }]);
  assert.equal(hits.length, 1);
  assert.ok(!('chunkIndex' in hits[0]), 'the key is absent, the hit keeps its four-field shape');
  assert.deepEqual(Object.keys(hits[0]).sort(), ['gate', 'memory', 'reason', 'score']);
});

test('resolveBlended: a keyword-only admission carries the chunk the id token matched in', async () => {
  const hits = await resolveWith([fakeMemory('kw')], [], [{ id: 'kw', chunkIndex: 3 }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].gate, 'keyword');
  assert.equal(hits[0].chunkIndex, 3);
});

test('resolveBlended: with a live semantic path, a keyword-only admission still carries its own chunk', async () => {
  // "sem" clears the floor, so this is the active-blend branch (not the
  // degraded one); "kw" has no semantic hit and is admitted by its id token.
  const hits = await resolveWith(
    [fakeMemory('sem'), fakeMemory('kw')],
    [{ id: 'sem', score: 0.9, chunk: { index: 2, offset: 40 } }],
    [{ id: 'kw', chunkIndex: 4 }],
  );
  const byId = new Map<string, GateHit>(hits.map((h) => [h.memory.id, h]));
  assert.equal(byId.get('kw')?.gate, 'keyword');
  assert.equal(byId.get('kw')?.chunkIndex, 4);
  assert.equal(byId.get('sem')?.chunkIndex, 2, 'the semantic hit keeps its own chunk');
});

test('resolveBlended: keyword admission in the degraded branch (semantic silent) also carries its chunk', async () => {
  // Every semantic candidate below the floor: the semantic path contributes
  // nothing, so the degraded branch builds the keyword-first slots.
  const hits = await resolveWith(
    [fakeMemory('kw'), fakeMemory('weak')],
    [{ id: 'weak', score: 0.1, chunk: { index: 9, offset: 1 } }],
    [{ id: 'kw', chunkIndex: 5 }],
  );
  const kw = hits.find((h) => h.memory.id === 'kw');
  if (!kw) throw new Error('keyword-admitted memory missing from the result');
  assert.equal(kw.gate, 'keyword');
  assert.equal(kw.chunkIndex, 5);
});

test('resolveBlended: semantic chunk wins over the keyword chunk when both are known for one memory', async () => {
  const hits = await resolveWith(
    [fakeMemory('both')],
    [{ id: 'both', score: 0.9, chunk: { index: 1, offset: 10 } }],
    [{ id: 'both', chunkIndex: 6 }],
  );
  assert.equal(hits[0].gate, 'confidence');
  assert.equal(hits[0].chunkIndex, 1);
});

test('resolveBlended: a semantic hit with no chunk but an id match takes the keyword chunk', async () => {
  const hits = await resolveWith(
    [fakeMemory('both')],
    [{ id: 'both', score: 0.9 }],
    [{ id: 'both', chunkIndex: 6 }],
  );
  assert.equal(hits[0].gate, 'confidence');
  assert.equal(hits[0].chunkIndex, 6);
});

test('resolveBlended: a keyword candidate whose seam entry has no chunk index leaves the key off', async () => {
  const hits = await resolveWith([fakeMemory('kw')], [], [{ id: 'kw' }]);
  assert.equal(hits[0].gate, 'keyword');
  assert.ok(!('chunkIndex' in hits[0]));
});

test('resolveBlended: each hit carries ITS OWN chunk index', async () => {
  const hits = await resolveWith(
    [fakeMemory('a'), fakeMemory('b'), fakeMemory('c')],
    [
      { id: 'a', score: 0.95, chunk: { index: 0, offset: 0 } },
      { id: 'b', score: 0.9, chunk: { index: 7, offset: 5 } },
      { id: 'c', score: 0.8 },
    ],
  );
  const byId = new Map<string, number | undefined>(hits.map((h) => [h.memory.id, h.chunkIndex]));
  assert.equal(byId.get('a'), 0, 'chunk 0 is a real index, not "unknown"');
  assert.equal(byId.get('b'), 7);
  assert.equal(byId.get('c'), undefined);
});

// --- real index fixtures ----------------------------------------------------

function withProviderEnv<T>(fn: () => Promise<T>): Promise<T> {
  const names = [
    'OPENAI_API_KEY',
    'MEMORY_ROUTER_EMBED_PROVIDER',
    'MEMORY_ROUTER_EMBED_MODEL',
    'MEMORY_ROUTER_KEYWORD',
  ];
  const prev = new Map(names.map((n) => [n, process.env[n]]));
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.MEMORY_ROUTER_EMBED_PROVIDER = 'openai';
  process.env.MEMORY_ROUTER_EMBED_MODEL = MODEL;
  delete process.env.MEMORY_ROUTER_KEYWORD;
  return fn().finally(() => {
    for (const [n, v] of prev) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  });
}

// Stubs fetch with a per-input vector function and records every input.
function stubFetch(vectorFor: (input: string) => number[]): { restore: () => void; inputs: string[] } {
  const orig = (globalThis as { fetch?: typeof fetch }).fetch;
  const inputs: string[] = [];
  (globalThis as { fetch: typeof fetch }).fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
    inputs.push(...body.input);
    const data = body.input.map((text, index) => ({ embedding: vectorFor(text), index }));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    restore: () => {
      if (orig) (globalThis as { fetch: typeof fetch }).fetch = orig;
      else delete (globalThis as { fetch?: typeof fetch }).fetch;
    },
    inputs,
  };
}

function writeMemory(
  dir: string,
  file: string,
  fm: { name: string; description: string; type: string },
  body: string,
): string {
  const full = path.join(dir, file);
  fs.writeFileSync(
    full,
    `---\nname: ${fm.name}\ndescription: ${fm.description}\ntype: ${fm.type}\n---\n\n${body}\n`,
  );
  return full;
}

function seedQuery(dir: string, prompt: string, vec: number[]): void {
  const store = openIndex({
    path: indexPath(dir),
    meta: { provider: 'openai', model: MODEL },
    cache: { model: MODEL, capacity: 10 },
  });
  try {
    store.putCachedQuery(prompt, vec);
  } finally {
    store.close();
  }
}

function runHook(dir: string, prompt: string): { stdout: string; stderr: string; code: number } {
  const res = spawnSync('node', [path.join(distDir, 'user-prompt-submit.js')], {
    input: JSON.stringify({ prompt }),
    env: {
      ...process.env,
      MEMORY_ROUTER_DIR: dir,
      OPENAI_API_KEY: 'sk-test-not-real',
      MEMORY_ROUTER_EMBED_PROVIDER: 'openai',
      MEMORY_ROUTER_EMBED_MODEL: MODEL,
      // Above the 0.5 an orthogonal pair of vectors scores in this store, so
      // only a true match (cosine 1.0) clears the floor.
      MEMORY_ROUTER_BLEND_MIN_SEMANTIC: '0.9',
      MEMORY_ROUTER_KEYWORD: 'on',
    },
    encoding: 'utf8',
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? -1 };
}

function injected(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
}

// --- real search layer -------------------------------------------------------

test('blendedSearch: a keyword hit carries the index of the chunk that holds the identifier, a semantic hit its winning chunk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-chunkthread-search-'));
  const stub = stubFetch(() => OFF);
  try {
    await withProviderEnv(async () => {
      const body = [para('ALPHA', 1100), para('BRAVO', 1100), `${para('CHARLIE', 1000)} zq7k29xd`, para('DELTA', 1100)].join('\n\n');
      writeMemory(dir, 'idmem.md', { name: 'Id memory', description: 'has an id', type: 'reference' }, body);
      await rebuildIndex(dir);
      const memories: Memory[] = loadMemoriesFromDir(dir);
      const chunks: MemoryChunk[] = chunkBody(memories[0].body);
      const idChunk = chunks.findIndex((c) => c.text.includes('zq7k29xd'));
      assert.ok(idChunk >= 2, 'fixture: the identifier sits in a later chunk');

      const outcome = await blendedSearch('what about zq7k29xd', memories, dir, 5);
      assert.equal(outcome.keyword.length, 1);
      assert.equal(outcome.keyword[0].chunkIndex, idChunk);
    });
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('blendedSearch: with several id tokens the keyword hit carries the chunk of the best-bm25 row across all of them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-chunkthread-multi-'));
  const stub = stubFetch(() => OFF);
  try {
    await withProviderEnv(async () => {
      // The first prompt token (weak) occurs once in chunk 1; the second
      // (strong) is repeated in chunk 3, which gives it the better bm25.
      const weak = 'qw4r81ab';
      const strong = 'zt9k52cd';
      const body = [
        para('ALPHA', 1000),
        `${para('BRAVO', 900)} ${weak}`,
        para('CHARLIE', 1100),
        `${para('DELTA', 600)} ${Array.from({ length: 8 }, () => strong).join(' ')}`,
      ].join('\n\n');
      writeMemory(dir, 'multi.md', { name: 'Multi id', description: 'two ids', type: 'reference' }, body);
      await rebuildIndex(dir);
      const memories: Memory[] = loadMemoriesFromDir(dir);
      const chunks: MemoryChunk[] = chunkBody(memories[0].body);
      const weakChunk = chunks.findIndex((c) => c.text.includes(weak));
      const strongChunk = chunks.findIndex((c) => c.text.includes(strong));
      assert.ok(weakChunk >= 0 && strongChunk > weakChunk, 'fixture: two different chunks');

      // Ground truth from the FTS table itself: which row has the best bm25.
      const store = openIndex({
        path: indexPath(dir),
        meta: { provider: 'openai', model: MODEL },
        readonly: true,
      });
      let bestChunk = -1;
      let bestScore = Infinity;
      try {
        for (const term of [weak, strong]) {
          for (const row of store.ftsMatch(`"${term}"`, 10) as { chunkIndex: number; score: number }[]) {
            if (row.score < bestScore) {
              bestScore = row.score;
              bestChunk = row.chunkIndex;
            }
          }
        }
      } finally {
        store.close();
      }
      assert.equal(bestChunk, strongChunk, 'fixture: the second token holds the best row');

      const outcome = await blendedSearch(`look at ${weak} and ${strong}`, memories, dir, 5);
      assert.equal(outcome.keyword.length, 1);
      assert.deepEqual(outcome.keyword[0].idTerms.sort(), [strong, weak].sort());
      assert.equal(outcome.keyword[0].chunkIndex, strongChunk);
    });
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- hook binary on a real index -------------------------------------------

test('hook, semantic path: the injected text is the matching chunk + description + path, not the body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-chunkthread-hook-'));
  // Only the chunk that carries SECTION3 matches the query; the document
  // input contains every section, so it stays OFF.
  const stub = stubFetch((input) =>
    input.includes('SECTION3 ') && !input.includes('SECTION1 ') ? ON : OFF,
  );
  try {
    await withProviderEnv(async () => {
      const file = writeMemory(
        dir,
        'long_memory.md',
        { name: 'Long memory', description: 'a long one about zebras', type: 'project' },
        sections(5),
      );
      await rebuildIndex(dir);
      seedQuery(dir, 'tell me about the zebra', ON);

      const res = runHook(dir, 'tell me about the zebra');
      assert.equal(res.code, 0, res.stderr);
      const ctx = injected(res.stdout);
      assert.ok(ctx.includes('SECTION3 '), 'the matching chunk');
      for (const other of [1, 2, 4, 5]) {
        assert.ok(!ctx.includes(`SECTION${other} `), `section ${other} must not be injected`);
      }
      assert.ok(ctx.includes('a long one about zebras'), 'the description');
      assert.ok(ctx.includes(`_Full memory: ${file}_`), 'the absolute path');
      assert.match(ctx, /_Excerpt \(chunk 3 of 5\):_/);
      assert.match(ctx, /confidence · /);
      assert.ok(Buffer.byteLength(ctx, 'utf8') < 3000);
    });
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook, keyword path: a keyword-only admission injects the chunk holding the identifier', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-chunkthread-hookkw-'));
  const stub = stubFetch(() => OFF);
  try {
    await withProviderEnv(async () => {
      const body = [para('ALPHA', 1100), `${para('BRAVO', 1000)} zq7k29xd`, para('CHARLIE', 1100)].join('\n\n');
      const file = writeMemory(
        dir,
        'task_note.md',
        { name: 'Task note', description: 'notes on a task', type: 'reference' },
        body,
      );
      await rebuildIndex(dir);
      // Query matches nothing semantically (all vectors OFF), so the id token
      // is what admits the memory.
      seedQuery(dir, 'what is the state of zq7k29xd', ON);

      const res = runHook(dir, 'what is the state of zq7k29xd');
      assert.equal(res.code, 0, res.stderr);
      const ctx = injected(res.stdout);
      assert.match(ctx, /keyword · /);
      assert.ok(ctx.includes('BRAVO '), 'the chunk with the identifier');
      assert.ok(ctx.includes('zq7k29xd'));
      assert.ok(!ctx.includes('ALPHA ') && !ctx.includes('CHARLIE '), 'no other chunk');
      assert.ok(ctx.includes(`_Full memory: ${file}_`));
    });
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- chunk alignment ---------------------------------------------------------

test('chunk alignment: the text injected for chunk i is exactly the text the indexer embedded for chunk i', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-chunkthread-align-'));
  const stub = stubFetch(() => OFF);
  try {
    await withProviderEnv(async () => {
      // A body with headings, a list and a fenced block, so the chunker's
      // boundary rules are all in play, and leading/trailing blank lines so
      // an untrimmed-vs-trimmed mismatch would shift every chunk.
      const body = [
        '',
        `## First part\n${para('P1', 1100)}`,
        `- item one ${para('P2', 1000)}\n- item two ${para('P2B', 200)}`,
        `## Code part\n\`\`\`bash\ngit push origin feature\ngit status\n\`\`\`\n${para('P3', 1000)}`,
        para('P4', 1300),
        '',
      ].join('\n\n');
      writeMemory(dir, 'aligned.md', { name: 'Aligned', description: 'alignment fixture', type: 'project' }, body);
      await rebuildIndex(dir);

      const memories: Memory[] = loadMemoriesFromDir(dir);
      const memory = memories[0];
      const chunks: MemoryChunk[] = chunkBody(memory.body);
      assert.ok(chunks.length >= 3, 'fixture produces several chunks');

      const prefix = `${memory.frontmatter.name}\n${memory.frontmatter.description}\n`;
      for (const chunk of chunks) {
        const rendered = renderHitsBudgeted(
          [{ memory, gate: 'confidence', score: 0.9, reason: 'x', chunkIndex: chunk.index }],
          { budgetBytes: 1_000_000 },
        );
        const start = rendered.indexOf(':_\n');
        const end = rendered.indexOf('\n\n_Full memory:');
        assert.ok(start >= 0 && end > start, `chunk ${chunk.index}: excerpt located`);
        const excerpt = rendered.slice(start + 3, end);
        // The renderer may append a neighbour for a short chunk; the embedded
        // text for THIS chunk must be the start of the excerpt.
        assert.ok(
          excerpt.startsWith(chunk.text),
          `chunk ${chunk.index}: the excerpt starts with the chunk text`,
        );
        assert.ok(
          stub.inputs.includes(`${prefix}${chunk.text}`),
          `chunk ${chunk.index}: the indexer embedded exactly name + description + this chunk text`,
        );
      }
    });
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
