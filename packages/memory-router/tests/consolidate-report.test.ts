// Direct unit test for the consolidate report formatters
// (src/consolidate/report.ts), same rationale as tests/migrate-report.test.ts
// / tests/eval-format.test.ts: a spawned CLI subprocess is invisible to
// --experimental-test-coverage.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatConsolidateReportText,
  formatConsolidateReportJson,
} = require('../src/consolidate/report');

function buildReport(overrides: Record<string, unknown> = {}) {
  return {
    dir: '/tmp/corpus',
    scannedCount: 3,
    exactDupes: {
      normalization: 'trim, collapse whitespace, lowercase, sha256',
      groups: [{ hash: 'abc123', ids: ['a', 'b'], paths: ['/tmp/corpus/a.md', '/tmp/corpus/b.md'] }],
    },
    nearDupes: {
      status: 'ok' as const,
      threshold: 0.95,
      indexedCount: 3,
      totalCount: 3,
      pairs: [{ aId: 'a', aPath: '/tmp/corpus/a.md', bId: 'c', bPath: '/tmp/corpus/c.md', similarity: 0.97 }],
    },
    stale: {
      hits: [],
      scannedCount: 3,
      refsChecked: 0,
      symbolCheckDegraded: false,
    },
    schema: {
      scannedCount: 3,
      untaggedCount: 1,
      untaggedIds: ['b'],
      legacyFormatCount: 1,
      legacyFormatRate: 1 / 3,
      legacyFormatIds: ['c'],
      loaderRejects: [{ path: '/tmp/corpus/broken.md', reason: 'no frontmatter' }],
    },
    ...overrides,
  };
}

test('formatConsolidateReportText: renders every section with real findings', () => {
  const text = formatConsolidateReportText(buildReport());
  assert.match(text, /dir: \/tmp\/corpus \(3 memory files loaded\)/);
  assert.match(text, /exact duplicates/);
  assert.match(text, /group \(2\): a, b/);
  assert.match(text, /near duplicates \(cosine >= 0\.95\)/);
  assert.match(text, /coverage: 3\/3/);
  assert.match(text, /0\.9700 {2}a <-> c/);
  assert.match(text, /stale references/);
  assert.match(text, /schema metrics/);
  assert.match(text, /untagged: 1\/3\n {2}b\n/);
  assert.match(text, /legacy format .*: 1\/3 \(33\.3%\)/);
  assert.match(text, /loader rejects: 1/);
  assert.match(text, /broken\.md: no frontmatter/);
  assert.match(text, /report only, nothing was written/);
});

test('formatConsolidateReportText: empty-findings corpus renders "none found" for both dupe sections', () => {
  const report = buildReport({
    exactDupes: { normalization: 'x', groups: [] },
    nearDupes: { status: 'ok', threshold: 0.95, indexedCount: 0, totalCount: 0, pairs: [] },
    schema: {
      scannedCount: 0,
      untaggedCount: 0,
      untaggedIds: [],
      legacyFormatCount: 0,
      legacyFormatRate: 0,
      legacyFormatIds: [],
      loaderRejects: [],
    },
  });
  const text = formatConsolidateReportText(report);
  assert.match(text, /exact duplicates[\s\S]*?none found/);
  assert.match(text, /near duplicates[\s\S]*?none found/);
  assert.match(text, /loader rejects: 0/);
});

test('formatConsolidateReportText: a skipped near-dupe pass renders the reason, not "none found"', () => {
  const report = buildReport({
    nearDupes: { status: 'skipped', reason: 'no embedding index found at /tmp/corpus/.memory-router/index.sqlite', threshold: 0.95, indexedCount: 0, totalCount: 3, pairs: [] },
  });
  const text = formatConsolidateReportText(report);
  assert.match(text, /skipped: no embedding index found/);
  assert.ok(!text.includes('none found'), 'a skip reason must render, never the "none found" fallback');
});

test('formatConsolidateReportJson: emits the documented stable shape, parseable and round-trippable', () => {
  const report = buildReport();
  const json = formatConsolidateReportJson(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.dir, '/tmp/corpus');
  assert.equal(parsed.scannedCount, 3);
  assert.deepEqual(parsed.exactDupes.groups[0].ids, ['a', 'b']);
  assert.equal(parsed.nearDupes.status, 'ok');
  assert.equal(parsed.nearDupes.pairs[0].similarity, 0.97);
  assert.equal(parsed.schema.untaggedCount, 1);
  assert.equal(parsed.schema.loaderRejects[0].reason, 'no frontmatter');
  assert.ok(json.endsWith('\n'));
});
