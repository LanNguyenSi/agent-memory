const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { rebuildIndex, semanticSearch } = require('../src/embed/indexer');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-failopen-'));
}

test('rebuildIndex fails open when OPENAI_API_KEY is missing', async () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const dir = tmpDir();
    const result = await rebuildIndex(dir);
    assert.equal(result.embedded, 0);
    assert.match(result.reason ?? '', /OPENAI_API_KEY/);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  }
});

test('semanticSearch returns [] when OPENAI_API_KEY is missing', async () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const dir = tmpDir();
    const hits = await semanticSearch('anything', [], dir, 5);
    assert.deepEqual(hits, []);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  }
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
