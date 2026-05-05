const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { openIndex, applyMigrations } = require('../src/embed/index-store');

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-store-'));
  return path.join(dir, 'idx.sqlite');
}

const M = 'text-embedding-3-small';

test('upsert + search roundtrip returns nearest-neighbour by cosine', () => {
  const dbPath = tmpDb();
  const store = openIndex({ path: dbPath, dimensions: 3 });
  try {
    // Three unit-ish vectors along distinct axes.
    store.upsert('x', 100, M, [1, 0, 0]);
    store.upsert('y', 100, M, [0, 1, 0]);
    store.upsert('z', 100, M, [0, 0, 1]);

    const hits = store.search([0.9, 0.1, 0], 3);
    assert.equal(hits[0].id, 'x', 'closest to x-axis query');
    assert.ok(hits[0].similarity > hits[1].similarity);
    assert.ok(hits[0].similarity <= 1);
    assert.ok(hits[hits.length - 1].similarity >= 0);
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('upsert is idempotent and reflects updated embedding', () => {
  const dbPath = tmpDb();
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    store.upsert('a', 100, M, [1, 0]);
    store.upsert('a', 200, M, [0, 1]); // rewrite
    const entries = store.listEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].mtime, 200);

    const [topHit] = store.search([0, 1], 1);
    assert.equal(topHit.id, 'a');
    assert.ok(topHit.similarity > 0.99, `expected near-identical, got ${topHit.similarity}`);
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('remove drops the entry + its vector', () => {
  const dbPath = tmpDb();
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    store.upsert('a', 100, M, [1, 0]);
    store.upsert('b', 100, M, [0, 1]);
    store.remove('a');
    const entries = store.listEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'b');

    const hits = store.search([1, 0], 5);
    assert.ok(!hits.some((h: { id: string }) => h.id === 'a'));
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('fresh DB is tagged at CURRENT_SCHEMA_VERSION on first open', () => {
  const dbPath = tmpDb();
  const store = openIndex({ path: dbPath, dimensions: 2 });
  store.close();
  const raw = new Database(dbPath);
  try {
    const row = raw
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    // BASELINE is v1; v2 migration runs immediately on a fresh open, so
    // the on-disk version reflects the current code's CURRENT.
    assert.equal(row?.value, '2');
  } finally {
    raw.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('pre-meta DB (entries already exist, no meta table) migrates to CURRENT without data loss', () => {
  const dbPath = tmpDb();
  // Populate at v1 the normal way, then strip the meta table to simulate a
  // file written by a memory-router build that predates this PR.
  const seed = openIndex({ path: dbPath, dimensions: 2 });
  seed.upsert('keep-me', 100, M, [1, 0]);
  seed.upsert('also-me', 200, M, [0, 1]);
  seed.close();

  const raw = new Database(dbPath);
  raw.exec('DROP TABLE meta');
  raw.close();

  // Reopening must tag the file as v1 and leave entries untouched.
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    const entries = store.listEntries();
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((e: { id: string }) => e.id).sort(),
      ['also-me', 'keep-me'],
    );

    const check = new Database(dbPath);
    try {
      const row = check
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      // Pre-meta files are tagged BASELINE=1 then migrated up to CURRENT=2.
      assert.equal(row?.value, '2');
    } finally {
      check.close();
    }
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('explicit schema_version=0 runs full migration chain with no data loss', () => {
  const dbPath = tmpDb();
  // Seed normally, then clobber the version to 0 to force the migration path.
  const seed = openIndex({ path: dbPath, dimensions: 2 });
  seed.upsert('survivor', 100, M, [1, 0]);
  seed.close();

  const raw = new Database(dbPath);
  raw.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
  raw.close();

  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    const entries = store.listEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'survivor');

    const check = new Database(dbPath);
    try {
      const row = check
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      // 0 → 1 (no-op) → 2 (ALTER TABLE adds model). Final version = 2.
      assert.equal(row?.value, '2');
    } finally {
      check.close();
    }
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('a throwing migration rolls back the version bump and leaves data intact', () => {
  const dbPath = tmpDb();
  // Seed at v1, then force the version row back to 0 so applyMigrations has
  // to run a 0→1 transition.
  const seed = openIndex({ path: dbPath, dimensions: 2 });
  seed.upsert('survivor', 100, M, [1, 0]);
  seed.close();

  const raw = new Database(dbPath);
  raw.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
  raw.close();

  const failingMigrations = [
    {
      from: 0,
      to: 1,
      run: () => {
        throw new Error('forced failure for rollback test');
      },
    },
  ];

  const conn = new Database(dbPath);
  try {
    assert.throws(() => applyMigrations(conn, failingMigrations), /forced failure/);

    const versionRow = conn
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    assert.equal(versionRow.value, '0', 'version row must roll back on migration failure');

    const entriesCount = (
      conn.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }
    ).n;
    assert.equal(entriesCount, 1, 'pre-migration data must survive a failed migration');
  } finally {
    conn.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('malformed schema_version (non-integer) is rejected', () => {
  const dbPath = tmpDb();
  const seed = openIndex({ path: dbPath, dimensions: 2 });
  seed.close();

  const raw = new Database(dbPath);
  raw.prepare("UPDATE meta SET value = 'abc' WHERE key = 'schema_version'").run();
  raw.close();

  assert.throws(
    () => openIndex({ path: dbPath, dimensions: 2 }),
    /invalid schema_version/,
  );
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('schema_version newer than CURRENT throws', () => {
  const dbPath = tmpDb();
  const seed = openIndex({ path: dbPath, dimensions: 2 });
  seed.close();

  const raw = new Database(dbPath);
  raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  raw.close();

  assert.throws(
    () => openIndex({ path: dbPath, dimensions: 2 }),
    /schema_version 99 is newer/,
  );
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

// Cross-model safety (v2 schema). Two embedding models on the same DB
// have incompatible vector spaces; cosine across them is meaningless.
// getEmbedding/search must reject rows whose stored model differs from
// the caller's expectation, including pre-v2 NULL rows.
test('getEmbedding rejects rows under a different model', () => {
  const dbPath = tmpDb();
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    store.upsert('a', 100, 'model-A', [1, 0]);
    // Same id with a different stored model overwrites the row, so use
    // a separate id to keep both models present.
    store.upsert('b', 100, 'model-B', [0, 1]);

    // No expectedModel: both visible.
    assert.deepEqual(
      store.getEmbedding('a'),
      [1, 0],
    );
    assert.deepEqual(
      store.getEmbedding('b'),
      [0, 1],
    );

    // expectedModel='model-A': 'b' is rejected.
    assert.deepEqual(
      store.getEmbedding('a', 'model-A'),
      [1, 0],
    );
    assert.equal(
      store.getEmbedding('b', 'model-A'),
      null,
      'cross-model row must not be returned',
    );

    // Unknown id is null regardless of model.
    assert.equal(store.getEmbedding('missing', 'model-A'), null);
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('search filters out cross-model rows when expectedModel is given', () => {
  const dbPath = tmpDb();
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    store.upsert('a', 100, 'model-A', [1, 0]);
    store.upsert('b', 100, 'model-B', [0.99, 0.01]);

    // No expectedModel: both candidates surface; the closer one wins.
    const allHits = store.search([1, 0], 5);
    assert.equal(allHits.length, 2);

    // expectedModel filters out the wrong-model row.
    const filtered = store.search([1, 0], 5, 'model-A');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'a');
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('pre-v2 NULL-model row is rejected by getEmbedding/search with expectedModel', () => {
  const dbPath = tmpDb();
  // Open a fresh DB (already migrated to v2). Insert a row with
  // model=NULL via direct SQL to simulate one that survived the
  // migration without a model stamp (real-world: a v1 file gets
  // ALTER TABLE'd, every row stays NULL until rebuildIndex runs).
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    store.upsert('legit', 100, 'model-X', [1, 0]);
    // Force a NULL-model row to mimic the post-ALTER state. The raw
    // connection has to load sqlite-vec so the vec virtual table is
    // writable; otherwise SQLite throws "no such module: vec0".
    const raw = new Database(dbPath);
    sqliteVec.load(raw);
    raw.prepare('INSERT INTO entries (id, mtime, model) VALUES (?, ?, NULL)').run(
      'legacy',
      100,
    );
    const rowid = (raw
      .prepare('SELECT rowid FROM entries WHERE id = ?')
      .get('legacy') as { rowid: number }).rowid;
    const blob = Buffer.from(new Float32Array([0, 1]).buffer);
    raw
      .prepare('INSERT INTO vec (rowid, embedding) VALUES (?, ?)')
      .run(BigInt(rowid), blob);
    raw.close();

    assert.equal(
      store.getEmbedding('legacy', 'model-X'),
      null,
      'NULL-model row must be rejected when an expectedModel is set',
    );
    // Without expectedModel the legacy row is still readable (caller
    // explicitly opted out of the filter).
    assert.deepEqual(store.getEmbedding('legacy'), [0, 1]);

    const filtered = store.search([0, 1], 5, 'model-X');
    assert.deepEqual(
      filtered.map((h: { id: string }) => h.id),
      ['legit'],
      'NULL-model rows must not appear in expected-model search',
    );

    // countEntriesWithStaleModel surfaces the legacy row.
    assert.equal(store.countEntriesWithStaleModel('model-X'), 1);
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('upsert without a model name throws (empty / undefined / non-string)', () => {
  const dbPath = tmpDb();
  const store = openIndex({ path: dbPath, dimensions: 2 });
  try {
    // Calling upsert without the model arg used to be valid in v1; v2
    // requires it. Pin the runtime check so a JS caller (no TS types)
    // doesn't silently insert NULL — and so a v1 caller hitting the
    // old 3-arg signature `upsert(id, mtime, vec)` gets the helpful
    // "non-empty model name" error instead of a TypeError on
    // `embedding.length`.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    assert.throws(
      () => (store.upsert as any)('x', 100, '', [1, 0]),
      /non-empty model name/,
      'empty string',
    );
    assert.throws(
      () => (store.upsert as any)('x', 100, undefined, [1, 0]),
      /non-empty model name/,
      'undefined',
    );
    assert.throws(
      () => (store.upsert as any)('x', 100, 42, [1, 0]),
      /non-empty model name/,
      'non-string',
    );
    // v1 call shape: `upsert(id, mtime, vec)`. The third arg becomes the
    // "model" string check, which fails (the array isn't a string).
    assert.throws(
      () => (store.upsert as any)('x', 100, [1, 0]),
      /non-empty model name/,
      'v1 3-arg shape',
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('dimension mismatch on upsert or search throws', () => {
  const dbPath = tmpDb();
  const store = openIndex({ path: dbPath, dimensions: 3 });
  try {
    assert.throws(() => store.upsert('bad', 100, M, [1, 0]), /dimension 2 != index dimension 3/);
    assert.throws(() => store.search([1, 0], 1), /dimension 2 != index dimension 3/);
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
