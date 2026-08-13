// Unit tests for resolveBlended (src/router.ts, mm-v1-T004): the
// score-blend resolver that replaces the old "shadowed gates" resolver
// (sync topic/tool gates first, confidence gate only when they stayed
// silent). That shadowing meant a Topic Gate hit's flat 1.0 score
// pre-empted the semantic path almost every real prompt — three different
// prompts sharing a topic word produced an identical top-5 regardless of
// what each prompt actually meant. These tests exercise the replacement:
// semantic score as the dominant signal, topic match as a boost, recency
// (mtime decay) and type as tie-breaking modifiers.
//
// Most tests use resolveBlended's `deps` test seam (5th, test-only
// parameter — see src/router.ts) to inject a controlled semantic-search
// result instead of touching the real embedding stack: real cosine
// similarity is not reproducible from a deterministic fake vector, so
// pinning "prompt A ranks memory X first, prompt B ranks memory Y first"
// needs a fake that maps directly to a score, not a fake embedding whose
// resulting cosine similarity would have to be computed by hand. The
// degradation-pinning and one-embedding-guarantee tests deliberately use
// the REAL semanticSearch (no deps override) since those two properties are
// about the real pipeline's behavior, not about controlling a score.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { resolveBlended, resolve } = require('../src/router');
const { loadMemoriesFromDir } = require('../src/memory/loader');
const { rebuildIndex } = require('../src/embed/indexer');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'memories');

// No topics.yml here — resolveBlended's internal topicGate.evaluate call
// falls back to the built-in default vocabulary (src/topic-patterns.ts),
// and threading ctx.memoryDir here (instead of leaving it unset) keeps
// every test hermetic against whatever $MEMORY_ROUTER_DIR happens to be
// ambient in the host environment running `npm test` (see src/gates/topic.ts).
const NOVOCAB_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'memory-router-blend-novocab-'),
);
test.after(() => {
  fs.rmSync(NOVOCAB_DIR, { recursive: true, force: true });
});

function fakeMemory(
  id: string,
  overrides: Partial<MemoryFrontmatter> = {},
  filePath: string = `/nonexistent/${id}.md`,
): Memory {
  return {
    id,
    path: filePath,
    frontmatter: {
      name: id,
      description: `desc for ${id}`,
      type: 'feedback',
      ...overrides,
    },
    body: `body for ${id}`,
  };
}

// Deps-seam fake: returns a hit for every memory id present in `scoresById`,
// score taken verbatim from the map. Mirrors the real semanticSearch's
// return shape ({ memory, score }[]) without touching the embedding stack.
function fakeSemanticSearch(
  scoresById: Record<string, number>,
): (
  prompt: string,
  memories: Memory[],
  memoryDir: string,
  k: number,
) => Promise<{ memory: Memory; score: number }[]> {
  return async (_prompt: string, memories: Memory[]) =>
    memories
      .filter((m) => scoresById[m.id] !== undefined)
      .map((m) => ({ memory: m, score: scoresById[m.id] }));
}

const NO_TOPIC_PROMPT = 'an unrelated prompt with no topic keywords at all';

// --- Ranking: semantic dominates, topic boosts, recency breaks ties -------

test('resolveBlended: semantic score dominates the ranking when topic/recency/type are equal', async () => {
  const a = fakeMemory('a');
  const b = fakeMemory('b');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const hits = await resolveBlended(ctx, [a, b], '/fake/dir', {}, {
    semanticSearch: fakeSemanticSearch({ a: 0.9, b: 0.3 }),
  });
  assert.deepEqual(hits.map((h: GateHit) => h.memory.id), ['a', 'b']);
});

test("resolveBlended: a topic match boosts a memory's ranking (secondary signal, not a flat 1.0 override)", async () => {
  const withTopic = fakeMemory('with-topic', { topics: ['workflow'] });
  const withoutTopic = fakeMemory('without-topic');
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const hits = await resolveBlended(ctx, [withTopic, withoutTopic], '/fake/dir', {}, {
    semanticSearch: fakeSemanticSearch({ 'with-topic': 0.4, 'without-topic': 0.4 }),
  });
  assert.equal(hits[0].memory.id, 'with-topic');
  assert.ok(
    hits[0].score > hits[1].score,
    `expected the topic-matched memory to outrank the tie, got scores ${hits[0].score} vs ${hits[1].score}`,
  );
  assert.notEqual(hits[0].score, 1.0, 'topic-boosted score must not be a flat 1.0');
});

