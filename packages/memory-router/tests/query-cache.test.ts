const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { rebuildIndex, semanticSearch } = require('../src/embed/indexer');
const { openIndex } = require('../src/embed/index-store');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'memories');
const EMBED_DIMENSIONS = 1536;

function tmpMemoryDir(): string {
  // Copy a real fixture corpus so `rebuildIndex` has something to embed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-cache-'));
  for (const f of fs.readdirSync(FIXTURES_DIR)) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(dir, f));
  }
  return dir;
}

function deterministicVector(seed: number): number[] {
  // Pseudo-random but stable per seed — sqlite-vec only needs floats, the
  // semantic content is irrelevant for cache-behavior tests.
  const out = new Array<number>(EMBED_DIMENSIONS);
  let s = seed || 1;
  for (let i = 0; i < EMBED_DIMENSIONS; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s / 0x7fffffff;
  }
  return out;
}

interface FetchStub {
  restore: () => void;
  callCount: () => number;
  reset: () => void;
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
    reset: () => {
      calls = 0;
    },
  };
}

test('semanticSearch caches the query embedding — repeat call issues zero HTTP requests', async () => {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevModel = process.env.MEMORY_ROUTER_EMBED_MODEL;
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.MEMORY_ROUTER_EMBED_MODEL = 'text-embedding-3-small';
  const fetchStub = stubFetch();
  const dir = tmpMemoryDir();
  try {
    await rebuildIndex(dir);
    const callsAfterIndex = fetchStub.callCount();
    assert.ok(callsAfterIndex > 0, 'rebuildIndex should embed at least once');

    const prompt = 'mal schauen was hier los ist';
    fetchStub.reset();
    await semanticSearch(prompt, [], dir, 5);
    assert.equal(fetchStub.callCount(), 1, 'first call embeds the query');

    fetchStub.reset();
    await semanticSearch(prompt, [], dir, 5);
    assert.equal(fetchStub.callCount(), 0, 'second call hits the cache');

    fetchStub.reset();
    await semanticSearch('a different prompt', [], dir, 5);
    assert.equal(fetchStub.callCount(), 1, 'distinct prompt re-embeds');
  } finally {
    fetchStub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    if (prevModel === undefined) delete process.env.MEMORY_ROUTER_EMBED_MODEL;
    else process.env.MEMORY_ROUTER_EMBED_MODEL = prevModel;
  }
});

test('semanticSearch invalidates the cache when MEMORY_ROUTER_EMBED_MODEL changes', async () => {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevModel = process.env.MEMORY_ROUTER_EMBED_MODEL;
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.MEMORY_ROUTER_EMBED_MODEL = 'text-embedding-3-small';
  const fetchStub = stubFetch();
  const dir = tmpMemoryDir();
  try {
    await rebuildIndex(dir);

    const prompt = 'cache invalidation check';
    fetchStub.reset();
    await semanticSearch(prompt, [], dir, 5);
    assert.equal(fetchStub.callCount(), 1, 'first call embeds');

    fetchStub.reset();
    await semanticSearch(prompt, [], dir, 5);
    assert.equal(fetchStub.callCount(), 0, 'second call hits the cache');

    // Switch model — old entry must be ignored, then evicted on the next put.
    process.env.MEMORY_ROUTER_EMBED_MODEL = 'text-embedding-3-large';
    fetchStub.reset();
    await semanticSearch(prompt, [], dir, 5);
    assert.equal(
      fetchStub.callCount(),
      1,
      'model change forces a re-embed under the new model',
    );

    fetchStub.reset();
    await semanticSearch(prompt, [], dir, 5);
    assert.equal(
      fetchStub.callCount(),
      0,
      'subsequent call under the new model hits the refreshed cache',
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

test('query cache enforces LRU cap — oldest by accessed_at evicted past capacity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-cache-lru-'));
  const dbPath = path.join(dir, 'idx.sqlite');
  const dims = 4;
  const store = openIndex({
    path: dbPath,
    dimensions: dims,
    cache: { model: 'test-model', capacity: 3 },
  });
  // accessed_at is millisecond-precision — sub-ms operations collide and
  // the LRU tiebreak becomes non-deterministic. A 2 ms gap between writes
  // mirrors real prompt arrival cadence and makes ordering deterministic.
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 2));
  try {
    const vec = (seed: number): number[] => [seed, seed + 1, seed + 2, seed + 3];

    store.putCachedQuery('a', vec(1));
    await tick();
    store.putCachedQuery('b', vec(2));
    await tick();
    store.putCachedQuery('c', vec(3));
    assert.equal(store.cacheSize(), 3, 'at cap, no eviction');

    // Touch 'a' so it's no longer the oldest, then add 'd' to force eviction.
    await tick();
    assert.ok(store.getCachedQuery('a'));
    await tick();
    store.putCachedQuery('d', vec(4));
    assert.equal(store.cacheSize(), 3, 'cap enforced');
    assert.ok(store.getCachedQuery('a'), 'recently-touched survives');
    assert.equal(store.getCachedQuery('b'), null, 'oldest (b) evicted');
    assert.ok(store.getCachedQuery('c'));
    assert.ok(store.getCachedQuery('d'));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('query cache evicts stale-model rows on put — alternating models stay clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-cache-model-'));
  const dbPath = path.join(dir, 'idx.sqlite');
  const dims = 4;

  const storeA = openIndex({
    path: dbPath,
    dimensions: dims,
    cache: { model: 'model-A', capacity: 10 },
  });
  storeA.putCachedQuery('p', [1, 1, 1, 1]);
  storeA.putCachedQuery('q', [2, 2, 2, 2]);
  assert.equal(storeA.cacheSize(), 2);
  storeA.close();

  const storeB = openIndex({
    path: dbPath,
    dimensions: dims,
    cache: { model: 'model-B', capacity: 10 },
  });
  try {
    // Putting under model-B must evict the model-A rows.
    storeB.putCachedQuery('p', [9, 9, 9, 9]);
    assert.equal(storeB.cacheSize(), 1, 'model-A rows gone after first model-B put');
    assert.equal(storeB.getCachedQuery('q'), null, 'model-A entries inaccessible');
    const fetched = storeB.getCachedQuery('p');
    assert.deepEqual(fetched, [9, 9, 9, 9], 'returns the model-B value');
  } finally {
    storeB.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('query cache survives store close/reopen — entries persist across hook invocations', async () => {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevModel = process.env.MEMORY_ROUTER_EMBED_MODEL;
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.MEMORY_ROUTER_EMBED_MODEL = 'text-embedding-3-small';
  const fetchStub = stubFetch();
  const dir = tmpMemoryDir();
  try {
    await rebuildIndex(dir);

    const prompt = 'persistence check';
    await semanticSearch(prompt, [], dir, 5);
    fetchStub.reset();

    // Each semanticSearch call opens + closes the store, simulating two
    // separate hook invocations against the same on-disk sqlite file.
    await semanticSearch(prompt, [], dir, 5);
    assert.equal(fetchStub.callCount(), 0, 'cache hit after reopen');
  } finally {
    fetchStub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    if (prevModel === undefined) delete process.env.MEMORY_ROUTER_EMBED_MODEL;
    else process.env.MEMORY_ROUTER_EMBED_MODEL = prevModel;
  }
});
