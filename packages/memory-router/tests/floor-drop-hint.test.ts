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
// real cosine scores cluster below it. This file pins the cases from the
// task's acceptance criteria plus two fix-round additions (d33f968c fix
// round, findings 1 and 2 below): the hint fires exactly once for the
// fallback-provenance total-loss case, and never for a calibrated map
// entry, an explicit override, OpenAI's own deliberate provider default, a
// run where at least one candidate still passed the floor, or a run where
// the semantic path found no candidates to filter at all (empty result or a
// caught search error).
//
// `node --test` isolates each test FILE into its own child process by
// default (this package's `test`/`test:coverage` scripts pass a file glob
// to the CLI, see package.json) — so src/router.ts's module-level
// floorDropHintEmitted flag starts fresh for this file and is shared only
// ACROSS the tests within it, exactly the "once per process" contract under
// test. The "second call in the same process emits nothing" case therefore
// makes both resolveBlended calls inside ONE test, not across two.
//
// Ordering within this file is deliberate, not incidental: once ANY test
// trips floorDropHintEmitted, every later test in this same process can
// never observe the hint firing again — that's the feature working as
// designed, but it also means a test placed AFTER the trip can no longer
// independently prove its own condition (a mutant on that condition would
// stay masked by the already-tripped guard, not caught). Case 4 ("at least
// one candidate passes" -> no hint) and Case 5 ("no candidates at all" ->
// no hint, below) therefore both run BEFORE case 1 ("all candidates below a
// fallback floor" -> exactly one hint, then none), which is the only test
// that intentionally trips the flag; cases 2/3/the openai case (a "map"/
// "env"/"provider" source) never trip it regardless of position, since
// their own first guard condition (source === 'fallback') is already false.
// Case 1 stays last.

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

// Deps-seam fake for the caught-search-error path: resolveBlended's own
// try/catch (src/router.ts) swallows this and degrades, so this fake never
// lets a real rejection escape to the test itself.
function fakeSemanticSearchThrows(
  message: string,
): (
  prompt: string,
  memories: Memory[],
  memoryDir: string,
  k: number,
) => Promise<{ memory: Memory; score: number }[]> {
  return async () => {
    throw new Error(message);
  };
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

// --- Case "provider": OpenAI's own deliberate 0.5 default, all below -----
//     -> no hint. Regression coverage (agent-tasks d33f968c fix round,
//     finding 1): before this fix round, OpenAI resolved through the SAME
//     'fallback' source Ollama's uncalibrated models use, so a completely
//     healthy OpenAI run (0.5 is OpenAI's own documented default; an
//     all-below-floor result there is the normal junk-rejection outcome,
//     not a calibration gap) misfired this hint with misleading calibration
//     advice. Never trips floorDropHintEmitted (source is 'provider', not
//     'fallback'), so this test's position in the file doesn't matter. -----

test('resolveBlended: openai provider default (0.5) with all candidates below it emits no stderr hint (not an uncalibrated-fallback misfire)', async () => {
  await withEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-not-real' },
    async () => {
      const a = fakeMemory('a');
      const ctx: RouterContext = { prompt: PROMPT, memoryDir: NOVOCAB_DIR };
      const { stdout, stderr } = await captureStd(async () => {
        await resolveBlended(ctx, [a], '/fake/dir', {}, {
          semanticSearch: fakeSemanticSearch({ a: 0.2 }), // below openai's 0.5
        });
      });
      assert.equal(stdout.length, 0);
      assert.equal(
        stderr.length,
        0,
        "openai's own deliberate provider default must never trigger the uncalibrated-fallback hint",
      );
    },
  );
});

// --- Case 4: uncalibrated fallback floor, at least one candidate passes ---
//     -> no hint. Runs BEFORE case 1 below: this is the only one of the
//     three "no hint" cases whose own guard (semanticHits.length === 0)
//     would be masked by case 1 tripping floorDropHintEmitted first — see
//     the ordering note at the top of this file. --------------------------

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

// --- Case 5: uncalibrated fallback floor, but the semantic path found NO
//     candidates at all (empty result, or a caught search error) -> no
//     hint. Runs BEFORE case 1 below, for the same reason case 4 does — see
//     the ordering note at the top of this file. --------------------------
//
// Regression coverage (agent-tasks d33f968c fix round, finding 2): deleting
// the `semanticCandidateCount > 0 &&` conjunct from resolveBlended's guard
// left the pre-fix suite fully green, because every other "no hint" case in
// this file either used a non-fallback source (map/env/provider) or had
// semanticHits.length > 0 after filtering. semanticCandidateCount === 0 is
// the one combination none of those exercise: fallback source AND
// semanticHits.length === 0 are both still true when the semantic path
// never returned any real candidate to drop in the first place (no
// index/provider available, or the try/catch above swallowed a search
// error) — without the N>0 conjunct the guard's other conditions are still
// all satisfied, so it would fire a "dropped all 0 semantic candidate(s)"
// hint, which is nonsense: nothing was dropped, nothing was ever there.

