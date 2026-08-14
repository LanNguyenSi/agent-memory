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

test('migrate: metadata.topics hoists to top-level topics, reported with source "metadata.topics"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-migrate-cli-hoist-'));
  fs.writeFileSync(
    path.join(dir, 'meta_topics_case.md'),
    '---\nname: meta topics case\ndescription: nothing vocabulary would match\nmetadata:\n  type: feedback\n  topics: [curated_a, curated_b]\n---\n\nbody\n',
  );
  try {
    const { status, stdout } = run(['migrate', '--dir', dir, '--json']);
    assert.equal(status, 0, stdout);
    const parsed = JSON.parse(stdout) as {
      files: Array<{ id: string; topics: { action: string; value?: string[]; source?: string } }>;
    };
    const f = parsed.files.find((x) => x.id === 'meta_topics_case');
    assert.ok(f);
    assert.equal(f!.topics.action, 'set');
    assert.equal(f!.topics.source, 'metadata.topics');
    assert.deepEqual(f!.topics.value, ['curated_a', 'curated_b']);
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

test('migrate --mapping: a value starting with `--` (the next flag swallowed) is rejected with a clear "expects a file path" error', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stderr, stdout } = run(['migrate', '--dir', dir, '--mapping', '--json']);
    assert.equal(status, 1, stdout);
    assert.match(stderr, /--mapping expects a file path/);
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

// --- exit code: real write failures gate, dry-run/untagged never do (fix-round 2, #2) ---

test('migrate --apply: a write failure (readonly target dir) exits 1, sources are left unchanged', () => {
  const dir = copyStaticCorpus();
  try {
    const before = fs.readFileSync(path.join(dir, 'feedback_needs_hoist.md'), 'utf8');
    fs.chmodSync(dir, 0o555); // read+execute only: writeFileSync for the tmp file must fail
    try {
      const { status, stdout } = run(['migrate', '--dir', dir, '--apply']);
      assert.equal(status, 1, stdout);
      assert.match(stdout, /errors \(\d+\):/);
    } finally {
      fs.chmodSync(dir, 0o755); // restore write perms so cleanup below can remove the dir
    }
    const after = fs.readFileSync(path.join(dir, 'feedback_needs_hoist.md'), 'utf8');
    assert.equal(after, before, 'a failed write must leave every source file untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: a dry run always exits 0 even when files are untagged/missing type', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stdout } = run(['migrate', '--dir', dir]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /untagged topics/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- vocabulary disclosure (fix-round 2, #5) ---------------------------------

test('migrate --json: vocabulary reports "default" with vocabularyError null when no topics.yml exists', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stdout } = run(['migrate', '--dir', dir, '--json']);
    assert.equal(status, 0, stdout);
    const parsed = JSON.parse(stdout) as { vocabulary: string; vocabularyError: string | null };
    assert.equal(parsed.vocabulary, 'default');
    assert.equal(parsed.vocabularyError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --json: vocabulary reports "custom" for a valid topics.yml', () => {
  const dir = copyStaticCorpus();
  fs.writeFileSync(path.join(dir, 'topics.yml'), '- name: custom_topic\n  patterns: ["\\\\bcustom\\\\b"]\n');
  try {
    const { status, stdout } = run(['migrate', '--dir', dir, '--json']);
    assert.equal(status, 0, stdout);
    const parsed = JSON.parse(stdout) as { vocabulary: string; vocabularyError: string | null };
    assert.equal(parsed.vocabulary, 'custom');
    assert.equal(parsed.vocabularyError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: a broken topics.yml is surfaced as a hint in a dry run (still exits 0)', () => {
  const dir = copyStaticCorpus();
  fs.writeFileSync(path.join(dir, 'topics.yml'), 'not_a_list: true\n');
  try {
    const { status, stdout } = run(['migrate', '--dir', dir]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /vocabulary: default \(topics\.yml rejected:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --apply: a broken topics.yml is a setup error (exit 1), same as an invalid --mapping file; nothing is written', () => {
  const dir = copyStaticCorpus();
  fs.writeFileSync(path.join(dir, 'topics.yml'), 'not_a_list: true\n');
  try {
    const before = fs.readFileSync(path.join(dir, 'feedback_needs_hoist.md'), 'utf8');
    const { status, stderr } = run(['migrate', '--dir', dir, '--apply']);
    assert.equal(status, 1);
    assert.match(stderr, /topics\.yml rejected/);
    const after = fs.readFileSync(path.join(dir, 'feedback_needs_hoist.md'), 'utf8');
    assert.equal(after, before, 'a refused --apply must not write anything');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--help lists the migrate verb', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /migrate \[--dir <path>\]/);
});
