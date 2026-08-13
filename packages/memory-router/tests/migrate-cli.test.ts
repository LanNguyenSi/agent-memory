// Smoke test for the `memory-router migrate` CLI verb: confirms the verb is
// registered, dry-run is the default, --apply actually writes, --mapping is
// consulted, --dir / $MEMORY_ROUTER_DIR resolution matches `eval`/`test`,
// --json emits parseable output, and error paths exit non-zero with a clear
// message. Mirrors the style of eval-cli.test.ts.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'dist', 'cli.js');
const STATIC_CORPUS = path.join(__dirname, 'fixtures', 'migrate', 'corpus');
const MAPPING_PATH = path.join(__dirname, 'fixtures', 'migrate', 'mapping.yml');

function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 8_000,
    env: { ...process.env, ...env },
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

// Every test gets its own throwaway copy of the static fixture corpus — the
// CLI is never pointed at the checked-in fixtures directory itself, dry-run
// or not, matching the task's "temp copies only" constraint.
function copyStaticCorpus(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-migrate-cli-'));
  fs.cpSync(STATIC_CORPUS, dir, { recursive: true });
  return dir;
}

test('migrate: dry-run is the default, no files are written', () => {
  const dir = copyStaticCorpus();
  const before = fs.readFileSync(path.join(dir, 'feedback_needs_hoist.md'), 'utf8');
  try {
    const { status, stdout } = run(['migrate', '--dir', dir]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /would apply to \d+ file\(s\)/);
    assert.equal(fs.readFileSync(path.join(dir, 'feedback_needs_hoist.md'), 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --apply: writes the planned changes', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stdout } = run(['migrate', '--dir', dir, '--apply']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /applied to \d+ file\(s\)/);
    const after = fs.readFileSync(path.join(dir, 'feedback_needs_hoist.md'), 'utf8');
    assert.match(after, /^type: feedback$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --apply twice: second run reports nothing left to change', () => {
  const dir = copyStaticCorpus();
  try {
    run(['migrate', '--dir', dir, '--apply']);
    const { status, stdout } = run(['migrate', '--dir', dir, '--apply']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /applied to 0 file\(s\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --json emits valid, parseable JSON matching the documented schema', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stdout } = run(['migrate', '--dir', dir, '--json']);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout) as {
      dir: string;
      mapping: string | null;
      apply: boolean;
      files: Array<{ id: string; changed: boolean; type: { action: string } }>;
      summary: {
        total: number;
        changed: number;
        unchanged: number;
        skipped: number;
        untaggedTopics: string[];
        missingType: string[];
        applied: number | null;
        errored: string[];
      };
    };
    assert.equal(parsed.dir, dir);
    assert.equal(parsed.mapping, null);
    assert.equal(parsed.apply, false);
    assert.equal(parsed.files.length, 4);
    assert.equal(parsed.summary.applied, null, 'dry-run reports applied: null, not a count');
    assert.deepEqual(
      [...parsed.summary.untaggedTopics].sort(),
      ['project_conflict', 'user_untagged'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --mapping: a curated mapping rule resolves an otherwise-untagged file', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stdout } = run([
      'migrate',
      '--dir',
      dir,
      '--mapping',
      MAPPING_PATH,
      '--json',
    ]);
    assert.equal(status, 0, stdout);
    const parsed = JSON.parse(stdout) as {
      files: Array<{ id: string; topics: { action: string; value?: string[]; source?: string } }>;
    };
    const f = parsed.files.find((x) => x.id === 'user_untagged');
    assert.ok(f);
    assert.equal(f!.topics.action, 'set');
    assert.equal(f!.topics.source, 'mapping');
    assert.deepEqual(f!.topics.value, ['mapped_topic']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --mapping: an invalid mapping file is a setup error (exit 1), not silently ignored', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stderr } = run([
      'migrate',
      '--dir',
      dir,
      '--mapping',
      path.join(dir, 'does-not-exist.yml'),
    ]);
    assert.equal(status, 1);
    assert.match(stderr, /mapping file: could not read/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: $MEMORY_ROUTER_DIR env resolves the corpus when --dir is omitted', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stdout } = run(['migrate', '--json'], { MEMORY_ROUTER_DIR: dir });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout) as { dir: string };
    assert.equal(parsed.dir, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: missing --dir / $MEMORY_ROUTER_DIR exits 1 with a clear message', () => {
  const { status, stderr } = run(['migrate'], { MEMORY_ROUTER_DIR: '' });
  assert.equal(status, 1);
  assert.match(stderr, /--dir <path> or \$MEMORY_ROUTER_DIR is required/);
});

test('migrate: nonexistent corpus dir exits 1 with a clear message', () => {
  const { status, stderr } = run([
    'migrate',
    '--dir',
    path.join(os.tmpdir(), 'memory-router-migrate-does-not-exist'),
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /error: cannot read/);
});

test('--help lists the migrate verb', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /migrate \[--dir <path>\]/);
});
