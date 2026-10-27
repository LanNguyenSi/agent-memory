// Tests for the optional `status: retired` frontmatter marker on project
// memories (src/gates/confidence.ts isRetiredProject / retiredPenalty, applied
// in resolveBlended in src/router.ts).
//
// What the feature does, in one place: a retired PROJECT memory has
// MEMORY_ROUTER_BLEND_RETIRED_PENALTY subtracted from its raw semantic score
// BEFORE the relevance floor, so it must clear the floor by the penalty's
// margin to stay a semantic hit and ranks that much lower when it does. The
// search is widened by the number of retired memories so a vacated slot is
// backfilled. Topic and keyword candidacy, the degraded topic-only path and
// every non-project type are untouched.
//
// Driven through resolveBlended's deps seam with controlled scores, floor
// pinned to 0.5 like tests/blend.test.ts so the exact-score assertions do not
// depend on the ambient embedding-provider env. Memories use a /nonexistent/
// path, so recency is the full weight (age 0) for every candidate.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { resolveBlended } = require('../src/router');
const { loadMemoriesFromDir } = require('../src/memory/loader');

const FLOOR = 0.5;
const DEFAULT_PENALTY = 0.05;
const TOPIC_BOOST = 0.05;
const RECENCY_WEIGHT = 0.05;
const PROJECT_TYPE_BONUS = 0.5 * 0.03;
const FEEDBACK_TYPE_BONUS = 1 * 0.03;

const NOVOCAB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-retired-novocab-'));
test.after(() => {
  fs.rmSync(NOVOCAB_DIR, { recursive: true, force: true });
});

const ENV_KEYS = [
  'MEMORY_ROUTER_BLEND_MIN_SEMANTIC',
  'MEMORY_ROUTER_BLEND_RETIRED_PENALTY',
  'MEMORY_ROUTER_BLEND_CANDIDATE_K',
  'MEMORY_ROUTER_KEYWORD',
] as const;
const prevEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
test.beforeEach(() => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC = String(FLOOR);
  delete process.env.MEMORY_ROUTER_BLEND_RETIRED_PENALTY;
  delete process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K;
  delete process.env.MEMORY_ROUTER_KEYWORD;
});
test.afterEach(() => {
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
});

function mem(id: string, overrides: Partial<MemoryFrontmatter> = {}): Memory {
  return {
    id,
    path: `/nonexistent/${id}.md`,
    frontmatter: { name: id, description: `desc for ${id}`, type: 'project', ...overrides },
    body: `body for ${id}`,
  };
}

const retired = (id: string, overrides: Partial<MemoryFrontmatter> = {}): Memory =>
  mem(id, { status: 'retired', ...overrides });

