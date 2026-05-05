const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { openIndex, applyMigrations } = require('../src/embed/index-store');

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-store-'));
  return path.join(dir, 'idx.sqlite');
}

test('upsert + search roundtrip returns nearest-neighbour by cosine', () => {
  const dbPath = tmpDb();
  const store = openIndex({ path: dbPath, dimensions: 3 });
  try {
    // Three unit-ish vectors along distinct axes.
    store.upsert('x', 100, [1, 0, 0]);
    store.upsert('y', 100, [0, 1, 0]);
    store.upsert('z', 100, [0, 0, 1]);

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
    store.upsert('a', 100, [1, 0]);
    store.upsert('a', 200, [0, 1]); // rewrite
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
    store.upsert('a', 100, [1, 0]);
    store.upsert('b', 100, [0, 1]);
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

test('fresh DB is tagged with schema_version=1 on first open', () => {
  const dbPath = tmpDb();
  const store = openIndex({ path: dbPath, dimensions: 2 });
  store.close();
  const raw = new Database(dbPath);
  try {
    const row = raw
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    assert.equal(row?.value, '1');
  } finally {
    raw.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('pre-meta DB (entries already exist, no meta table) is tagged v1 without data loss', () => {
  const dbPath = tmpDb();
  // Populate at v1 the normal way, then strip the meta table to simulate a
  // file written by a memory-router build that predates this PR.
  const seed = openIndex({ path: dbPath, dimensions: 2 });
  seed.upsert('keep-me', 100, [1, 0]);
  seed.upsert('also-me', 200, [0, 1]);
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
      assert.equal(row?.value, '1');
    } finally {
      check.close();
    }
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('explicit schema_version=0 runs the 0→1 migration on next open with no data loss', () => {
  const dbPath = tmpDb();
  // Seed normally, then clobber the version to 0 to force the migration path.
  const seed = openIndex({ path: dbPath, dimensions: 2 });
  seed.upsert('survivor', 100, [1, 0]);
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
      assert.equal(row?.value, '1');
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
  seed.upsert('survivor', 100, [1, 0]);
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

test('dimension mismatch on upsert or search throws', () => {
  const dbPath = tmpDb();
  const store = openIndex({ path: dbPath, dimensions: 3 });
  try {
    assert.throws(() => store.upsert('bad', 100, [1, 0]), /dimension 2 != index dimension 3/);
    assert.throws(() => store.search([1, 0], 1), /dimension 2 != index dimension 3/);
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
