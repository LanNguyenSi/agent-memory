// A corrupt or dropped FTS index must never turn a working search into a
// failed one, and it must never fail SILENTLY either: the store-level catch in
// ftsDocCount/ftsMatch (src/embed/index-store.ts) degrades the keyword pass to
// "no keyword matches" and writes ONE stderr warning line per process (the
// same once-per-process shape as the missing-index / stale-model /
// keyword-pass warnings in src/embed/indexer.ts). docs/scoring.md and
// docs/okf/semantic-search-silent-noop.md both promise exactly this.
//
// The break is exercised through the real blendedSearch path: after a rebuild
// the FTS virtual table is replaced by a plain look-alike table (same name, so
// the open-time probe still sees it and ftsTablesReady stays true, but every
// MATCH query throws "no such column: chunks_fts"). The index-store module is
// re-required fresh so the once-per-process flag starts clear and the "written
// once, never again" assertion does not depend on test order.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const STORE_PATH = require.resolve('../src/embed/index-store');
const INDEXER_PATH = require.resolve('../src/embed/indexer');
const MODEL = 'text-embedding-3-small';
const FTS_WARN_RE = /FTS keyword index query failed, continuing without keyword matches/g;

function freshBlendedSearch() {
  // Drop BOTH module caches so the fresh indexer picks up a fresh store (the
  // once-per-process ftsWarned flag lives in the store module).
  delete require.cache[STORE_PATH];
  delete require.cache[INDEXER_PATH];
  return require('../src/embed/indexer').blendedSearch;
}

const ENV_NAMES = [
  'OPENAI_API_KEY',
  'MEMORY_ROUTER_EMBED_PROVIDER',
  'MEMORY_ROUTER_EMBED_MODEL',
  'MEMORY_ROUTER_OLLAMA_EMBED_MODEL',
  'MEMORY_ROUTER_KEYWORD',
  'MEMORY_ROUTER_KEYWORD_BOOST',
];
const savedEnv: Record<string, string | undefined> = {};
test.before(() => {
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.MEMORY_ROUTER_EMBED_PROVIDER = 'openai';
  process.env.MEMORY_ROUTER_EMBED_MODEL = MODEL;
  delete process.env.MEMORY_ROUTER_OLLAMA_EMBED_MODEL;
  delete process.env.MEMORY_ROUTER_KEYWORD;
  delete process.env.MEMORY_ROUTER_KEYWORD_BOOST;
});
test.after(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function deterministicVector(seed: number): number[] {
  const out: number[] = [];
  let s = seed || 1;
  for (let i = 0; i < 1536; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out.push(s / 0x7fffffff);
  }
  return out;
}

function stubFetch(): () => void {
  const orig = (globalThis as { fetch?: typeof fetch }).fetch;
  let nextSeed = 1;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { body?: string },
  ) => {
    const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
    const data = body.input.map((_text: string, idx: number) => ({
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
  return () => {
    if (orig) (globalThis as { fetch: typeof fetch }).fetch = orig;
  };
}

// Capture every process.stderr.write chunk while `fn` runs.
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  (process.stderr as unknown as { write: typeof origWrite }).write = ((
    chunk: string | Uint8Array,
  ) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof origWrite;
  try {
    await fn();
  } finally {
    process.stderr.write = origWrite;
  }
  return captured;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-fts-warn-'));
}

test('a corrupt FTS index (broken after open): blendedSearch keeps the semantic hits and warns once', async () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'task.md'),
    '---\nname: task\ndescription: task tracker\ntype: reference\n---\n\ncarry task 4e7729ab across branches\n',
  );
  const restoreFetch = stubFetch();
  try {
    // Build a real v4 index (entries + vec + chunks + chunks_fts).
    const { rebuildIndex, indexPath } = require('../src/embed/indexer');
    const { loadMemoriesFromDir } = require('../src/memory/loader');
    await rebuildIndex(dir);
    const memories = loadMemoriesFromDir(dir);

    // Break the FTS index while keeping the table present: drop the fts5
    // virtual table and recreate a plain table of the same name, so the
    // open-time probe still finds it but every MATCH query throws.
    const raw = new Database(indexPath(dir));
    raw.exec('DROP TABLE chunks_fts');
    raw.exec(
      'CREATE TABLE chunks_fts (name TEXT, description TEXT, text TEXT, mid TEXT, cidx INTEGER)',
    );
    raw.close();

    const blendedSearch = freshBlendedSearch();
    const captured = await captureStderr(async () => {
      const outcome = await blendedSearch('look up 4e7729ab', memories, dir, 5);
      assert.ok(
        outcome.semantic.length >= 1,
        'the semantic path is untouched by the broken keyword index',
      );
      assert.deepEqual(outcome.keyword, [], 'the keyword pass degrades to no matches');
    });

    const first = (captured.match(FTS_WARN_RE) ?? []).length;
    assert.equal(first, 1, 'exactly one FTS warning line on the first failing call');
    assert.match(captured, FTS_WARN_RE);

    // A second failing call in the same process adds no further line.
    const captured2 = await captureStderr(async () => {
      await blendedSearch('another look up 4e7729ab', memories, dir, 5);
    });
    assert.equal(
      (captured2.match(FTS_WARN_RE) ?? []).length,
      0,
      'the warning is once-per-process, not once-per-query',
    );
  } finally {
    restoreFetch();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt FTS index: ftsMatch on its own returns no rows and warns once', async () => {
  // ftsDocCount runs before ftsMatch on the blendedSearch path and takes the
  // once-per-process warning first, so the ftsMatch catch is pinned here by
  // calling it directly on a fresh store module.
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'task.md'),
    '---\nname: task\ndescription: task tracker\ntype: reference\n---\n\ncarry task 4e7729ab across branches\n',
  );
  const restoreFetch = stubFetch();
  try {
    const { rebuildIndex, indexPath } = require('../src/embed/indexer');
    await rebuildIndex(dir);

    const raw = new Database(indexPath(dir));
    raw.exec('DROP TABLE chunks_fts');
    raw.exec(
      'CREATE TABLE chunks_fts (name TEXT, description TEXT, text TEXT, mid TEXT, cidx INTEGER)',
    );
    raw.close();

    delete require.cache[STORE_PATH];
    const { openIndex } = require('../src/embed/index-store');
    const store = openIndex({ path: indexPath(dir), meta: { provider: 'openai', model: MODEL } });
    try {
      const captured = await captureStderr(async () => {
        assert.deepEqual(store.ftsMatch('"4e7729ab"', 5), [], 'a failing MATCH degrades to no rows');
        assert.deepEqual(store.ftsMatch('"4e7729ab"', 5), [], 'and keeps degrading');
      });
      assert.equal(
        (captured.match(FTS_WARN_RE) ?? []).length,
        1,
        'exactly one FTS warning line from ftsMatch',
      );
    } finally {
      store.close();
    }
  } finally {
    restoreFetch();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
