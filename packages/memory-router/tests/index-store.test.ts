const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { openIndex } = require('../src/embed/index-store');

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
