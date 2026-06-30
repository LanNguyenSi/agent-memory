// Unit tests for packages/memory-router/src/embed/provider.ts
//
// Covers: embedBatch (ok response, non-ok responses, network errors, AbortError)
// and resolveProviderConfig (env-var branches, missing key, custom model/baseUrl).
//
// globalThis.fetch is stubbed per-test with save/restore in try/finally.
// process.env is mutated and restored per-test.
// Node:test runs top-level tests serially by default — no concurrency conflicts.

const test = require('node:test');
const assert = require('node:assert/strict');
const { embedBatch, resolveProviderConfig } = require('../../src/embed/provider');

// ─── embedBatch ──────────────────────────────────────────────────────────────

test('embedBatch: ok response — returns sorted embeddings and validates request', async () => {
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  try {
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        // Return data OUT of order to exercise the sort-by-index path.
        json: async () => ({
          data: [
            { embedding: [0.2, 0.3], index: 1 },
            { embedding: [0.1, 0.2], index: 0 },
          ],
        }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await embedBatch({
      apiKey: 'sk-test-key',
      model: 'text-embedding-3-small',
      inputs: ['hello', 'world'],
    });

    // Returned vectors must be sorted by index (index 0 first).
    assert.deepEqual(result, [[0.1, 0.2], [0.2, 0.3]]);

    // Request URL must be the OpenAI default base + /v1/embeddings.
    assert.equal(capturedUrl, 'https://api.openai.com/v1/embeddings');

    // Method must be POST.
    const init = capturedInit as RequestInit;
    assert.equal(init.method, 'POST');

    // Authorization and Content-Type headers must be correct.
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['Authorization'], 'Bearer sk-test-key');

    // Body must encode model + input array.
    const body = JSON.parse(init.body as string) as { model: string; input: string[] };
    assert.equal(body.model, 'text-embedding-3-small');
    assert.deepEqual(body.input, ['hello', 'world']);
  } finally {
    if (origFetch) {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  }
});

test('embedBatch: custom baseUrl — trailing slash is stripped from URL', async () => {
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  let capturedUrl: string | undefined;

  try {
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: [0.5], index: 0 }] }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await embedBatch({
      apiKey: 'sk-test',
      model: 'any',
      inputs: ['x'],
      baseUrl: 'https://custom.api.com/',
    });

    assert.equal(capturedUrl, 'https://custom.api.com/v1/embeddings',
      'trailing slash must be stripped before appending /v1/embeddings');
  } finally {
    if (origFetch) {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  }
});

test('embedBatch: non-ok 429 → throws "embedding request failed"', async () => {
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;

  try {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'rate limited',
    } as unknown as Response)) as unknown as typeof fetch;

    await assert.rejects(
      () => embedBatch({ apiKey: 'k', model: 'm', inputs: ['x'] }),
      (err: Error) => {
        assert.ok(
          err.message.includes('embedding request failed'),
          `expected "embedding request failed" in: ${err.message}`
        );
        assert.ok(err.message.includes('429'));
        return true;
      }
    );
  } finally {
    if (origFetch) {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  }
});

test('embedBatch: non-ok 500 → throws "embedding request failed"', async () => {
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;

  try {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'server error body',
    } as unknown as Response)) as unknown as typeof fetch;

    await assert.rejects(
      () => embedBatch({ apiKey: 'k', model: 'm', inputs: ['x'] }),
      (err: Error) => {
        assert.ok(err.message.includes('embedding request failed'));
        assert.ok(err.message.includes('500'));
        return true;
      }
    );
  } finally {
    if (origFetch) {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  }
});

test('embedBatch: network error — fetch rejection propagates as-is', async () => {
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;

  try {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error('network failure');
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => embedBatch({ apiKey: 'k', model: 'm', inputs: ['x'] }),
      (err: Error) => {
        assert.equal(err.message, 'network failure');
        return true;
      }
    );
  } finally {
    if (origFetch) {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  }
});

