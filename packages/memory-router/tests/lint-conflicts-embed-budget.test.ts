// fe9c61bc: `memory-router lint --semantic` called embedBatch with no
// timeoutMs (inheriting embedBatch's 5s hook-tight DEFAULT_TIMEOUT_MS) and
// shipped every missing pair-embed input in a single request, unchunked.
// Reviewer measurement from PR #96 (Task ad1dba42): 64 real inputs take
// ~9.3s warm against Ollama/bge-m3, so any non-trivial corpus already blew
// the 5s budget and aborted — same bug class rebuildIndex had before
// mm-v1-T008 gave it INDEX_DEFAULT_TIMEOUT_MS + 64-batch chunking.
//
// This file pins two things end-to-end through
// lintMemoryDirForConflictsWithSemantic's real (non-embedFn-seam)
// embedBatch call:
//  - the missing-pair embed call uses INDEX_DEFAULT_TIMEOUT_MS, not the
//    tight hook default (see tests/embed-timeout-budget.test.ts for the
//    same assertion shape against rebuildIndex/semanticSearch).
//  - missing pairs are chunked at 64 per request instead of shipped in one
//    unchunked call.
//
// No live network calls: fetch and AbortSignal.timeout are both stubbed,
// mirroring tests/embed-timeout-budget.test.ts's withCapturedTimeouts.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { DEFAULT_TIMEOUT_MS, INDEX_DEFAULT_TIMEOUT_MS } = require('../src/embed/provider');
const { lintMemoryDirForConflictsWithSemantic } = require('../src/lint/conflicts');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-lint-embed-budget-'));
}

function writeMem(dir: string, name: string, frontmatter: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `---\n${frontmatter}\n---\n\n${body}\n`);
}

// Writes `count` opposite-polarity, topic-sharing pairs. Each pair gets its
// own unique topic (so pairs don't cross-pollinate into extra hits) and
// entirely disjoint subject vocabulary between the two halves (so the
// regex-only pass keeps the pair at INFO — Jaccard well under the 0.15
// HIGH floor — which is exactly the bucket the semantic pass re-embeds).
function writePairs(dir: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const topic = `synth-budget-${i}`;
    writeMem(
      dir,
      `zz_pair_${i}_a.md`,
      `name: pair ${i} a\ndescription: synthetic fixture\ntype: feedback\ntopics: [${topic}]`,
      `ALWAYS store apples in warehouse dock ${i}.`,
    );
    writeMem(
      dir,
      `zz_pair_${i}_b.md`,
      `name: pair ${i} b\ndescription: synthetic fixture\ntype: feedback\ntopics: [${topic}]`,
      `NEVER paint bicycles during thunderstorm ${i}.`,
    );
  }
}

// Same pattern as tests/embed-timeout-budget.test.ts's withCapturedTimeouts,
// extended to also capture each request's batch size (`input.length`) so
// chunking can be pinned alongside the timeout budget.
async function withCapturedEmbedCalls(
  fn: () => Promise<void>,
): Promise<{ timeoutMs: number; batchSize: number }[]> {
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  const origTimeout = AbortSignal.timeout;
  const captured: { timeoutMs: number; batchSize: number }[] = [];
  let pendingBatchSize = 0;

  (AbortSignal as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
    captured.push({ timeoutMs: ms, batchSize: pendingBatchSize });
    return origTimeout.call(AbortSignal, ms);
  };
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { body?: string },
  ) => {
    const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
    // AbortSignal.timeout() is called by embedBatch before fetch(), so the
    // capture above already ran with a stale pendingBatchSize; record the
    // real size against the most recent capture entry instead.
    if (captured.length > 0) {
      captured[captured.length - 1].batchSize = body.input.length;
    }
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

// Must actually await fn() — see tests/embed-timeout-budget.test.ts's
// withOpenAiKey for why a non-awaited try/finally would restore too early.
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

test('lint --semantic: missing-pair embed call uses INDEX_DEFAULT_TIMEOUT_MS, not embedBatch\'s hook default', async () => {
  const dir = tmpDir();
  writePairs(dir, 2); // well under BATCH=64: exactly one request expected
  try {
    await withOpenAiKey(async () => {
      const captured = await withCapturedEmbedCalls(async () => {
        const report = await lintMemoryDirForConflictsWithSemantic(dir, { semantic: true });
        assert.ok(report.hits.length > 0);
      });
      assert.equal(captured.length, 1, 'expected exactly one embed request for 4 missing ids');
      assert.equal(
        captured[0].timeoutMs,
        INDEX_DEFAULT_TIMEOUT_MS,
        'lint --semantic must use the index budget, not embedBatch\'s DEFAULT_TIMEOUT_MS',
      );
      assert.notEqual(
        captured[0].timeoutMs,
        DEFAULT_TIMEOUT_MS,
        'sanity: the two constants must actually differ for this assertion to mean anything',
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint --semantic: missing pairs are chunked at 64 per request, not shipped in one call', async () => {
  const dir = tmpDir();
  // 40 pairs = 80 missing memory ids (2 per pair, all uncached — fresh tmp
  // dir has no .memory-router index to reuse from). Expect two requests:
  // 64 then 16.
  writePairs(dir, 40);
  try {
    await withOpenAiKey(async () => {
      const captured = await withCapturedEmbedCalls(async () => {
        const report = await lintMemoryDirForConflictsWithSemantic(dir, { semantic: true });
        assert.ok(report.hits.length > 0);
      });
      assert.equal(captured.length, 2, 'expected two chunked requests for 80 missing ids');
      assert.deepEqual(
        captured.map((c) => c.batchSize),
        [64, 16],
        'batches must be capped at 64, remainder in a second request',
      );
      assert.ok(
        captured.every((c) => c.timeoutMs === INDEX_DEFAULT_TIMEOUT_MS),
        'every chunk must use the index budget',
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
