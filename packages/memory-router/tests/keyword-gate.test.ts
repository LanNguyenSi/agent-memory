// Router-level tests for the keyword gate in resolveBlended
// (src/router.ts): every input combination of the admission table gets its
// own test, driven through the deps seam with a controlled
// { semantic, keyword } search outcome (the shape blendedSearch returns).
// The search layer delivers ONLY id-token candidates (the id rule and the
// df cap are pinned against a real index in tests/keyword-index.test.ts,
// where "not admitted" cases are proven by an EMPTY candidate list); what
// this file pins is what the router does with the candidates it gets:
// admit up to the cap, boost above-floor semantic matches, degrade, and
// obey the off switch.
//
// Floor pinned to 0.5 for the whole file exactly like tests/blend.test.ts
// does, so exact score assertions are independent of the ambient embedding
// provider env.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { resolveBlended, resolve } = require('../src/router');

const DEFAULT_TOPIC_BOOST = 0.05;
const DEFAULT_RECENCY_WEIGHT = 0.05;
const DEFAULT_TYPE_WEIGHT = 0.03;
const TYPE_MODIFIER_UNITS: Record<string, number> = {
  feedback: 1,
  project: 0.5,
  reference: 0.25,
  user: 0,
};
const FLOOR = 0.5;
const ADMISSION_OFFSET = 0.01;
const DEFAULT_KEYWORD_BOOST = 0.02;

const NOVOCAB_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'memory-router-keyword-novocab-'),
);
test.after(() => {
  fs.rmSync(NOVOCAB_DIR, { recursive: true, force: true });
});

let prevMinSemantic: string | undefined;
let prevOff: string | undefined;
let prevBoost: string | undefined;
test.beforeEach(() => {
  prevMinSemantic = process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
  process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC = String(FLOOR);
  prevOff = process.env.MEMORY_ROUTER_KEYWORD;
  delete process.env.MEMORY_ROUTER_KEYWORD;
  prevBoost = process.env.MEMORY_ROUTER_KEYWORD_BOOST;
  delete process.env.MEMORY_ROUTER_KEYWORD_BOOST;
});
test.afterEach(() => {
  if (prevMinSemantic === undefined) delete process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
  else process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC = prevMinSemantic;
  if (prevOff === undefined) delete process.env.MEMORY_ROUTER_KEYWORD;
  else process.env.MEMORY_ROUTER_KEYWORD = prevOff;
  if (prevBoost === undefined) delete process.env.MEMORY_ROUTER_KEYWORD_BOOST;
  else process.env.MEMORY_ROUTER_KEYWORD_BOOST = prevBoost;
});

function fakeMemory(id: string, overrides: Partial<MemoryFrontmatter> = {}): Memory {
  return {
    id,
    path: `/nonexistent/${id}.md`,
    frontmatter: { name: id, description: `desc for ${id}`, type: 'feedback', ...overrides },
    body: `body for ${id}`,
  };
}

// Deps-seam fake returning the TWO-CHANNEL shape: semantic scores verbatim
// from the map, keyword candidates verbatim from the array (the search
// layer delivers them best-bm25-first; the fake preserves the order).
function fakeSearch(
  scoresById: Record<string, number>,
  keyword: Array<{
    id: string;
    idTerms: string[];
    bm25?: number;
  }> = [],
): (
  prompt: string,
  memories: Memory[],
  memoryDir: string,
  k: number,
) => Promise<{
  semantic: { memory: Memory; score: number }[];
  keyword: {
    memory: Memory;
    idTerms: string[];
    bm25: number;
  }[];
}> {
  return async (_prompt: string, memories: Memory[]) => ({
    semantic: memories
      .filter((m) => scoresById[m.id] !== undefined)
      .map((m) => ({ memory: m, score: scoresById[m.id] })),
    keyword: keyword.map((c) => ({
      memory: memories.find((m) => m.id === c.id)!,
      idTerms: c.idTerms,
      bm25: c.bm25 ?? -1,
    })),
  });
}

// Exact expected blend score for a /nonexistent/ path (stat fails → age 0 →
// full recency weight), feedback type, no topic match.
function expectedScore(semanticScore: number, keywordBoost = 0): number {
  return (
    semanticScore +
    keywordBoost +
    TYPE_MODIFIER_UNITS.feedback * DEFAULT_TYPE_WEIGHT +
    1 * DEFAULT_RECENCY_WEIGHT
  );
}

const NO_TOPIC_PROMPT = 'an unrelated prompt with no topic keywords at all';

// --- Admission combinations -------------------------------------------------