test('resolveBlended: uncalibrated fallback floor with NO semantic candidates at all (empty result) emits no stderr hint', async () => {
  await withEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'ollama', MEMORY_ROUTER_EMBED_MODEL: 'all-minilm' },
    async () => {
      const a = fakeMemory('a');
      const ctx: RouterContext = { prompt: PROMPT, memoryDir: NOVOCAB_DIR };
      const { stdout, stderr } = await captureStd(async () => {
        await resolveBlended(ctx, [a], '/fake/dir', {}, {
          semanticSearch: fakeSemanticSearch({}), // no hits at all, count === 0
        });
      });
      assert.equal(stdout.length, 0);
      assert.equal(
        stderr.length,
        0,
        'no candidates to filter at all is not "all candidates dropped by the floor"',
      );
    },
  );
});

test('resolveBlended: uncalibrated fallback floor with a caught semantic-search error emits only the search-failure message, never the floor-drop hint on top of it', async () => {
  await withEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'ollama', MEMORY_ROUTER_EMBED_MODEL: 'all-minilm' },
    async () => {
      const a = fakeMemory('a');
      const ctx: RouterContext = { prompt: PROMPT, memoryDir: NOVOCAB_DIR };
      const { stdout, stderr } = await captureStd(async () => {
        await resolveBlended(ctx, [a], '/fake/dir', {}, {
          semanticSearch: fakeSemanticSearchThrows('embedding endpoint unreachable'),
        });
      });
      assert.equal(stdout.length, 0);
      // resolveBlended's own try/catch (src/router.ts) always writes its
      // "semantic search failed" diagnostic here, unconditionally and
      // unrelated to the floor-drop guard under test — so this case can't
      // assert stderr.length === 0 outright the way the others do. It
      // instead asserts the same thing they assert: exactly one stderr
      // write (the search-failure message, not two), and that the
      // floor-drop hint text specifically never appears.
      assert.equal(
        stderr.length,
        1,
        'expected only the search-failure message, no floor-drop hint stacked on top of it',
      );
      assert.match(stderr[0], /^memory-router: semantic search failed/);
      assert.doesNotMatch(stderr[0], /uncalibrated relevance floor/);
    },
  );
});

// --- Case 1: uncalibrated fallback floor, all N>0 candidates below it -----
//     -> exactly one hint, then none again in this process. Runs LAST: it
//     is the only test in this file that intentionally trips
//     floorDropHintEmitted, which would otherwise mask case 4/5 above; that
//     also makes it the only place in this file that can pin the exact
//     text of a firing hint (a second "first fire" elsewhere in this same
//     process would already be masked by this one).
//
// The model name below is deliberately tag-suffixed and dirty
// (leading/trailing whitespace, an embedded control byte) rather than the
// plain "all-minilm" used by the other cases in this file: resolveBlended's
// sanitizeModelNameForLog (agent-tasks d33f968c fix round, finding 4; the
// env var is operator/misconfiguration-controlled provenance, same threat
// model as the resolveDefaultMinSemanticScoreDetail hasOwnProperty guard in
// src/gates/confidence.ts) trims and strips control characters before
// interpolating the model name into the stderr line, but deliberately keeps
// the `:tag` suffix — unlike the floor lookup's own
// normalizeOllamaModelName, which strips it for the map lookup only. This
// pins both behaviors in the one place that can observe a firing message.

test('resolveBlended: uncalibrated fallback floor with all semantic candidates below it emits exactly one stderr hint (model name trimmed/control-stripped, tag suffix kept); a second call in the same process emits none', async () => {
  await withEnv(
    {
      MEMORY_ROUTER_EMBED_PROVIDER: 'ollama',
      MEMORY_ROUTER_EMBED_MODEL: '  all-minilm:latest\u0007  ',
    },
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
      assert.equal(
        first.stderr[0],
        'memory-router: uncalibrated relevance floor 0.78 for model "all-minilm:latest" dropped all 2 semantic candidate(s) this run; set MEMORY_ROUTER_BLEND_MIN_SEMANTIC to override, or calibrate a floor for this model, see README "Calibration" (#calibration-mm-v1-t008).\n',
        'expected the raw whitespace/control byte stripped from the model name, the :latest tag suffix kept',
      );

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
