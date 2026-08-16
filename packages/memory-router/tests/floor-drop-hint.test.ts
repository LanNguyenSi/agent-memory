// Unit tests for the once-per-process "uncalibrated floor dropped every
// semantic candidate" stderr hint in resolveBlended (src/router.ts,
// agent-tasks d33f968c, review residual of mm-v1-T008/PR #97's
// model-conditional relevance floor). PR #97 made the un-overridden
// MEMORY_ROUTER_BLEND_MIN_SEMANTIC default model/provider-CONDITIONAL, but
// only bge-m3 has a specifically-calibrated entry (src/gates/confidence.ts's
// OLLAMA_MODEL_FLOOR_DEFAULTS) — every OTHER Ollama model (all-minilm,
// mxbai-embed-large, nomic-embed-text, ...) falls through to the generic
// provider fallback (0.78, calibrated against bge-m3's own cosine band, not
// theirs) and can silently lose its entire semantic path if that model's
// real cosine scores cluster below it. This file pins the four cases from
// the task's acceptance criteria: the hint fires exactly once for the
// fallback-provenance total-loss case, and never for a calibrated map
// entry, an explicit override, or a run where at least one candidate still
// passed the floor.
//
// `node --test` isolates each test FILE into its own child process by
// default (this package's `test`/`test:coverage` scripts pass a file glob
// to the CLI, see package.json) — so src/router.ts's module-level
// floorDropHintEmitted flag starts fresh for this file and is shared only
// ACROSS the tests within it, exactly the "once per process" contract under
// test. The "second call in the same process emits nothing" case therefore
// makes both resolveBlended calls inside ONE test, not across two.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { resolveBlended } = require('../src/router');

// No topics.yml here — resolveBlended's internal topicGate.evaluate call
// falls back to the built-in default vocabulary, and threading ctx.memoryDir
// here (instead of leaving it unset) keeps this suite hermetic against
// whatever $MEMORY_ROUTER_DIR happens to be ambient in the host environment
// running `npm test` (mirrors tests/blend.test.ts's NOVOCAB_DIR).
const NOVOCAB_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'memory-router-floor-hint-novocab-'),
);
test.after(() => {
  fs.rmSync(NOVOCAB_DIR, { recursive: true, force: true });
});

// Every env var resolveProviderConfig() / the floor resolver consults —
// saved and restored around each test so this file stays hermetic against
// whatever embedding-provider env happens to be ambient on the host running
// `npm test` (mirrors tests/confidence.test.ts's FLOOR_ENV_KEYS/withFloorEnv
// pattern).
const ENV_KEYS = [
  'OPENAI_API_KEY',
  'MEMORY_ROUTER_EMBED_PROVIDER',
  'MEMORY_ROUTER_EMBED_MODEL',
  'MEMORY_ROUTER_OLLAMA_EMBED_MODEL',
  'MEMORY_ROUTER_BLEND_MIN_SEMANTIC',
] as const;

async function withEnv(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  for (const key of ENV_KEYS) prev[key] = process.env[key];
  for (const key of ENV_KEYS) {
    if (key in vars && vars[key] !== undefined) process.env[key] = vars[key];
    else delete process.env[key];
  }
  try {
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function fakeMemory(id: string): Memory {
  return {
    id,
    path: `/nonexistent/${id}.md`,
    frontmatter: { name: id, description: `desc for ${id}`, type: 'feedback' },
    body: `body for ${id}`,
  };
}

// Deps-seam fake mirroring tests/blend.test.ts's fakeSemanticSearch: returns
// a hit for every memory id present in `scoresById`, score taken verbatim
// from the map, without touching the real embedding stack.
function fakeSemanticSearch(
  scoresById: Record<string, number>,
): (
  prompt: string,
  memories: Memory[],
  memoryDir: string,
  k: number,
) => Promise<{ memory: Memory; score: number }[]> {
  return async (_prompt: string, memories: Memory[]) =>
    memories
      .filter((m) => scoresById[m.id] !== undefined)
      .map((m) => ({ memory: m, score: scoresById[m.id] }));
}

// Captures every process.stdout.write / process.stderr.write call made
// during `fn`, then restores the real streams — even if `fn` throws. No
// write() call is forwarded to the real terminal while captured.
async function captureStd(
  fn: () => Promise<void>,
): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
  }
  return { stdout, stderr };
}

const PROMPT = 'an unrelated prompt with no topic keywords at all';

// --- Case 1: uncalibrated fallback floor, all N>0 candidates below it -----

