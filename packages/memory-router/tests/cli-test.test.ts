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
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'dist', 'cli.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'memories');
const VOCAB_CORPUS = path.join(__dirname, 'fixtures', 'vocab');

// Hermetic against an ambient $MEMORY_ROUTER_DIR (mm-v1-T002 review round 2,
// fix 3): this suite's `--dir`-scoped assertions must pass identically
// whether or not the host running these tests happens to have
// $MEMORY_ROUTER_DIR set in its own environment. Every call strips the
// inherited value before spawning; a test that specifically wants to
// exercise the env-fallback path (see the "falls back to $MEMORY_ROUTER_DIR"
// test below) re-adds it explicitly via the `env` param, which always wins
// (applied after the stripped base).
function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const baseEnv = { ...process.env };
  delete baseEnv.MEMORY_ROUTER_DIR;
  const res = spawnSync(process.execPath, [BIN, ...args], {
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

// --- HIGH fix 1: dir-threading, not the $MEMORY_ROUTER_DIR env global -----

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

// --- MEDIUM fix 3: hermetic against ambient $MEMORY_ROUTER_DIR ------------

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
