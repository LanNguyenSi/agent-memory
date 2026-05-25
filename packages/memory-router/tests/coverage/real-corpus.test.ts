// Routing-recall regression net for the synchronous router.
//
// Privacy policy: every prompt and memory under `tests/coverage/` is
// synthetic. Real user prompts and real-corpus memory bodies must NEVER be
// committed here verbatim — they can leak credentials, host names, or
// session content. The local-only path is `MEMORY_ROUTER_CORPUS_DIR=...`
// (and a separate uncommitted prompt sample) for ad-hoc dogfood runs.
//
// Suite structure: each labelled prompt asserts (a) every memory in
// `expectedMatches` actually fires, and (b) no memory in `expectedNoMatches`
// fires. Extras outside both sets are tolerated — the gate is recall, not
// minimality. After every prompt is evaluated, the suite emits a single
// `# coverage:` line summarising match-rate, mean hits/prompt, false-
// negatives, false-positives. The line is TAP-comment-prefixed so it
// flows through node:test's reporter and is greppable in CI output.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');

const { loadMemoriesFromDir } = require('../../dist/memory/loader');
const { resolve } = require('../../dist/router');

interface LabelledPrompt {
  prompt: string;
  expectedMatches: string[];
  expectedNoMatches: string[];
}

const FIXTURE_CORPUS = path.join(__dirname, 'corpus');
const CORPUS_DIR = process.env.MEMORY_ROUTER_COVERAGE_CORPUS_DIR ?? FIXTURE_CORPUS;
const DOGFOOD_MODE = CORPUS_DIR !== FIXTURE_CORPUS;
const FIXTURE_PATH = path.join(__dirname, 'prompts.fixture.json');

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as LabelledPrompt[];
const memories = loadMemoriesFromDir(CORPUS_DIR);

// Guardrail: if the corpus is empty, every assertion would vacuously fail
// in a confusing way. Surface the misconfiguration up front.
test('coverage suite: corpus loads', () => {
  assert.ok(
    memories.length > 0,
    `corpus dir ${CORPUS_DIR} produced zero memories (frontmatter parse error or wrong path?)`,
  );
});

test('coverage suite: fixture is non-empty', () => {
  assert.ok(fixture.length > 0, 'prompts fixture must contain ≥1 labelled prompt');
});

interface Stats {
  prompts: number;
  promptsWithAnyHit: number;
  totalHits: number;
  falseNegatives: number; // expectedMatches that didn't fire
  falsePositives: number; // expectedNoMatches that did fire
  expectedMatchTotal: number;
  expectedNoMatchTotal: number;
}

const stats: Stats = {
  prompts: 0,
  promptsWithAnyHit: 0,
  totalHits: 0,
  falseNegatives: 0,
  falsePositives: 0,
  expectedMatchTotal: 0,
  expectedNoMatchTotal: 0,
};

for (const entry of fixture) {
  test(`prompt: ${entry.prompt}`, () => {
    const ctx = { prompt: entry.prompt };
    const hits = resolve(ctx, memories, { maxHits: 1000 });
    const hitIds = new Set<string>(
      hits.map((h: { memory: { id: string } }) => h.memory.id),
    );

    stats.prompts += 1;
    stats.totalHits += hitIds.size;
    if (hitIds.size > 0) stats.promptsWithAnyHit += 1;

    // Dogfood mode: env-override points at a corpus whose IDs don't match
    // the fixture's labels. Aggregate firing-rate stats are still useful
    // (does the matcher fire at all on these prompts?) but the labelled
    // assertions become noise, so skip them.
    if (DOGFOOD_MODE) return;

    stats.expectedMatchTotal += entry.expectedMatches.length;
    stats.expectedNoMatchTotal += entry.expectedNoMatches.length;

    const missing = entry.expectedMatches.filter((id) => !hitIds.has(id));
    const wronglyMatched = entry.expectedNoMatches.filter((id) => hitIds.has(id));
    stats.falseNegatives += missing.length;
    stats.falsePositives += wronglyMatched.length;

    assert.deepEqual(
      missing,
      [],
      `prompt ${JSON.stringify(entry.prompt)}: expected memories did not fire: ${missing.join(', ')}`,
    );
    assert.deepEqual(
      wronglyMatched,
      [],
      `prompt ${JSON.stringify(entry.prompt)}: forbidden memories fired: ${wronglyMatched.join(', ')}`,
    );
  });
}

// Emit the aggregate stats line after every prompt subtest has run.
// node:test's `after()` hook fires after all peer tests in the same file,
// which is what we want — a single trailing summary, not one per prompt.
test.after(() => {
  const matchRate =
    stats.prompts === 0
      ? 0
      : (stats.promptsWithAnyHit / stats.prompts) * 100;
  const meanHits =
    stats.prompts === 0 ? 0 : stats.totalHits / stats.prompts;
  const fnRate =
    stats.expectedMatchTotal === 0
      ? 0
      : (stats.falseNegatives / stats.expectedMatchTotal) * 100;
  const fpRate =
    stats.expectedNoMatchTotal === 0
      ? 0
      : (stats.falsePositives / stats.expectedNoMatchTotal) * 100;

  // Single-line summary, TAP-comment prefixed so node:test's reporter
  // surfaces it verbatim. CI greppers: `grep '^# coverage:'`. In dogfood
  // mode (env-override at a non-fixture corpus) FN/FP are not tracked,
  // so the line omits them and prefixes "dogfood" so a reader doesn't
  // mistake it for the fixture run.
  const prefix = DOGFOOD_MODE ? 'coverage (dogfood)' : 'coverage';
  const labelledPart = DOGFOOD_MODE
    ? ''
    : ` | FN=${stats.falseNegatives}/${stats.expectedMatchTotal} (${fnRate.toFixed(1)}%)` +
      ` | FP=${stats.falsePositives}/${stats.expectedNoMatchTotal} (${fpRate.toFixed(1)}%)`;
  console.log(
    `${prefix}: ${matchRate.toFixed(1)}% (${stats.promptsWithAnyHit}/${stats.prompts} prompts matched ≥1)` +
      ` | mean_hits=${meanHits.toFixed(2)}${labelledPart}`,
  );
});
