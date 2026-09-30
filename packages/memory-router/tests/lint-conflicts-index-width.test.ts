// `lint --conflicts --semantic` reads the embedding index opportunistically
// to reuse stored embeddings. That read must never change what the index
// records about itself: opening a width-less index writable with a fixed
// width hint used to create the vector table at 1536 and record
// embed_dimensions=1536, after which semanticSearch and `memory-router
// index` under a provider of another width threw a dimension mismatch until
// the index was rebuilt. This file pins the read-only open, the
// unchanged behaviour on an index that already has a width, and the
// degrade (skip with one warning) when the index cannot be opened at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
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

test('lint --semantic skips with one warning and returns the regex-only report when the index cannot be opened', async () => {
  const dir = tmpDir();
  writePair(dir);
  const idx = indexPath(dir);
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  fs.writeFileSync(idx, 'this is not a sqlite database');

  const cap = captureStderr();
  try {
    await withEnv(async () => {
      const base = lintMemoryDirForConflicts(dir);
      const report = await lintMemoryDirForConflictsWithSemantic(dir, {
        semantic: true,
        embedFn: async (texts: string[]) => texts.map(() => [1, 0, 0]),
      });
      assert.deepEqual(report, base, 'identical to the run without --semantic');
    });
    const warnings = cap.lines.filter((l) =>
      l.includes('--semantic skipped: cannot open embedding index'),
    );
    assert.equal(warnings.length, 1, 'exactly one warning line');
  } finally {
    cap.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
