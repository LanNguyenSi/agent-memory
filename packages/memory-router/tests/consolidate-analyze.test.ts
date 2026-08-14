// Direct unit tests for src/consolidate/analyze.ts (runConsolidate): proves
// the four passes are actually wired together against a real corpus copy,
// and that the verb never writes to the corpus dir.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { runConsolidate, DEFAULT_NEAR_THRESHOLD } = require('../src/consolidate/analyze');

const STATIC_CORPUS = path.join(__dirname, 'fixtures', 'consolidate', 'corpus');

function copyStaticCorpus(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-consolidate-analyze-'));
  fs.cpSync(STATIC_CORPUS, dir, { recursive: true });
  return dir;
}

function snapshot(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).slice().sort();
}

test('runConsolidate: assembles exact dupes, near dupes (skipped, no index), stale, and schema from one corpus', () => {
  const dir = copyStaticCorpus();
  // A repoRoot where the fixture's verify: path genuinely does not exist,
  // so lint/stale.ts's own logic (called unmodified) reports it STALE.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-consolidate-reporoot-'));
  try {
    const report = runConsolidate(dir, { repoRoots: [repoRoot] });

    assert.equal(report.dir, dir);
    assert.equal(report.scannedCount, 6);

    assert.equal(report.exactDupes.groups.length, 1);
    assert.deepEqual(report.exactDupes.groups[0].ids, ['feedback_dupe_a', 'feedback_dupe_b']);
    assert.equal(typeof report.exactDupes.normalization, 'string');

    assert.equal(report.nearDupes.status, 'skipped');
    assert.match(report.nearDupes.reason, /no embedding index found/);
    assert.equal(report.nearDupes.threshold, DEFAULT_NEAR_THRESHOLD);

    assert.equal(report.stale.scannedCount, 6);
    const staleHit = report.stale.hits.find(
      (h: { memoryId: string }) => h.memoryId === 'reference_stale_ref',
    );
    assert.ok(staleHit, 'the verify: path ref must be surfaced by the reused stale.ts pass');
    assert.equal(staleHit.status, 'missing');

    assert.equal(report.schema.scannedCount, 6);
    assert.equal(report.schema.untaggedCount, 1);
    assert.equal(report.schema.legacyFormatCount, 2);
    assert.equal(report.schema.loaderRejects.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runConsolidate: a custom nearThreshold is threaded through to the near-dupes result', () => {
  const dir = copyStaticCorpus();
  try {
    const report = runConsolidate(dir, { nearThreshold: 0.42 });
    assert.equal(report.nearDupes.threshold, 0.42);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runConsolidate: never writes to the corpus dir (byte-identical directory snapshot before/after)', () => {
  const dir = copyStaticCorpus();
  const before = snapshot(dir);
  const beforeHashes = before.map((f) => {
    const full = path.join(dir, f);
    return fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : null;
  });
  try {
    runConsolidate(dir, { repoRoots: [dir] });
    const after = snapshot(dir);
    assert.deepEqual(after, before, 'no files created/removed');
    const afterHashes = after.map((f) => {
      const full = path.join(dir, f);
      return fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : null;
    });
    assert.deepEqual(afterHashes, beforeHashes, 'every file byte-identical before/after');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runConsolidate: default repoRoots falls back to [process.cwd()] without throwing', () => {
  const dir = copyStaticCorpus();
  try {
    const report = runConsolidate(dir);
    assert.equal(report.scannedCount, 6);
    assert.ok(Array.isArray(report.stale.hits));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// mm-v1-T007 fix round LOW #9: empty-body memories are wired through into
// exactDupes.emptyBodies, on a dedicated ad-hoc corpus (not the shared
// static fixture, so its scannedCount assertions elsewhere stay untouched).
test('runConsolidate: exactDupes.emptyBodies surfaces empty/whitespace-only-body memories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-consolidate-analyze-empty-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'blank_one.md'),
      '---\nname: blank one\ntype: reference\ntopics: [testing]\n---\n\n   \n',
    );
    fs.writeFileSync(
      path.join(dir, 'has_body.md'),
      '---\nname: has body\ntype: reference\ntopics: [testing]\n---\n\nreal content here\n',
    );
    const report = runConsolidate(dir, { repoRoots: [dir] });
    assert.equal(report.scannedCount, 2);
    assert.deepEqual(report.exactDupes.groups, []);
    assert.deepEqual(report.exactDupes.emptyBodies, [
      { id: 'blank_one', path: path.join(dir, 'blank_one.md') },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
