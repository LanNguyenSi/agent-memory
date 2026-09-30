// `lint --conflicts --semantic` reads the embedding index opportunistically
// to reuse stored embeddings. That read must never change what the index
// records about itself: opening a width-less index writable with a fixed
// width hint used to create the vector table at 1536 and record
// embed_dimensions=1536, after which semanticSearch and `memory-router
// index` under a provider of another width threw a dimension mismatch until
// the index was rebuilt. This file pins the read-only open, the
// unchanged behaviour on an index that already has a width, that the index
// file stays byte-identical (a writable open would migrate a legacy layout
// or initialise an empty file), and the degrade when the index cannot be
// opened at all (one warning, no reuse, fresh embedding as with no index).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { openIndex } = require('../src/embed/index-store');
const { indexPath, semanticSearch } = require('../src/embed/indexer');
const { loadMemoriesFromDir } = require('../src/memory/loader');
const {
  lintMemoryDirForConflicts,
  lintMemoryDirForConflictsWithSemantic,
} = require('../src/lint/conflicts');

const MODEL = 'width-test-768';
const WIDTH = 768;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-lint-width-'));
}

function writeMem(dir: string, name: string, frontmatter: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `---\n${frontmatter}\n---\n\n${body}\n`);
}

// Two opposite-polarity memories with disjoint vocabulary: the regex pass
// keeps them at INFO, so the semantic pass is what decides the upgrade.
function writePair(dir: string): void {
  writeMem(
    dir,
    'feedback_squash_yes.md',
    'name: squash always\ndescription: one tidy commit\ntype: feedback\ntopics: [workflow]',
    'ALWAYS squash before merge to keep master tidy.',
  );
  writeMem(
    dir,
    'feedback_ff_only.md',
    'name: fast-forward only\ndescription: keep linear history without squash\ntype: feedback\ntopics: [workflow]',
    'NEVER rewrite history during merge; use fast-forward only.',
  );
}

function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const keys = [
    'MEMORY_ROUTER_EMBED_PROVIDER',
    'MEMORY_ROUTER_EMBED_MODEL',
    'OPENAI_API_KEY',
  ];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  process.env.MEMORY_ROUTER_EMBED_PROVIDER = 'ollama';
  process.env.MEMORY_ROUTER_EMBED_MODEL = MODEL;
  delete process.env.OPENAI_API_KEY;
  return fn().finally(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any) => {
    lines.push(String(chunk));
    return true;
  };
  return { lines, restore: () => { process.stderr.write = orig; } };
}

function stubFetch(width: number): () => void {
  const orig = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { body?: string },
  ) => {
    const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: body.input.map((_t, index) => ({
          embedding: new Array(width).fill(0).map((_v, i) => (i === 0 ? 1 : 0)),
          index,
        })),
      }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => {
    if (orig) (globalThis as { fetch: typeof fetch }).fetch = orig;
  };
}

function readMeta(idx: string, key: string): string | null {
  const db = new Database(idx, { readonly: true });
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  } finally {
    db.close();
  }
}

function hasVecTable(idx: string): boolean {
  const db = new Database(idx, { readonly: true });
  try {
    return (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec'")
        .get() !== undefined
    );
  } finally {
    db.close();
  }
}

