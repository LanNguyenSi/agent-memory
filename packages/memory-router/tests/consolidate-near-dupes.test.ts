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
const { createHash } = require('node:crypto');

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

// --- mm-v1-T007 fix round HIGH #1: read-only index access ---------------

test('findNearDupes: HIGH #1 regression guard: the near-dupes openIndex call requests a readonly connection', () => {
  // WHY a source-level guard rather than a behavioral one, verified
  // empirically (see tests/index-store.test.ts's readonly tests, and the
  // module-level comment at the top of src/consolidate/near-dupes.ts):
  // against an already fully-built index (the only thing this readonly
  // connection is ever pointed at), none of the write paths `readonly:
  // true` skips at open time (the WAL pragma, CREATE TABLE DDL,
  // applyMigrations, recordProvenance) would actually have written
  // anything anyway, so removing the flag has NO observable effect on
  // findNearDupes' own return values or on the index file's bytes. The
  // flag's real, valuable effect (a write attempt through the store is
  // rejected by SQLite itself rather than silently corrupting a
  // concurrently-used index) is proven behaviorally in
  // tests/index-store.test.ts's dedicated readonly tests. This guard
  // exists so a future edit that drops the flag here is still caught,
  // even though its effect can't be observed through findNearDupes' own
  // black-box API in the normal (already fully-built, already-current)
  // index case.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'consolidate', 'near-dupes.ts'),
    'utf8',
  );
  assert.match(
    source,
    /openIndex\(\{[\s\S]{0,400}?readonly:\s*true/,
    'near-dupes.ts must request a readonly index-store connection',
  );
});

test('findNearDupes: the index.sqlite file itself is byte-for-byte unchanged by a successful (ok) run', () => {
  const dir = tmpMemoryDir();
  buildFixtureIndex(dir, [
    { id: 'near_a', vector: [1, 0, 0] },
    { id: 'near_b', vector: [0.999, 0.001, 0] },
  ]);
  const idxPath = path.join(dir, '.memory-router', 'index.sqlite');
  const before = createHash('sha256').update(fs.readFileSync(idxPath)).digest('hex');
  try {
    withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
      const result = findNearDupes(dir, [memory('near_a'), memory('near_b')], 0.95);
      assert.equal(result.status, 'ok');
    });
    const after = createHash('sha256').update(fs.readFileSync(idxPath)).digest('hex');
    assert.equal(
      after,
      before,
      'a readonly connection can never checkpoint or write to the base file',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findNearDupes: the index.sqlite file itself is byte-for-byte unchanged by a provider-mismatch skip run', () => {
  const dir = tmpMemoryDir();
  buildFixtureIndex(dir, [{ id: 'a', vector: [1, 0, 0] }], {
    provider: 'openai',
    model: MODEL,
  });
  const idxPath = path.join(dir, '.memory-router', 'index.sqlite');
  const before = createHash('sha256').update(fs.readFileSync(idxPath)).digest('hex');
  try {
    withEnv({ MEMORY_ROUTER_EMBED_PROVIDER: 'ollama' }, () => {
      const result = findNearDupes(dir, [memory('a')], 0.95);
      assert.equal(result.status, 'skipped');
    });
    const after = createHash('sha256').update(fs.readFileSync(idxPath)).digest('hex');
    assert.equal(after, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- mm-v1-T007 fix round: corrupted-index degrades to skipped, never crashes (LOW #10) ---

test('findNearDupes: a corrupted/unreadable index file degrades to status "skipped" with a clear reason instead of crashing the whole consolidate run', () => {
  const dir = tmpMemoryDir();
  buildFixtureIndex(dir, [
    { id: 'a', vector: [1, 0, 0] },
    { id: 'b', vector: [0, 1, 0] },
  ]);
  const idxPath = path.join(dir, '.memory-router', 'index.sqlite');
  // Truncate the file after a valid build: a real-world analog (a killed
  // `memory-router index` process, a disk-full mid-write) that corrupts
  // the on-disk SQLite structure without deleting it outright, so
  // findNearDupes' existsSync(idxPath) guard doesn't short-circuit to the
  // (different, already-tested) "no index found" skip path.
  const full = fs.readFileSync(idxPath);
  fs.writeFileSync(idxPath, full.subarray(0, Math.floor(full.length / 2)));
  try {
    withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
      const result = findNearDupes(dir, [memory('a'), memory('b')], 0.95);
      assert.equal(result.status, 'skipped');
      assert.equal(typeof result.reason, 'string');
      assert.ok((result.reason as string).length > 0);
      assert.deepEqual(result.pairs, []);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- mm-v1-T007 fix round MEDIUM #2/#4: reason:null, threshold boundary, stale-model disclosure ---

test('findNearDupes: reason is explicitly null (not simply absent) on an "ok" result, a stable key set', () => {
  const dir = tmpMemoryDir();
  buildFixtureIndex(dir, [{ id: 'a', vector: [1, 0, 0] }]);
  try {
    withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
      const result = findNearDupes(dir, [memory('a')], 0.95);
      assert.equal(result.status, 'ok');
      assert.ok('reason' in result, 'the key must be present, not simply omitted');
      assert.equal(result.reason, null);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findNearDupes: threshold boundary: a pair with a known intermediate cosine (~0.91) is excluded at 0.95 and included at 0.85', () => {
  const dir = tmpMemoryDir();
  // Integer vector components: exactly representable in the float32
  // storage sqlite-vec uses, so the cosine computed here (double
  // precision) exactly matches what findNearDupes computes internally
  // from the roundtripped vectors, no floating-point rounding involved.
  const vecA = [10, 0];
  const vecB = [9, 4];
  buildFixtureIndex(dir, [
    { id: 'a', vector: vecA },
    { id: 'b', vector: vecB },
  ]);
  try {
    withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
      const sim = cosineSimilarity(vecA, vecB);
      assert.ok(
        sim > 0.85 && sim < 0.95,
        `fixture cosine must sit strictly between 0.85 and 0.95, got ${sim}`,
      );

      const excluded = findNearDupes(dir, [memory('a'), memory('b')], 0.95);
      assert.equal(excluded.pairs.length, 0, 'a below-threshold pair must be excluded at 0.95');

      const included = findNearDupes(dir, [memory('a'), memory('b')], 0.85);
      assert.equal(
        included.pairs.length,
        1,
        'the same pair must be included once the threshold drops below its cosine',
      );
      assert.equal(included.pairs[0].similarity, sim);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findNearDupes: threshold boundary: a pair whose cosine EXACTLY equals the threshold is included (the comparison is >=, not >)', () => {
  const dir = tmpMemoryDir();
  const vecA = [2, 1];
  const vecB = [1, 2];
  buildFixtureIndex(dir, [
    { id: 'a', vector: vecA },
    { id: 'b', vector: vecB },
  ]);
  try {
    withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
      const sim = cosineSimilarity(vecA, vecB);
      // Pin the threshold to the exact computed similarity: proves the
      // `similarity >= threshold` comparison inside findNearDupes, not
      // `>`, since a boundary-equal pair would silently vanish under a
      // strict `>`.
      const result = findNearDupes(dir, [memory('a'), memory('b')], sim);
      assert.equal(result.pairs.length, 1);
      assert.equal(result.pairs[0].similarity, sim);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findNearDupes: stale-model disclosure: memories indexed under a different model than the one currently active are distinguished from "never indexed"', () => {
  const dir = tmpMemoryDir();
  buildFixtureIndex(
    dir,
    [
      { id: 'a', vector: [1, 0, 0] },
      { id: 'b', vector: [0, 1, 0] },
    ],
    { provider: 'openai', model: 'model-A' },
  );
  try {
    withEnv({ OPENAI_API_KEY: 'sk-test', MEMORY_ROUTER_EMBED_MODEL: 'model-B' }, () => {
      const result = findNearDupes(dir, [memory('a'), memory('b')], 0.95);
      assert.equal(result.status, 'ok');
      assert.equal(result.indexedCount, 0, 'both rows are tagged for model-A, none match the active model-B');
      assert.equal(result.totalCount, 2);
      assert.equal(result.staleModelRows, 2);
      assert.match(result.staleModelReason, /model-B/);
      assert.match(result.staleModelReason, /stored under a different embedding model/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findNearDupes: staleModelRows is omitted (not 0) when the coverage gap is genuinely "never indexed", not a model mismatch', () => {
  const dir = tmpMemoryDir();
  buildFixtureIndex(dir, [{ id: 'indexed', vector: [1, 0, 0] }]);
  try {
    withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
      const result = findNearDupes(dir, [memory('indexed'), memory('not_yet_indexed')], 0.95);
      assert.equal(result.indexedCount, 1);
      assert.equal(result.totalCount, 2);
      assert.equal(
        result.staleModelRows,
        undefined,
        'the missing memory was simply never indexed, not stale-model',
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