test('resolveBlended: uncalibrated fallback floor with all semantic candidates below it emits exactly one stderr hint; a second call in the same process emits none', async () => {
  await withEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'ollama', MEMORY_ROUTER_EMBED_MODEL: 'all-minilm' },
    async () => {
      const a = fakeMemory('a');
      const b = fakeMemory('b');
      const ctx: RouterContext = { prompt: PROMPT, memoryDir: NOVOCAB_DIR };

      const first = await captureStd(async () => {
        await resolveBlended(ctx, [a, b], '/fake/dir', {}, {
          // 0.78 is the provider-level fallback for an un-calibrated Ollama
          // model — both scores below it.
          semanticSearch: fakeSemanticSearch({ a: 0.5, b: 0.6 }),
        });
      });
      assert.equal(first.stdout.length, 0, 'resolveBlended must never write stdout');
      assert.equal(first.stderr.length, 1, 'expected exactly one stderr write on the first call');
      assert.match(
        first.stderr[0],
        /^memory-router: uncalibrated relevance floor 0\.78 for model "all-minilm" dropped all 2 semantic candidate\(s\) this run/,
      );
      assert.match(first.stderr[0], /MEMORY_ROUTER_BLEND_MIN_SEMANTIC/);
      assert.match(first.stderr[0], /README "Calibration"/);

      // Second call, same process, conditions still satisfied: the guard is
      // "once per process", not "once per failing run".
      const second = await captureStd(async () => {
        await resolveBlended(ctx, [a, b], '/fake/dir', {}, {
          semanticSearch: fakeSemanticSearch({ a: 0.4, b: 0.55 }),
        });
      });
      assert.equal(second.stdout.length, 0);
      assert.equal(
        second.stderr.length,
        0,
        'expected no stderr write on a second call in the same process',
      );
    },
  );
});

// --- Case 2: calibrated map-hit model (bge-m3), all below -> no hint ------

test('resolveBlended: a calibrated map-hit model (bge-m3) with all candidates below the floor emits no stderr hint', async () => {
  await withEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'ollama', MEMORY_ROUTER_EMBED_MODEL: 'bge-m3' },
    async () => {
      const a = fakeMemory('a');
      const ctx: RouterContext = { prompt: PROMPT, memoryDir: NOVOCAB_DIR };
      const { stdout, stderr } = await captureStd(async () => {
        await resolveBlended(ctx, [a], '/fake/dir', {}, {
          semanticSearch: fakeSemanticSearch({ a: 0.5 }), // below 0.78
        });
      });
      assert.equal(stdout.length, 0);
      assert.equal(
        stderr.length,
        0,
        'a specifically-calibrated map entry must never trigger the hint',
      );
    },
  );
});

// --- Case 3: explicit MEMORY_ROUTER_BLEND_MIN_SEMANTIC override, all below
//     -> no hint --------------------------------------------------------

test('resolveBlended: an explicit MEMORY_ROUTER_BLEND_MIN_SEMANTIC override with all candidates below it emits no stderr hint', async () => {
  await withEnv(
    {
      MEMORY_ROUTER_EMBED_PROVIDER: 'ollama',
      MEMORY_ROUTER_EMBED_MODEL: 'all-minilm',
      MEMORY_ROUTER_BLEND_MIN_SEMANTIC: '0.9',
    },
    async () => {
      const a = fakeMemory('a');
      const ctx: RouterContext = { prompt: PROMPT, memoryDir: NOVOCAB_DIR };
      const { stdout, stderr } = await captureStd(async () => {
        await resolveBlended(ctx, [a], '/fake/dir', {}, {
          semanticSearch: fakeSemanticSearch({ a: 0.5 }), // below 0.9
        });
      });
      assert.equal(stdout.length, 0);
      assert.equal(
        stderr.length,
        0,
        "an operator's own explicit override must never trigger the hint",
      );
    },
  );
});

// --- Case 4: uncalibrated fallback floor, at least one candidate passes ---
//     -> no hint ---------------------------------------------------------

test('resolveBlended: uncalibrated fallback floor with at least one candidate passing emits no stderr hint', async () => {
  await withEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'ollama', MEMORY_ROUTER_EMBED_MODEL: 'all-minilm' },
    async () => {
      const a = fakeMemory('a');
      const b = fakeMemory('b');
      const ctx: RouterContext = { prompt: PROMPT, memoryDir: NOVOCAB_DIR };
      const { stdout, stderr } = await captureStd(async () => {
        await resolveBlended(ctx, [a, b], '/fake/dir', {}, {
          semanticSearch: fakeSemanticSearch({ a: 0.5, b: 0.9 }), // b clears 0.78
        });
      });
      assert.equal(stdout.length, 0);
      assert.equal(
        stderr.length,
        0,
        'a run with at least one surviving candidate is a live signal, not a total loss',
      );
    },
  );
});
