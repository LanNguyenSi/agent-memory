// Smoke test for the `memory-router consolidate` CLI verb: confirms the
// verb is registered, --dir/$MEMORY_ROUTER_DIR resolution matches
// `migrate`/`eval`, --json emits parseable output matching the documented
// schema, --near-threshold is validated, the corpus dir is never written to,
// and it always exits 0 on an error-free run (a report, not a gate), even
// when findings exist. Mirrors the style of tests/migrate-cli.test.ts.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'dist', 'cli.js');
const STATIC_CORPUS = path.join(__dirname, 'fixtures', 'consolidate', 'corpus');

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

// Every test gets its own throwaway copy of the static fixture corpus; the
// CLI is never pointed at the checked-in fixtures dir itself.
function copyStaticCorpus(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-consolidate-cli-'));
  fs.cpSync(STATIC_CORPUS, dir, { recursive: true });
  return dir;
}

function snapshotWithContents(dir: string): Map<string, string | null> {
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).slice().sort();
  const map = new Map<string, string | null>();
  for (const f of files) {
    const full = path.join(dir, f);
    map.set(f, fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : null);
  }
  return map;
}

test('consolidate: exits 0 on an error-free run and never writes to the corpus dir, even with findings present', () => {
  const dir = copyStaticCorpus();
  const before = snapshotWithContents(dir);
  try {
    const { status, stdout } = run(['consolidate', '--dir', dir]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /report only, nothing was written/);
    // Findings do exist in this fixture (exact dupes, untagged, legacy
    // format, loader rejects) — the report, not the exit code, is where
    // they show up.
    assert.match(stdout, /group \(2\): feedback_dupe_a, feedback_dupe_b/);
    const after = snapshotWithContents(dir);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [file, contents] of before) {
      assert.equal(after.get(file), contents, `${file} must be byte-identical after consolidate`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('consolidate --json: emits valid, parseable JSON matching the documented schema', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stdout } = run(['consolidate', '--dir', dir, '--json']);
    assert.equal(status, 0, stdout);
    const parsed = JSON.parse(stdout) as {
      dir: string;
      scannedCount: number;
      exactDupes: { normalization: string; groups: Array<{ hash: string; ids: string[]; paths: string[] }> };
      nearDupes: { status: string; reason?: string; threshold: number; indexedCount: number; totalCount: number; pairs: unknown[] };
      stale: { hits: unknown[]; scannedCount: number; refsChecked: number };
      schema: { scannedCount: number; untaggedCount: number; legacyFormatCount: number; loaderRejects: unknown[] };
    };
    assert.equal(parsed.dir, dir);
    assert.equal(parsed.scannedCount, 6);
    assert.equal(parsed.exactDupes.groups.length, 1);
    assert.deepEqual(parsed.exactDupes.groups[0].ids, ['feedback_dupe_a', 'feedback_dupe_b']);
    assert.equal(parsed.nearDupes.status, 'skipped');
    assert.equal(parsed.nearDupes.threshold, 0.95);
    assert.equal(parsed.schema.untaggedCount, 1);
    assert.equal(parsed.schema.legacyFormatCount, 2);
    assert.equal(parsed.schema.loaderRejects.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('consolidate --near-threshold: a valid value is reflected in the report', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stdout } = run(['consolidate', '--dir', dir, '--near-threshold', '0.8', '--json']);
    assert.equal(status, 0, stdout);
    const parsed = JSON.parse(stdout) as { nearDupes: { threshold: number } };
    assert.equal(parsed.nearDupes.threshold, 0.8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('consolidate --near-threshold: an out-of-range value (0) is rejected with a clear error, exit 1', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stderr } = run(['consolidate', '--dir', dir, '--near-threshold', '0']);
    assert.equal(status, 1);
    assert.match(stderr, /--near-threshold expects a number in \(0, 1\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('consolidate --near-threshold: a value above 1 is rejected with a clear error, exit 1', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stderr } = run(['consolidate', '--dir', dir, '--near-threshold', '1.5']);
    assert.equal(status, 1);
    assert.match(stderr, /--near-threshold expects a number in \(0, 1\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('consolidate --near-threshold: a non-numeric value is rejected with a clear error, exit 1', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stderr } = run(['consolidate', '--dir', dir, '--near-threshold', 'abc']);
    assert.equal(status, 1);
    assert.match(stderr, /--near-threshold expects a number in \(0, 1\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('consolidate --near-threshold: a value swallowing the next flag is rejected, not silently consumed', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stderr } = run(['consolidate', '--dir', dir, '--near-threshold', '--json']);
    assert.equal(status, 1);
    assert.match(stderr, /--near-threshold requires a number in \(0, 1\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('consolidate: $MEMORY_ROUTER_DIR env resolves the corpus when --dir is omitted', () => {
  const dir = copyStaticCorpus();
  try {
    const { status, stdout } = run(['consolidate', '--json'], { MEMORY_ROUTER_DIR: dir });
    assert.equal(status, 0, stdout);
    const parsed = JSON.parse(stdout) as { dir: string };
    assert.equal(parsed.dir, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('consolidate: missing --dir / $MEMORY_ROUTER_DIR exits 1 with a clear message', () => {
  const { status, stderr } = run(['consolidate'], { MEMORY_ROUTER_DIR: '' });
  assert.equal(status, 1);
  assert.match(stderr, /--dir <path> or \$MEMORY_ROUTER_DIR is required/);
});

test('consolidate: nonexistent corpus dir exits 1 with a clear message', () => {
  const { status, stderr } = run([
    'consolidate',
    '--dir',
    path.join(os.tmpdir(), 'memory-router-consolidate-does-not-exist'),
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /error: cannot read/);
});

test('--help lists the consolidate verb', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /consolidate \[--dir <path>\] \[--near-threshold <n>\] \[--json\]/);
});
