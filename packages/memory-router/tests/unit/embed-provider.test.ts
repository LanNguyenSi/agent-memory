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
const {
  embedBatch,
  resolveProviderConfig,
  resolveEmbedTimeoutMs,
  resolveHookEmbedTimeoutMs,
  DEFAULT_TIMEOUT_MS,
  INDEX_DEFAULT_TIMEOUT_MS,
} = require('../../src/embed/provider');

// Save/restore MEMORY_ROUTER_EMBED_TIMEOUT_MS around a test body. `value ===
// undefined` deletes the var (unset), matching this file's per-test env
// save/restore convention used below for OPENAI_API_KEY etc.
function withEmbedTimeoutEnv<T>(value: string | undefined, fn: () => T): T {
  const orig = process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS;
  if (value === undefined) delete process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS;
  else process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS = value;
  try {
    return fn();
  } finally {
    if (orig === undefined) delete process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS;
    else process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS = orig;
  }
}

// Same shape as withEmbedTimeoutEnv above, for the hook-specific knob.
function withHookEmbedTimeoutEnv<T>(value: string | undefined, fn: () => T): T {
  const orig = process.env.MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS;
  if (value === undefined) delete process.env.MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS;
  else process.env.MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS = value;
  try {
    return fn();
  } finally {
    if (orig === undefined) delete process.env.MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS;
    else process.env.MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS = orig;
  }
}

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

test('embedBatch: omitted timeoutMs wires the DEFAULT_TIMEOUT_MS (5000) into AbortSignal.timeout', async () => {
  // Not just "an abort throws" — pin that the 5000ms default is the value passed
  // to AbortSignal.timeout and that its signal reaches fetch. Spies over the real
  // AbortSignal.timeout (call-through so fetch's init stays well-formed) and fetch.
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  const origTimeout = AbortSignal.timeout;
  let capturedTimeoutArg: number | undefined;
  let capturedSignal: AbortSignal | undefined;

  try {
    (AbortSignal as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
      capturedTimeoutArg = ms;
      return origTimeout.call(AbortSignal, ms);
    };
    (globalThis as { fetch: typeof fetch }).fetch = (async (_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: [] }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await embedBatch({ apiKey: 'k', model: 'm', inputs: ['x'] }); // timeoutMs omitted

    assert.equal(capturedTimeoutArg, 5000, 'default embed timeout must be 5000ms');
    assert.ok(capturedSignal instanceof AbortSignal, 'the timeout signal must be wired to fetch');
  } finally {
    AbortSignal.timeout = origTimeout;
    if (origFetch) {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  }
});

test('embedBatch: explicit timeoutMs overrides the default', async () => {
  // Pins both sides of the `opts.timeoutMs ?? DEFAULT_TIMEOUT_MS` branch so a
  // mutation collapsing it to a constant fails.
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  const origTimeout = AbortSignal.timeout;
  let capturedTimeoutArg: number | undefined;

  try {
    (AbortSignal as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
      capturedTimeoutArg = ms;
      return origTimeout.call(AbortSignal, ms);
    };
    (globalThis as { fetch: typeof fetch }).fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [] }),
      text: async () => '',
    } as unknown as Response)) as unknown as typeof fetch;

    await embedBatch({ apiKey: 'k', model: 'm', inputs: ['x'], timeoutMs: 1234 });

    assert.equal(capturedTimeoutArg, 1234, 'explicit timeoutMs must win over the default');
  } finally {
    AbortSignal.timeout = origTimeout;
    if (origFetch) {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  }
});

// ─── resolveEmbedTimeoutMs / MEMORY_ROUTER_EMBED_TIMEOUT_MS ─────────────────
// ad1dba42: the hook path (DEFAULT_TIMEOUT_MS, 5000) must stay tight so a
// prompt is never blocked for long; the index-rebuild path
// (INDEX_DEFAULT_TIMEOUT_MS) needs a much larger budget instead, since a
// real Ollama batch measured 5-17 s on the mm-v1-T008 corpus. Both defaults
// are overridable via one env var.