test('lint --semantic on an index with no recorded width leaves it width-less and a non-1536 search returns []', async () => {
  const dir = tmpDir();
  writePair(dir);
  const idx = indexPath(dir);
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  // A first `memory-router index` whose embed call failed after the file
  // was created: the file exists, no embedding was ever written.
  openIndex({ path: idx }).close();
  assert.equal(readMeta(idx, 'embed_dimensions'), null, 'precondition: no width');
  assert.equal(hasVecTable(idx), false, 'precondition: no vector table');

  const restoreFetch = stubFetch(WIDTH);
  try {
    await withEnv(async () => {
      const report = await lintMemoryDirForConflictsWithSemantic(dir, {
        semantic: true,
        embedFn: async (texts: string[]) => texts.map(() => [1, 0, 0]),
      });
      const high = report.hits.filter(
        (h: { severity: string }) => h.severity === 'high',
      );
      assert.equal(high.length, 1, 'semantic pass still upgrades via fresh embeddings');

      assert.equal(readMeta(idx, 'embed_dimensions'), null, 'width must stay unrecorded');
      assert.equal(hasVecTable(idx), false, 'no vector table may be created by lint');

      const hits = await semanticSearch(
        'squash before merge',
        loadMemoriesFromDir(dir),
        dir,
        5,
      );
      assert.deepEqual(hits, [], 'search under a non-1536 model returns [] instead of throwing');
    });
  } finally {
    restoreFetch();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint --semantic on an index with a recorded width still reuses stored embeddings unchanged', async () => {
  const dir = tmpDir();
  writePair(dir);
  const idx = indexPath(dir);
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  const vec = new Array(WIDTH).fill(0).map((_v, i) => (i === 0 ? 1 : 0));
  const store = openIndex({ path: idx });
  for (const m of loadMemoriesFromDir(dir)) store.upsert(m.id, 1, MODEL, vec);
  store.close();
  assert.equal(readMeta(idx, 'embed_dimensions'), String(WIDTH));

  try {
    await withEnv(async () => {
      let embedCalls = 0;
      const report = await lintMemoryDirForConflictsWithSemantic(dir, {
        semantic: true,
        embedFn: async (texts: string[]) => {
          embedCalls += 1;
          return texts.map(() => [0, 1, 0]);
        },
      });
      assert.equal(embedCalls, 0, 'every needed embedding comes from the index');
      const high = report.hits.filter(
        (h: { severity: string }) => h.severity === 'high',
      );
      assert.equal(high.length, 1, 'stored identical vectors clear the threshold');
      assert.match(high[0].reason, /semantic similarity 100%/);
      assert.equal(readMeta(idx, 'embed_dimensions'), String(WIDTH), 'recorded width unchanged');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Runs the semantic lint against a corpus whose index file was prepared by
// `prepare`, and returns the report, the captured stderr lines and the
// index file hash before and after.
async function lintWithIndex(
  prepare: (idx: string) => void,
): Promise<{
  high: number;
  warnings: string[];
  before: string;
  after: string;
}> {
  const dir = tmpDir();
  writePair(dir);
  const idx = indexPath(dir);
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  prepare(idx);
  const before = sha256(idx);
  const cap = captureStderr();
  try {
    let high = 0;
    await withEnv(async () => {
      const report = await lintMemoryDirForConflictsWithSemantic(dir, {
        semantic: true,
        embedFn: async (texts: string[]) => texts.map(() => [1, 0, 0]),
      });
      high = report.hits.filter((h: { severity: string }) => h.severity === 'high').length;
    });
    return {
      high,
      warnings: cap.lines.filter((l) => l.includes('cannot open embedding index')),
      before,
      after: sha256(idx),
    };
  } finally {
    cap.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('lint --semantic leaves a zero-byte index file byte-identical and still upgrades via fresh embeddings', async () => {
  const r = await lintWithIndex((idx) => fs.writeFileSync(idx, ''));
  assert.equal(r.after, r.before, 'index bytes unchanged (a writable open would initialise it)');
  assert.equal(r.high, 1, 'semantic upgrade still happens without the index');
  assert.equal(r.warnings.length, 1, 'exactly one warning line');
  assert.equal(countOf(r.warnings[0], 'memory-router index'), 1, 'rebuild hint exactly once');
  assert.match(r.warnings[0], /memory-router index \S+ to rebuild it/, 'hint names the memory dir');
});

test('lint --semantic leaves a legacy pre-meta index file byte-identical and still upgrades via fresh embeddings', async () => {
  const r = await lintWithIndex((idx) => {
    const db = new Database(idx);
    db.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, mtime INTEGER NOT NULL)');
    db.close();
  });
  assert.equal(r.after, r.before, 'index bytes unchanged (a writable open would migrate it)');
  assert.equal(r.high, 1, 'semantic upgrade still happens without the index');
  assert.equal(r.warnings.length, 1, 'exactly one warning line');
  assert.match(r.warnings[0], /no such table: meta/, 'raw reason kept');
  assert.equal(countOf(r.warnings[0], 'memory-router index'), 1, 'rebuild hint exactly once');
});

test('lint --semantic warns with the reason for an inconsistent-width index, leaves it unchanged and still upgrades', async () => {
  const r = await lintWithIndex((idx) => {
    const vec = new Array(WIDTH).fill(0).map((_v, i) => (i === 0 ? 1 : 0));
    const store = openIndex({ path: idx });
    store.upsert('some-memory', 1, MODEL, vec);
    store.close();
    const db = new Database(idx);
    db.prepare("UPDATE meta SET value = '1536' WHERE key = 'embed_dimensions'").run();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  });
  assert.equal(r.after, r.before, 'index bytes unchanged');
  assert.equal(r.high, 1, 'semantic upgrade still happens without reuse');
  assert.equal(r.warnings.length, 1, 'exactly one warning line');
  assert.match(r.warnings[0], /internally inconsistent/, 'warning carries the reason');
  assert.equal(countOf(r.warnings[0], 'rebuild'), 1, 'the existing rebuild hint is not repeated');
  assert.equal(countOf(r.warnings[0], 'memory-router index'), 0, 'no second hint appended');
});
