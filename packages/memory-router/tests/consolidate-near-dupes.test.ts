// Direct unit tests for src/consolidate/near-dupes.ts.
//
// No live embedding calls anywhere in this file: fixture indexes are built
// with hand-picked fake vectors via src/embed/index-store.ts's public
// openIndex() API, the same way tests/index-store.test.ts does.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { openIndex } = require('../src/embed/index-store');
const {
  findNearDupes,
  cosineSimilarity,
  DEFAULT_NEAR_THRESHOLD,
} = require('../src/consolidate/near-dupes');

function memory(id: string): Memory {
  return {
    id,
    path: `/corpus/${id}.md`,
    frontmatter: { name: id, description: '', type: 'reference' },
    body: '',
  };
}

// Saves/restores every env var resolveProviderConfig() consults, so tests
// never leak state into each other regardless of pass/fail. Mirrors
// tests/embed-multi-provider.test.ts's withEnv helper.
const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'MEMORY_ROUTER_EMBED_PROVIDER',
  'MEMORY_ROUTER_EMBED_MODEL',
  'MEMORY_ROUTER_OLLAMA_BASE_URL',
  'MEMORY_ROUTER_OLLAMA_EMBED_MODEL',
] as const;

function withEnv(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => void,
): void {
  const prev: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  for (const key of ENV_KEYS) prev[key] = process.env[key];
  for (const key of ENV_KEYS) {
    if (key in vars && vars[key] !== undefined) process.env[key] = vars[key];
    else delete process.env[key];
  }
  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function tmpMemoryDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-near-dupes-'));
}

const MODEL = 'text-embedding-3-small';

function buildFixtureIndex(
  dir: string,
  entries: { id: string; vector: number[] }[],
  meta: { provider: string; model: string } = { provider: 'openai', model: MODEL },
): void {
  fs.mkdirSync(path.join(dir, '.memory-router'), { recursive: true });
  const store = openIndex({
    path: path.join(dir, '.memory-router', 'index.sqlite'),
    meta,
  });
  try {
    let mtime = 100;
    for (const e of entries) {
      store.upsert(e.id, mtime++, meta.model, e.vector);
    }
  } finally {
    store.close();
  }
}

test('cosineSimilarity: identical vectors are 1, orthogonal vectors are 0', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 1e-9);
});

test('cosineSimilarity: a zero vector never divides by zero (returns 0, not NaN)', () => {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 0, 0]), 0);
});

test('findNearDupes: no index at <dir>/.memory-router/index.sqlite is skipped with an explicit reason, not a silent empty result', () => {
  const dir = tmpMemoryDir();
  try {
    const result = findNearDupes(dir, [memory('a'), memory('b')], 0.95);
    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /no embedding index found at/);
    assert.match(result.reason, /memory-router index/);
    assert.deepEqual(result.pairs, []);
    assert.equal(result.indexedCount, 0);
    assert.equal(result.totalCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findNearDupes: index present but no embedding provider configured is skipped with an explicit reason', () => {
  const dir = tmpMemoryDir();
  buildFixtureIndex(dir, [{ id: 'a', vector: [1, 0, 0] }]);
  try {
    // resolveProviderConfig({ autoDetectOllama: true }) auto-detects a local
    // Ollama config whenever no explicit provider is chosen and no
    // OPENAI_API_KEY is set (see src/embed/provider.ts) — the SAME
    // resolution findNearDupes itself performs, mirroring indexer.ts. The
    // only way to reach a genuinely null config is an EXPLICIT
    // `MEMORY_ROUTER_EMBED_PROVIDER=openai` selection with no API key,
    // which resolveProviderConfig refuses to silently substitute Ollama for.
    withEnv({ MEMORY_ROUTER_EMBED_PROVIDER: 'openai' }, () => {
      const result = findNearDupes(dir, [memory('a')], 0.95);
      assert.equal(result.status, 'skipped');
      assert.match(result.reason, /no embedding provider configured/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findNearDupes: index built under a different provider than the active config is skipped (not crashed), with the mismatch reason surfaced', () => {
  const dir = tmpMemoryDir();
  buildFixtureIndex(dir, [{ id: 'a', vector: [1, 0, 0] }], {
    provider: 'openai',
    model: MODEL,
  });
  try {
    withEnv({ MEMORY_ROUTER_EMBED_PROVIDER: 'ollama' }, () => {
      const result = findNearDupes(dir, [memory('a')], 0.95);
      assert.equal(result.status, 'skipped');
      assert.match(result.reason, /provider=openai/);
      assert.match(result.reason, /provider=ollama/);
      assert.match(result.reason, /Rebuild the index/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findNearDupes: pairs at/above the threshold are reported, below-threshold pairs are not, sorted by similarity desc', () => {
  const dir = tmpMemoryDir();
  buildFixtureIndex(dir, [
    { id: 'near_a', vector: [1, 0, 0] },
    { id: 'near_b', vector: [0.999, 0.001, 0] }, // ~cosine 1.0 with near_a
    { id: 'far_c', vector: [0, 1, 0] }, // orthogonal to both
  ]);
  try {
    withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
      const result = findNearDupes(
        dir,
        [memory('near_a'), memory('near_b'), memory('far_c')],
        0.95,
      );
      assert.equal(result.status, 'ok');
      assert.equal(result.indexedCount, 3);
      assert.equal(result.totalCount, 3);
      assert.equal(result.pairs.length, 1);
      assert.equal(result.pairs[0].aId, 'near_a');
      assert.equal(result.pairs[0].bId, 'near_b');
      assert.ok(result.pairs[0].similarity >= 0.95);
      assert.equal(result.pairs[0].aPath, '/corpus/near_a.md');
      assert.equal(result.pairs[0].bPath, '/corpus/near_b.md');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findNearDupes: a memory absent from the index (stale index relative to corpus) is excluded from pairs but counted in totalCount, not indexedCount', () => {
  const dir = tmpMemoryDir();
  buildFixtureIndex(dir, [{ id: 'indexed', vector: [1, 0, 0] }]);
  try {
    withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
      const result = findNearDupes(dir, [memory('indexed'), memory('not_yet_indexed')], 0.95);
      assert.equal(result.status, 'ok');
      assert.equal(result.indexedCount, 1);
      assert.equal(result.totalCount, 2);
      assert.deepEqual(result.pairs, []);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findNearDupes: default threshold is DEFAULT_NEAR_THRESHOLD (0.95) when not passed', () => {
  const dir = tmpMemoryDir();
  buildFixtureIndex(dir, [
    { id: 'a', vector: [1, 0] },
    { id: 'b', vector: [0.9, 0.1] }, // cosine ~0.994, above 0.95 but test default explicitly below too
  ]);
  try {
    withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
      const result = findNearDupes(dir, [memory('a'), memory('b')]);
      assert.equal(result.threshold, DEFAULT_NEAR_THRESHOLD);
      assert.equal(DEFAULT_NEAR_THRESHOLD, 0.95);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