test('the two path defaults are pinned: hook stays 5000ms, index rebuild is at least 60000ms and strictly larger than the hook default', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 5000, 'hook/semanticSearch default must stay 5000ms');
  assert.ok(
    INDEX_DEFAULT_TIMEOUT_MS >= 60_000,
    `index-rebuild default must be at least 60000ms, got ${INDEX_DEFAULT_TIMEOUT_MS}`,
  );
  assert.ok(
    INDEX_DEFAULT_TIMEOUT_MS > DEFAULT_TIMEOUT_MS,
    'index-rebuild default must be strictly more generous than the hook default',
  );
});

test('resolveEmbedTimeoutMs: no env var set → returns the caller-supplied fallback unchanged', () => {
  withEmbedTimeoutEnv(undefined, () => {
    assert.equal(resolveEmbedTimeoutMs(DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
    assert.equal(resolveEmbedTimeoutMs(INDEX_DEFAULT_TIMEOUT_MS), INDEX_DEFAULT_TIMEOUT_MS);
  });
});

test('resolveEmbedTimeoutMs: a valid positive value overrides the fallback, for either path default', () => {
  withEmbedTimeoutEnv('12345', () => {
    assert.equal(resolveEmbedTimeoutMs(DEFAULT_TIMEOUT_MS), 12345);
    assert.equal(resolveEmbedTimeoutMs(INDEX_DEFAULT_TIMEOUT_MS), 12345);
  });
});

// '1500.7' (fractional) and '5e9' (> uint32) would make AbortSignal.timeout
// throw RangeError; '3000000000' sits in the 32-bit overflow window where
// Node silently degrades the timer to 1 ms; 'Infinity' fails isInteger.
for (const bad of [
  '',
  '   ',
  'not-a-number',
  'NaN',
  '-1',
  '-500',
  '0',
  '1500.7',
  '5e9',
  '3000000000',
  'Infinity',
]) {
  test(`resolveEmbedTimeoutMs: invalid override ${JSON.stringify(bad)} falls back to the caller-supplied default`, () => {
    withEmbedTimeoutEnv(bad, () => {
      assert.equal(resolveEmbedTimeoutMs(DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
      assert.equal(resolveEmbedTimeoutMs(INDEX_DEFAULT_TIMEOUT_MS), INDEX_DEFAULT_TIMEOUT_MS);
    });
  });
}

// ─── resolveHookEmbedTimeoutMs / MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS ────────
// b1bbbf68: MEMORY_ROUTER_EMBED_TIMEOUT_MS overrides both the hook
// (semanticSearch) and index-rebuild paths at once, so a persistent shell
// export meant to give `index` more headroom also raises the hook's
// per-prompt budget. MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS decouples the hook
// path: hook knob, then the shared knob, then the 5s hook default.

test('resolveHookEmbedTimeoutMs: no env vars set → returns DEFAULT_TIMEOUT_MS', () => {
  withHookEmbedTimeoutEnv(undefined, () => {
    withEmbedTimeoutEnv(undefined, () => {
      assert.equal(resolveHookEmbedTimeoutMs(), DEFAULT_TIMEOUT_MS);
    });
  });
});

test('resolveHookEmbedTimeoutMs: only the shared knob set → falls back to it (unchanged pre-existing behavior)', () => {
  withHookEmbedTimeoutEnv(undefined, () => {
    withEmbedTimeoutEnv('7777', () => {
      assert.equal(resolveHookEmbedTimeoutMs(), 7777);
    });
  });
});

test('resolveHookEmbedTimeoutMs: hook knob set → wins over both the shared knob and the default (precedence)', () => {
  withHookEmbedTimeoutEnv('42', () => {
    withEmbedTimeoutEnv('7777', () => {
      assert.equal(resolveHookEmbedTimeoutMs(), 42, 'hook knob must win over the shared knob');
    });
    withEmbedTimeoutEnv(undefined, () => {
      assert.equal(resolveHookEmbedTimeoutMs(), 42, 'hook knob must win over the default');
    });
  });
});

// b1bbbf68 fix-round: pins the accepted upper boundary. Its rejected
// neighbor '3000000000' is already covered by the invalid table below;
// this confirms parseTimeoutOverride's `<= 2147483647` check is inclusive,
// not off-by-one.
test('resolveHookEmbedTimeoutMs: the upper boundary value 2147483647 is accepted', () => {
  withHookEmbedTimeoutEnv('2147483647', () => {
    assert.equal(resolveHookEmbedTimeoutMs(), 2147483647);
  });
});

// Same invalid-value table as resolveEmbedTimeoutMs above (PR #96).
for (const bad of [
  '',
  '   ',
  'not-a-number',
  'NaN',
  '-1',
  '-500',
  '0',
  '1500.7',
  '5e9',
  '3000000000',
  'Infinity',
]) {
  test(`resolveHookEmbedTimeoutMs: invalid hook override ${JSON.stringify(bad)}, no shared knob → falls back to DEFAULT_TIMEOUT_MS`, () => {
    withHookEmbedTimeoutEnv(bad, () => {
      withEmbedTimeoutEnv(undefined, () => {
        assert.equal(resolveHookEmbedTimeoutMs(), DEFAULT_TIMEOUT_MS);
      });
    });
  });

  test(`resolveHookEmbedTimeoutMs: invalid hook override ${JSON.stringify(bad)}, shared knob set → falls back to the shared knob, not straight to the default`, () => {
    withHookEmbedTimeoutEnv(bad, () => {
      withEmbedTimeoutEnv('7777', () => {
        assert.equal(resolveHookEmbedTimeoutMs(), 7777);
      });
    });
  });
}

test('embedBatch: MEMORY_ROUTER_EMBED_TIMEOUT_MS overrides the default when timeoutMs is omitted', async () => {
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  const origTimeout = AbortSignal.timeout;
  let capturedTimeoutArg: number | undefined;

  try {
    (AbortSignal as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
      capturedTimeoutArg = ms;
      return origTimeout.call(AbortSignal, ms);
    };
    (globalThis as { fetch: typeof fetch }).fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [] }),
      text: async () => '',
    } as unknown as Response)) as unknown as typeof fetch;

    await withEmbedTimeoutEnv('9999', async () => {
      await embedBatch({ apiKey: 'k', model: 'm', inputs: ['x'] }); // timeoutMs omitted
    });

    assert.equal(capturedTimeoutArg, 9999, 'env override must win over DEFAULT_TIMEOUT_MS');
  } finally {
    AbortSignal.timeout = origTimeout;
    if (origFetch) {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  }
});

test('embedBatch: an explicit opts.timeoutMs still wins over MEMORY_ROUTER_EMBED_TIMEOUT_MS', async () => {
  // Callers that pin their own budget (e.g. indexer.ts) must not be
  // second-guessed by a global env override once they've already resolved
  // their own value into opts.timeoutMs.
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  const origTimeout = AbortSignal.timeout;
  let capturedTimeoutArg: number | undefined;

  try {
    (AbortSignal as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
      capturedTimeoutArg = ms;
      return origTimeout.call(AbortSignal, ms);
    };
    (globalThis as { fetch: typeof fetch }).fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [] }),
      text: async () => '',
    } as unknown as Response)) as unknown as typeof fetch;

    await withEmbedTimeoutEnv('9999', async () => {
      await embedBatch({ apiKey: 'k', model: 'm', inputs: ['x'], timeoutMs: 42 });
    });

    assert.equal(capturedTimeoutArg, 42, 'an explicit timeoutMs must not be overridden by the env var');
  } finally {
    AbortSignal.timeout = origTimeout;
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