test('keyword gate: id match only (no semantic hit at all) admits the memory at floor+0.01 with the id reason and gate=keyword', async () => {
  const mem = fakeMemory('task-memory');
  const ctx: RouterContext = { prompt: 'what is 4e7729ab about', memoryDir: NOVOCAB_DIR };
  const hits = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
    semanticSearch: fakeSearch({}, [
      { id: 'task-memory', idTerms: ['4e7729ab'], bm25: -3 },
    ]),
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].memory.id, 'task-memory');
  assert.equal(hits[0].gate, 'keyword');
  assert.equal(hits[0].reason, 'keyword match (id: 4e7729ab)');
  assert.equal(
    hits[0].score,
    expectedScore(FLOOR + ADMISSION_OFFSET),
    'an admitted keyword-only memory scores at the relevance floor + 0.01 plus the usual modifiers',
  );
});

test('keyword gate: 3+ id-only candidates are capped at 2 admissions, best bm25 first', async () => {
  const m1 = fakeMemory('kw-1');
  const m2 = fakeMemory('kw-2');
  const m3 = fakeMemory('kw-3');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  // bm25 ascending = search-layer order (best first): kw-1 wins, kw-3 loses.
  const hits = await resolveBlended(ctx, [m1, m2, m3], '/fake/dir', {}, {
    semanticSearch: fakeSearch(
      {},
      [
        { id: 'kw-1', idTerms: ['aaa111'], bm25: -9 },
        { id: 'kw-2', idTerms: ['aaa222'], bm25: -5 },
        { id: 'kw-3', idTerms: ['aaa333'], bm25: -1 },
      ],
    ),
  });
  assert.equal(hits.length, 2, 'keywordMaxHits = 2 keyword-only admissions per prompt');
  assert.deepEqual(
    hits.map((h: GateHit) => h.memory.id).sort(),
    ['kw-1', 'kw-2'],
    'the two best-bm25 candidates win',
  );
});

test('keyword gate: semantic hit above the floor plus an id match gets exactly + keywordBoost and keeps gate=confidence', async () => {
  const mem = fakeMemory('strong-semantic');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const hits = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
    semanticSearch: fakeSearch({ 'strong-semantic': 0.9 }, [
      { id: 'strong-semantic', idTerms: ['4e7729ab'] },
    ]),
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].gate, 'confidence', 'a boosted above-floor hit stays a confidence hit');
  assert.equal(
    hits[0].score,
    expectedScore(0.9, DEFAULT_KEYWORD_BOOST),
    'expected 0.9 + the default 0.02 keyword boost + modifiers',
  );
  assert.match(hits[0].reason, /semantic match \(score=0\.90\)/);
  assert.match(hits[0].reason, /keyword match \(id: 4e7729ab\)/);
});

test('keyword gate: semantic hit without any keyword match keeps its exact unboosted score (control for the boost test)', async () => {
  const mem = fakeMemory('plain-semantic');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const hits = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
    semanticSearch: fakeSearch({ 'plain-semantic': 0.9 }),
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].gate, 'confidence');
  assert.equal(hits[0].score, expectedScore(0.9));
  assert.equal(hits[0].reason, 'semantic match (score=0.90)');
});

test('keyword gate: a keyword candidate that already has an above-floor semantic hit is not admitted as keyword-only (no double count, no floor-edge downgrade)', async () => {
  const mem = fakeMemory('already-semantic');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const hits = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
    semanticSearch: fakeSearch({ 'already-semantic': 0.9 }, [
      { id: 'already-semantic', idTerms: ['4e7729ab'] },
    ]),
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].gate, 'confidence', 'the memory keeps its semantic attribution');
  assert.equal(
    hits[0].score,
    expectedScore(0.9, DEFAULT_KEYWORD_BOOST),
    'it takes the boost, never the floor+0.01 admission score',
  );
});

// --- Boost scope (only above-floor semantic hits boost) --------------------

