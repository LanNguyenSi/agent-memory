// Direct unit tests for src/consolidate/schema-metrics.ts against the
// static fixture corpus tests/fixtures/consolidate/corpus.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { scanRawFrontmatter, buildSchemaMetrics } = require('../src/consolidate/schema-metrics');

interface RawScanEntryLike {
  path: string;
  id: string;
  ok: boolean;
  reason?: string;
  hasTopLevelType?: boolean;
  hasMetadataType?: boolean;
  hasTopLevelTopics?: boolean;
  hasMetadataTopics?: boolean;
}

const STATIC_CORPUS = path.join(__dirname, 'fixtures', 'consolidate', 'corpus');

function copyStaticCorpus(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-schema-metrics-'));
  fs.cpSync(STATIC_CORPUS, dir, { recursive: true });
  return dir;
}

test('scanRawFrontmatter: classifies every fixture file ok/rejected with the expected reasons', () => {
  const entries: RawScanEntryLike[] = scanRawFrontmatter(STATIC_CORPUS);
  const byId = new Map(entries.map((e) => [e.id, e]));

  assert.equal(byId.get('broken_no_frontmatter')!.ok, false);
  assert.match(byId.get('broken_no_frontmatter')!.reason, /no YAML frontmatter delimiter/);

  assert.equal(byId.get('broken_bad_type')!.ok, false);
  assert.match(byId.get('broken_bad_type')!.reason, /unknown type/);

  const dupeA = byId.get('feedback_dupe_a')!;
  assert.equal(dupeA.ok, true);
  assert.equal(dupeA.hasTopLevelType, true);
  assert.equal(dupeA.hasTopLevelTopics, true);
  assert.equal(dupeA.hasMetadataType, false);
  assert.equal(dupeA.hasMetadataTopics, false);

  const legacyTagged = byId.get('reference_legacy_tagged')!;
  assert.equal(legacyTagged.ok, true);
  assert.equal(legacyTagged.hasTopLevelType, false);
  assert.equal(legacyTagged.hasMetadataType, true);
  assert.equal(legacyTagged.hasTopLevelTopics, true);

  const legacyUntagged = byId.get('user_legacy_untagged')!;
  assert.equal(legacyUntagged.ok, true);
  assert.equal(legacyUntagged.hasTopLevelType, false);
  assert.equal(legacyUntagged.hasMetadataType, true);
  assert.equal(legacyUntagged.hasTopLevelTopics, false);
  assert.equal(legacyUntagged.hasMetadataTopics, false);
});

test('scanRawFrontmatter: an unreadable dir returns an empty list rather than throwing (mirrors loader.ts)', () => {
  const missing = path.join(os.tmpdir(), 'memory-router-schema-metrics-does-not-exist');
  assert.deepEqual(scanRawFrontmatter(missing), []);
});

test('buildSchemaMetrics: counts untagged/legacy-format/loader-rejects against the fixture corpus', () => {
  const metrics = buildSchemaMetrics(STATIC_CORPUS);

  // 6 valid files: feedback_dupe_a, feedback_dupe_b, project_unique,
  // reference_legacy_tagged, user_legacy_untagged, reference_stale_ref.
  assert.equal(metrics.scannedCount, 6);

  assert.equal(metrics.untaggedCount, 1);
  assert.deepEqual(metrics.untaggedIds, ['user_legacy_untagged']);

  assert.equal(metrics.legacyFormatCount, 2);
  assert.deepEqual(
    [...metrics.legacyFormatIds].sort(),
    ['reference_legacy_tagged', 'user_legacy_untagged'],
  );
  assert.ok(Math.abs(metrics.legacyFormatRate - 2 / 6) < 1e-9);

  assert.equal(metrics.loaderRejects.length, 2);
  const rejectPaths = metrics.loaderRejects.map((r: { path: string }) => path.basename(r.path)).sort();
  assert.deepEqual(rejectPaths, ['broken_bad_type.md', 'broken_no_frontmatter.md']);
  for (const r of metrics.loaderRejects) {
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0);
  }
});

