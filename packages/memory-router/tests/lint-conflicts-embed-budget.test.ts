// fe9c61bc: `memory-router lint --semantic` called embedBatch with no
// timeoutMs (inheriting embedBatch's 5s hook-tight DEFAULT_TIMEOUT_MS) and
// shipped every missing pair-embed input in a single request, unchunked.
// Reviewer measurement from PR #96 (Task ad1dba42): 64 real inputs take
// ~9.3s warm against Ollama/bge-m3, so any non-trivial corpus already blew
// the 5s budget and aborted — same bug class rebuildIndex had before
// mm-v1-T008 gave it INDEX_DEFAULT_TIMEOUT_MS + 64-batch chunking.
//
// This file pins several things end-to-end through
// lintMemoryDirForConflictsWithSemantic's real (non-embedFn-seam)
// embedBatch call:
//  - the missing-pair embed call uses INDEX_DEFAULT_TIMEOUT_MS, not the
//    tight hook default (see tests/embed-timeout-budget.test.ts for the
//    same assertion shape against rebuildIndex/semanticSearch).
//  - missing pairs are chunked at 64 per request instead of shipped in one
//    unchunked call, including the exact 64-id boundary (one request, no
//    empty trailing batch) and the vectors-to-ids alignment across a
//    chunk boundary.
//  - a malformed non-first chunk fails open to the untouched base report
//    with a chunk-sized (not total-sized) stderr message.
//
// No live network calls: fetch and AbortSignal.timeout are both stubbed,
// mirroring tests/embed-timeout-budget.test.ts's withCapturedTimeouts.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { DEFAULT_TIMEOUT_MS, INDEX_DEFAULT_TIMEOUT_MS } = require('../src/embed/provider');
const {
  lintMemoryDirForConflicts,
  lintMemoryDirForConflictsWithSemantic,
} = require('../src/lint/conflicts');

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
// The `pair <N>` marker in the `name` frontmatter field (present verbatim
// in the embed input via buildPairEmbedInput) is what markerVector() below
// reads to build a per-pair-index embedding.
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

// Wide enough for every pair index this file uses (max ~70); a one-hot
// vector per pair index so cosine similarity pins alignment: the two
// halves of pair N always embed to the *same* one-hot vector (similarity
// 1.0, clears the 0.85 threshold), while any two different pairs embed to
// orthogonal vectors (similarity 0.0). A vectors-to-ids misalignment bug
// (e.g. the SUT reading vectors[j+1] instead of vectors[j]) then shows up
// as pairs that fail to upgrade, which the constant fixture vector this
// file used before could never detect.
const MARKER_DIM = 256;

function markerVector(text: string, dim: number = MARKER_DIM): number[] {
  const match = text.match(/pair (\d+)/);
  const idx = match ? parseInt(match[1], 10) : 0;
  const vec = new Array(dim).fill(0);
  vec[idx] = 1;
  return vec;
}

