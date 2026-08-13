// mm-v1-T003: multi-provider embeddings (OpenAI + Ollama).
//
// Covers:
//  - provider.ts's resolveProviderConfig(): explicit selection, auto-detect
//    (OPENAI_API_KEY present -> openai; else, opt-in only, -> ollama),
//    unrecognized explicit values, and the sync contract the two
//    lint/conflicts.ts + eval/runner.ts callsites depend on.
//  - embedBatch()'s request shape against mocked OpenAI- and Ollama-shaped
//    responses (auth header present/absent, correct endpoint).
//  - index-store.ts's embed-provenance: dimensions derived from the first
//    real embed response (never hardcoded), and a provider switch against
//    an existing index throwing a clear error with the exact rebuild
//    command instead of silently comparing incompatible vector spaces.
//
// No live network calls anywhere in this file — every fetch is mocked.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { resolveProviderConfig, embedBatch } = require('../src/embed/provider');
const {
  rebuildIndex,
  semanticSearch,
  EMBED_DIMENSIONS,
} = require('../src/embed/indexer');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'memories');

function tmpMemoryDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-router-multiprovider-'),
  );
  for (const f of fs.readdirSync(FIXTURES_DIR)) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(dir, f));
  }
  return dir;
}

// Saves/restores the full set of env vars this feature reads, so tests
// never leak state into each other regardless of pass/fail.
const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'MEMORY_ROUTER_EMBED_PROVIDER',
  'MEMORY_ROUTER_EMBED_MODEL',
  'MEMORY_ROUTER_OLLAMA_BASE_URL',
] as const;

function withEnv(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => void,
): void;
function withEnv(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
): Promise<void>;
function withEnv(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => void | Promise<void>,
): void | Promise<void> {
  const prev: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
    {};
  for (const key of ENV_KEYS) prev[key] = process.env[key];
  for (const key of ENV_KEYS) {
    if (key in vars && vars[key] !== undefined) process.env[key] = vars[key];
    else delete process.env[key];
  }
  const restore = () => {
    for (const key of ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  };
  const result = fn();
  if (result && typeof (result as Promise<void>).finally === 'function') {
    return (result as Promise<void>).finally(restore);
  }
  restore();
  return undefined;
}

// ---------------------------------------------------------------------
// resolveProviderConfig(): explicit selection, auto-detect, sync contract
// ---------------------------------------------------------------------

test('resolveProviderConfig: explicit ollama returns an unauthenticated config with defaults', () => {
  withEnv({ MEMORY_ROUTER_EMBED_PROVIDER: 'ollama' }, () => {
    const cfg = resolveProviderConfig();
    assert.deepEqual(cfg, {
      provider: 'ollama',
      apiKey: '',
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434',
    });
  });
});

test('resolveProviderConfig: explicit ollama honors MEMORY_ROUTER_EMBED_MODEL and MEMORY_ROUTER_OLLAMA_BASE_URL', () => {
  withEnv(
    {
      MEMORY_ROUTER_EMBED_PROVIDER: 'OLLAMA', // case-insensitive
      MEMORY_ROUTER_EMBED_MODEL: 'mxbai-embed-large',
      MEMORY_ROUTER_OLLAMA_BASE_URL: 'http://ollama.internal:9999',
    },
    () => {
      const cfg = resolveProviderConfig();
      assert.deepEqual(cfg, {
        provider: 'ollama',
        apiKey: '',
        model: 'mxbai-embed-large',
        baseUrl: 'http://ollama.internal:9999',
      });
    },
  );
});

test('resolveProviderConfig: explicit openai with a key returns an openai config, ignoring autoDetectOllama', () => {
  withEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' },
    () => {
      const cfg = resolveProviderConfig({ autoDetectOllama: true });
      assert.equal(cfg?.provider, 'openai');
      assert.equal(cfg?.apiKey, 'sk-test');
      assert.equal(cfg?.model, 'text-embedding-3-small');
    },
  );
});

test('resolveProviderConfig: explicit openai without a key returns null even when autoDetectOllama is set', () => {
  withEnv({ MEMORY_ROUTER_EMBED_PROVIDER: 'openai' }, () => {
    // Explicit selection wins outright: the user asked for OpenAI
    // specifically, so there is nothing to silently substitute.
    assert.equal(resolveProviderConfig({ autoDetectOllama: true }), null);
    assert.equal(resolveProviderConfig(), null);
  });
});

