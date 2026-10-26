// Chunked embeddings (schema v3) end to end: the chunk tables in
// src/embed/index-store.ts, the chunk embed pass of rebuildIndex and the
// max(document, best chunk) merge in semanticSearch (both in
// src/embed/indexer.ts), plus the pure chunker's role in all of it
// (unit-level rules are pinned in tests/chunking.test.ts).
//
// Embeddings are stubbed at the `fetch` layer (same seam as
// tests/query-cache.test.ts) with EXACT-INPUT-MATCHED fake vectors: the
// tests compute the document/chunk embed inputs with the same rule
// indexer.ts uses, look them up in a table, and fall back to an orthogonal
// vector for anything unregistered. A vector table keyed by the input text
// therefore also pins the input format of both the document and the chunk
// embed calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const { openIndex } = require('../src/embed/index-store');
const { rebuildIndex, semanticSearch, indexPath } = require('../src/embed/indexer');
const { chunkBody } = require('../src/embed/chunking');
const { loadMemoriesFromDir } = require('../src/memory/loader');

const MODEL = 'text-embedding-3-small';
// Orthogonal stand-ins for "matches the query" / "does not match"; the
// 0.6/0.8 pair is a partial match (cosine 0.6 with `ON`).
const ON = [1, 0];
const OFF = [0, 1];
const PARTIAL = [0.6, 0.8];

// --- embed-input helpers (mirrors indexer.ts's build*EmbedInput) ----------

function docInput(memory: {
  frontmatter: { name: string; description: string };
  body: string;
}): string {
  const parts = [
    memory.frontmatter.name,
    memory.frontmatter.description,
    memory.body,
  ];
  return parts.filter(Boolean).join('\n').slice(0, 8000);
}

function chunkInput(
  memory: { frontmatter: { name: string; description: string } },
  chunkText: string,
): string {
  const parts = [
    memory.frontmatter.name,
    memory.frontmatter.description,
    chunkText,
  ];
  return parts.filter(Boolean).join('\n').slice(0, 8000);
}

// --- test harness ---------------------------------------------------------

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `memory-router-${prefix}-`));
}

function writeMemory(
  dir: string,
  fileName: string,
  opts: { name: string; description: string; body: string },
): string {
  const file = path.join(dir, fileName);
  const frontmatter = ['---', `name: ${opts.name}`, `description: ${opts.description}`, 'type: project', '---'].join('\n');
  const body = opts.body === '' ? '' : `\n${opts.body}\n`;
  fs.writeFileSync(file, `${frontmatter}${body}`, 'utf8');
  return file;
}

// Save/restore the provider env vars so a developer's own
// MEMORY_ROUTER_EMBED_* exports cannot leak into these tests.
async function withProviderEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = {
    key: process.env.OPENAI_API_KEY,
    provider: process.env.MEMORY_ROUTER_EMBED_PROVIDER,
    model: process.env.MEMORY_ROUTER_EMBED_MODEL,
    hookTimeout: process.env.MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS,
    timeout: process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS,
  };
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.MEMORY_ROUTER_EMBED_PROVIDER = 'openai';
  process.env.MEMORY_ROUTER_EMBED_MODEL = MODEL;
  delete process.env.MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS;
  delete process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS;
  try {
    return await fn();
  } finally {
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('OPENAI_API_KEY', prev.key);
    restore('MEMORY_ROUTER_EMBED_PROVIDER', prev.provider);
    restore('MEMORY_ROUTER_EMBED_MODEL', prev.model);
    restore('MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS', prev.hookTimeout);
    restore('MEMORY_ROUTER_EMBED_TIMEOUT_MS', prev.timeout);
  }
}

interface FetchStub {
  restore: () => void;
  inputs: () => string[];
  calls: () => number;
}

// Stubs fetch so every embed input gets `resolve(text)`; unregistered
// inputs get OFF and are recorded so tests can assert on them. `calls()`
// counts HTTP requests, which is how the batching tests pin "one request
// per 64 INPUTS". `failOnRequest` makes the n-th request reject like a
// dead provider would (for the interrupted-rebuild tests).
function stubFetch(
  resolve: (input: string) => number[],
  opts?: { failOnRequest?: number },
): FetchStub {
  const orig = (globalThis as { fetch?: typeof fetch }).fetch;
  const seen: string[] = [];
  let requests = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { body?: string },
  ) => {
    requests++;
    if (opts?.failOnRequest === requests) {
      throw new Error(`stubbed embed failure on request ${requests}`);
    }
    const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
    seen.push(...body.input);
    const data = body.input.map((text, index) => ({
      embedding: resolve(text),
      index,
    }));
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
    inputs: () => seen,
    calls: () => requests,
  };
}

function rawQuery<T>(dbPath: string, sql: string): T {
  const raw = new Database(dbPath);
  sqliteVec.load(raw);
  try {
    return (raw.prepare(sql).all() as unknown) as T;
  } finally {
    raw.close();
  }
}

function chunkRowCount(dbPath: string, id: string): number {
  const rows = rawQuery<{ n: number }[]>(
    dbPath,
    `SELECT COUNT(*) AS n FROM chunks WHERE id = '${id}'`,
  );
  return rows[0].n;
}

// Every chunk row must own exactly one vector row: an orphan `chunk_vec`
// row is invisible to the current JOIN but would silently attach itself to
// any FUTURE chunks row that reuses its rowid (SQLite reuses rowids after
// a delete), scoring a chunk that was replaced long ago.
function chunkVecRowCount(dbPath: string): number {
  const rows = rawQuery<{ n: number }[]>(dbPath, 'SELECT COUNT(*) AS n FROM chunk_vec');
  return rows[0].n;
}

function chunkTotal(dbPath: string): number {
  const rows = rawQuery<{ n: number }[]>(dbPath, 'SELECT COUNT(*) AS n FROM chunks');
  return rows[0].n;
}

function insertRawChunk(
  dbPath: string,
  id: string,
  chunkIndex: number,
  charOffset: number,
  model: string,
  embedding: number[],
): void {
  const raw = new Database(dbPath);
  sqliteVec.load(raw);
  try {
    const info = raw
      .prepare(
        'INSERT INTO chunks (id, chunk_index, char_offset, model) VALUES (?, ?, ?, ?)',
      )
      .run(id, chunkIndex, charOffset, model);
    raw
      .prepare('INSERT INTO chunk_vec (rowid, embedding) VALUES (?, ?)')
      .run(
        BigInt(info.lastInsertRowid as number),
        Buffer.from(new Float32Array(embedding).buffer),
      );
  } finally {
    raw.close();
  }
}

// A body with a marker deeper than the document embed input's 8,000-char
// cut: only a chunk can carry it.
const MARKER = 'the secret passphrase is zebra-quantum-flux';

