// Smoke test for the `memory-router test "<prompt>"` CLI verb. The verb
// dry-runs a prompt against the live router (same matcher the
// UserPromptSubmit hook uses), so the goal here is to confirm
// (a) positional prompt + --dir resolves to the fixture corpus,
// (b) a prompt that matches a fixture's topic prints the memory + score,
// (c) a deliberately-non-matching prompt prints "no match" and exits 0,
// (d) --json emits valid JSON that downstream tools can parse,
// (e) missing --dir / $MEMORY_ROUTER_DIR exits 1 with a clear message.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'dist', 'cli.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'memories');
const VOCAB_CORPUS = path.join(__dirname, 'fixtures', 'vocab');

// Hermetic against an ambient $MEMORY_ROUTER_DIR: this suite's
// `--dir`-scoped assertions must pass identically
// whether or not the host running these tests happens to have
// $MEMORY_ROUTER_DIR set in its own environment. Every call strips the
// inherited value before spawning; a test that specifically wants to
// exercise the env-fallback path (see the "falls back to $MEMORY_ROUTER_DIR"
// test below) re-adds it explicitly via the `env` param, which always wins
// (applied after the stripped base).
function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  // Extra node CLI args, prepended before the script path (e.g. a
  // --require preload for the dist/router.js export seam).
  nodeArgs: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const baseEnv = { ...process.env };
  delete baseEnv.MEMORY_ROUTER_DIR;
  const res = spawnSync(process.execPath, [...nodeArgs, BIN, ...args], {
    encoding: 'utf8',
    timeout: 8_000,
    env: { ...baseEnv, ...env },
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

test('test verb matches a fixture memory via the topic gate', () => {
  // feedback_force_push.md ships topics: [destructive_ops], which the topic
  // gate maps to keywords including "force push". The prompt below should
  // trip the gate.
  const { status, stdout } = run([
    'test',
    'git push --force to master',
    '--dir',
    FIXTURES,
  ]);
  assert.equal(status, 0, `expected exit 0; stderr was:\n${stdout}`);
  assert.match(stdout, /1 match:|matches:/);
  assert.match(stdout, /feedback_force_push/);
  assert.match(stdout, /topic · /);
});

test('test verb prints "no match" for an unrelated prompt', () => {
  const { status, stdout } = run([
    'test',
    'rename a typescript variable to camelCase',
    '--dir',
    FIXTURES,
  ]);
  assert.equal(status, 0);
  assert.match(stdout, /no match\./);
});

test('test --json emits valid parseable JSON', () => {
  const { status, stdout } = run([
    'test',
    'git push --force to master',
    '--dir',
    FIXTURES,
    '--json',
  ]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as {
    prompt: string;
    dir: string;
    hits: Array<{ id: string; gate: string; score: number }>;
  };
  assert.equal(parsed.prompt, 'git push --force to master');
  assert.equal(parsed.dir, FIXTURES);
  assert.ok(parsed.hits.length >= 1, 'expected at least one hit');
  assert.equal(parsed.hits[0].id, 'feedback_force_push');
  assert.equal(parsed.hits[0].gate, 'topic');
  assert.equal(typeof parsed.hits[0].score, 'number');
});

test('test verb falls back to $MEMORY_ROUTER_DIR when --dir is omitted', () => {
  const { status, stdout } = run(
    ['test', 'git push --force to master'],
    { MEMORY_ROUTER_DIR: FIXTURES },
  );
  assert.equal(status, 0);
  assert.match(stdout, /feedback_force_push/);
});

test('test verb errors when neither --dir nor $MEMORY_ROUTER_DIR is set', () => {
  // Spawn with an empty env (preserve PATH so node finds itself) so
  // $MEMORY_ROUTER_DIR is genuinely absent.
  const cleanEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  const res = spawnSync(process.execPath, [BIN, 'test', 'anything'], {
    encoding: 'utf8',
    timeout: 4_000,
    env: cleanEnv,
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--dir <path> or \$MEMORY_ROUTER_DIR is required/);
});

test('test verb errors when prompt is missing', () => {
  const { status, stderr } = run(['test', '--dir', FIXTURES]);
  assert.equal(status, 1);
  assert.match(stderr, /test <prompt> is required/);
});

test('--max-hits refuses to swallow the next flag as a value', () => {
  const { status, stderr } = run([
    'test',
    'git push --force to master',
    '--dir',
    FIXTURES,
    '--max-hits',
    '--json',
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /--max-hits/);
});

test('--max-hits=n form accepts a positive integer', () => {
  const { status } = run([
    'test',
    'git push --force to master',
    '--dir',
    FIXTURES,
    '--max-hits',
    '3',
  ]);
  assert.equal(status, 0);
});

// --- dir-threading, not the $MEMORY_ROUTER_DIR env global -----

test('test verb: custom topics.yml at --dir applies even without $MEMORY_ROUTER_DIR set (ctx.memoryDir threading, not the env global)', () => {
  // VOCAB_CORPUS's topics.yml declares `incident_response`, which is not
  // part of the built-in default vocabulary — this prompt only matches if
  // --dir's own topics.yml is actually consulted by the gate (via
  // ctx.memoryDir) rather than whatever $MEMORY_ROUTER_DIR happens to
  // resolve to (here: unset, thanks to the hermetic run() helper above).
  const { status, stdout } = run([
    'test',
    'we had an outage last night, on-call got paged',
    '--dir',
    VOCAB_CORPUS,
  ]);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /1 match:|matches:/);
  assert.match(stdout, /feedback_incident/);
  assert.match(stdout, /topic · /);
});

// --- hermetic against ambient $MEMORY_ROUTER_DIR ------------

test('hermetic: an ambient $MEMORY_ROUTER_DIR in the calling process does not leak into the spawned CLI and override --dir', () => {
  const original = process.env.MEMORY_ROUTER_DIR;
  // A foreign corpus with no topics.yml at all — if this ever leaked into
  // the child process and won over --dir, "no match." would print instead.
  process.env.MEMORY_ROUTER_DIR = FIXTURES;
  try {
    const { status, stdout } = run([
      'test',
      'we had an outage last night, on-call got paged',
      '--dir',
      VOCAB_CORPUS,
    ]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /feedback_incident/);
  } finally {
    if (original === undefined) delete process.env.MEMORY_ROUTER_DIR;
    else process.env.MEMORY_ROUTER_DIR = original;
  }
});

// --- rendered size (what the UserPromptSubmit hook would inject) -----------

const { resolve: resolveSync } = require('../src/router');
const { renderHitsBudgeted } = require('../src/render');
const { loadMemoriesFromDir } = require('../src/memory/loader');

function renderedBytesInProcess(prompt: string, dir: string): number {
  const hits = resolveSync(
    { prompt, cwd: process.cwd(), memoryDir: dir },
    loadMemoriesFromDir(dir),
    { maxHits: 5 },
  );
  return Buffer.byteLength(renderHitsBudgeted(hits, { budgetBytes: 16384 }), 'utf8');
}

test('test verb prints the rendered size in bytes with the budget', () => {
  const { status, stdout } = run(['test', 'git push --force to master', '--dir', FIXTURES]);
  assert.equal(status, 0);
  const expected = renderedBytesInProcess('git push --force to master', FIXTURES);
  assert.ok(expected > 0);
  assert.match(stdout, new RegExp(`rendered: ${expected} bytes \\(budget 16384 bytes\\)`));
});

test('test --json carries renderedBytes and budgetBytes, honoring MEMORY_ROUTER_INJECT_BUDGET', () => {
  const base = run(['test', 'git push --force to master', '--dir', FIXTURES, '--json']);
  assert.equal(base.status, 0);
  const parsed = JSON.parse(base.stdout) as { renderedBytes: number; budgetBytes: number };
  assert.equal(parsed.budgetBytes, 16384);
  assert.equal(parsed.renderedBytes, renderedBytesInProcess('git push --force to master', FIXTURES));

  const small = run(
    ['test', 'git push --force to master', '--dir', FIXTURES, '--json'],
    { MEMORY_ROUTER_INJECT_BUDGET: '1' },
  );
  const smallParsed = JSON.parse(small.stdout) as { renderedBytes: number; budgetBytes: number };
  assert.equal(smallParsed.budgetBytes, 1);
  assert.ok(smallParsed.renderedBytes > 0, 'the top hit is always rendered');
});

test('test --json: an invalid MEMORY_ROUTER_INJECT_BUDGET falls back to the default with one stderr note', () => {
  const res = run(
    ['test', 'git push --force to master', '--dir', FIXTURES, '--json'],
    { MEMORY_ROUTER_INJECT_BUDGET: 'abc' },
  );
  assert.equal(res.status, 0);
  assert.equal((JSON.parse(res.stdout) as { budgetBytes: number }).budgetBytes, 16384);
  assert.equal(res.stderr.split('MEMORY_ROUTER_INJECT_BUDGET').length - 1, 1);
});

test('test --json for a prompt with no match reports 0 rendered bytes', () => {
  const { status, stdout } = run(['test', 'rename a typescript variable to camelCase', '--dir', FIXTURES, '--json']);
  assert.equal(status, 0);
  assert.equal((JSON.parse(stdout) as { renderedBytes: number }).renderedBytes, 0);
});

// `--semantic` handles a prompt, so its confidence-gate failure line must name
// the error class and never the message (src/error-summary.ts): the prompt is in
// flight and a store-level failure on this path can come back with a message
// quoting prompt-derived text.
//
// The failure here is real, not stubbed: the corpus has an index and a provider
// config, and the embed endpoint is a closed loopback port, so the search gets
// past openIndex and `embedBatch` rejects. indexer.ts rethrows that through
// `describeEmbedError`, whose message interpolates the active model tag (here
// MARKER), so a message-echoing catch would put the marker on stderr.
const MARKER = 'PROMPT-MARKER-xyz';

test('test --semantic: a failed confidence gate names the error class, never the error message', () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-router-cli-hygiene-'),
  );
  try {
    fs.mkdirSync(path.join(dir, '.memory-router'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'force_push.md'),
      '---\nname: hygiene_force_push\ndescription: force push rule\ntype: feedback\ntopics: [destructive_ops]\n---\n\nnever git push --force to a shared branch\n',
    );
    const { openIndex } = require('../src/embed/index-store');
    const store = openIndex({
      path: path.join(dir, '.memory-router', 'index.sqlite'),
      dimensions: 4,
      meta: { provider: 'openai', model: MARKER },
    });
    store.close();
    const res = run(
      ['test', 'git push --force to master', '--dir', dir, '--semantic'],
      {
        OPENAI_API_KEY: 'sk-test-not-real',
        MEMORY_ROUTER_EMBED_PROVIDER: 'openai',
        MEMORY_ROUTER_EMBED_MODEL: MARKER,
        OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
      },
    );
    assert.match(
      res.stderr,
      /warning: --semantic confidence gate failed, sync hits only: Error\n/,
    );
    assert.ok(
      !res.stderr.includes(MARKER),
      `the confidence-gate error message leaked into stderr: ${JSON.stringify(res.stderr)}`,
    );
    assert.ok(
      !res.stderr.includes('if the embedding provider or model changed'),
      `a non-provenance error must not print the rebuild hint: ${JSON.stringify(res.stderr)}`,
    );
    // The documented fallback: the sync-only hits are still reported.
    assert.equal(res.status, 0);
    assert.match(res.stdout, /topic match: destructive_ops/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An index built with a different provider is the provenance-mismatch class:
// openIndex throws it at the confidence gate, and the warning line must carry
// the FIXED rebuild hint naming the dir (the full rebuild command lives in the
// error message, which the line must not print - src/error-summary.ts).
test('test --semantic: an index provenance mismatch appends the fixed rebuild hint with the dir', () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-router-cli-provenance-'),
  );
  try {
    fs.mkdirSync(path.join(dir, '.memory-router'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'force_push.md'),
      '---\nname: hygiene_force_push\ndescription: force push rule\ntype: feedback\ntopics: [destructive_ops]\n---\n\nnever git push --force to a shared branch\n',
    );
    const { openIndex } = require('../src/embed/index-store');
    // Index provenance: provider=openai, model=MARKER (only ever printed
    // from the error message).
    const store = openIndex({
      path: path.join(dir, '.memory-router', 'index.sqlite'),
      dimensions: 4,
      meta: { provider: 'openai', model: MARKER },
    });
    store.close();
    const res = run(
      ['test', 'git push --force to master', '--dir', dir, '--semantic'],
      {
        OPENAI_API_KEY: '',
        MEMORY_ROUTER_EMBED_PROVIDER: 'ollama',
      },
    );
    assert.match(
      res.stderr,
      /warning: --semantic confidence gate failed, sync hits only: IndexProvenanceMismatchError; if the embedding provider or model changed, run `memory-router index \/.*` to rebuild\n/,
    );
    assert.ok(
      res.stderr.includes(`memory-router index ${dir}\` to rebuild`),
      `expected the hint to name the tested dir (${dir}): ${JSON.stringify(res.stderr)}`,
    );
    assert.ok(
      !res.stderr.includes(MARKER),
      `the provenance error message leaked into stderr: ${JSON.stringify(res.stderr)}`,
    );
    // Same documented fallback as any other gate failure: sync hits only.
    assert.equal(res.status, 0);
    assert.match(res.stdout, /topic match: destructive_ops/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The sync resolve() in runTest runs with the prompt in flight, so a gate
// error must be caught there (errorSummary + non-zero exit), not escape to
// the top-level main().catch with its String(err).
const PRELOAD = path.join(__dirname, 'fixtures', 'stub-router-preload.cjs');

test('test: a sync resolver failure prints the error summary, never the message, and exits 1', () => {
  const res = run(
    ['test', 'git push --force to master', '--dir', FIXTURES],
    {
      MEMORY_ROUTER_TEST_STUB_EXPORT: 'resolve',
      MEMORY_ROUTER_TEST_STUB_MARKER: MARKER,
    },
    ['--require', PRELOAD],
  );
  assert.match(
    res.stderr,
    /^error: memory-router test failed: RouterFailure \(SQLITE_ERROR\)\n/,
  );
  assert.ok(
    !res.stderr.includes(MARKER),
    `the resolver error message leaked into stderr: ${JSON.stringify(res.stderr)}`,
  );
  assert.ok(
    !res.stderr.includes('if the embedding provider or model changed'),
    `a non-provenance error must not print the rebuild hint: ${JSON.stringify(res.stderr)}`,
  );
  assert.equal(res.stdout, '');
  assert.equal(res.status, 1);
});