test('resolveProviderConfig: auto-detect prefers openai when OPENAI_API_KEY is present, even with autoDetectOllama set', () => {
  withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
    const cfg = resolveProviderConfig({ autoDetectOllama: true });
    assert.equal(cfg?.provider, 'openai');
    assert.equal(cfg?.apiKey, 'sk-test');
  });
});

test('resolveProviderConfig: no explicit provider, no key, default (autoDetectOllama unset) -> null', () => {
  withEnv({}, () => {
    // This is the exact contract src/lint/conflicts.ts and
    // src/eval/runner.ts depend on (both call resolveProviderConfig() with
    // no arguments) — see tests/lint-conflicts.test.ts's "--semantic skips
    // with stderr warning when OPENAI_API_KEY is unset" and
    // tests/eval-runner.test.ts, both of which run unmodified against this
    // change.
    assert.equal(resolveProviderConfig(), null);
  });
});

test('resolveProviderConfig: no explicit provider, no key, autoDetectOllama=true -> optimistic ollama config', () => {
  withEnv({}, () => {
    const cfg = resolveProviderConfig({ autoDetectOllama: true });
    assert.deepEqual(cfg, {
      provider: 'ollama',
      apiKey: '',
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434',
    });
  });
});

test('resolveProviderConfig: an unrecognized MEMORY_ROUTER_EMBED_PROVIDER value falls through to auto-detect', () => {
  withEnv(
    {
      MEMORY_ROUTER_EMBED_PROVIDER: 'not-a-real-provider',
      OPENAI_API_KEY: 'sk-test',
    },
    () => {
      const cfg = resolveProviderConfig();
      assert.equal(cfg?.provider, 'openai');
    },
  );
  withEnv({ MEMORY_ROUTER_EMBED_PROVIDER: 'not-a-real-provider' }, () => {
    assert.equal(
      resolveProviderConfig({ autoDetectOllama: true })?.provider,
      'ollama',
    );
  });
});

test('resolveProviderConfig is synchronous: returns a plain value, not a Promise', () => {
  withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
    const result = resolveProviderConfig();
    assert.notEqual(result, null);
    assert.equal(
      typeof (result as unknown as { then?: unknown }).then,
      'undefined',
      'resolveProviderConfig() must not return a thenable — src/lint/conflicts.ts:439 and ' +
        'src/eval/runner.ts:106 call it unconditionally, synchronously, with no await',
    );
  });
});

// ---------------------------------------------------------------------
// embedBatch(): request shape against mocked OpenAI- and Ollama-shaped
// responses. No live API calls.
// ---------------------------------------------------------------------

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: { model: string; input: string[] };
}

function stubFetch(
  respond: (call: CapturedCall) => { embedding: number[] }[],
): { calls: CapturedCall[]; restore: () => void } {
  const orig = (globalThis as { fetch?: typeof fetch }).fetch;
  const calls: CapturedCall[] = [];
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: { headers?: Record<string, string>; body?: string },
  ) => {
    const body = JSON.parse(init?.body ?? '{}') as {
      model: string;
      input: string[];
    };
    const call: CapturedCall = {
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    };
    calls.push(call);
    const embeddings = respond(call);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: embeddings.map((e, index) => ({ embedding: e.embedding, index })),
      }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      if (orig) (globalThis as { fetch: typeof fetch }).fetch = orig;
    },
  };
}

test('embedBatch: OpenAI-shaped request carries the Authorization header and hits api.openai.com by default', async () => {
  const stub = stubFetch((call) =>
    call.body.input.map(() => ({ embedding: [1, 2, 3] })),
  );
  try {
    const vectors = await embedBatch({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      inputs: ['hello'],
    });
    assert.deepEqual(vectors, [[1, 2, 3]]);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://api.openai.com/v1/embeddings');
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer sk-test');
    assert.equal(stub.calls[0].body.model, 'text-embedding-3-small');
  } finally {
    stub.restore();
  }
});