// Seam fake that honours k like the real search (top-k by score) and records
// the k it was asked for.
function search(scoresById: Record<string, number>, captured?: { k?: number }) {
  return async (_prompt: string, memories: Memory[], _dir: string, k: number) => {
    if (captured) captured.k = k;
    return memories
      .filter((m) => scoresById[m.id] !== undefined)
      .map((m) => ({ memory: m, score: scoresById[m.id] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  };
}

const NO_TOPIC: RouterContext = {
  prompt: 'an unrelated prompt with no topic keywords at all',
  memoryDir: NOVOCAB_DIR,
};
const TOPIC_CTX: RouterContext = {
  prompt: 'please review and merge this PR',
  memoryDir: NOVOCAB_DIR,
};

const ids = (hits: GateHit[]): string[] => hits.map((h) => h.memory.id);
const byId = (hits: GateHit[], id: string): GateHit => {
  const h = hits.find((x) => x.memory.id === id);
  if (!h) throw new Error(`expected a hit for ${id}, got ${ids(hits).join(', ')}`);
  return h;
};
const near = (actual: number, expected: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, msg ?? `expected ${expected}, got ${actual}`);

// --- per input: no status / retired project / retired non-project ----------

test('retired: a project memory without status is scored exactly as before (no demotion, search not widened)', async () => {
  const captured: { k?: number } = {};
  const hits = await resolveBlended(NO_TOPIC, [mem('plain')], '/fake', {}, {
    semanticSearch: search({ plain: 0.9 }, captured),
  });
  near(hits[0].score, 0.9 + PROJECT_TYPE_BONUS + RECENCY_WEIGHT);
  assert.equal(captured.k, 5, 'no retired memory in the corpus: the default pool width');
});

test('retired: a retired project memory loses exactly the penalty from its score and ranks below a current project memory it used to beat', async () => {
  const r = retired('old-setup');
  const cur = mem('current');
  const hits = await resolveBlended(NO_TOPIC, [r, cur], '/fake', {}, {
    semanticSearch: search({ 'old-setup': 0.9, current: 0.88 }),
  });
  assert.deepEqual(ids(hits), ['current', 'old-setup']);
  near(byId(hits, 'old-setup').score, 0.9 - DEFAULT_PENALTY + PROJECT_TYPE_BONUS + RECENCY_WEIGHT);
  near(byId(hits, 'current').score, 0.88 + PROJECT_TYPE_BONUS + RECENCY_WEIGHT);
});

test('retired: without the marker the same scores keep the older memory first (control for the previous case)', async () => {
  const hits = await resolveBlended(NO_TOPIC, [mem('old-setup'), mem('current')], '/fake', {}, {
    semanticSearch: search({ 'old-setup': 0.9, current: 0.88 }),
  });
  assert.deepEqual(ids(hits), ['old-setup', 'current']);
});

test('retired: a retired feedback memory is NOT demoted (the marker is honoured only for project memories)', async () => {
  const captured: { k?: number } = {};
  const fb = retired('rule', { type: 'feedback' });
  const other = mem('current');
  const hits = await resolveBlended(NO_TOPIC, [fb, other], '/fake', {}, {
    semanticSearch: search({ rule: 0.9, current: 0.88 }, captured),
  });
  near(byId(hits, 'rule').score, 0.9 + FEEDBACK_TYPE_BONUS + RECENCY_WEIGHT);
  assert.equal(ids(hits)[0], 'rule');
  assert.equal(captured.k, 5, 'a retired feedback memory does not widen the search either');
});

test('retired: user and reference memories are not demoted either', async () => {
  for (const type of ['user', 'reference'] as const) {
    const m = retired(`m-${type}`, { type });
    const hits = await resolveBlended(NO_TOPIC, [m], '/fake', {}, {
      semanticSearch: search({ [`m-${type}`]: 0.9 }),
    });
    const bonus = type === 'user' ? 0 : 0.25 * 0.03;
    near(hits[0].score, 0.9 + bonus + RECENCY_WEIGHT, type);
  }
});

// --- the penalty shifts the relevance floor --------------------------------

test('retired: a weak match (above the floor, below floor + penalty) drops out; the same score survives on a current memory', async () => {
  const weak = 0.52; // floor 0.5 + penalty 0.05 = 0.55
  const strong = mem('strong');
  const withMarker = await resolveBlended(NO_TOPIC, [retired('old-setup'), strong], '/fake', {}, {
    semanticSearch: search({ 'old-setup': weak, strong: 0.9 }),
  });
  assert.deepEqual(ids(withMarker), ['strong']);

  const without = await resolveBlended(NO_TOPIC, [mem('old-setup'), strong], '/fake', {}, {
    semanticSearch: search({ 'old-setup': weak, strong: 0.9 }),
  });
  assert.deepEqual(ids(without), ['strong', 'old-setup']);
});

test('retired: a strong match (clears floor + penalty) stays in the result, demoted', async () => {
  const hits = await resolveBlended(NO_TOPIC, [retired('old-setup'), mem('other')], '/fake', {}, {
    semanticSearch: search({ 'old-setup': 0.56, other: 0.9 }),
  });
  assert.deepEqual(ids(hits), ['other', 'old-setup']);
  near(byId(hits, 'old-setup').score, 0.56 - DEFAULT_PENALTY + PROJECT_TYPE_BONUS + RECENCY_WEIGHT);
});

test('retired: a result made only of demoted-away retired hits degrades to the topic-only path like any other empty semantic result', async () => {
  const hits = await resolveBlended(NO_TOPIC, [retired('old-setup')], '/fake', {}, {
    semanticSearch: search({ 'old-setup': 0.52 }),
  });
  assert.deepEqual(hits, []);
});

// --- the search is widened so a vacated slot is backfilled -----------------

test('retired: with a retired project memory in the corpus the search asks for one extra candidate per retired memory', async () => {
  const captured: { k?: number } = {};
  await resolveBlended(NO_TOPIC, [retired('a'), retired('b'), mem('c')], '/fake', {}, {
    semanticSearch: search({ a: 0.9, b: 0.9, c: 0.9 }, captured),
  });
  assert.equal(captured.k, 7, 'default pool 5 + 2 retired memories');
});

test('retired: a demoted memory frees its slot for the next candidate, and the final pool is cut back to the normal width', async () => {
  const corpus = [
    retired('old-setup'),
    mem('a'),
    mem('b'),
    mem('c'),
    mem('d'),
    mem('e'),
  ];
  const scores = { 'old-setup': 0.89, a: 0.9, b: 0.88, c: 0.87, d: 0.86, e: 0.85 };
  const hits = await resolveBlended(NO_TOPIC, corpus, '/fake', {}, {
    semanticSearch: search(scores),
  });
  assert.deepEqual(ids(hits), ['a', 'b', 'c', 'd', 'e'], 'e backfills the slot the demoted memory left');

  // Control: the same scores with no marker keep the old memory and leave e out.
  const control = await resolveBlended(NO_TOPIC, corpus.map((m) => mem(m.id)), '/fake', {}, {
    semanticSearch: search(scores),
  });
  assert.deepEqual(ids(control), ['a', 'old-setup', 'b', 'c', 'd']);
});

test('retired: the widened result is cut back to the normal pool width, so a candidate beyond it is not rescued by a topic boost', async () => {
  const topics = ['workflow'] as MemoryFrontmatter['topics'];
  const corpus = [
    retired('old-setup'),
    mem('a'),
    mem('b'),
    mem('c'),
    mem('d'),
    mem('e', { topics }),
  ];
  // Search order is old-setup, a, b, c, d, e; after the demotion old-setup
  // (0.95 -> 0.90) sits between b and c and e is the sixth candidate. e has a
  // topic match: if it stayed in the pool, 0.885 + the 0.05 boost would put it
  // first. At the normal pool width of 5 it is out of the semantic pool.
  const hits = await resolveBlended(TOPIC_CTX, corpus, '/fake', {}, {
    semanticSearch: search({ 'old-setup': 0.95, a: 0.91, b: 0.905, c: 0.895, d: 0.89, e: 0.885 }),
  });
  assert.deepEqual(ids(hits), ['a', 'b', 'old-setup', 'c', 'd']);
});

// --- retired + topic match: what wins ---------------------------------------

test('retired + topic match: the topic boost is added on top of the demoted score (penalty and boost cancel at the defaults), the topic match alone keeps a weak retired memory a topic-only candidate', async () => {
  const topics = ['workflow'] as MemoryFrontmatter['topics'];
  const rt = retired('old-setup', { topics });
  const plain = mem('plain');

  // Strong semantic match: demoted score + topic boost.
  const strong = await resolveBlended(TOPIC_CTX, [rt, plain], '/fake', {}, {
    semanticSearch: search({ 'old-setup': 0.9, plain: 0.88 }),
  });
  near(
    byId(strong, 'old-setup').score,
    0.9 - DEFAULT_PENALTY + TOPIC_BOOST + PROJECT_TYPE_BONUS + RECENCY_WEIGHT,
  );
  assert.deepEqual(ids(strong), ['old-setup', 'plain'], 'with the boost the retired memory still beats a 0.88 neighbour (0.90 vs 0.88)');

  // A clearly better current memory still wins: the penalty is not cancelled by the topic match.
  const beaten = await resolveBlended(TOPIC_CTX, [rt, plain], '/fake', {}, {
    semanticSearch: search({ 'old-setup': 0.9, plain: 0.95 }),
  });
  assert.deepEqual(ids(beaten), ['plain', 'old-setup']);

  // Weak semantic match: the semantic part is gone, the topic match remains.
  const weak = await resolveBlended(TOPIC_CTX, [rt, plain], '/fake', {}, {
    semanticSearch: search({ 'old-setup': 0.52, plain: 0.9 }),
  });
  assert.deepEqual(ids(weak), ['plain', 'old-setup']);
  const topicOnly = byId(weak, 'old-setup');
  assert.equal(topicOnly.gate, 'topic');
  near(topicOnly.score, TOPIC_BOOST + PROJECT_TYPE_BONUS + RECENCY_WEIGHT);
});

// --- the penalty env: each input on its own ---------------------------------

const STRONG_RETIRED = 0.9;

async function retiredScoreWithEnv(value: string | undefined): Promise<{ score: number; k: number | undefined; present: boolean }> {
  if (value === undefined) delete process.env.MEMORY_ROUTER_BLEND_RETIRED_PENALTY;
  else process.env.MEMORY_ROUTER_BLEND_RETIRED_PENALTY = value;
  const captured: { k?: number } = {};
  const hits = await resolveBlended(NO_TOPIC, [retired('old-setup'), mem('other')], '/fake', {}, {
    semanticSearch: search({ 'old-setup': STRONG_RETIRED, other: 0.6 }, captured),
  });
  const h = hits.find((x: GateHit) => x.memory.id === 'old-setup');
  return { score: h ? h.score : NaN, k: captured.k, present: Boolean(h) };
}
const base = STRONG_RETIRED + PROJECT_TYPE_BONUS + RECENCY_WEIGHT;

test('retired penalty env: unset uses the default 0.05', async () => {
  const r = await retiredScoreWithEnv(undefined);
  near(r.score, base - DEFAULT_PENALTY);
});

test('retired penalty env: a valid value wins over the default', async () => {
  const r = await retiredScoreWithEnv('0.2');
  near(r.score, base - 0.2);
});

test('retired penalty env: 0 switches the demotion off (score untouched, search not widened)', async () => {
  const r = await retiredScoreWithEnv('0');
  near(r.score, base);
  assert.equal(r.k, 5);
});

test('retired penalty env: a value above the largest cosine removes retired memories from the semantic path', async () => {
  const r = await retiredScoreWithEnv('2');
  assert.equal(r.present, false);
});

test('retired penalty env: empty string counts as unset (default), not as 0', async () => {
  const r = await retiredScoreWithEnv('');
  near(r.score, base - DEFAULT_PENALTY);
});

test('retired penalty env: whitespace only counts as unset (default)', async () => {
  const r = await retiredScoreWithEnv('   ');
  near(r.score, base - DEFAULT_PENALTY);
});

test('retired penalty env: a non-numeric value falls back to the default', async () => {
  const r = await retiredScoreWithEnv('abc');
  near(r.score, base - DEFAULT_PENALTY);
});

test('retired penalty env: a negative value falls back to the default (a negative penalty would boost retired memories)', async () => {
  const r = await retiredScoreWithEnv('-0.3');
  near(r.score, base - DEFAULT_PENALTY);
});

// --- paths the penalty deliberately does not touch --------------------------

test('retired: the degraded topic-only path (no semantic hit at all) is unchanged, a topic-matching retired memory is still returned', async () => {
  const rt = retired('old-setup', { topics: ['workflow'] as MemoryFrontmatter['topics'] });
  const hits = await resolveBlended(TOPIC_CTX, [rt], '/fake', {}, {
    semanticSearch: search({}),
  });
  assert.deepEqual(ids(hits), ['old-setup']);
  assert.equal(hits[0].score, 1.0, 'flat pre-blend topic score, no penalty');
});

test('retired: an id-token keyword admission is not demoted (typing the exact id of a retired memory still finds it)', async () => {
  const r = retired('old-setup');
  const other = mem('other');
  const hits = await resolveBlended(NO_TOPIC, [r, other], '/fake', {}, {
    semanticSearch: async (_p: string, memories: Memory[]) => ({
      semantic: [{ memory: memories[1], score: 0.9 }],
      keyword: [{ memory: memories[0], idTerms: ['4e7729ab'], bm25: -2 }],
    }),
  });
  const kw = byId(hits, 'old-setup');
  assert.equal(kw.gate, 'keyword');
  near(kw.score, FLOOR + 0.01 + PROJECT_TYPE_BONUS + RECENCY_WEIGHT);
});

// --- end to end through the real loader -------------------------------------

test('retired: memory files marked with status: retired (top-level or metadata) are demoted through loadMemoriesFromDir; a file without frontmatter is simply skipped', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-retired-'));
  const write = (name: string, fm: string) =>
    fs.writeFileSync(path.join(tmp, `${name}.md`), `---\n${fm}---\nbody ${name}\n`);
  write('top', 'name: top\ndescription: d\ntype: project\nstatus: retired\n');
  write('nested', 'name: nested\ndescription: d\nmetadata:\n  type: project\n  status: retired\n');
  write('current', 'name: current\ndescription: d\ntype: project\n');
  fs.writeFileSync(path.join(tmp, 'nofm.md'), '# no frontmatter at all\n');
  try {
    const memories = loadMemoriesFromDir(tmp);
    assert.deepEqual(memories.map((m: Memory) => m.id).sort(), ['current', 'nested', 'top']);
    const hits = await resolveBlended(NO_TOPIC, memories, tmp, {}, {
      semanticSearch: search({ top: 0.9, nested: 0.89, current: 0.7 }),
    });
    // 0.9 and 0.89 each lose 0.05 (0.85, 0.84); current stays at 0.7 and so ranks last but is present.
    assert.deepEqual(ids(hits), ['top', 'nested', 'current']);
    // Real files: mtime is a few ms old, so recency is the full weight up to rounding.
    assert.ok(
      Math.abs(byId(hits, 'top').score - (0.9 - DEFAULT_PENALTY + PROJECT_TYPE_BONUS + RECENCY_WEIGHT)) < 1e-6,
    );
    assert.ok(
      Math.abs(byId(hits, 'current').score - (0.7 + PROJECT_TYPE_BONUS + RECENCY_WEIGHT)) < 1e-6,
      'the unmarked file keeps its full score',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