// Same pattern as tests/embed-timeout-budget.test.ts's withCapturedTimeouts,
// extended to also capture each request's batch size (`input.length`) so
// chunking can be pinned alongside the timeout budget. Each fetch call
// pushes one complete {timeoutMs, batchSize} entry, reading the timeout off
// `lastTimeoutMs` (set by the AbortSignal.timeout call that always precedes
// fetch() for the same request in embedBatch).
async function withCapturedEmbedCalls(
  fn: () => Promise<void>,
): Promise<{ timeoutMs: number; batchSize: number }[]> {
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  const origTimeout = AbortSignal.timeout;
  const captured: { timeoutMs: number; batchSize: number }[] = [];
  let lastTimeoutMs = 0;

  (AbortSignal as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
    lastTimeoutMs = ms;
    return origTimeout.call(AbortSignal, ms);
  };
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { body?: string },
  ) => {
    const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
    captured.push({ timeoutMs: lastTimeoutMs, batchSize: body.input.length });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: body.input.map((t, index) => ({ embedding: markerVector(t), index })),
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

// Copied from tests/embed-timeout-budget.test.ts (file-local there, not
// exported): every test in this file must be hermetic against an ambient
// MEMORY_ROUTER_EMBED_TIMEOUT_MS, or a real value exported in the shell
// (e.g. a persistent widened index budget) silently changes what
// captured[].timeoutMs equals and turns these tests red for reasons
// unrelated to the code under test.
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

// Capture process.stderr.write for the duration of an async fn, mirroring
// tests/loader.test.ts's captureStderr but awaiting an async body.
async function withCapturedStderr<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (
    chunk: string,
  ) => {
    lines.push(chunk);
    return true;
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
}

test('lint --semantic: missing-pair embed call uses INDEX_DEFAULT_TIMEOUT_MS, not embedBatch\'s hook default', async () => {
  const dir = tmpDir();
  writePairs(dir, 2); // well under BATCH=64: exactly one request expected
  try {
    await withOpenAiKey(async () => {
      await withEmbedTimeoutEnv(undefined, async () => {
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
      await withEmbedTimeoutEnv(undefined, async () => {
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
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint --semantic: exactly 64 missing ids fit in a single request, no empty trailing batch', async () => {
  const dir = tmpDir();
  writePairs(dir, 32); // 32 pairs = 64 missing ids, exactly the BATCH boundary
  try {
    await withOpenAiKey(async () => {
      await withEmbedTimeoutEnv(undefined, async () => {
        const captured = await withCapturedEmbedCalls(async () => {
          const report = await lintMemoryDirForConflictsWithSemantic(dir, { semantic: true });
          assert.ok(report.hits.length > 0);
        });
        assert.equal(
          captured.length,
          1,
          'exactly 64 ids must not spill an empty trailing batch',
        );
        assert.equal(captured[0].batchSize, 64);
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint --semantic: embedding vectors stay aligned to their pair ids across a chunk boundary', async () => {
  const dir = tmpDir();
  const N = 70; // > BATCH=64: forces two chunked requests; every pair must still align.
  writePairs(dir, N);
  try {
    await withOpenAiKey(async () => {
      await withEmbedTimeoutEnv(undefined, async () => {
        await withCapturedEmbedCalls(async () => {
          const report = await lintMemoryDirForConflictsWithSemantic(dir, { semantic: true });
          const high = report.hits.filter((h: { severity: string }) => h.severity === 'high');
          assert.equal(
            high.length,
            N,
            `expected all ${N} opposite-polarity pairs to upgrade to high severity; a ` +
              `vectors-to-ids misalignment silently drops some instead of erroring (got ${high.length})`,
          );
        });
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint --semantic: a malformed non-first chunk fails open to the untouched base report, with a chunk-sized stderr message', async () => {
  const dir = tmpDir();
  const N = 35; // 70 missing ids: chunk 1 = 64 (ok), chunk 2 = 6 (short by one)
  writePairs(dir, N);
  const baseReport = lintMemoryDirForConflicts(dir);

  let callCount = 0;
  const embedFn = async (texts: string[]): Promise<number[][]> => {
    callCount++;
    if (callCount === 1) {
      assert.equal(texts.length, 64, 'first chunk must request the full 64-item batch');
      return texts.map((t) => markerVector(t));
    }
    assert.equal(texts.length, 6, 'second chunk must request the 6-item remainder');
    // Malformed: one vector short of the requested batch.
    return texts.slice(1).map((t) => markerVector(t));
  };

  try {
    const { result: report, lines } = await withCapturedStderr(() =>
      lintMemoryDirForConflictsWithSemantic(dir, { semantic: true, embedFn }),
    );
    assert.deepEqual(
      report,
      baseReport,
      'a malformed non-first chunk must fail open to the untouched regex-only report, ' +
        "discarding the first chunk's already-fetched embeddings too",
    );
    assert.equal(callCount, 2, 'must have reached the second chunk before failing');
    assert.ok(
      lines.some((line) => line.includes('5 vectors for 6 inputs')),
      `stderr must report the chunk-sized counts (5/6), not the total (69/70); got: ${JSON.stringify(lines)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