test('embedBatch: Ollama-shaped request omits Authorization and hits the given base URL', async () => {
  const stub = stubFetch((call) =>
    call.body.input.map(() => ({ embedding: [4, 5, 6, 7] })),
  );
  try {
    const vectors = await embedBatch({
      apiKey: '',
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434',
      inputs: ['hello'],
    });
    assert.deepEqual(vectors, [[4, 5, 6, 7]]);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'http://localhost:11434/v1/embeddings');
    assert.equal(
      'Authorization' in stub.calls[0].headers,
      false,
      'Ollama takes no auth — an Authorization header must not be sent',
    );
    assert.equal(stub.calls[0].body.model, 'nomic-embed-text');
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------
// Index-level provenance (index-store.ts, exercised end-to-end through
// indexer.ts's rebuildIndex/semanticSearch): dimensions derived from the
// first embed response, and a provider switch against an existing index
// throwing instead of silently returning wrong neighbours.
// ---------------------------------------------------------------------

function stubFetchWithDimensions(dim: number): {
  calls: number;
  restore: () => void;
} {
  const orig = (globalThis as { fetch?: typeof fetch }).fetch;
  let calls = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { body?: string },
  ) => {
    calls++;
    const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
    const data = body.input.map((_text, index) => ({
      embedding: Array.from(
        { length: dim },
        (_v, i) => (index + 1) * 0.01 + i * 0.001,
      ),
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
    get calls() {
      return calls;
    },
    restore: () => {
      if (orig) (globalThis as { fetch: typeof fetch }).fetch = orig;
    },
  } as unknown as { calls: number; restore: () => void };
}

test('EMBED_DIMENSIONS stays exported at 1536 for src/lint/conflicts.ts backward compat', () => {
  assert.equal(EMBED_DIMENSIONS, 1536);
});

test('rebuildIndex + semanticSearch: dimension is derived from the first embed response, not hardcoded', async () => {
  // A real Ollama nomic-embed-text response is 768-dim; use a small,
  // deliberately non-1536 width here to prove nothing in the index path
  // assumes EMBED_DIMENSIONS.
  const stub = stubFetchWithDimensions(5);
  const dir = tmpMemoryDir();
  await withEnv({ MEMORY_ROUTER_EMBED_PROVIDER: 'ollama' }, async () => {
    try {
      const result = await rebuildIndex(dir);
      assert.ok(
        result.embedded > 0,
        'rebuildIndex should have embedded the fixture memories',
      );
      assert.equal(result.reason, undefined);

      const hits = await semanticSearch('a prompt', [], dir, 5);
      // The fixture memories aren't returned as GateHit here since we pass
      // an empty `memories` array (mirrors query-cache.test.ts's pattern),
      // but a non-throwing round-trip through a 5-dim index proves the
      // dimension was learned from the stub response, not the 1536
      // constant (which would have thrown "dimension 5 != index dimension
      // 1536" had it leaked into the index path).
      assert.deepEqual(hits, []);
    } finally {
      stub.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('rebuildIndex: switching provider against an existing index throws with the exact rebuild command', async () => {
  const dir = tmpMemoryDir();
  const openaiStub = stubFetchWithDimensions(4);
  try {
    await withEnv(
      { MEMORY_ROUTER_EMBED_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' },
      async () => {
        const first = await rebuildIndex(dir);
        assert.ok(first.embedded > 0);
      },
    );
  } finally {
    openaiStub.restore();
  }

  // No fetch stub installed for the second call: the mismatch must be
  // caught synchronously at open time, before any embed call is attempted.
  const noFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = undefined;
  try {
    await withEnv({ MEMORY_ROUTER_EMBED_PROVIDER: 'ollama' }, async () => {
      await assert.rejects(
        () => rebuildIndex(dir),
        (err: Error) => {
          assert.match(err.message, /provider=openai/);
          assert.match(err.message, /provider=ollama/);
          assert.match(err.message, /rm -rf/);
          assert.match(
            err.message,
            new RegExp(
              `memory-router index ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
            ),
          );
          return true;
        },
      );
    });
  } finally {
    (globalThis as { fetch?: typeof fetch }).fetch = noFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('semanticSearch: switching provider against an existing index throws instead of returning results', async () => {
  const dir = tmpMemoryDir();
  const openaiStub = stubFetchWithDimensions(4);
  try {
    await withEnv(
      { MEMORY_ROUTER_EMBED_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' },
      async () => {
        const first = await rebuildIndex(dir);
        assert.ok(first.embedded > 0);
      },
    );
  } finally {
    openaiStub.restore();
  }

  const noFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = undefined;
  try {
    await withEnv({ MEMORY_ROUTER_EMBED_PROVIDER: 'ollama' }, async () => {
      await assert.rejects(
        () => semanticSearch('anything', [], dir, 5),
        /provider=openai.*provider=ollama|Comparing embeddings|Embeddings from different providers/s,
      );
    });
  } finally {
    (globalThis as { fetch?: typeof fetch }).fetch = noFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
