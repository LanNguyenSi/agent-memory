// ad1dba42: memory-router index was unusable on the Mac mini because the
// index-rebuild path shared embedBatch's 5s hook timeout, and a real Ollama
// batch (nomic-embed-text 5-7s, bge-m3 8-17s, mm-v1-T008 reference corpus)
// blew past that on the first batch after a cold model load.
//
// Covers, end-to-end through indexer.ts (not just provider.ts in
// isolation):
//  - rebuildIndex's embedBatch call defaults to INDEX_DEFAULT_TIMEOUT_MS.
//  - semanticSearch's embedBatch call keeps the tight hook default
//    (DEFAULT_TIMEOUT_MS), unaffected by the index path's larger default.
//  - MEMORY_ROUTER_EMBED_TIMEOUT_MS overrides both paths at once.
//
// No live network calls: fetch and AbortSignal.timeout are both stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { DEFAULT_TIMEOUT_MS, INDEX_DEFAULT_TIMEOUT_MS } = require('../src/embed/provider');
const { rebuildIndex, semanticSearch } = require('../src/embed/indexer');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'memories');

function tmpMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-timeout-budget-'));
  for (const f of fs.readdirSync(FIXTURES_DIR)) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(dir, f));
  }
  return dir;
}

// Stubs global fetch (always-ok, echoes one embedding per input) and
// AbortSignal.timeout (call-through, capturing every ms argument in order)
// for the duration of `fn`. Mirrors tests/unit/embed-provider.test.ts's
// per-test AbortSignal.timeout spy pattern.
async function withCapturedTimeouts(fn: () => Promise<void>): Promise<number[]> {
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  const origTimeout = AbortSignal.timeout;
  const captured: number[] = [];

  (AbortSignal as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
    captured.push(ms);
    return origTimeout.call(AbortSignal, ms);
  };
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
        data: body.input.map((_t, index) => ({ embedding: [0.1, 0.2, 0.3], index })),
      }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;

  try {
    await fn();
  } finally {
    AbortSignal.timeout = origTimeout;
    if (origFetch) (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    else delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
  return captured;
}

// `fn` may contain several sequential `await`s (rebuildIndex, then
// semanticSearch), so this must actually AWAIT fn() before restoring the
// env var — a `try { return fn(); } finally { restore() }` shape (no
// await) restores as soon as fn() yields its FIRST pending promise, not
// once fn() truly finishes, corrupting every await after that first one.
async function withEmbedTimeoutEnv<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const orig = process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS;
  if (value === undefined) delete process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS;
  else process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS = value;
  try {
    return await fn();
  } finally {
    if (orig === undefined) delete process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS;
    else process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS = orig;
  }
}

// Same "must actually await" requirement as withEmbedTimeoutEnv above.
async function withOpenAiKey<T>(fn: () => Promise<T>): Promise<T> {
  const orig = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  try {
    return await fn();
  } finally {
    if (orig === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = orig;
  }
}

test('rebuildIndex: no env override → embedBatch call uses INDEX_DEFAULT_TIMEOUT_MS, not the hook default', async () => {
  const dir = tmpMemoryDir();
  try {
    await withOpenAiKey(async () => {
      await withEmbedTimeoutEnv(undefined, async () => {
        const captured = await withCapturedTimeouts(async () => {
          const result = await rebuildIndex(dir);
          assert.ok(result.embedded > 0, 'fixtures should have been embedded');
        });
        assert.deepEqual(
          captured,
          [INDEX_DEFAULT_TIMEOUT_MS],
          'rebuildIndex must pass INDEX_DEFAULT_TIMEOUT_MS to embedBatch, not DEFAULT_TIMEOUT_MS',
        );
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('semanticSearch: no env override → embedBatch call uses DEFAULT_TIMEOUT_MS (the tight hook budget), separate from the index default', async () => {
  const dir = tmpMemoryDir();
  try {
    await withOpenAiKey(async () => {
      // Build the index first (its own capture window, discarded) so
      // semanticSearch finds an index file and actually reaches the
      // query-embedding call. Still needs the fetch stub - no live network
      // calls anywhere in this file.
      await withEmbedTimeoutEnv(undefined, async () => {
        await withCapturedTimeouts(async () => {
          const first = await rebuildIndex(dir);
          assert.ok(first.embedded > 0);
        });
      });

      await withEmbedTimeoutEnv(undefined, async () => {
        const captured = await withCapturedTimeouts(async () => {
          const hits = await semanticSearch('a prompt not seen before', [], dir, 5);
          assert.deepEqual(hits, []); // empty `memories` arg, see embed-multi-provider.test.ts
        });
        assert.deepEqual(
          captured,
          [DEFAULT_TIMEOUT_MS],
          'semanticSearch must keep the tight hook default, not the larger index default',
        );
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MEMORY_ROUTER_EMBED_TIMEOUT_MS overrides both rebuildIndex and semanticSearch at once', async () => {
  const dir = tmpMemoryDir();
  try {
    await withOpenAiKey(async () => {
      await withEmbedTimeoutEnv('7777', async () => {
        const rebuildCaptured = await withCapturedTimeouts(async () => {
          const result = await rebuildIndex(dir);
          assert.ok(result.embedded > 0);
        });
        assert.deepEqual(rebuildCaptured, [7777]);

        const searchCaptured = await withCapturedTimeouts(async () => {
          const hits = await semanticSearch('another new prompt', [], dir, 5);
          assert.deepEqual(hits, []);
        });
        assert.deepEqual(searchCaptured, [7777]);
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuildIndex: an invalid MEMORY_ROUTER_EMBED_TIMEOUT_MS (negative) falls back to INDEX_DEFAULT_TIMEOUT_MS end-to-end', async () => {
  const dir = tmpMemoryDir();
  try {
    await withOpenAiKey(async () => {
      await withEmbedTimeoutEnv('-100', async () => {
        const captured = await withCapturedTimeouts(async () => {
          const result = await rebuildIndex(dir);
          assert.ok(result.embedded > 0);
        });
        assert.deepEqual(captured, [INDEX_DEFAULT_TIMEOUT_MS]);
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