test('embedBatch: AbortError from fetch propagates unchanged', async () => {
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;

  try {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      // DOMException with name 'AbortError' is what AbortSignal.timeout fires.
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => embedBatch({ apiKey: 'k', model: 'm', inputs: ['x'], timeoutMs: 1 }),
      (err: DOMException) => {
        assert.equal(err.name, 'AbortError');
        return true;
      }
    );
  } finally {
    if (origFetch) {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  }
});

test('embedBatch: res.text() failure in non-ok path falls back to "<no body>"', async () => {
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;

  try {
    (globalThis as { fetch: typeof fetch }).fetch = (async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      // text() rejects — should be caught and replaced with '<no body>'
      text: async () => { throw new Error('cannot read body'); },
    } as unknown as Response)) as unknown as typeof fetch;

    await assert.rejects(
      () => embedBatch({ apiKey: 'k', model: 'm', inputs: ['x'] }),
      (err: Error) => {
        assert.ok(err.message.includes('embedding request failed'));
        assert.ok(err.message.includes('<no body>'));
        return true;
      }
    );
  } finally {
    if (origFetch) {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  }
});

// ─── resolveProviderConfig ───────────────────────────────────────────────────

test('resolveProviderConfig: OPENAI_API_KEY missing → returns null', () => {
  const orig = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    const cfg = resolveProviderConfig();
    assert.equal(cfg, null);
  } finally {
    if (orig === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = orig;
  }
});

test('resolveProviderConfig: OPENAI_API_KEY set → returns config with default model', () => {
  const origKey = process.env.OPENAI_API_KEY;
  const origModel = process.env.MEMORY_ROUTER_EMBED_MODEL;
  const origBase = process.env.OPENAI_BASE_URL;
  try {
    process.env.OPENAI_API_KEY = 'sk-real-key';
    delete process.env.MEMORY_ROUTER_EMBED_MODEL;
    delete process.env.OPENAI_BASE_URL;

    const cfg = resolveProviderConfig();
    assert.ok(cfg !== null);
    assert.equal(cfg.apiKey, 'sk-real-key');
    assert.equal(cfg.model, 'text-embedding-3-small', 'default model must be text-embedding-3-small');
    assert.equal(cfg.baseUrl, undefined);
  } finally {
    if (origKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origKey;
    if (origModel === undefined) delete process.env.MEMORY_ROUTER_EMBED_MODEL;
    else process.env.MEMORY_ROUTER_EMBED_MODEL = origModel;
    if (origBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = origBase;
  }
});

test('resolveProviderConfig: MEMORY_ROUTER_EMBED_MODEL overrides default model', () => {
  const origKey = process.env.OPENAI_API_KEY;
  const origModel = process.env.MEMORY_ROUTER_EMBED_MODEL;
  try {
    process.env.OPENAI_API_KEY = 'sk-key';
    process.env.MEMORY_ROUTER_EMBED_MODEL = 'text-embedding-3-large';

    const cfg = resolveProviderConfig();
    assert.ok(cfg !== null);
    assert.equal(cfg.model, 'text-embedding-3-large');
  } finally {
    if (origKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origKey;
    if (origModel === undefined) delete process.env.MEMORY_ROUTER_EMBED_MODEL;
    else process.env.MEMORY_ROUTER_EMBED_MODEL = origModel;
  }
});

test('resolveProviderConfig: OPENAI_BASE_URL is forwarded', () => {
  const origKey = process.env.OPENAI_API_KEY;
  const origBase = process.env.OPENAI_BASE_URL;
  try {
    process.env.OPENAI_API_KEY = 'sk-key';
    process.env.OPENAI_BASE_URL = 'https://my-proxy.example.com';

    const cfg = resolveProviderConfig();
    assert.ok(cfg !== null);
    assert.equal(cfg.baseUrl, 'https://my-proxy.example.com');
  } finally {
    if (origKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origKey;
    if (origBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = origBase;
  }
});