test('resolveBlended: a dominant semantic lead is NOT overturned by a topic boost on a weak semantic score', async () => {
  const strong = fakeMemory('strong');
  const weakWithTopic = fakeMemory('weak-topic', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const hits = await resolveBlended(ctx, [strong, weakWithTopic], '/fake/dir', {}, {
    semanticSearch: fakeSemanticSearch({ strong: 0.9, 'weak-topic': 0.1 }),
  });
  assert.equal(hits[0].memory.id, 'strong', 'semantic score must dominate the blend');
});

test('resolveBlended: recency breaks a tie between two memories with equal semantic score and no topic match', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-blend-recency-'));
  try {
    const oldPath = path.join(dir, 'old.md');
    const newPath = path.join(dir, 'new.md');
    fs.writeFileSync(oldPath, 'old body');
    fs.writeFileSync(newPath, 'new body');
    const now = Date.now();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldPath, new Date(now - ninetyDaysMs), new Date(now - ninetyDaysMs));
    fs.utimesSync(newPath, new Date(now), new Date(now));

    const oldMem = fakeMemory('old', {}, oldPath);
    const newMem = fakeMemory('new', {}, newPath);
    const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
    const hits = await resolveBlended(ctx, [oldMem, newMem], '/fake/dir', {}, {
      semanticSearch: fakeSemanticSearch({ old: 0.5, new: 0.5 }),
    });
    assert.equal(hits[0].memory.id, 'new', 'the more recently modified memory must win the tie');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveBlended: type modifier nudges a tie (feedback outranks reference at equal semantic score, no topic, equal mtime)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-blend-type-'));
  try {
    const feedbackPath = path.join(dir, 'feedback.md');
    const referencePath = path.join(dir, 'reference.md');
    fs.writeFileSync(feedbackPath, 'body');
    fs.writeFileSync(referencePath, 'body');
    const now = new Date();
    fs.utimesSync(feedbackPath, now, now);
    fs.utimesSync(referencePath, now, now);

    const feedbackMem = fakeMemory('feedback-mem', { type: 'feedback' }, feedbackPath);
    const referenceMem = fakeMemory('reference-mem', { type: 'reference' }, referencePath);
    const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
    const hits = await resolveBlended(ctx, [feedbackMem, referenceMem], '/fake/dir', {}, {
      semanticSearch: fakeSemanticSearch({ 'feedback-mem': 0.5, 'reference-mem': 0.5 }),
    });
    assert.equal(hits[0].memory.id, 'feedback-mem');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Identical-top-5 regression symptom ------------------------------------

test('resolveBlended: two prompts sharing the same topic but different semantic content rank differently (fixes the "identical top-5" symptom)', async () => {
  const m1 = fakeMemory('m1', { topics: ['workflow'] });
  const m2 = fakeMemory('m2', { topics: ['workflow'] });
  const m3 = fakeMemory('m3', { topics: ['workflow'] });
  const ctxFor = (prompt: string): RouterContext => ({ prompt, memoryDir: NOVOCAB_DIR });

  const hitsA = await resolveBlended(
    ctxFor('please review and merge PR one'),
    [m1, m2, m3],
    '/fake/dir',
    {},
    { semanticSearch: fakeSemanticSearch({ m1: 0.9, m2: 0.2, m3: 0.1 }) },
  );
  const hitsB = await resolveBlended(
    ctxFor('please review and merge PR two'),
    [m1, m2, m3],
    '/fake/dir',
    {},
    { semanticSearch: fakeSemanticSearch({ m3: 0.9, m2: 0.2, m1: 0.1 }) },
  );

  assert.equal(hitsA[0].memory.id, 'm1');
  assert.equal(hitsB[0].memory.id, 'm3');
  assert.notDeepEqual(
    hitsA.map((h: GateHit) => h.memory.id),
    hitsB.map((h: GateHit) => h.memory.id),
    'two prompts with different semantic content sharing one topic must not collapse to the same ranking (the bug this resolver replaces)',
  );
});

// --- Degradation: no phantom hits, fail-open, and pinned-identical-to-old -

test('resolveBlended: a memory with neither a semantic nor a topic signal never surfaces (modifiers alone cannot select a memory)', async () => {
  const matched = fakeMemory('matched');
  const silent = fakeMemory('silent');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const hits = await resolveBlended(ctx, [matched, silent], '/fake/dir', {}, {
    semanticSearch: fakeSemanticSearch({ matched: 0.5 }),
  });
  assert.deepEqual(hits.map((h: GateHit) => h.memory.id), ['matched']);
});

test('resolveBlended: empty result when ctx.prompt is unset (no semantic call attempted)', async () => {
  let semanticSearchCalled = false;
  const hits = await resolveBlended({}, [fakeMemory('a')], '/fake/dir', {}, {
    semanticSearch: async () => {
      semanticSearchCalled = true;
      return [];
    },
  });
  assert.deepEqual(hits, []);
  assert.equal(semanticSearchCalled, false);
});

test('resolveBlended: a semantic-search failure degrades to the exact pre-blend topic-only hit (flat 1.0, no modifiers) rather than throwing (never blocks the prompt)', async () => {
  const withTopic = fakeMemory('with-topic', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const hits = await resolveBlended(ctx, [withTopic], '/fake/dir', {}, {
    semanticSearch: async () => {
      throw new Error('simulated embeddings API failure');
    },
  });
  // A caught semantic-search error is one of the two "semantic path
  // contributes nothing" cases (the other is no index/provider, see the
  // real-pipeline degradation-pinning test below): both must degrade to
  // EXACTLY resolve()'s topic-only output, not a blended score. An earlier
  // version of this resolver applied the topic-boost/recency/type modifiers
  // even here, which re-ranks a degraded top-N once a prompt has more topic
  // candidates than maxHits (measured against the real corpus).
  assert.deepEqual(hits, resolve(ctx, [withTopic], { maxHits: 5 }));
  assert.deepEqual(hits.map((h: GateHit) => h.memory.id), ['with-topic']);
  assert.equal(hits[0].gate, 'topic');
  assert.equal(hits[0].score, 1.0, `expected the flat pre-blend topic score, got ${hits[0].score}`);
});

test('resolveBlended: without an index/provider (real semanticSearch, no deps override), degraded output is byte-identical to resolve(), same ids, scores, reasons, and order, with more topic candidates than maxHits', async () => {
  // Regression fixture for the mm-v1-T004 post-hoc fix: the original
  // degradation guard below only asserted SET equality of memory ids and a
  // "score is not exactly 1.0" property, using the 4-file shared fixtures
  // dir (all matching different topics, well under maxHits=5). That corpus
  // was too small to expose the bug: resolveBlended was still applying
  // topicBoost/recency/type modifiers in degraded mode, which is invisible
  // when every topic candidate fits inside maxHits (the ORDER doesn't
  // matter if nothing gets capped) and invisible to a set-only assertion
  // (a re-ranked but same-membership top-5 still passes `notEqual(1.0)` +
  // set equality). This fixture builds MORE than maxHits (5) topic
  // candidates for one prompt, with mtimes spread widely (0/20/40/60/80/100
  // days old) and every `type` represented, so a modifier applied in
  // degraded mode would both re-order the top-5 AND evict a load-order
  // pick, and asserts full deep equality against resolve(), not just a set.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-blend-degrade-pin-'));
  try {
    const now = Date.now();
    const types: MemoryType[] = ['feedback', 'project', 'reference', 'user'];
    const dayMs = 24 * 60 * 60 * 1000;
    const memories: Memory[] = [];
    for (let i = 0; i < 7; i++) {
      const p = path.join(dir, `m${i}.md`);
      fs.writeFileSync(p, `body ${i}`);
      const mtime = new Date(now - i * 20 * dayMs);
      fs.utimesSync(p, mtime, mtime);
      memories.push(
        fakeMemory(`m${i}`, { topics: ['workflow'], type: types[i % types.length] }, p),
      );
    }
    assert.ok(memories.length > 5, 'fixture sanity: need more topic candidates than maxHits (5)');

    const ctx: RouterContext = {
      prompt: 'please review and merge this PR',
      memoryDir: NOVOCAB_DIR,
    };

    // Real semanticSearch: no `.memory-router` index exists under `dir`, so
    // it no-ops (returns [], no HTTP call) regardless of whatever embedding
    // provider env happens to be configured — see src/embed/indexer.ts.
    const blendedHits = await resolveBlended(ctx, memories, dir, { maxHits: 5 });
    const oldHits = resolve(ctx, memories, { maxHits: 5 });

    assert.equal(oldHits.length, 5, 'sanity: resolve() itself caps at maxHits');
    assert.deepEqual(
      blendedHits,
      oldHits,
      'the degraded blend must be byte-identical to resolve() (ids, scores, reasons, and load-order), not just same-membership',
    );
    for (const h of blendedHits) {
      assert.equal(h.score, 1.0, 'degraded mode must use the flat pre-blend topic score, no modifiers');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Tool Gate passthrough (ctx.tool, e.g. MCP's memory_resolve) ----------

test('resolveBlended: ctx.tool still resolves via the deterministic Tool Gate, unaffected by the semantic blend', async () => {
  const toolMem = fakeMemory('tool-mem', { triggers: { tools: ['Bash'] } });
  const ctx: RouterContext = {
    prompt: NO_TOPIC_PROMPT,
    memoryDir: NOVOCAB_DIR,
    tool: { name: 'Bash', args: { command: 'ls' } },
  };
  const hits = await resolveBlended(ctx, [toolMem], '/fake/dir', {}, {
    semanticSearch: fakeSemanticSearch({}),
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].memory.id, 'tool-mem');
  assert.equal(hits[0].gate, 'tool');
  assert.equal(hits[0].score, 1.0);
});

// --- Weights are env-overridable (MEMORY_ROUTER_BLEND_* namespace) --------

test('resolveBlended: MEMORY_ROUTER_BLEND_TOPIC_BOOST overrides the default topic boost weight', async () => {
  const withTopic = fakeMemory('with-topic', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const prev = process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST;
  process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST = '5';
  try {
    // A non-empty (if tiny) semantic score is required here: since the
    // mm-v1-T004 degradation fix, resolveBlended bypasses topicBoost/
    // recency/type entirely (returns the flat pre-blend resolve() output)
    // whenever the semantic path contributes nothing at all, see the
    // degradation-pinning test above. This test is about the blend's env
    // override, not about degraded mode, so it must keep the semantic path
    // "live" (non-zero score for this memory) to actually exercise it.
    const hits = await resolveBlended(ctx, [withTopic], '/fake/dir', {}, {
      semanticSearch: fakeSemanticSearch({ 'with-topic': 0.01 }),
    });
    assert.ok(
      hits[0].score >= 5,
      `expected the overridden topic boost (5) to dominate the score, got ${hits[0].score}`,
    );
  } finally {
    if (prev === undefined) delete process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST;
    else process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST = prev;
  }
});

test('resolveBlended: a non-numeric MEMORY_ROUTER_BLEND_TOPIC_BOOST override falls back to the built-in default rather than producing NaN scores', async () => {
  const withTopic = fakeMemory('with-topic', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const prev = process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST;
  process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST = 'not-a-number';
  try {
    const hits = await resolveBlended(ctx, [withTopic], '/fake/dir', {}, {
      semanticSearch: fakeSemanticSearch({}),
    });
    assert.ok(
      Number.isFinite(hits[0].score) && hits[0].score > 0,
      `expected a finite fallback-default score, got ${hits[0].score}`,
    );
  } finally {
    if (prev === undefined) delete process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST;
    else process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST = prev;
  }
});

test('resolveBlended: a non-positive MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS override falls back to the built-in default instead of dividing by zero', async () => {
  const now = new Date();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-blend-halflife-'));
  try {
    const p = path.join(dir, 'mem.md');
    fs.writeFileSync(p, 'body');
    fs.utimesSync(p, now, now);
    const mem = fakeMemory('mem', {}, p);
    const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
    const prev = process.env.MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS;
    process.env.MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS = '0';
    try {
      const hits = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
        semanticSearch: fakeSemanticSearch({ mem: 0.5 }),
      });
      assert.ok(
        Number.isFinite(hits[0].score),
        `expected a finite score using the built-in half-life fallback, got ${hits[0].score}`,
      );
    } finally {
      if (prev === undefined) delete process.env.MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS;
      else process.env.MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS = prev;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Exactly one query embedding per prompt (real pipeline, stubbed HTTP) -

function tmpMemoryDirFromFixtures(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-blend-embed-'));
  for (const f of fs.readdirSync(FIXTURES_DIR)) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(dir, f));
  }
  return dir;
}

function deterministicVector(seed: number): number[] {
  const DIMENSIONS = 1536;
  const out = new Array<number>(DIMENSIONS);
  let s = seed || 1;
  for (let i = 0; i < DIMENSIONS; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s / 0x7fffffff;
  }
  return out;
}

interface FetchStub {
  restore: () => void;
  callCount: () => number;
}

function stubFetch(): FetchStub {
  const orig = (globalThis as { fetch?: typeof fetch }).fetch;
  let calls = 0;
  let nextSeed = 1;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { body?: string },
  ) => {
    calls++;
    const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
    const data = body.input.map((_text, idx) => ({
      embedding: deterministicVector(nextSeed + idx),
      index: idx,
    }));
    nextSeed += body.input.length;
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
    },
    callCount: () => calls,
  };
}

test('resolveBlended: calls the semantic-search entry point exactly once per prompt (deps call-count, independent of the query cache)', async () => {
  // The real semanticSearch has its own query-embedding cache (see
  // src/embed/indexer.ts), which would mask a double-call at the fetch
  // layer (a second call with the same prompt+model is a cache hit, not a
  // second HTTP request). This test instead counts calls into the deps
  // seam directly, so it catches resolveBlended calling deps.semanticSearch
  // more than once even when the underlying cache would hide the cost.
  const withTopic = fakeMemory('with-topic', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  let calls = 0;
  await resolveBlended(ctx, [withTopic], '/fake/dir', {}, {
    semanticSearch: async (...args: unknown[]) => {
      calls++;
      return fakeSemanticSearch({ 'with-topic': 0.4 })(
        args[0] as string,
        args[1] as Memory[],
        args[2] as string,
        args[3] as number,
      );
    },
  });
  assert.equal(calls, 1, `expected exactly one semanticSearch call, got ${calls}`);
});

test('resolveBlended: exactly one query embedding per prompt when the semantic path is live (real semanticSearch, stubbed HTTP)', async () => {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevModel = process.env.MEMORY_ROUTER_EMBED_MODEL;
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.MEMORY_ROUTER_EMBED_MODEL = 'text-embedding-3-small';
  const fetchStub = stubFetch();
  const dir = tmpMemoryDirFromFixtures();
  try {
    await rebuildIndex(dir); // embeds the corpus — one HTTP call, not the one under test
    const callsBeforeQuery = fetchStub.callCount();

    const memories = loadMemoriesFromDir(dir);
    const ctx: RouterContext = { prompt: 'merge PR 42', memoryDir: dir };
    await resolveBlended(ctx, memories, dir);

    assert.equal(
      fetchStub.callCount() - callsBeforeQuery,
      1,
      'expected exactly one embedding HTTP call for the query prompt',
    );
  } finally {
    fetchStub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    if (prevModel === undefined) delete process.env.MEMORY_ROUTER_EMBED_MODEL;
    else process.env.MEMORY_ROUTER_EMBED_MODEL = prevModel;
  }
});
