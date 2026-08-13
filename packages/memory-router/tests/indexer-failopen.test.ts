const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { rebuildIndex, semanticSearch } = require('../src/embed/indexer');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-failopen-'));
}

// mm-v1-T003: plain "OPENAI_API_KEY missing" no longer means "no provider
// configured" by itself — indexer.ts's rebuildIndex/semanticSearch now
// auto-detect a local Ollama config in that case (see
// tests/embed-multi-provider.test.ts). The only way resolveProviderConfig()
// still returns null (the genuine "nothing usable configured" case these
// two tests exercise) is an EXPLICIT `MEMORY_ROUTER_EMBED_PROVIDER=openai`
// with no key: the user asked for OpenAI specifically, so there is nothing
// to silently substitute.
function withNoProvider(fn: () => Promise<void>): Promise<void> {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevProvider = process.env.MEMORY_ROUTER_EMBED_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  process.env.MEMORY_ROUTER_EMBED_PROVIDER = 'openai';
  return fn().finally(() => {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    if (prevProvider === undefined)
      delete process.env.MEMORY_ROUTER_EMBED_PROVIDER;
    else process.env.MEMORY_ROUTER_EMBED_PROVIDER = prevProvider;
  });
}

test('rebuildIndex fails open when no provider is configured (explicit openai, no key)', async () => {
  await withNoProvider(async () => {
    const dir = tmpDir();
    const result = await rebuildIndex(dir);
    assert.equal(result.embedded, 0);
    assert.match(result.reason ?? '', /OPENAI_API_KEY/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('semanticSearch returns [] when no provider is configured (explicit openai, no key)', async () => {
  await withNoProvider(async () => {
    const dir = tmpDir();
    const hits = await semanticSearch('anything', [], dir, 5);
    assert.deepEqual(hits, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('semanticSearch returns [] when index file is missing', async () => {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  try {
    const dir = tmpDir();
    // Capture stderr so we can assert the hint fires without polluting
    // the test output.
    const origWrite = process.stderr.write.bind(process.stderr);
    let stderrCaptured = '';
    (process.stderr as unknown as { write: typeof origWrite }).write = ((
      chunk: string | Uint8Array,
    ) => {
      stderrCaptured += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof origWrite;
    try {
      const hits = await semanticSearch('anything', [], dir, 5);
      assert.deepEqual(hits, []);
      assert.match(stderrCaptured, /embedding index missing/);
    } finally {
      process.stderr.write = origWrite;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});