test('keyword gate: an id match on a TOPIC-ONLY candidate beyond the 2-admission cap is never boosted and adds no keyword reason (only above-floor semantic hits boost)', async () => {
  // 3 id-only candidates (kw-1, kw-2, kw-3) plus one above-floor semantic hit
  // that also id-matches. kw-3 is the third id candidate: it falls past the
  // KEYWORD_MAX_HITS=2 cap, so it is NOT admitted; it also matches the topic
  // gate, so it is a topic-only candidate. Per spec ONLY the above-floor
  // semantic hit (strong-semantic) is boosted; kw-3 keeps its plain topic
  // score and a keyword-free reason.
  const kw1 = fakeMemory('kw-1');
  const kw2 = fakeMemory('kw-2');
  const kw3 = fakeMemory('kw-3', { topics: ['workflow'] });
  const strong = fakeMemory('strong-semantic');
  const memories = [kw1, kw2, kw3, strong];
  // Topic-bearing prompt so kw-3 is a topic hit; NO_TOPIC_PROMPT has none.
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const idCandidates = [
    { id: 'strong-semantic', idTerms: ['4e7729ab'] },
    { id: 'kw-1', idTerms: ['aaa111'], bm25: -9 },
    { id: 'kw-2', idTerms: ['aaa222'], bm25: -5 },
    { id: 'kw-3', idTerms: ['aaa333'], bm25: -1 },
  ];
  const hits = await resolveBlended(ctx, memories, '/fake/dir', {}, {
    semanticSearch: fakeSearch({ 'strong-semantic': 0.9 }, idCandidates),
  });
  const byId = new Map(hits.map((h: GateHit) => [h.memory.id, h]));

  const boosted = byId.get('strong-semantic') as GateHit;
  assert.equal(boosted.gate, 'confidence', 'the above-floor semantic hit keeps confidence');
  assert.equal(
    boosted.score,
    expectedScore(0.9, DEFAULT_KEYWORD_BOOST),
    'the semantic hit that id-matches is boosted exactly by keywordBoost',
  );
  assert.match(boosted.reason, /keyword match \(id: 4e7729ab\)/);

  const kw3Hit = byId.get('kw-3') as GateHit;
  assert.ok(kw3Hit, 'kw-3 is present as a topic-only candidate');
  assert.equal(kw3Hit.gate, 'topic', 'the capped id candidate is a plain topic hit, not keyword');
  assert.ok(
    !kw3Hit.reason.includes('keyword'),
    `a capped topic-only candidate carries no keyword reason, got: ${kw3Hit.reason}`,
  );

  // Control: identical run with kw-3 carrying NO id match. Its score is the
  // unboosted topic-only score; the boost guard must make the two equal.
  const control = await resolveBlended(ctx, memories, '/fake/dir', {}, {
    semanticSearch: fakeSearch({ 'strong-semantic': 0.9 }, [
      { id: 'strong-semantic', idTerms: ['4e7729ab'] },
      { id: 'kw-1', idTerms: ['aaa111'], bm25: -9 },
      { id: 'kw-2', idTerms: ['aaa222'], bm25: -5 },
    ]),
  });
  const controlKw3 = control.find((h: GateHit) => h.memory.id === 'kw-3') as GateHit;
  assert.ok(controlKw3, 'kw-3 still appears via the topic gate in the control run');
  assert.equal(
    kw3Hit.score,
    controlKw3.score,
    'kw-3 scores exactly the unboosted topic score (the +keywordBoost never reaches a non-semantic candidate)',
  );
});

// --- Degraded path ---------------------------------------------------------

