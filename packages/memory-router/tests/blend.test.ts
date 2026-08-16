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

// Independent copies of src/gates/confidence.ts's BLEND_DEFAULTS and
// TYPE_MODIFIER_UNITS, hardcoded here rather than imported/called, so the
// "exact expected score" assertions below (mm-v1-T004 fix-round 2, MEDIUM
// #3) actually catch a regression in those source constants instead of
// silently agreeing with a broken value (calling typeModifier/recencyModifier
// to compute "expected" would make the assertion circular: a bug that zeros
// out a weight would zero both sides identically). Keep these in sync with
// src/gates/confidence.ts by hand.
const DEFAULT_TOPIC_BOOST = 0.05;
const DEFAULT_RECENCY_WEIGHT = 0.05;
const DEFAULT_RECENCY_HALFLIFE_DAYS = 30;
const DEFAULT_TYPE_WEIGHT = 0.03;
const TYPE_MODIFIER_UNITS: Record<string, number> = {
  feedback: 1,
  project: 0.5,
  reference: 0.25,
  user: 0,
};

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

// minSemanticScore's un-overridden default is now model/provider
// CONDITIONAL (src/gates/confidence.ts's resolveDefaultMinSemanticScore),
// not a flat 0.5 — it depends on the ambient embedding-provider env
// (OPENAI_API_KEY, MEMORY_ROUTER_EMBED_PROVIDER,
// MEMORY_ROUTER_OLLAMA_EMBED_MODEL) at test-run time, which this suite
// does not control and which differs between a machine with a local Ollama
// daemon and CI. Every test below predates that feature and pins concrete
// floor-relative scores (0.5, 0.52, 0.6, 0.9, ...) against the OLD flat 0.5
// default; without this pin, a runner with no OPENAI_API_KEY auto-detects
// Ollama and resolves a 0.78 default instead, silently dropping most of
// those scores before the blend and breaking dozens of unrelated
// assertions. Pinning MEMORY_ROUTER_BLEND_MIN_SEMANTIC=0.5 for the whole
// file keeps those numbers meaningful (this suite is about topic/recency/
// type blend behavior, not about the floor-resolution feature itself) —
// it now exercises the "explicit override always wins" path rather than a
// literal default; the conditional-default RESOLUTION itself is pinned
// separately in tests/confidence.test.ts. Tests below that manage
// MEMORY_ROUTER_BLEND_MIN_SEMANTIC themselves (search this file) save and
// restore relative to whatever this hook set, so they compose correctly.
let prevMinSemanticScore: string | undefined;
test.beforeEach(() => {
  prevMinSemanticScore = process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
  process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC = '0.5';
});
test.afterEach(() => {
  if (prevMinSemanticScore === undefined) {
    delete process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
  } else {
    process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC = prevMinSemanticScore;
  }
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

// Like fakeSemanticSearch, but honors the k argument the way the real
// semanticSearch does (top-k by score). The candidate-pool tests MUST use
// this variant: a stub that ignores k makes the pool effectively infinite
// and would keep a pool-width assertion green no matter what candidateK
// resolves to.
function fakeSemanticSearchHonoringK(
  scoresById: Record<string, number>,
  capturedK?: { value?: number },
): (
  prompt: string,
  memories: Memory[],
  memoryDir: string,
  k: number,
) => Promise<{ memory: Memory; score: number }[]> {
  return async (_prompt: string, memories: Memory[], _dir: string, k: number) => {
    if (capturedK) capturedK.value = k;
    return memories
      .filter((m) => scoresById[m.id] !== undefined)
      .map((m) => ({ memory: m, score: scoresById[m.id] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  };
}

const NO_TOPIC_PROMPT = 'an unrelated prompt with no topic keywords at all';

// --- Ranking: semantic dominates, topic boosts, recency breaks ties -------

test('resolveBlended: semantic score dominates the ranking when topic/recency/type are equal', async () => {
  const a = fakeMemory('a');
  const b = fakeMemory('b');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  // Both scores must clear the fix-round-2 relevance floor (default 0.5,
  // MEMORY_ROUTER_BLEND_MIN_SEMANTIC) or the weaker one is dropped before
  // the blend even runs — this test is about dominance ranking, not the
  // floor, so both stay comfortably above it.
  const hits = await resolveBlended(ctx, [a, b], '/fake/dir', {}, {
    semanticSearch: fakeSemanticSearch({ a: 0.9, b: 0.6 }),
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
  // Both scores above the fix-round-2 relevance floor (default 0.5) so the
  // blend stays active for both memories; this test is about the topic
  // boost, not the floor.
  const hits = await resolveBlended(ctx, [withTopic, withoutTopic], '/fake/dir', {}, {
    semanticSearch: fakeSemanticSearch({ 'with-topic': 0.6, 'without-topic': 0.6 }),
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

test("resolveBlended: type modifier nudges a tie (feedback outranks reference at equal semantic score, no topic, equal mtime) — exact score gap, insertion order reversed (mm-v1-T004 fix-round 2 MEDIUM #3d)", async () => {
  // The original version of this test always passed `[feedbackMem,
  // referenceMem]` (feedback first) into resolveBlended. If typeModifier
  // were completely broken (e.g. always returned 0), the two scores would
  // TIE, and Array.prototype.sort's ES2019 stability guarantee would
  // preserve that insertion order — feedback-mem would still land first,
  // and `assert.equal(hits[0].memory.id, 'feedback-mem')` would still pass
  // even though the type modifier did nothing. Passing reference-mem FIRST
  // here closes that hole: a broken/zeroed type modifier would now leave
  // reference-mem in front (stable-sort tie), turning this assertion red.
  // The exact score-gap assertion below closes it independently of
  // insertion order or sort behavior altogether.
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
    const hits = await resolveBlended(ctx, [referenceMem, feedbackMem], '/fake/dir', {}, {
      semanticSearch: fakeSemanticSearch({ 'feedback-mem': 0.5, 'reference-mem': 0.5 }),
    });
    assert.equal(hits[0].memory.id, 'feedback-mem');
    assert.equal(hits[1].memory.id, 'reference-mem');

    // Independent (not derived by calling typeModifier) expected gap: both
    // memories share the same semantic score, no topic, and age-0 mtime, so
    // the ENTIRE score difference must be exactly the type-modifier delta:
    // (feedback units - reference units) * typeWeight.
    const expectedDelta =
      (TYPE_MODIFIER_UNITS.feedback - TYPE_MODIFIER_UNITS.reference) * DEFAULT_TYPE_WEIGHT;
    const actualDelta = hits[0].score - hits[1].score;
    assert.ok(
      Math.abs(actualDelta - expectedDelta) < 1e-9,
      `expected the score gap to be exactly the type-modifier difference (${expectedDelta}), got ${actualDelta}`,
    );
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

test('resolveBlended: with a widened candidate pool (MEMORY_ROUTER_BLEND_CANDIDATE_K > maxHits, opt-in since mm-v1-T008) a memory ranked below maxHits on raw semantic score still wins a slot via topic boost', async () => {
  // 6 semantic candidates, strictly decreasing raw score, all above the
  // default floor (0.5). m5 ranks 6th by raw semantic score alone (outside
  // the raw top-maxHits=5) but carries a topic match: with the pool widened
  // to 10 its blended score (semantic + topicBoost + modifiers) outranks
  // m4's un-boosted score. Uses the k-HONORING stub: with the pool at the
  // calibrated default (5 == cap) m5 would never even enter the blend, so
  // this rescue is exercised as the env opt-in it now is (see the
  // defaults-pin test below for the default behavior).
  const maxHits = 5;
  const m0 = fakeMemory('m0');
  const m1 = fakeMemory('m1');
  const m2 = fakeMemory('m2');
  const m3 = fakeMemory('m3');
  const m4 = fakeMemory('m4');
  const m5 = fakeMemory('m5', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const prevK = process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K;
  process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K = '10';
  try {
    const hits = await resolveBlended(
      ctx,
      [m0, m1, m2, m3, m4, m5],
      '/fake/dir',
      { maxHits },
      {
        semanticSearch: fakeSemanticSearchHonoringK({
          m0: 0.9,
          m1: 0.8,
          m2: 0.7,
          m3: 0.6,
          m4: 0.55,
          m5: 0.52,
        }),
      },
    );
    assert.equal(hits.length, maxHits);
    assert.ok(
      hits.some((h: GateHit) => h.memory.id === 'm5'),
      `expected the raw-rank-6 memory (m5) to win a slot via its topic boost with the widened pool, got ids ${hits.map((h: GateHit) => h.memory.id).join(', ')}`,
    );
    assert.ok(
      !hits.some((h: GateHit) => h.memory.id === 'm4'),
      `m5's boosted score must displace the weakest un-boosted candidate (m4) out of the maxHits cap, got ids ${hits.map((h: GateHit) => h.memory.id).join(', ')}`,
    );
  } finally {
    if (prevK === undefined) delete process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K;
    else process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K = prevK;
  }
});

test('resolveBlended: at calibrated defaults the candidate pool equals the cap — no topic-boost rescue from outside the raw semantic top-maxHits (mm-v1-T008)', async () => {
  // Same 6-candidate setup as above, but NO env override and a k-honoring
  // stub: the pool is max(maxHits=5, candidateK default 5) = 5, so m5
  // (raw rank 6) never enters the blend and its topic match cannot rescue
  // it. Pins the deliberate mm-v1-T008 behavior change (candidateK 10 -> 5).
  const maxHits = 5;
  const m0 = fakeMemory('m0');
  const m1 = fakeMemory('m1');
  const m2 = fakeMemory('m2');
  const m3 = fakeMemory('m3');
  const m4 = fakeMemory('m4');
  const m5 = fakeMemory('m5', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const capturedK: { value?: number } = {};
  const hits = await resolveBlended(
    ctx,
    [m0, m1, m2, m3, m4, m5],
    '/fake/dir',
    { maxHits },
    {
      semanticSearch: fakeSemanticSearchHonoringK(
        {
          m0: 0.9,
          m1: 0.8,
          m2: 0.7,
          m3: 0.6,
          m4: 0.55,
          m5: 0.52,
        },
        capturedK,
      ),
    },
  );
  assert.equal(capturedK.value, 5, 'default pool = max(maxHits 5, candidateK 5)');
  assert.deepEqual(
    hits.map((h: GateHit) => h.memory.id),
    ['m0', 'm1', 'm2', 'm3', 'm4'],
    'at defaults the raw semantic top-5 IS the result; m5 is not rescued',
  );
});

test('resolveBlended: default-path semanticK consults BLEND_DEFAULTS.candidateK, not just maxHits (no env override)', async () => {
  // maxHits 3 < the default candidateK 5: a captured k of 5 proves the
  // default path reads BLEND_DEFAULTS.candidateK (the only k assertions
  // before this ran with the env var set).
  const mem = fakeMemory('mem');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const capturedK: { value?: number } = {};
  await resolveBlended(ctx, [mem], '/fake/dir', { maxHits: 3 }, {
    semanticSearch: fakeSemanticSearchHonoringK({ mem: 0.9 }, capturedK),
  });
  assert.equal(
    capturedK.value,
    5,
    `expected default semanticK max(3, 5) = 5, got ${capturedK.value}`,
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

// --- Relevance floor (mm-v1-T004 fix-round 2, HIGH #1) ---------------------
//
// MEMORY_ROUTER_BLEND_MIN_SEMANTIC (pinned to 0.5 for this whole file, see
// the file-level beforeEach/afterEach above; 0.5 was the flat default
// before the model-conditional default introduced in
// src/gates/confidence.ts) drops a semantic-search hit BEFORE it can enter
// the blend at all, applied before the degradation guard above: a
// sub-floor cosine match is noise, not a real signal, so a prompt whose
// only "matches" are all sub-floor must degrade to the deterministic
// topic-only path rather than blend near-zero-relevance scores in. The
// tests below exercise floor-filtering MECHANICS against the pinned value;
// the conditional-default RESOLUTION is covered in tests/confidence.test.ts.

test('resolveBlended: relevance floor drops every sub-floor semantic hit (negative control, active stub, all scores under the default floor 0.5, no topic hits either)', async () => {
  const m0 = fakeMemory('m0');
  const m1 = fakeMemory('m1');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const hits = await resolveBlended(ctx, [m0, m1], '/fake/dir', {}, {
    semanticSearch: fakeSemanticSearch({ m0: 0.2, m1: 0.3 }),
  });
  assert.deepEqual(
    hits,
    [],
    'every semantic hit is below the default floor (0.5) and neither memory has a topic match, so nothing should surface',
  );
});

test('resolveBlended: sub-floor semantic score plus a topic match degrades to EXACTLY the sync-only resolve() output (the floor filters the semantic signal out before it can blend)', async () => {
  const withTopic = fakeMemory('with-topic', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const hits = await resolveBlended(ctx, [withTopic], '/fake/dir', {}, {
    // Below the default 0.5 floor: this hit must be filtered out before the
    // blend runs, so the ONLY surviving signal is the Topic Gate match —
    // the same degraded path a semantic-search failure/no-index takes.
    semanticSearch: fakeSemanticSearch({ 'with-topic': 0.2 }),
  });
  assert.deepEqual(
    hits,
    resolve(ctx, [withTopic], { maxHits: 5 }),
    'a sub-floor semantic hit must degrade to byte-identical resolve() output, not a blended (near-zero-semantic) score',
  );
  assert.equal(hits[0].gate, 'topic');
  assert.equal(
    hits[0].score,
    1.0,
    `expected the flat pre-blend topic score once the sub-floor semantic hit is filtered out, got ${hits[0].score}`,
  );
});

test('resolveBlended: a candidate present only via a (floor-permitted) zero semantic score is labeled gate="confidence" with a non-empty reason, never a phantom "topic" gate hit with an empty reason (mm-v1-T004 fix-round 2 LOW #9)', async () => {
  // Under the DEFAULT floor (0.5) an exact-zero semantic score can never
  // survive filtering, so this edge case is structurally unreachable in
  // production today. It becomes reachable the moment an operator sets
  // MEMORY_ROUTER_BLEND_MIN_SEMANTIC=0 (a legal, non-negative override,
  // see envFloat's guard) — this test proves the gate/reason attribution
  // is still correct once that door is open.
  const mem = fakeMemory('mem'); // no topics field: no possible topic hit
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const prev = process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
  process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC = '0';
  try {
    const hits = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
      semanticSearch: fakeSemanticSearch({ mem: 0 }),
    });
    assert.equal(hits.length, 1);
    assert.equal(
      hits[0].gate,
      'confidence',
      'a semantic-only candidate (even at score 0) must never be mislabeled "topic" when there is no actual topic hit',
    );
    assert.notEqual(hits[0].reason, '', 'the reason must not be empty for a genuine (if zero-score) semantic candidate');
    assert.match(hits[0].reason, /semantic match \(score=0\.00\)/);
  } finally {
    if (prev === undefined) delete process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
    else process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC = prev;
  }
});

// --- Model-conditional relevance floor default, end-to-end through
// resolveBlended() (agent-tasks 3ef3ded3) ----------------------------------
//
// The unit-level resolution (bge-m3 -> 0.78, provider fallback, openai ->
// 0.5, explicit override always wins) is pinned directly against
// loadBlendWeights()/resolveDefaultMinSemanticScore() in
// tests/confidence.test.ts. These two tests instead prove the wiring: with
// NO MEMORY_ROUTER_BLEND_MIN_SEMANTIC override and an ollama/bge-m3
// provider config (the real hook default on a machine with a local Ollama
// daemon and no OPENAI_API_KEY — see README "Calibration"), resolveBlended
// itself actually applies the resolved 0.78 floor, not just the standalone
// resolver function.

test('resolveBlended: with no MEMORY_ROUTER_BLEND_MIN_SEMANTIC override and an ollama/bge-m3 provider config, a sub-0.78 semantic score is dropped (the pre-fix flat-0.5 default would have let it through)', async () => {
  const mem = fakeMemory('mem'); // no topics field: only the semantic path can surface it
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const prevFloor = process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
  const prevProvider = process.env.MEMORY_ROUTER_EMBED_PROVIDER;
  const prevOllamaModel = process.env.MEMORY_ROUTER_OLLAMA_EMBED_MODEL;
  const prevOpenaiKey = process.env.OPENAI_API_KEY;
  delete process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC; // no override: exercise the conditional default itself
  delete process.env.MEMORY_ROUTER_EMBED_PROVIDER; // auto-detect path
  delete process.env.OPENAI_API_KEY; // forces auto-detect onto ollama
  process.env.MEMORY_ROUTER_OLLAMA_EMBED_MODEL = 'bge-m3';
  try {
    const hits = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
      // 0.6 clears the OLD flat default (0.5) but not the bge-m3 conditional
      // default (0.78): this is the exact "junk-prompt injects a memory"
      // failure mode the calibration fixed (measured 0/4 negative controls
      // at floor 0.5 on the bge-m3 reference corpus).
      semanticSearch: fakeSemanticSearch({ mem: 0.6 }),
    });
    assert.deepEqual(
      hits,
      [],
      'a 0.6 semantic score must be dropped by the resolved 0.78 default (no topic match to fall back on)',
    );
  } finally {
    if (prevFloor === undefined) delete process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
    else process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC = prevFloor;
    if (prevProvider === undefined) delete process.env.MEMORY_ROUTER_EMBED_PROVIDER;
    else process.env.MEMORY_ROUTER_EMBED_PROVIDER = prevProvider;
    if (prevOllamaModel === undefined) delete process.env.MEMORY_ROUTER_OLLAMA_EMBED_MODEL;
    else process.env.MEMORY_ROUTER_OLLAMA_EMBED_MODEL = prevOllamaModel;
    if (prevOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenaiKey;
  }
});

test('resolveBlended: with no MEMORY_ROUTER_BLEND_MIN_SEMANTIC override and an ollama/bge-m3 provider config, a score at/above 0.78 clears the floor and blends normally', async () => {
  const mem = fakeMemory('mem');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const prevFloor = process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
  const prevProvider = process.env.MEMORY_ROUTER_EMBED_PROVIDER;
  const prevOllamaModel = process.env.MEMORY_ROUTER_OLLAMA_EMBED_MODEL;
  const prevOpenaiKey = process.env.OPENAI_API_KEY;
  delete process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
  delete process.env.MEMORY_ROUTER_EMBED_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  process.env.MEMORY_ROUTER_OLLAMA_EMBED_MODEL = 'bge-m3';
  try {
    const hits = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
      semanticSearch: fakeSemanticSearch({ mem: 0.8 }),
    });
    assert.equal(hits.length, 1, 'a 0.8 semantic score clears the resolved 0.78 default and must surface');
    assert.equal(hits[0].memory.id, 'mem');
    assert.equal(hits[0].gate, 'confidence');
  } finally {
    if (prevFloor === undefined) delete process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC;
    else process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC = prevFloor;
    if (prevProvider === undefined) delete process.env.MEMORY_ROUTER_EMBED_PROVIDER;
    else process.env.MEMORY_ROUTER_EMBED_PROVIDER = prevProvider;
    if (prevOllamaModel === undefined) delete process.env.MEMORY_ROUTER_OLLAMA_EMBED_MODEL;
    else process.env.MEMORY_ROUTER_OLLAMA_EMBED_MODEL = prevOllamaModel;
    if (prevOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenaiKey;
  }
});

// --- Tool Gate passthrough (ctx.tool, e.g. MCP's memory_resolve) ----------

test('resolveBlended: ctx.tool still resolves via the deterministic Tool Gate in an ACTIVE blend (non-empty semantic score elsewhere), unaffected by the semantic blend (mm-v1-T004 fix-round 2 MEDIUM #3a)', async () => {
  // A previous version of this test stubbed semanticSearch with an EMPTY
  // scoresById, which means semanticHits.length === 0 for every memory
  // here (there is only toolMem in the corpus) — resolveBlended's
  // degradation guard then short-circuits to resolve(ctx, memories,
  // {maxHits}) BEFORE the toolHits/blended-array code below it ever runs.
  // That made the test pass by exercising the OLD sync-only resolve() path
  // (which also consults the Tool Gate via DEFAULT_GATES), never the new
  // active-blend branch's own toolHits handling — a semantic-scoring bug
  // there could regress silently. Adding a second, semantically-scored
  // memory keeps the blend genuinely active while toolMem itself stays a
  // pure Tool-Gate hit (no semantic score, no topic).
  const toolMem = fakeMemory('tool-mem', { triggers: { tools: ['Bash'] } });
  const semanticMem = fakeMemory('semantic-mem');
  const ctx: RouterContext = {
    prompt: NO_TOPIC_PROMPT,
    memoryDir: NOVOCAB_DIR,
    tool: { name: 'Bash', args: { command: 'ls' } },
  };
  const hits = await resolveBlended(ctx, [toolMem, semanticMem], '/fake/dir', {}, {
    semanticSearch: fakeSemanticSearch({ 'semantic-mem': 0.6 }),
  });
  assert.equal(hits.length, 2, `expected both the tool hit and the blend hit, got ${hits.map((h: GateHit) => h.memory.id).join(', ')}`);
  const toolHit = hits.find((h: GateHit) => h.memory.id === 'tool-mem');
  assert.ok(toolHit, 'the Tool Gate hit must still resolve when the semantic blend is active');
  assert.equal(toolHit.gate, 'tool');
  assert.equal(toolHit.score, 1.0);
});

test('resolveBlended: a Tool-Gate hit is privileged ahead of the maxHits cap and is never evicted by blend-scored memories exceeding 1.0 (mm-v1-T004 fix-round 2 MEDIUM #2)', async () => {
  // Three blended-only candidates each score semantic(0.95) + topicBoost
  // (default 0.05) + type/recency modifiers > 1.0 — strictly above the
  // Tool Gate's flat 1.0. With maxHits=2 and plain highest-score-wins
  // slot allocation (the pre-fix behavior), all 2 slots would go to the
  // blend candidates and toolMem would be evicted entirely, even though
  // it is a deterministic, directly-matched hit.
  const toolMem = fakeMemory('tool-mem', { triggers: { tools: ['Bash'] } });
  const b1 = fakeMemory('b1', { topics: ['workflow'] });
  const b2 = fakeMemory('b2', { topics: ['workflow'] });
  const b3 = fakeMemory('b3', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
    tool: { name: 'Bash', args: { command: 'ls' } },
  };
  const hits = await resolveBlended(
    ctx,
    [toolMem, b1, b2, b3],
    '/fake/dir',
    { maxHits: 2 },
    { semanticSearch: fakeSemanticSearch({ b1: 0.95, b2: 0.95, b3: 0.95 }) },
  );
  assert.equal(hits.length, 2);
  assert.ok(
    hits.some((h: GateHit) => h.memory.id === 'tool-mem'),
    `expected the privileged Tool-Gate hit to keep its slot despite 3 higher-scoring blend candidates, got ids ${hits.map((h: GateHit) => h.memory.id).join(', ')}`,
  );
  const toolHit = hits.find((h: GateHit) => h.memory.id === 'tool-mem');
  assert.equal(toolHit.gate, 'tool');
  assert.equal(toolHit.score, 1.0);
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
    // A semantic score above the fix-round-2 relevance floor (default 0.5,
    // MEMORY_ROUTER_BLEND_MIN_SEMANTIC) is required here: since the
    // mm-v1-T004 degradation fix, resolveBlended bypasses topicBoost/
    // recency/type entirely (returns the flat pre-blend resolve() output)
    // whenever the semantic path contributes nothing at all — including
    // when every hit is filtered out by the relevance floor — see the
    // degradation-pinning test above. This test is about the blend's env
    // override, not about degraded mode, so it must keep the semantic path
    // "live" (a hit that clears the floor) to actually exercise it.
    const hits = await resolveBlended(ctx, [withTopic], '/fake/dir', {}, {
      semanticSearch: fakeSemanticSearch({ 'with-topic': 0.6 }),
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

test('resolveBlended: a non-numeric MEMORY_ROUTER_BLEND_TOPIC_BOOST override falls back to the built-in default rather than producing NaN scores (active blend, exact score, mm-v1-T004 fix-round 2 MEDIUM #3b)', async () => {
  // The original version of this test stubbed semanticSearch with an EMPTY
  // scoresById, so semanticHits.length === 0 for the only memory in play —
  // the degradation guard short-circuits BEFORE loadBlendWeights()/
  // topicBoost is ever consulted, so the override's fallback behavior was
  // never actually exercised; `score > 0` also trivially holds for the
  // flat 1.0 degraded score regardless of the override. A non-empty
  // semantic score above the fix-round-2 relevance floor (default 0.5)
  // keeps the blend active, and the exact expected score (computed from
  // hardcoded, independent constants — see top of file) proves the
  // fallback landed on exactly the built-in default (DEFAULT_TOPIC_BOOST),
  // not merely
  // "some finite positive number".
  const withTopic = fakeMemory('with-topic', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const prev = process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST;
  process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST = 'not-a-number';
  try {
    const semanticScore = 0.6;
    const hits = await resolveBlended(ctx, [withTopic], '/fake/dir', {}, {
      semanticSearch: fakeSemanticSearch({ 'with-topic': semanticScore }),
    });
    // fakeMemory defaults to type 'feedback' and a /nonexistent/ path, so
    // statSync throws and recencyModifier sees age 0 (full recency weight).
    const expected =
      semanticScore +
      DEFAULT_TOPIC_BOOST +
      TYPE_MODIFIER_UNITS.feedback * DEFAULT_TYPE_WEIGHT +
      1 * DEFAULT_RECENCY_WEIGHT;
    assert.equal(
      hits[0].score,
      expected,
      `expected the built-in topicBoost default (${DEFAULT_TOPIC_BOOST}) folded into the exact blend sum, got ${hits[0].score} vs expected ${expected}`,
    );
  } finally {
    if (prev === undefined) delete process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST;
    else process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST = prev;
  }
});

test('resolveBlended: a negative MEMORY_ROUTER_BLEND_TOPIC_BOOST override falls back to the built-in default rather than accepting a negative weight (mm-v1-T004 fix-round 2 LOW #6, analogous to the half-life guard)', async () => {
  const withTopic = fakeMemory('with-topic', { topics: ['workflow'] });
  const ctx: RouterContext = {
    prompt: 'please review and merge this PR',
    memoryDir: NOVOCAB_DIR,
  };
  const prev = process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST;
  process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST = '-1';
  try {
    const semanticScore = 0.6;
    const hits = await resolveBlended(ctx, [withTopic], '/fake/dir', {}, {
      semanticSearch: fakeSemanticSearch({ 'with-topic': semanticScore }),
    });
    const expected =
      semanticScore +
      DEFAULT_TOPIC_BOOST +
      TYPE_MODIFIER_UNITS.feedback * DEFAULT_TYPE_WEIGHT +
      1 * DEFAULT_RECENCY_WEIGHT;
    assert.equal(
      hits[0].score,
      expected,
      `a negative topicBoost override must fall back to the built-in default (${DEFAULT_TOPIC_BOOST}), got ${hits[0].score} vs expected ${expected}`,
    );
  } finally {
    if (prev === undefined) delete process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST;
    else process.env.MEMORY_ROUTER_BLEND_TOPIC_BOOST = prev;
  }
});

test('resolveBlended: a non-positive MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS override falls back to the built-in default instead of dividing by zero (mtime chosen so the fallback is measurable, exact score, mm-v1-T004 fix-round 2 MEDIUM #3c)', async () => {
  // The original version of this test used mtime = now (age 0 days). At
  // age 0, decay = 0.5 ** (0 / halfLifeDays) === 1 for EVERY halfLifeDays
  // value (0, 30, or anything else) — the guard's fallback-vs-no-fallback
  // branches are indistinguishable at age 0, so this test passed even
  // before the non-positive guard existed. Backdating the file's mtime by
  // exactly the built-in default half-life (30 days) makes the two
  // branches diverge measurably: with the guard (falls back to 30), decay
  // = 0.5 ** (30/30) = 0.5; without it (dividing by the raw override, 0),
  // decay = 0.5 ** Infinity = 0. The exact expected score below pins the
  // WITH-guard value.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-blend-halflife-'));
  try {
    const now = Date.now();
    const mtime = new Date(now - DEFAULT_RECENCY_HALFLIFE_DAYS * 24 * 60 * 60 * 1000);
    const p = path.join(dir, 'mem.md');
    fs.writeFileSync(p, 'body');
    fs.utimesSync(p, mtime, mtime);
    const mem = fakeMemory('mem', {}, p);
    const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
    const prev = process.env.MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS;
    process.env.MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS = '0';
    try {
      const semanticScore = 0.6;
      const hits = await resolveBlended(ctx, [mem], '/fake/dir', {}, {
        semanticSearch: fakeSemanticSearch({ mem: semanticScore }),
      });
      // No topic match (NO_TOPIC_PROMPT), type defaults to 'feedback'.
      const decayWithFallback = Math.pow(0.5, DEFAULT_RECENCY_HALFLIFE_DAYS / DEFAULT_RECENCY_HALFLIFE_DAYS);
      const expected =
        semanticScore +
        0 +
        TYPE_MODIFIER_UNITS.feedback * DEFAULT_TYPE_WEIGHT +
        decayWithFallback * DEFAULT_RECENCY_WEIGHT;
      const actual = hits[0].score;
      assert.ok(
        Math.abs(actual - expected) < 1e-9,
        `expected the built-in half-life fallback (${DEFAULT_RECENCY_HALFLIFE_DAYS} days) to produce exactly ${expected}, got ${actual} (an unguarded divide-by-zero would instead collapse the recency term to 0, giving ${semanticScore + TYPE_MODIFIER_UNITS.feedback * DEFAULT_TYPE_WEIGHT})`,
      );
    } finally {
      if (prev === undefined) delete process.env.MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS;
      else process.env.MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS = prev;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBlended: MEMORY_ROUTER_BLEND_CANDIDATE_K overrides the semantic candidate-pool width passed to semanticSearch (mm-v1-T004 fix-round 2 LOW #5)', async () => {
  const mem = fakeMemory('mem');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const prev = process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K;
  process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K = '20';
  try {
    let capturedK: number | undefined;
    await resolveBlended(ctx, [mem], '/fake/dir', { maxHits: 5 }, {
      semanticSearch: async (
        _prompt: string,
        _memories: Memory[],
        _dir: string,
        k: number,
      ) => {
        capturedK = k;
        return [];
      },
    });
    assert.equal(
      capturedK,
      20,
      `expected the overridden candidate width (20, wider than maxHits=5) to reach semanticSearch, got ${capturedK}`,
    );
  } finally {
    if (prev === undefined) delete process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K;
    else process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K = prev;
  }
});

test('resolveBlended: a negative MEMORY_ROUTER_BLEND_CANDIDATE_K override falls back to the built-in default (5) rather than narrowing the candidate pool', async () => {
  const mem = fakeMemory('mem');
  const ctx: RouterContext = { prompt: NO_TOPIC_PROMPT, memoryDir: NOVOCAB_DIR };
  const prev = process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K;
  process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K = '-3';
  try {
    let capturedK: number | undefined;
    // maxHits 3 < the default candidateK 5, so a captured k of 5 proves the
    // fallback consulted BLEND_DEFAULTS.candidateK, not the maxHits floor
    // (semanticK = max(maxHits, candidateK)).
    await resolveBlended(ctx, [mem], '/fake/dir', { maxHits: 3 }, {
      semanticSearch: async (
        _prompt: string,
        _memories: Memory[],
        _dir: string,
        k: number,
      ) => {
        capturedK = k;
        return [];
      },
    });
    assert.equal(capturedK, 5, `expected the negative override to fall back to the built-in default (5), got ${capturedK}`);
  } finally {
    if (prev === undefined) delete process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K;
    else process.env.MEMORY_ROUTER_BLEND_CANDIDATE_K = prev;
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