function longBodyWithMarker(): string {
  const filler = Array.from(
    { length: 120 },
    (_, i) => `filler paragraph ${i} ${'f'.repeat(80)}`,
  ).join('\n\n');
  const body = `${filler}\n\n${MARKER}\n\n${filler}`;
  if (body.indexOf(MARKER) <= 10_000) throw new Error('fixture marker too shallow');
  if (body.slice(0, 8000).includes(MARKER)) throw new Error('marker visible to doc');
  return body;
}

// =========================================================================
// index-store.ts chunk API (store level, no indexer involved)
// =========================================================================

const M = 'test-model';

test('fresh index gets the v3 chunk tables; replaceChunks + searchChunks roundtrip', () => {
  const dir = tmpDir('chunks-roundtrip');
  const dbPath = path.join(dir, 'idx.sqlite');
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    assert.deepEqual(store.listChunkIds(), []);
    store.upsert('a', 100, M, [1, 0]);
    store.replaceChunks('a', M, [
      { index: 0, offset: 0, embedding: [1, 0.4] },
      { index: 1, offset: 1200, embedding: [1, 0] },
    ]);
    assert.deepEqual(store.listChunkIds(), ['a']);

    const hits = store.searchChunks([1, 0], 5, M);
    assert.equal(hits.length, 1, 'one hit per memory id');
    assert.equal(hits[0].id, 'a');
    assert.equal(hits[0].chunkIndex, 1, 'the nearest chunk wins');
    assert.equal(hits[0].charOffset, 1200);
    assert.ok(hits[0].similarity > 0.99);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replaceChunks replaces the whole set: an empty list deletes all chunks of that id', () => {
  const dir = tmpDir('chunks-replace');
  const dbPath = path.join(dir, 'idx.sqlite');
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    store.upsert('a', 100, M, [1, 0]);
    store.replaceChunks('a', M, [
      { index: 0, offset: 0, embedding: [1, 0] },
      { index: 1, offset: 1500, embedding: [1, 0.2] },
    ]);
    assert.equal(chunkRowCount(dbPath, 'a'), 2);

    // Shorter new version: ONE chunk, and no orphan of chunk index 1.
    store.replaceChunks('a', M, [{ index: 0, offset: 0, embedding: [0, 1] }]);
    assert.equal(chunkRowCount(dbPath, 'a'), 1);
    const afterReplace = store.searchChunks([1, 0], 5, M);
    assert.equal(afterReplace.length, 1, 'still one hit per memory');
    assert.equal(afterReplace[0].chunkIndex, 0, 'the near chunk of index 1 is gone');
    assert.ok(
      afterReplace[0].similarity < 0.6,
      `the orphan would have scored ~1, got ${afterReplace[0].similarity}`,
    );
    assert.equal(
      chunkVecRowCount(dbPath),
      chunkTotal(dbPath),
      'replacing a chunk set leaves no orphan chunk vectors',
    );

    store.replaceChunks('a', M, []);
    assert.equal(chunkRowCount(dbPath, 'a'), 0);
    assert.deepEqual(store.listChunkIds(), []);
    assert.equal(chunkVecRowCount(dbPath), 0, 'no orphan chunk vectors after the full delete');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remove(id) drops the memory AND its chunk rows', () => {
  const dir = tmpDir('chunks-remove');
  const dbPath = path.join(dir, 'idx.sqlite');
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    store.upsert('a', 100, M, [1, 0]);
    store.replaceChunks('a', M, [
      { index: 0, offset: 0, embedding: [1, 0] },
      { index: 1, offset: 900, embedding: [1, 0.1] },
    ]);
    store.upsert('b', 100, M, [0, 1]);
    store.remove('a');
    assert.equal(chunkRowCount(dbPath, 'a'), 0);
    assert.deepEqual(store.listChunkIds(), []);
    assert.deepEqual(store.searchChunks([1, 0], 5, M), []);
    assert.equal(store.listEntries().length, 1, 'the other memory is untouched');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remove() also deletes chunk rows this connection opened before the chunk_vec table existed', () => {
  const dir = tmpDir('chunks-remove-cross-connection');
  const dbPath = path.join(dir, 'idx.sqlite');
  // `early` opens while the file has no chunk_vec table yet; a second
  // connection then creates that table and writes chunk rows through it.
  // remove() on the early connection must not skip the chunk deletes
  // just because its open-time existence flag said the table was absent.
  const early = openIndex({ path: dbPath, dimensions: 2 });
  const other = openIndex({ path: dbPath, dimensions: 2 });
  try {
    other.upsert('b', 100, M, [0, 1]);
    other.replaceChunks('b', M, [
      { index: 0, offset: 0, embedding: [1, 0] },
      { index: 1, offset: 900, embedding: [1, 0.1] },
    ]);
    assert.equal(chunkRowCount(dbPath, 'b'), 2, 'the other connection wrote chunk rows');
    early.remove('b');
    assert.equal(chunkRowCount(dbPath, 'b'), 0, 'the chunk rows are gone');
    assert.equal(chunkVecRowCount(dbPath), 0, 'and their vectors too');
    assert.deepEqual(other.searchChunks([1, 0], 5, M), []);
    assert.equal(other.listEntries().length, 0, 'the entries row is gone as well');
  } finally {
    early.close();
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remove() deletes chunk rows of an id that has no entries row at all', () => {
  const dir = tmpDir('chunks-remove-no-entry');
  const dbPath = path.join(dir, 'idx.sqlite');
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    store.upsert('seed', 100, M, [1, 0]);
    store.replaceChunks('seed', M, [{ index: 0, offset: 0, embedding: [1, 0] }]);
    // A chunk row with no entries row: what an older build's remove()
    // could leave behind. remove() must not stop at the missing row.
    insertRawChunk(dbPath, 'ghost', 0, 0, M, [1, 0]);
    store.remove('ghost');
    assert.equal(chunkRowCount(dbPath, 'ghost'), 0, 'the orphan chunk row is deleted');
    assert.equal(chunkTotal(dbPath), 1, "the seeded memory's chunk stays");
    assert.equal(
      chunkVecRowCount(dbPath),
      chunkTotal(dbPath),
      'no orphan chunk vector is left for the ghost id',
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('many chunks of one memory produce ONE hit and never crowd another memory out of k', () => {
  const dir = tmpDir('chunks-overfetch');
  const dbPath = path.join(dir, 'idx.sqlite');
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    // Eight chunks of 'a' ALL nearer to the query than the single chunk of
    // 'b': a plain `LIMIT k` would return k rows of 'a' and never see 'b'.
    store.replaceChunks(
      'a',
      M,
      Array.from({ length: 8 }, (_, i) => ({
        index: i,
        offset: i * 1500,
        embedding: [1, 0.001 * (i + 1)],
      })),
    );
    store.replaceChunks('b', M, [{ index: 0, offset: 0, embedding: [1, 0.5] }]);
    store.replaceChunks('c', M, [{ index: 0, offset: 0, embedding: [1, 0.9] }]);

    const hits = store.searchChunks([1, 0], 2, M);
    assert.deepEqual(
      hits.map((h: { id: string }) => h.id),
      ['a', 'b'],
      'k distinct memory ids, not k chunk rows',
    );
    assert.ok(
      hits[0].similarity > hits[1].similarity,
      'best-first ordering by the winning chunk',
    );
    assert.equal(hits.length, 2);

    // Widening past the exhausted index stops cleanly, and asking for more
    // memories than exist returns all of them.
    assert.deepEqual(
      store.searchChunks([1, 0], 10, M).map((h: { id: string }) => h.id),
      ['a', 'b', 'c'],
    );
    assert.deepEqual(store.searchChunks([1, 0], 1, M).map((h: { id: string }) => h.id), ['a']);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchChunks applies the model filter to chunk rows too', () => {
  const dir = tmpDir('chunks-model-filter');
  const dbPath = path.join(dir, 'idx.sqlite');
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    store.replaceChunks('stale', 'model-OLD', [
      { index: 0, offset: 0, embedding: [1, 0] },
    ]);
    store.replaceChunks('current', M, [{ index: 0, offset: 0, embedding: [1, 0.5] }]);

    const filtered = store.searchChunks([1, 0], 5, M);
    assert.deepEqual(
      filtered.map((h: { id: string }) => h.id),
      ['current'],
      'a stale-model chunk nearer the query never scores',
    );
    // Without an expected model the stale row is visible (same contract as
    // search()).
    assert.deepEqual(
      store.searchChunks([1, 0], 5).map((h: { id: string }) => h.id),
      ['stale', 'current'],
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replaceChunks rejects a bad model name, a non-array, and a width mismatch (rollback keeps the old chunks)', () => {
  const dir = tmpDir('chunks-validation');
  const dbPath = path.join(dir, 'idx.sqlite');
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    store.replaceChunks('a', M, [{ index: 0, offset: 0, embedding: [1, 0] }]);

    /* eslint-disable @typescript-eslint/no-explicit-any */
    assert.throws(() => (store.replaceChunks as any)('a', '', []), /non-empty model name/);
    assert.throws(() => (store.replaceChunks as any)('a', undefined, []), /non-empty model name/);
    assert.throws(() => (store.replaceChunks as any)('a', M, 'nope'), /array of chunks/);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    assert.throws(
      () => store.replaceChunks('a', M, [{ index: 0, offset: 0, embedding: [1, 0, 0] }]),
      /chunk embedding dimension 3 != index dimension 2/,
    );
    // The transaction rolled back: the good chunk set is still there.
    assert.equal(chunkRowCount(dbPath, 'a'), 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replaceChunks on a fresh index learns the width from the first chunk embedding', () => {
  const dir = tmpDir('chunks-learn-width');
  const dbPath = path.join(dir, 'idx.sqlite');
  const store = openIndex({ path: dbPath });
  try {
    // Nothing embedded yet: an empty chunk list is a no-op (no width to
    // learn), then the first real chunk teaches the store its dimension.
    store.replaceChunks('a', M, []);
    assert.deepEqual(store.searchChunks([1, 0], 5, M), []);
    store.replaceChunks('a', M, [{ index: 0, offset: 7, embedding: [1, 0, 0] }]);
    const hits = store.searchChunks([1, 0, 0], 5, M);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].charOffset, 7);
    assert.deepEqual(store.getEmbedding('a'), null, 'no document vector was written');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchChunks rejects a query of the wrong width, and is empty on an index with no chunks', () => {
  const dir = tmpDir('chunks-dimension');
  const dbPath = path.join(dir, 'idx.sqlite');
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    assert.deepEqual(store.searchChunks([1, 0, 0], 5, M), [], 'no chunk_vec yet');
    store.replaceChunks('a', M, [{ index: 0, offset: 0, embedding: [1, 0] }]);
    assert.throws(
      () => store.searchChunks([1, 0, 0], 5, M),
      /query dimension 3 != index dimension 2/,
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// readonly behavior: a readonly open must not create or migrate anything
// =========================================================================

function seedV2Index(dbPath: string, withRows: boolean): void {
  // Write a file that looks exactly like a pre-v3 (schema v2) index: the
  // entries/vec/query_cache tables plus schema_version=2, and no chunk
  // tables at all.
  const raw = new Database(dbPath);
  sqliteVec.load(raw);
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('schema_version', '2');
    CREATE TABLE entries (id TEXT PRIMARY KEY, mtime INTEGER NOT NULL, model TEXT);
    CREATE VIRTUAL TABLE vec USING vec0(embedding FLOAT[2] distance_metric=cosine);
    CREATE TABLE IF NOT EXISTS query_cache (
      prompt_sha TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      embedding BLOB NOT NULL,
      accessed_at INTEGER NOT NULL
    );
  `);
  if (withRows) {
    raw.prepare('INSERT INTO entries (id, mtime, model) VALUES (?, ?, ?)').run('a', 100, M);
    const rowid = (raw.prepare('SELECT rowid FROM entries WHERE id = ?').get('a') as {
      rowid: number;
    }).rowid;
    raw
      .prepare('INSERT INTO vec (rowid, embedding) VALUES (?, ?)')
      .run(BigInt(rowid), Buffer.from(new Float32Array([1, 0]).buffer));
  }
  raw.close();
}

function hasTable(dbPath: string, name: string): boolean {
  const rows = rawQuery<{ n: number }[]>(
    dbPath,
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '${name}'`,
  );
  return rows[0].n > 0;
}

test('readonly open of a v2 file neither creates nor migrates the chunk tables', () => {
  const dir = tmpDir('chunks-readonly-v2');
  const dbPath = path.join(dir, 'idx.sqlite');
  seedV2Index(dbPath, true);
  const store = openIndex({ path: dbPath, dimensions: 2, readonly: true });
  try {
    // The v2 reads the readonly callers need still work, and the chunk
    // paths degrade to "no chunks" instead of touching the file.
    assert.deepEqual(store.getEmbedding('a', M), [1, 0]);
    assert.deepEqual(store.listChunkIds(), []);
    assert.deepEqual(store.searchChunks([1, 0], 5, M), []);
  } finally {
    store.close();
  }
  assert.equal(hasTable(dbPath, 'chunks'), false, 'no chunks table was created');
  assert.equal(hasTable(dbPath, 'chunk_vec'), false, 'no chunk_vec table was created');
  const rows = rawQuery<{ value: string }[]>(
    dbPath,
    "SELECT value FROM meta WHERE key = 'schema_version'",
  );
  assert.equal(rows[0].value, '2', 'the file stayed at schema v2');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a v2 index migrates and searches exactly as document vectors alone; rebuildIndex then builds chunks despite unchanged mtimes', async () => {
  const dir = tmpDir('chunks-migrate');
  const memDir = tmpDir('chunks-migrate-corpus');
  const body = 'Always run the linter before pushing.\n\nMore prose about why.';
  const file = writeMemory(memDir, 'lint.md', {
    name: 'Lint before push',
    description: 'Linter runs before every push',
    body,
  });
  const memory = {
    id: 'lint',
    path: file,
    frontmatter: { name: 'Lint before push', description: 'Linter runs before every push' },
    body,
  };
  const queryVec = [0.9, 0.1];
  const stub = stubFetch((input) => {
    if (input === 'lint prompt') return ON;
    if (input === docInput(memory as never)) return [0.9, 0.1];
    return OFF;
  });
  try {
    await withProviderEnv(async () => {
      const first = await rebuildIndex(memDir);
      assert.equal(first.embedded, 1);
      const idxPath = indexPath(memDir);
      assert.ok(chunkRowCount(idxPath, 'lint') > 0, 'fresh build writes chunks');

      // Snapshot the document-only search result on the v3 file.
      const beforeSearch = openIndex({ path: idxPath, dimensions: 2 });
      const docOnly = beforeSearch.search(queryVec, 5, MODEL);
      beforeSearch.close();

      // Downgrade the file to schema v2 the way an on-disk v2 index looks:
      // drop the chunk tables, stamp schema_version back to 2.
      const raw = new Database(idxPath);
      sqliteVec.load(raw);
      raw.exec('DROP TABLE chunk_vec; DROP TABLE chunks;');
      raw
        .prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'")
        .run();
      raw.close();
      assert.equal(hasTable(idxPath, 'chunks'), false);

      // First writable open after the downgrade runs migration 2 -> 3.
      const migrated = openIndex({ path: idxPath, dimensions: 2 });
      try {
        assert.ok(hasTable(idxPath, 'chunks'), 'migration 2 -> 3 created the table');
        assert.deepEqual(migrated.listChunkIds(), [], 'a migrated index has no chunk rows yet');
        assert.deepEqual(
          migrated.search(queryVec, 5, MODEL),
          docOnly,
          'search returns the same results as document vectors alone',
        );
        assert.deepEqual(migrated.searchChunks(queryVec, 5, MODEL), []);
      } finally {
        migrated.close();
      }

      // And through the hook path: the memory is still findable, on its
      // document vector only, with no chunk attribution.
      const memories = loadMemoriesFromDir(memDir);
      const before = await semanticSearch('lint prompt', memories, memDir, 3);
      assert.equal(before.length, 1);
      assert.equal(before[0].chunk, undefined);

      // Now the TRAP: nothing on disk changed (same mtime), but the index
      // has no chunk rows, so rebuildIndex must build them anyway.
      const second = await rebuildIndex(memDir);
      assert.equal(second.embedded, 0, 'document vector skipped: mtime unchanged');
      assert.ok(
        second.chunksEmbedded > 0,
        `chunks must be built on a freshly migrated index, got ${second.chunksEmbedded}`,
      );
      assert.ok(chunkRowCount(idxPath, 'lint') > 0);
    });
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(memDir, { recursive: true, force: true });
  }
});

// =========================================================================
// rebuildIndex chunk lifecycle (replace / remove) and batching
// =========================================================================

function bumpMtime(file: string): void {
  // mtime is floored to whole milliseconds and the write above can land in
  // the same millisecond as the first rebuild read it, so set it forward
  // explicitly instead of relying on the write itself.
  const stat = fs.statSync(file);
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 5_000));
}

test('re-embedding a changed memory replaces all its chunks (a shorter body leaves no orphans)', async () => {
  const memDir = tmpDir('chunks-reembed');
  const longBody = Array.from(
    { length: 6 },
    (_, i) => `section ${i}: ${'s'.repeat(1500)}`,
  ).join('\n\n');
  const file = writeMemory(memDir, 'multi.md', {
    name: 'Multi section',
    description: 'A long memory',
    body: longBody,
  });
  const stub = stubFetch(() => OFF);
  try {
    await withProviderEnv(async () => {
      const first = await rebuildIndex(memDir);
      const idxPath = indexPath(memDir);
      const longChunks = chunkBody(longBody).length;
      assert.ok(longChunks >= 3, `fixture must chunk into several pieces, got ${longChunks}`);
      assert.equal(first.chunksEmbedded, longChunks);
      assert.equal(chunkRowCount(idxPath, 'multi'), longChunks);
      assert.equal(
        chunkVecRowCount(idxPath),
        chunkTotal(idxPath),
        'no orphan chunk_vec rows after a fresh build',
      );

      // Shorter new version: exactly one chunk, and every old chunk gone.
      bumpMtime(file);
      const shortBody = 'Now just one short rule.';
      writeMemory(memDir, 'multi.md', {
        name: 'Multi section',
        description: 'A long memory',
        body: shortBody,
      });
      const second = await rebuildIndex(memDir);
      assert.equal(second.chunksEmbedded, 1);
      assert.equal(chunkRowCount(idxPath, 'multi'), 1);
      assert.equal(
        chunkVecRowCount(idxPath),
        chunkTotal(idxPath),
        'a shorter new version leaves no orphan chunk vectors behind',
      );
      const rows = rawQuery<{ chunk_index: number; char_offset: number }[]>(
        idxPath,
        `SELECT chunk_index, char_offset FROM chunks WHERE id = 'multi'`,
      );
      assert.deepEqual(rows, [{ chunk_index: 0, char_offset: 0 }]);

      // An emptied body keeps no chunk rows either.
      bumpMtime(file);
      writeMemory(memDir, 'multi.md', {
        name: 'Multi section',
        description: 'A long memory',
        body: '',
      });
      const third = await rebuildIndex(memDir);
      assert.equal(third.chunksEmbedded, 0);
      assert.equal(chunkRowCount(idxPath, 'multi'), 0);
      assert.equal(loadMemoriesFromDir(memDir).length, 1, 'the memory itself still exists');
    });
  } finally {
    stub.restore();
    fs.rmSync(memDir, { recursive: true, force: true });
  }
});

test('removing a memory removes its chunk rows on the next rebuild', async () => {
  const memDir = tmpDir('chunks-remove-file');
  const longBody = Array.from(
    { length: 4 },
    (_, i) => `section ${i}: ${'t'.repeat(1500)}`,
  ).join('\n\n');
  writeMemory(memDir, 'gone.md', {
    name: 'Going away',
    description: 'Will be deleted',
    body: longBody,
  });
  writeMemory(memDir, 'stay.md', {
    name: 'Staying',
    description: 'Stays in the corpus',
    body: 'A short body that stays.',
  });
  const stub = stubFetch(() => OFF);
  try {
    await withProviderEnv(async () => {
      await rebuildIndex(memDir);
      const idxPath = indexPath(memDir);
      assert.ok(chunkRowCount(idxPath, 'gone') > 0);
      assert.ok(chunkRowCount(idxPath, 'stay') > 0);

      fs.rmSync(path.join(memDir, 'gone.md'));
      const result = await rebuildIndex(memDir);
      assert.equal(result.removed, 1);
      assert.equal(chunkRowCount(idxPath, 'gone'), 0, 'no orphan chunk rows');
      assert.equal(
        chunkVecRowCount(idxPath),
        chunkTotal(idxPath),
        'a removed memory leaves no orphan chunk vectors either',
      );
      assert.ok(chunkRowCount(idxPath, 'stay') > 0, 'the other memory keeps its chunks');
    });
  } finally {
    stub.restore();
    fs.rmSync(memDir, { recursive: true, force: true });
  }
});

test('chunk embeds batch by INPUT (64 per request), not by memory', async () => {
  const memDir = tmpDir('chunks-batching');
  // 10 memories x (1 document + 3 chunks) = 40 inputs, i.e. 4x the memory
  // count. Batching per MEMORY (the pre-chunking shape) would still put
  // them all in one request; the point pinned here is that the flat
  // input queue is what the 64 window counts.
  for (let i = 0; i < 10; i++) {
    writeMemory(memDir, `m${i}.md`, {
      name: `Memory ${i}`,
      description: 'Batching fixture',
      body: Array.from({ length: 3 }, (_, c) => `part ${c}: ${'u'.repeat(1500)}`).join('\n\n'),
    });
  }
  const stub = stubFetch(() => OFF);
  try {
    await withProviderEnv(async () => {
      const result = await rebuildIndex(memDir);
      assert.equal(result.embedded, 10);
      assert.equal(result.chunksEmbedded, 30);
      assert.equal(stub.inputs().length, 40, 'all inputs sent');
      assert.equal(stub.calls(), 1, '40 inputs fit the 64-input window');
    });
  } finally {
    stub.restore();
    fs.rmSync(memDir, { recursive: true, force: true });
  }
});

test('a corpus larger than the batch size splits across requests without misaligning vectors', async () => {
  const memDir = tmpDir('chunks-multi-batch');
  // 40 memories x (1 document + 2 chunks) = 120 inputs -> 2 requests of at
  // most 64. Each memory's SECOND chunk carries a unique marker, so the
  // assertions below prove every chunk vector landed on its OWN chunk
  // across the request boundary.
  const marker = (i: number): string => `needle${i}`;
  for (let i = 0; i < 40; i++) {
    writeMemory(memDir, `m${i}.md`, {
      name: `Mem${i}`,
      description: 'Align',
      body: `first part ${'v'.repeat(1500)}\n\nsecond part ${marker(i)} ${'w'.repeat(200)}`,
    });
  }
  const stub = stubFetch((input) => (/needle\d+/.test(input) ? ON : OFF));
  try {
    await withProviderEnv(async () => {
      const result = await rebuildIndex(memDir);
      assert.equal(result.embedded, 40);
      assert.equal(result.chunksEmbedded, 80);
      assert.equal(stub.calls(), 2, '120 inputs need two 64-input requests');
      const idxPath = indexPath(memDir);
      const rows = rawQuery<{ n: number }[]>(
        idxPath,
        'SELECT COUNT(*) AS n FROM chunk_vec WHERE rowid IN (SELECT rowid FROM chunks WHERE char_offset > 1000)',
      );
      assert.equal(rows[0].n, 40, 'every memory has exactly one marker chunk');
      const hits = openIndex({ path: idxPath, dimensions: 2 });
      try {
        const top = hits.searchChunks(ON, 40, MODEL);
        assert.equal(top.length, 40);
        for (const h of top) {
          assert.equal(h.chunkIndex, 1, `chunk of ${h.id} is the marker chunk`);
          assert.ok(h.similarity > 0.99, `${h.id} scored on its own marker chunk`);
        }
      } finally {
        hits.close();
      }
    });
  } finally {
    stub.restore();
    fs.rmSync(memDir, { recursive: true, force: true });
  }
});

// =========================================================================
// Which input wins the max. Each test registers its OWN vector table,
// so the test name states which input is expected to win.
// =========================================================================

const MULTI_SECTION_BODY = Array.from(
  { length: 4 },
  (_, i) => `section ${i} body ${'a'.repeat(1500)}`,
).join('\n\n');

test('document vector only: chunks exist but none matches, the document score wins and no chunk is attributed', async () => {
  await withProviderEnv(async () => {
    const memDir = tmpDir('chunks-ac5-doc-only');
    const body = MULTI_SECTION_BODY;
    const memory = {
      id: 'one',
      path: '',
      frontmatter: { name: 'One memory', description: 'Score case' },
      body,
    };
    const table = new Map<string, number[]>([['the query', ON]]);
    table.set(docInput(memory as never), ON);
    for (const c of chunkBody(body)) table.set(chunkInput(memory as never, c.text), OFF);
    const stub = stubFetch((input) => table.get(input) ?? OFF);
    try {
      writeMemory(memDir, 'one.md', {
        name: 'One memory',
        description: 'Score case',
        body,
      });
      await rebuildIndex(memDir);
      const hits = await semanticSearch('the query', loadMemoriesFromDir(memDir), memDir, 3);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].score > 0.99, 'document similarity');
      assert.equal(hits[0].chunk, undefined, 'the chunk did not win');
    } finally {
      stub.restore();
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });
});

test('chunks only better: the document vector misses, a later chunk matches and supplies both score and offset', async () => {
  await withProviderEnv(async () => {
    const memDir = tmpDir('chunks-ac5-chunk-better');
    const body = `${MULTI_SECTION_BODY}\n\nthe secret passphrase is zebra-quantum-flux\n\n${MULTI_SECTION_BODY}`;
    const memory = {
      id: 'one',
      path: '',
      frontmatter: { name: 'One memory', description: 'Score case' },
      body,
    };
    const chunks = chunkBody(body);
    assert.ok(chunks.length >= 4, 'fixture must produce several chunks');
    const table = new Map<string, number[]>([['the query', ON]]);
    table.set(docInput(memory as never), OFF);
    const winning = chunks.filter((c: { text: string }) => c.text.includes('zebra-quantum-flux'));
    assert.equal(winning.length, 1, 'exactly one chunk carries the marker');
    for (const c of chunks) {
      table.set(
        chunkInput(memory as never, c.text),
        c.text.includes('zebra-quantum-flux') ? ON : OFF,
      );
    }
    const stub = stubFetch((input) => table.get(input) ?? OFF);
    try {
      writeMemory(memDir, 'one.md', {
        name: 'One memory',
        description: 'Score case',
        body,
      });
      await rebuildIndex(memDir);
      const hits = await semanticSearch('the query', loadMemoriesFromDir(memDir), memDir, 3);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].score > 0.99, 'chunk similarity');
      assert.ok(hits[0].chunk, 'the winning chunk is exposed');
      assert.equal(hits[0].chunk?.offset, winning[0].offset);
      assert.equal(hits[0].chunk?.index, winning[0].index);
      assert.equal(winning[0].offset, body.indexOf('zebra-quantum-flux') - winning[0].text.indexOf('zebra-quantum-flux'));
    } finally {
      stub.restore();
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });
});

test('document vector better: a partial chunk match loses to the strong document vector', async () => {
  await withProviderEnv(async () => {
    const memDir = tmpDir('chunks-ac5-doc-better');
    const body = MULTI_SECTION_BODY;
    const memory = {
      id: 'one',
      path: '',
      frontmatter: { name: 'One memory', description: 'Score case' },
      body,
    };
    const table = new Map<string, number[]>([['the query', ON]]);
    table.set(docInput(memory as never), ON);
    for (const c of chunkBody(body)) table.set(chunkInput(memory as never, c.text), PARTIAL);
    const stub = stubFetch((input) => table.get(input) ?? OFF);
    try {
      writeMemory(memDir, 'one.md', {
        name: 'One memory',
        description: 'Score case',
        body,
      });
      await rebuildIndex(memDir);
      const hits = await semanticSearch('the query', loadMemoriesFromDir(memDir), memDir, 3);
      assert.equal(hits.length, 1);
      // cos(ON, PARTIAL) = 0.6 -> similarity 0.8; the document stays on 1.
      assert.ok(hits[0].score > 0.99, 'document similarity, not the chunk 0.8');
      assert.equal(hits[0].chunk, undefined);
    } finally {
      stub.restore();
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });
});

test('empty body: no chunk rows at all, score comes from the document vector alone', async () => {
  await withProviderEnv(async () => {
    const memDir = tmpDir('chunks-ac5-empty');
    const body = '';
    const memory = {
      id: 'one',
      path: '',
      frontmatter: { name: 'One memory', description: 'Score case' },
      body,
    };
    const table = new Map<string, number[]>([['the query', ON]]);
    table.set(docInput(memory as never), ON);
    const stub = stubFetch((input) => table.get(input) ?? OFF);
    try {
      writeMemory(memDir, 'one.md', {
        name: 'One memory',
        description: 'Score case',
        body,
      });
      const result = await rebuildIndex(memDir);
      assert.equal(result.chunksEmbedded, 0, 'an empty body gets zero chunks');
      const store = openIndex({ path: indexPath(memDir), dimensions: 2 });
      try {
        assert.deepEqual(store.listChunkIds(), []);
      } finally {
        store.close();
      }
      const hits = await semanticSearch('the query', loadMemoriesFromDir(memDir), memDir, 3);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].score > 0.99);
      assert.equal(hits[0].chunk, undefined);
    } finally {
      stub.restore();
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });
});

test('stale-model chunk rows present: they never score, the document vector decides', async () => {
  await withProviderEnv(async () => {
    const memDir = tmpDir('chunks-ac5-stale-chunks');
    const body = MULTI_SECTION_BODY;
    const memory = {
      id: 'one',
      path: '',
      frontmatter: { name: 'One memory', description: 'Score case' },
      body,
    };
    const table = new Map<string, number[]>([['the query', ON]]);
    table.set(docInput(memory as never), OFF);
    for (const c of chunkBody(body)) table.set(chunkInput(memory as never, c.text), OFF);
    const stub = stubFetch((input) => table.get(input) ?? OFF);
    try {
      writeMemory(memDir, 'one.md', {
        name: 'One memory',
        description: 'Score case',
        body,
      });
      await rebuildIndex(memDir);
      // A perfect chunk row left over from a different embedding model must
      // not lift the score: cosine across embedding spaces is meaningless.
      // chunk_index 99 is beyond anything this run wrote, so it does not
      // collide with the memory's own current-model rows.
      insertRawChunk(indexPath(memDir), 'one', 99, 100, 'model-STALE', ON);
      const hits = await semanticSearch('the query', loadMemoriesFromDir(memDir), memDir, 3);
      assert.equal(hits.length, 1);
      assert.ok(
        hits[0].score < 0.6,
        `orthogonal document+chunks give similarity 0.5, got ${hits[0].score}`,
      );
      assert.equal(hits[0].chunk, undefined);
    } finally {
      stub.restore();
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// The long-memory recall case, through the hook entry point
// =========================================================================

test('a memory whose only match sits past char 10,000 of its body is found by semanticSearch', async () => {
  const memDir = tmpDir('chunks-ac1');
  const body = longBodyWithMarker();
  const markerAt = body.indexOf(MARKER);
  const memory = {
    id: 'deep',
    path: '',
    frontmatter: { name: 'Deep rule', description: 'Buried in a long memory' },
    body,
  };
  const table = new Map<string, number[]>([['zebra-quantum-flux?', ON]]);
  table.set(docInput(memory as never), OFF);
  const chunks = chunkBody(body);
  const carriers = chunks.filter((c: { text: string }) => c.text.includes(MARKER));
  assert.equal(carriers.length, 1);
  for (const c of chunks) {
    table.set(
      chunkInput(memory as never, c.text),
      c.text.includes(MARKER) ? ON : OFF,
    );
  }
  const stub = stubFetch((input) => table.get(input) ?? OFF);
  try {
    await withProviderEnv(async () => {
      writeMemory(memDir, 'deep.md', {
        name: 'Deep rule',
        description: 'Buried in a long memory',
        body,
      });
      const result = await rebuildIndex(memDir);
      assert.equal(result.embedded, 1);
      assert.ok(result.chunksEmbedded >= 8, `expected >= 8 chunks, got ${result.chunksEmbedded}`);

      const memories = loadMemoriesFromDir(memDir);
      const hits = await semanticSearch('zebra-quantum-flux?', memories, memDir, 3);
      assert.equal(hits.length, 1, 'the deep memory is returned by semanticSearch');
      assert.equal(hits[0].memory.id, 'deep');
      assert.ok(
        hits[0].score > 0.99,
        `the chunk match must dominate (document vector is orthogonal, similarity 0.5), got ${hits[0].score}`,
      );
      assert.ok(hits[0].chunk, 'the winning chunk is exposed on the hit');
      assert.equal(hits[0].chunk?.index, carriers[0].index);
      assert.equal(hits[0].chunk?.offset, carriers[0].offset);
      assert.ok(markerAt > 10_000 && carriers[0].offset > 8000);
    });
  } finally {
    stub.restore();
    fs.rmSync(memDir, { recursive: true, force: true });
  }
});

// =========================================================================
// the only match sits under a FINAL heading-led section (the chunker must
// never drop the body's last section, and the index must carry it)
// =========================================================================

test('a memory whose only match sits under a final ## heading past char 10,000 is found by semanticSearch', async () => {
  const memDir = tmpDir('chunks-final-heading');
  const filler = Array.from(
    { length: 120 },
    (_, i) => `filler paragraph ${i} ${'f'.repeat(80)}`,
  ).join('\n\n');
  // The marker lives in the LAST section of the body, heading-led with no
  // blank line after the heading: exactly the shape the chunker used to
  // drop from every chunk.
  const body = `${filler}\n\n## Deep rule\n${MARKER}`;
  const markerAt = body.indexOf(MARKER);
  if (markerAt <= 10_000) throw new Error('fixture marker too shallow');
  const memory = {
    id: 'deep',
    path: '',
    frontmatter: { name: 'Deep rule', description: 'Final buried section' },
    body,
  };
  const table = new Map<string, number[]>([['zebra-final?', ON]]);
  table.set(docInput(memory as never), OFF);
  const chunks = chunkBody(body);
  const carriers = chunks.filter((c: { text: string }) => c.text.includes(MARKER));
  assert.equal(carriers.length, 1, 'the final section survives in exactly one chunk');
  for (const c of chunks) {
    table.set(
      chunkInput(memory as never, c.text),
      c.text.includes(MARKER) ? ON : OFF,
    );
  }
  const stub = stubFetch((input) => table.get(input) ?? OFF);
  try {
    await withProviderEnv(async () => {
      writeMemory(memDir, 'deep.md', {
        name: 'Deep rule',
        description: 'Final buried section',
        body,
      });
      const result = await rebuildIndex(memDir);
      assert.equal(result.embedded, 1);
      assert.ok(result.chunksEmbedded >= 8);
      const hits = await semanticSearch('zebra-final?', loadMemoriesFromDir(memDir), memDir, 3);
      assert.equal(hits.length, 1, 'the final-section memory is found');
      assert.equal(hits[0].memory.id, 'deep');
      assert.ok(hits[0].score > 0.99, 'the chunk match dominates');
      assert.equal(hits[0].chunk?.index, carriers[0].index);
      assert.equal(hits[0].chunk?.offset, carriers[0].offset);
      assert.ok(markerAt > 10_000 && carriers[0].offset > 8000);
    });
  } finally {
    stub.restore();
    fs.rmSync(memDir, { recursive: true, force: true });
  }
});

// =========================================================================
// interrupted rebuilds and orphan cleanup: a failed run must never leave
// a memory scoring on chunks of a body it no longer has
// =========================================================================

test('a rebuild interrupted mid-way re-chunks the edited memory on the next run (no stale chunks survive)', async () => {
  const memDir = tmpDir('chunks-interrupted');
  const word = (w: string, n: number): string =>
    Array.from({ length: n }, () => w).join(' ');
  const fm = { name: 'AX', description: 'The edited memory' };
  const oldBody = `alpha\n\n${word('oldphrase', 1500)}`;
  const newBody = `beta\n\n${word('newphrase', 1500)}`;
  const file = writeMemory(memDir, 'ax.md', { ...fm, body: oldBody });
  const docOld = docInput({ frontmatter: fm, body: oldBody } as never);
  const docNew = docInput({ frontmatter: fm, body: newBody } as never);

  await withProviderEnv(async () => {
    // Run 1: everything embeds; the old chunks score on the old text.
    const stub1 = stubFetch(
      (input) => (input === docOld ? OFF : input.includes('oldphrase') ? ON : OFF),
    );
    try {
      await rebuildIndex(memDir);
      const idxPath = indexPath(memDir);
      assert.ok(chunkRowCount(idxPath, 'ax') >= 3, 'fixture: the old body chunks up');
      const store = openIndex({ path: idxPath, dimensions: 2 });
      try {
        const top = store.searchChunks(ON, 5, MODEL);
        assert.equal(top.length, 1);
        assert.equal(top[0].id, 'ax', 'the old chunk vectors score on the old text');
        assert.ok(top[0].similarity > 0.99);
      } finally {
        store.close();
      }
    } finally {
      stub1.restore();
    }

    // The memory is edited AND 40 memories are added, so the embed work
    // spans more than one 64-input request.
    const idxPath = indexPath(memDir);
    const mtimeBefore = (
      rawQuery<{ mtime: number }[]>(idxPath, "SELECT mtime FROM entries WHERE id = 'ax'")
    )[0].mtime;
    bumpMtime(file);
    writeMemory(memDir, 'ax.md', { ...fm, body: newBody });
    for (let i = 0; i < 40; i++) {
      writeMemory(memDir, `m${String(i).padStart(2, '0')}.md`, {
        name: `M${i}`,
        description: 'Filler memory',
        body: `filler body ${i} ${'v'.repeat(1600)}`,
      });
    }

    // Run 2: the first request succeeds (the edited document row commits
    // with its new mtime), the second one fails like a dead provider.
    const stub2 = stubFetch(
      (input) => (input === docNew || input === docOld ? OFF : input.includes('newphrase') ? ON : OFF),
      { failOnRequest: 2 },
    );
    try {
      await assert.rejects(() => rebuildIndex(memDir), /stubbed embed failure on request 2/);
      // Precondition of the repro: the edited document row DID commit.
      const mtimeAfter = (
        rawQuery<{ mtime: number }[]>(idxPath, "SELECT mtime FROM entries WHERE id = 'ax'")
      )[0].mtime;
      assert.ok(mtimeAfter > mtimeBefore, 'run 2 committed the new document mtime');
      // The failed state: the OLD chunk vectors must not survive next to
      // that new mtime, or every later run would skip the memory and it
      // would keep ranking on text its body no longer contains.
      const store = openIndex({ path: idxPath, dimensions: 2 });
      try {
        assert.deepEqual(
          store.searchChunks(ON, 10, MODEL).filter((h: { id: string }) => h.id === 'ax'),
          [],
          'no old chunk vector of the edited memory survives the failed run',
        );
        // And the full hook path does not rank it by the old text either.
        const stubQ = stubFetch((input) => (input === 'q-old' ? ON : OFF));
        try {
          const hits = await semanticSearch('q-old', loadMemoriesFromDir(memDir), memDir, 3);
          for (const h of hits) {
            assert.ok(
              h.score < 0.9,
              `nothing may rank first on the old text (got ${h.memory.id} at ${h.score})`,
            );
          }
        } finally {
          stubQ.restore();
        }
      } finally {
        store.close();
      }
    } finally {
      stub2.restore();
    }

    // Run 3 (clean): the edited memory is RE-chunked from its current
    // body (the missing-chunks rule, not the mtime), and its chunk rows
    // now match that body exactly.
    const stub3 = stubFetch(
      (input) => (input === docNew || input === docOld ? OFF : input.includes('newphrase') ? ON : OFF),
    );
    try {
      const third = await rebuildIndex(memDir);
      const expected = chunkBody(newBody);
      assert.ok(expected.length >= 3, 'fixture: the new body chunks up');
      const rows = rawQuery<{ chunk_index: number; char_offset: number }[]>(
        idxPath,
        'SELECT chunk_index, char_offset FROM chunks WHERE id = \'ax\' ORDER BY chunk_index',
      );
      assert.deepEqual(
        rows,
        expected.map((c: { index: number; offset: number }) => ({
          chunk_index: c.index,
          char_offset: c.offset,
        })),
        'the chunks match the current body exactly',
      );
      assert.equal(
        chunkVecRowCount(idxPath),
        chunkTotal(idxPath),
        'no orphan chunk vectors after the recovery run',
      );
      const store = openIndex({ path: idxPath, dimensions: 2 });
      try {
        const top = store.searchChunks(ON, 10, MODEL);
        const ax = top.filter((h: { id: string }) => h.id === 'ax');
        assert.equal(ax.length, 1);
        assert.ok(ax[0].similarity > 0.99, 'the new chunks carry the new text');
      } finally {
        store.close();
      }
      assert.ok(third.total > 40);
    } finally {
      stub3.restore();
    }
  });
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('a rebuild that fails on its first request leaves the edited memory document-only and re-chunks it next run', async () => {
  const memDir = tmpDir('chunks-first-request-fails');
  const word = (w: string, n: number): string =>
    Array.from({ length: n }, () => w).join(' ');
  const fm = { name: 'AX', description: 'The edited memory' };
  const oldBody = `alpha\n\n${word('oldphrase', 1500)}`;
  const newBody = `beta\n\n${word('newphrase', 1500)}`;
  const file = writeMemory(memDir, 'ax.md', { ...fm, body: oldBody });
  const idxPath = indexPath(memDir);

  await withProviderEnv(async () => {
    const stub1 = stubFetch((input) => (input.includes('oldphrase') ? ON : OFF));
    try {
      await rebuildIndex(memDir);
      assert.ok(chunkRowCount(idxPath, 'ax') >= 3, 'fixture: the old body chunks up');
    } finally {
      stub1.restore();
    }
    const mtimeBefore = (
      rawQuery<{ mtime: number }[]>(idxPath, "SELECT mtime FROM entries WHERE id = 'ax'")
    )[0].mtime;
    bumpMtime(file);
    writeMemory(memDir, 'ax.md', { ...fm, body: newBody });

    // Run 2 fails before any document upsert commits.
    const stub2 = stubFetch(() => OFF, { failOnRequest: 1 });
    try {
      await assert.rejects(() => rebuildIndex(memDir), /stubbed embed failure on request 1/);
      const mtimeAfter = (
        rawQuery<{ mtime: number }[]>(idxPath, "SELECT mtime FROM entries WHERE id = 'ax'")
      )[0].mtime;
      assert.equal(mtimeAfter, mtimeBefore, 'the document row was not rewritten');
      assert.equal(chunkRowCount(idxPath, 'ax'), 0, 'the old chunks were dropped anyway');
    } finally {
      stub2.restore();
    }

    // Run 3: the stale document and the missing chunks are both rebuilt;
    // run 4 has nothing left to do.
    const stub3 = stubFetch((input) => (input.includes('newphrase') ? ON : OFF));
    try {
      const third = await rebuildIndex(memDir);
      assert.equal(third.embedded, 1);
      assert.equal(chunkRowCount(idxPath, 'ax'), chunkBody(newBody).length);
      const fourth = await rebuildIndex(memDir);
      assert.equal(fourth.embedded, 0);
      assert.equal(fourth.chunksEmbedded, 0);
    } finally {
      stub3.restore();
    }
  });
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('a rebuild purges orphan chunk rows whose id has no memory and no entries row', async () => {
  const memDir = tmpDir('chunks-purge');
  writeMemory(memDir, 'stay.md', {
    name: 'Staying',
    description: 'Stays in the corpus',
    body: 'A short body that stays.',
  });
  const stub = stubFetch(() => OFF);
  try {
    await withProviderEnv(async () => {
      await rebuildIndex(memDir);
      const idxPath = indexPath(memDir);
      // A chunk row for an id with neither a file nor an entries row:
      // what an older build's remove() could leave behind. The removal
      // loop iterates entries only, so the rebuild must also sweep chunk
      // ids.
      insertRawChunk(idxPath, 'ghost', 0, 0, MODEL, ON);
      const result = await rebuildIndex(memDir);
      assert.equal(result.removed, 0, 'no entries row existed to remove');
      assert.equal(chunkRowCount(idxPath, 'ghost'), 0, 'the orphan chunk row is purged');
      assert.ok(chunkRowCount(idxPath, 'stay') > 0, 'the real memory keeps its chunks');
      assert.equal(chunkVecRowCount(idxPath), chunkTotal(idxPath));
    });
  } finally {
    stub.restore();
    fs.rmSync(memDir, { recursive: true, force: true });
  }
});

// =========================================================================
// the k cut: the merged document + chunk ranking must be cut to exactly k
// hits, not k per source list
// =========================================================================

test('the merged result is cut to exactly k when the document top-k and the chunk top-k are disjoint', async () => {
  await withProviderEnv(async () => {
    const memDir = tmpDir('chunks-k-cut');
    const body = MULTI_SECTION_BODY;
    const memA = {
      id: 'a',
      path: '',
      frontmatter: { name: 'Alpha', description: 'Doc winner' },
      body,
    };
    const memB = {
      id: 'b',
      path: '',
      frontmatter: { name: 'Beta', description: 'Chunk winner' },
      body,
    };
    const chunksB = chunkBody(body);
    const bWinners = chunksB.filter((c: { text: string }) => c.text.includes('section 0'));
    assert.equal(bWinners.length, 1);
    const table = new Map<string, number[]>([['q-doc', ON], ['q-chunk', PARTIAL]]);
    table.set(docInput(memA as never), ON); // A wins the document list
    table.set(docInput(memB as never), OFF);
    for (const c of chunkBody(body)) table.set(chunkInput(memA as never, c.text), OFF);
    for (const c of chunksB) {
      table.set(
        chunkInput(memB as never, c.text),
        c.text.includes('section 0') ? PARTIAL : OFF,
      ); // B wins the chunk list
    }
    const stub = stubFetch((input) => table.get(input) ?? OFF);
    try {
      writeMemory(memDir, 'a.md', { name: 'Alpha', description: 'Doc winner', body });
      writeMemory(memDir, 'b.md', { name: 'Beta', description: 'Chunk winner', body });
      await rebuildIndex(memDir);
      const memories = loadMemoriesFromDir(memDir);

      // k = 1 with disjoint winners: without the final cut the merge
      // returns up to 2k hits (one per source list).
      const docWin = await semanticSearch('q-doc', memories, memDir, 1);
      assert.equal(docWin.length, 1, 'exactly k hits, not one per source list');
      assert.equal(docWin[0].memory.id, 'a', 'the document winner leads');
      assert.ok(docWin[0].score > 0.99);
      assert.equal(docWin[0].chunk, undefined, 'its document vector produced the score');

      // Same corpus, chunk-favoring query: exactly k on that side too.
      const chunkWin = await semanticSearch('q-chunk', memories, memDir, 1);
      assert.equal(chunkWin.length, 1, 'exactly k hits');
      assert.equal(chunkWin[0].memory.id, 'b', 'the chunk winner leads');
      assert.ok(chunkWin[0].score > 0.99, 'chunk similarity');
      assert.equal(chunkWin[0].chunk?.index, bWinners[0].index);
      assert.equal(chunkWin[0].chunk?.offset, bWinners[0].offset);
    } finally {
      stub.restore();
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });
});