test('degraded path with keyword admissions: keyword hits take the first slots, the rest is exactly resolve() output deduplicated', async () => {
  const topicMem = fakeMemory('topic-mem', { topics: ['workflow'] });
  const bothMem = fakeMemory('both-mem', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const hits = await resolveBlended(ctx, [topicMem, bothMem], '/fake/dir', {}, {
    semanticSearch: fakeSearch({}, [
      { id: 'both-mem', idTerms: ['b11905'] },
    ]),
  });
  const degraded = resolve(ctx, [topicMem, bothMem], { maxHits: 5 });
  assert.ok(
    degraded.some((h: GateHit) => h.memory.id === 'both-mem'),
    'fixture sanity: the keyword memory also matches the topic gate, so it appears in the degraded output too',
  );
  assert.equal(hits[0].memory.id, 'both-mem');
  assert.equal(hits[0].gate, 'keyword');
  // Topic boost folds into the keyword hit's score (modifiers "as usual").
  assert.equal(
    hits[0].score,
    expectedScore(FLOOR + ADMISSION_OFFSET) + DEFAULT_TOPIC_BOOST,
  );
  const rest = hits.slice(1);
  const expectedRest = degraded.filter((h: GateHit) => h.memory.id !== 'both-mem');
  assert.deepEqual(rest, expectedRest, 'remaining slots are exactly today topic-only degraded output, minus the already-taken memory');
  assert.equal(rest.length + 1, hits.length);
});

test('degraded path without keyword admissions: byte-identical to resolve() (unchanged degraded behaviour)', async () => {
  const topicMem = fakeMemory('topic-mem', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const hits = await resolveBlended(ctx, [topicMem], '/fake/dir', {}, {
    semanticSearch: fakeSearch({}, []),
  });
  assert.deepEqual(hits, resolve(ctx, [topicMem], { maxHits: 5 }));
  assert.equal(hits[0].gate, 'topic');
  assert.equal(hits[0].score, 1.0);
});

// --- Off switch (router half; the hook-level byte-identity lives in
// tests/keyword-hook.test.ts) ----------------------------------------------

test('off switch: MEMORY_ROUTER_KEYWORD=off makes the router ignore delivered keyword candidates (degraded and active blend alike)', async () => {
  const topicMem = fakeMemory('topic-mem', { topics: ['workflow'] });
  const strongMem = fakeMemory('strong-mem');
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR 4e7729ab',
    memoryDir: NOVOCAB_DIR,
  };
  const candidates = [{ id: 'strong-mem', idTerms: ['4e7729ab'] }];
  const on = await resolveBlended(ctx, [topicMem, strongMem], '/fake/dir', {}, {
    semanticSearch: fakeSearch({}, candidates),
  });
  process.env.MEMORY_ROUTER_KEYWORD = 'off';
  const off = await resolveBlended(ctx, [topicMem, strongMem], '/fake/dir', {}, {
    semanticSearch: fakeSearch({}, candidates),
  });
  assert.deepEqual(
    off,
    resolve(ctx, [topicMem, strongMem], { maxHits: 5 }),
    'with the switch off the degraded path must be byte-identical to the pre-keyword resolver',
  );
  assert.notDeepEqual(off, on, 'sanity: the very same candidates DO change the result when the path is on');
});

test('off switch: with an active blend, an id match boosts when on and never when off', async () => {
  const mem = fakeMemory('strong-semantic');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const candidates = [{ id: 'strong-semantic', idTerms: ['4e7729ab'] }];
  const on = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
    semanticSearch: fakeSearch({ 'strong-semantic': 0.9 }, candidates),
  });
  process.env.MEMORY_ROUTER_KEYWORD = 'off';
  const off = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
    semanticSearch: fakeSearch({ 'strong-semantic': 0.9 }, candidates),
  });
  assert.equal(on[0].score, expectedScore(0.9, DEFAULT_KEYWORD_BOOST));
  assert.deepEqual(off[0], {
    memory: mem,
    gate: 'confidence',
    score: expectedScore(0.9),
    reason: 'semantic match (score=0.90)',
  });
});

// --- Empty / stopword-only prompts -----------------------------------------

test('empty prompt: resolveBlended returns [] without consulting the search layer at all', async () => {
  let called = false;
  const hits = await resolveBlended({}, [fakeMemory('a')], '/fake/dir', {}, {
    semanticSearch: async () => {
      called = true;
      return { semantic: [], keyword: [] };
    },
  });
  assert.deepEqual(hits, []);
  assert.equal(called, false);
});

test('stopword/punctuation-only prompt: a search layer that yields no keyword terms degrades to the plain topic-only path', async () => {
  const topicMem = fakeMemory('topic-mem', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const hits = await resolveBlended(ctx, [topicMem], '/fake/dir', {}, {
    semanticSearch: fakeSearch({}, []),
  });
  assert.deepEqual(hits, resolve(ctx, [topicMem], { maxHits: 5 }));
});

// --- Env overrides through the router (boost) -------------------------------

function withEnv(name: string, value: string | undefined, fn: () => Promise<void>) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

test('env override: MEMORY_ROUTER_KEYWORD_BOOST unset boosts by exactly the 0.02 default', async () => {
  const mem = fakeMemory('strong-semantic');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const candidates = [{ id: 'strong-semantic', idTerms: ['4e7729ab'] }];
  await withEnv('MEMORY_ROUTER_KEYWORD_BOOST', undefined, async () => {
    const hits = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
      semanticSearch: fakeSearch({ 'strong-semantic': 0.9 }, candidates),
    });
    assert.equal(hits[0].score, expectedScore(0.9, DEFAULT_KEYWORD_BOOST));
  });
});

test('env override: MEMORY_ROUTER_KEYWORD_BOOST=0.1 set changes the boost to exactly 0.1; invalid falls back to 0.02', async () => {
  const mem = fakeMemory('strong-semantic');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const candidates = [{ id: 'strong-semantic', idTerms: ['4e7729ab'] }];
  await withEnv('MEMORY_ROUTER_KEYWORD_BOOST', '0.1', async () => {
    const hits = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
      semanticSearch: fakeSearch({ 'strong-semantic': 0.9 }, candidates),
    });
    assert.equal(hits[0].score, expectedScore(0.9, 0.1));
  });
  await withEnv('MEMORY_ROUTER_KEYWORD_BOOST', '-3', async () => {
    const hits = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
      semanticSearch: fakeSearch({ 'strong-semantic': 0.9 }, candidates),
    });
    assert.equal(
      hits[0].score,
      expectedScore(0.9, DEFAULT_KEYWORD_BOOST),
      'a negative boost override must fall back to the built-in 0.02 default',
    );
  });
});