test('buildSchemaMetrics: legacyFormatRate is 0 (not NaN) on a corpus with zero valid files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-schema-metrics-empty-'));
  try {
    const metrics = buildSchemaMetrics(dir);
    assert.equal(metrics.scannedCount, 0);
    assert.equal(metrics.legacyFormatRate, 0);
    assert.deepEqual(metrics.untaggedIds, []);
    assert.deepEqual(metrics.loaderRejects, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// mm-v1-T007 fix round LOW #6: topics classification mirrors loader.ts's
// resolution precedence exactly, rather than checking non-empty-array
// presence at each location independently of the other.
test('scanRawFrontmatter: a top-level topics: [] shadows a non-empty metadata.topics (UNTAGGED, matching the loader), not TAGGED', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-schema-metrics-shape-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'shadowed.md'),
      '---\nname: a\ntype: feedback\ntopics: []\nmetadata:\n  topics: [x, y]\n---\nbody\n',
    );
    const entries: RawScanEntryLike[] = scanRawFrontmatter(dir);
    const e = entries.find((x) => x.id === 'shadowed')!;
    assert.equal(e.ok, true);
    assert.equal((e as { topicsShape?: string }).topicsShape, 'untagged');

    const metrics = buildSchemaMetrics(dir);
    assert.equal(metrics.untaggedCount, 1);
    assert.deepEqual(metrics.untaggedIds, ['shadowed']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanRawFrontmatter: a nullish (explicit YAML null) top-level topics falls through to metadata.topics, matching the loader\'s `??`', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-schema-metrics-shape-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'falls_through.md'),
      '---\nname: a\ntype: feedback\ntopics:\nmetadata:\n  topics: [x]\n---\nbody\n',
    );
    const metrics = buildSchemaMetrics(dir);
    assert.equal(metrics.untaggedCount, 0);
    assert.deepEqual(metrics.untaggedIds, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanRawFrontmatter/buildSchemaMetrics: a non-list resolved topics value (string or map) is bucketed as invalidTopicsShape, not folded into untagged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-schema-metrics-shape-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'string_topics.md'),
      '---\nname: a\ntype: feedback\ntopics: notalist\n---\nbody\n',
    );
    fs.writeFileSync(
      path.join(dir, 'map_topics.md'),
      '---\nname: b\ntype: feedback\ntopics:\n  a: 1\n---\nbody\n',
    );
    fs.writeFileSync(
      path.join(dir, 'string_meta_topics.md'),
      '---\nname: c\ntype: feedback\nmetadata:\n  topics: notalist\n---\nbody\n',
    );

    const entries: RawScanEntryLike[] = scanRawFrontmatter(dir);
    for (const id of ['string_topics', 'map_topics', 'string_meta_topics']) {
      const e = entries.find((x) => x.id === id)!;
      assert.equal((e as { topicsShape?: string }).topicsShape, 'invalid-shape', id);
    }

    const metrics = buildSchemaMetrics(dir);
    assert.equal(metrics.invalidTopicsShapeCount, 3);
    assert.deepEqual(
      [...metrics.invalidTopicsShapeIds].sort(),
      ['map_topics', 'string_meta_topics', 'string_topics'],
    );
    // None of these are double-counted as untagged.
    assert.equal(metrics.untaggedCount, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSchemaMetrics: the static fixture corpus has zero invalid-shape topics (no regression on the existing untagged/legacy counts)', () => {
  const metrics = buildSchemaMetrics(STATIC_CORPUS);
  assert.equal(metrics.invalidTopicsShapeCount, 0);
  assert.deepEqual(metrics.invalidTopicsShapeIds, []);
});

test('buildSchemaMetrics: MEMORY.md and non-.md files are never scanned', () => {
  const dir = copyStaticCorpus();
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# pointer file, not a memory\n');
  fs.writeFileSync(path.join(dir, 'topics.yml'), '- name: custom\n');
  try {
    const metrics = buildSchemaMetrics(dir);
    // Same counts as the static corpus: MEMORY.md/topics.yml contribute
    // neither a valid entry nor a reject.
    assert.equal(metrics.scannedCount, 6);
    assert.equal(metrics.loaderRejects.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSchemaMetrics: untaggedIds are code-unit sorted (Zulu before alpha), independent of readdir order', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-schema-metrics-'));
  // Both land in untaggedIds (empty `topics: []`), so their relative order
  // exercises the output comparator directly.
  for (const name of ['Zulu.md', 'alpha.md']) {
    fs.writeFileSync(
      path.join(tmp, name),
      `---\nname: ${path.basename(name, '.md')}\ntype: feedback\ntopics: []\n---\nbody\n`,
    );
  }
  // Simulate a hash-ordered filesystem (e.g. ext4 dir_index) with a fixed
  // scrambled readdir result, so this pins the comparator on every platform
  // instead of the host filesystem's incidental ordering. schema-metrics
  // destructures readdirSync at module load, so patch fs first and require a
  // fresh instance. The stub is scoped to the fixture dir (everything else
  // passes through).
  const metricsPath = require.resolve('../src/consolidate/schema-metrics');
  const realReaddirSync = fs.readdirSync;
  (fs as unknown as { readdirSync: (dir: string) => string[] }).readdirSync = (
    dir: string,
  ) =>
    dir === tmp
      ? ['alpha.md', 'Zulu.md']
      : (realReaddirSync as unknown as (dir: string) => string[])(dir);
  try {
    delete require.cache[metricsPath];
    const { buildSchemaMetrics: freshBuild } = require(metricsPath);
    const metrics = freshBuild(tmp);
    // 'Zulu' (leading 'Z', code unit 90) before 'alpha' (97): code-unit
    // order. An en-US localeCompare would order alpha first. This pins the
    // comparator choice (code-unit, not locale-aware collation).
    assert.deepEqual(metrics.untaggedIds, ['Zulu', 'alpha']);
  } finally {
    (fs as unknown as { readdirSync: typeof realReaddirSync }).readdirSync =
      realReaddirSync;
    delete require.cache[metricsPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
