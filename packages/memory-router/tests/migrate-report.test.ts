// Direct unit test for the migrate report formatters (src/migrate/report.ts).
//
// migrate-cli.test.ts already exercises these indirectly through a spawned
// `dist/cli.js` subprocess, but a subprocess is invisible to Node's
// --experimental-test-coverage instrumentation (it only tracks in-process
// `require`s). This file requires report.ts directly against small
// hand-built plans, matching the existing house convention for the other
// formatter modules (tests/eval-format.test.ts, formatDriftReportText, ...).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatMigrationReportText,
  formatMigrationReportJson,
} = require('../src/migrate/report');

interface FieldResultLike {
  action: 'kept' | 'set' | 'missing';
  value?: unknown;
  source?: string;
}

interface FilePlanLike {
  id: string;
  path: string;
  skipped: boolean;
  reason?: string;
  changed: boolean;
  type: FieldResultLike;
  topics: FieldResultLike;
  created: FieldResultLike;
}

interface MigrationPlanLike {
  dir: string;
  mappingPath: string | null;
  vocabularySource?: 'default' | 'custom';
  vocabularyError?: string | null;
  files: FilePlanLike[];
}

const kept = (value: unknown): FieldResultLike => ({ action: 'kept', value });
const missing = (): FieldResultLike => ({ action: 'missing' });
const set = (value: unknown, source: string): FieldResultLike => ({
  action: 'set',
  value,
  source,
});

function buildPlan(): MigrationPlanLike {
  return {
    dir: '/tmp/corpus',
    mappingPath: null,
    files: [
      {
        id: 'needs_hoist',
        path: '/tmp/corpus/needs_hoist.md',
        skipped: false,
        changed: true,
        type: set('feedback', 'metadata.type'),
        topics: set(['deployment'], 'vocabulary-pattern'),
        created: set('2026-03-15', 'mtime (approx)'),
      },
      {
        id: 'already_canonical',
        path: '/tmp/corpus/already_canonical.md',
        skipped: false,
        changed: false,
        type: kept('reference'),
        topics: kept(['workflow']),
        created: kept('2026-01-01'),
      },
      {
        id: 'untagged_case',
        path: '/tmp/corpus/untagged_case.md',
        skipped: false,
        changed: true,
        type: kept('user'),
        topics: missing(),
        created: set('2026-02-01', 'mtime (approx)'),
      },
      {
        id: 'no_type_case',
        path: '/tmp/corpus/no_type_case.md',
        skipped: false,
        changed: true,
        type: missing(),
        topics: missing(),
        created: set('2026-02-02', 'mtime (approx)'),
      },
      {
        id: 'broken',
        path: '/tmp/corpus/broken.md',
        skipped: true,
        reason: 'no YAML frontmatter delimiter (`---`) found',
        changed: false,
        type: missing(),
        topics: missing(),
        created: missing(),
      },
    ],
  };
}

// --- text: header ------------------------------------------------------------

test('formatMigrationReportText: header reports dir, file count, and mapping path (or "none")', () => {
  const text = formatMigrationReportText(buildPlan(), null);
  assert.match(text, /dir: \/tmp\/corpus \(5 memory files\)/);
  assert.match(text, /mapping: none/);

  const withMapping = buildPlan();
  withMapping.mappingPath = '/tmp/mapping.yml';
  const text2 = formatMigrationReportText(withMapping, null);
  assert.match(text2, /mapping: \/tmp\/mapping\.yml/);
});

// --- text: vocabulary disclosure header line ----------------------------------

test('formatMigrationReportText: vocabulary header reads "default (no topics.yml)" when the plan carries no vocabulary info', () => {
  // buildPlan() deliberately omits vocabularySource/vocabularyError to
  // cover a plan built before this field existed: must default sanely,
  // never print "undefined".
  const text = formatMigrationReportText(buildPlan(), null);
  assert.match(text, /vocabulary: default \(no topics\.yml\)/);
});

test('formatMigrationReportText: vocabulary header reads "custom (topics.yml)" when a valid topics.yml was loaded', () => {
  const plan = buildPlan();
  plan.vocabularySource = 'custom';
  plan.vocabularyError = null;
  const text = formatMigrationReportText(plan, null);
  assert.match(text, /vocabulary: custom \(topics\.yml\)/);
});

test('formatMigrationReportText: vocabulary header reads "default (topics.yml rejected: <reason>)" when a present topics.yml is invalid', () => {
  const plan = buildPlan();
  plan.vocabularySource = 'default';
  plan.vocabularyError = 'topics.yml: expected a top-level list of {name, description, patterns} entries';
  const text = formatMigrationReportText(plan, null);
  assert.match(
    text,
    /vocabulary: default \(topics\.yml rejected: topics\.yml: expected a top-level list/,
  );
});

// --- text: dry-run vs apply wording -------------------------------------------

test('formatMigrationReportText: dry-run (applyResult=null) uses "would set" / "would apply" wording', () => {
  const text = formatMigrationReportText(buildPlan(), null);
  assert.match(text, /\+ \(would set\) type: "feedback"\s+\(from metadata\.type\)/);
  assert.match(text, /would apply to 3 file\(s\), 1 unchanged, 1 skipped/);
});

test('formatMigrationReportText: --apply result uses "+" / "applied" wording, no "would"', () => {
  const applyResult = { applied: 3, unchanged: 1, skipped: 1, errored: [] };
  const text = formatMigrationReportText(buildPlan(), applyResult);
  assert.match(text, /\+ type: "feedback"\s+\(from metadata\.type\)/);
  assert.doesNotMatch(text, /would set/);
  assert.match(text, /applied to 3 file\(s\), 1 unchanged, 1 skipped/);
});

// --- text: per-field rendering -------------------------------------------------

test('formatMigrationReportText: a "kept" field is never printed (already canonical, silent)', () => {
  const text = formatMigrationReportText(buildPlan(), null);
  assert.doesNotMatch(text, /already_canonical[\s\S]{0,5}\n\s+\+/);
});

test('formatMigrationReportText: an unchanged file prints "(already canonical, no changes)"', () => {
  const text = formatMigrationReportText(buildPlan(), null);
  assert.match(text, /already_canonical\n\s+\(already canonical, no changes\)/);
});

test('formatMigrationReportText: topics "missing" renders as untagged, needs manual review', () => {
  const text = formatMigrationReportText(buildPlan(), null);
  assert.match(
    text,
    /topics: untagged — no metadata\.topics\/mapping\/vocabulary match \(needs manual review\)/,
  );
});

test('formatMigrationReportText: type "missing" renders as missing, needs manual review', () => {
  const text = formatMigrationReportText(buildPlan(), null);
  assert.match(text, /type: missing — no metadata\.type to hoist \(needs manual review\)/);
});

test('formatMigrationReportText: an array-valued "set" field renders as a bracketed list', () => {
  const text = formatMigrationReportText(buildPlan(), null);
  assert.match(text, /\+ \(would set\) topics: \[deployment\]\s+\(from vocabulary-pattern\)/);
});

test('formatMigrationReportText: a metadata.topics hoist is visibly distinguished from a mapped/derived topics set (via source)', () => {
  const plan: MigrationPlanLike = {
    dir: '/tmp/corpus',
    mappingPath: null,
    files: [
      {
        id: 'hoisted_case',
        path: '/tmp/corpus/hoisted_case.md',
        skipped: false,
        changed: true,
        type: kept('feedback'),
        topics: set(['curated_one', 'curated_two'], 'metadata.topics'),
        created: kept('2026-01-01'),
      },
    ],
  };
  const text = formatMigrationReportText(plan, null);
  assert.match(
    text,
    /\+ \(would set\) topics: \[curated_one, curated_two\]\s+\(from metadata\.topics\)/,
  );
});

test('formatMigrationReportText: a kept top-level topics with an invalid shape is flagged for manual review, not silently treated as canonical', () => {
  const plan: MigrationPlanLike = {
    dir: '/tmp/corpus',
    mappingPath: null,
    files: [
      {
        id: 'invalid_shape_case',
        path: '/tmp/corpus/invalid_shape_case.md',
        skipped: false,
        changed: true,
        type: kept('feedback'),
        topics: { action: 'kept', value: 'scalar-value', source: 'invalid-shape' },
        created: set('2026-01-01', 'mtime (approx)'),
      },
    ],
  };
  const text = formatMigrationReportText(plan, null);
  assert.match(text, /topics: kept \(invalid shape, needs manual review\)/);
});

// --- text: skipped section ------------------------------------------------------

test('formatMigrationReportText: skipped files are listed separately with their reason, not in the main per-file list', () => {
  const text = formatMigrationReportText(buildPlan(), null);
  assert.match(text, /--- skipped \(not a valid memory file\) ---\nbroken: no YAML frontmatter delimiter/);
});

// --- text: summary -----------------------------------------------------------

test('formatMigrationReportText: summary lists untagged topics and missing type ids', () => {
  const text = formatMigrationReportText(buildPlan(), null);
  assert.match(text, /untagged topics \(2\): untagged_case, no_type_case/);
  assert.match(text, /missing type \(1\): no_type_case/);
});

test('formatMigrationReportText: write errors under --apply are surfaced in the summary', () => {
  const applyResult = { applied: 2, unchanged: 1, skipped: 1, errored: ['/tmp/corpus/x.md: EACCES'] };
  const text = formatMigrationReportText(buildPlan(), applyResult);
  assert.match(text, /errors \(1\):\n\s+\/tmp\/corpus\/x\.md: EACCES/);
});

test('formatMigrationReportText: summary lists invalid-shape topics ids under "invalid topics shape"', () => {
  const plan: MigrationPlanLike = {
    dir: '/tmp/corpus',
    mappingPath: null,
    files: [
      {
        id: 'invalid_shape_case',
        path: '/tmp/corpus/invalid_shape_case.md',
        skipped: false,
        changed: true,
        type: kept('feedback'),
        topics: { action: 'kept', value: 'scalar-value', source: 'invalid-shape' },
        created: set('2026-01-01', 'mtime (approx)'),
      },
    ],
  };
  const text = formatMigrationReportText(plan, null);
  assert.match(text, /invalid topics shape \(1\): invalid_shape_case/);
});

test('formatMigrationReportText: no untagged/missing/errors: none of those summary lines appear', () => {
  const plan: MigrationPlanLike = {
    dir: '/tmp/clean',
    mappingPath: null,
    files: [
      {
        id: 'clean',
        path: '/tmp/clean/clean.md',
        skipped: false,
        changed: false,
        type: kept('reference'),
        topics: kept(['workflow']),
        created: kept('2026-01-01'),
      },
    ],
  };
  const text = formatMigrationReportText(plan, null);
  assert.doesNotMatch(text, /untagged topics/);
  assert.doesNotMatch(text, /missing type/);
  assert.doesNotMatch(text, /errors \(/);
});

// --- json ----------------------------------------------------------------------

test('formatMigrationReportJson: emits the documented stable schema, newline-terminated', () => {
  const json = formatMigrationReportJson(buildPlan(), null);
  assert.ok(json.endsWith('\n'), 'JSON output is newline-terminated');
  const parsed = JSON.parse(json);
  assert.equal(parsed.dir, '/tmp/corpus');
  assert.equal(parsed.mapping, null);
  assert.equal(parsed.apply, false);
  assert.equal(parsed.vocabulary, 'default', 'a plan with no vocabulary info defaults to "default"');
  assert.equal(parsed.vocabularyError, null);
  assert.equal(parsed.files.length, 5);
  assert.deepEqual(parsed.files[0].type, { action: 'set', value: 'feedback', source: 'metadata.type' });
  assert.equal(parsed.files[4].skipped, true);
  assert.equal(parsed.files[4].reason, 'no YAML frontmatter delimiter (`---`) found');
  assert.deepEqual(parsed.summary, {
    total: 5,
    changed: 3,
    unchanged: 1,
    skipped: 1,
    untaggedTopics: ['untagged_case', 'no_type_case'],
    missingType: ['no_type_case'],
    invalidTopicsShape: [],
    applied: null,
    errored: [],
  });
});

test('formatMigrationReportJson: vocabulary/vocabularyError reflect a custom, valid topics.yml', () => {
  const plan = buildPlan();
  plan.vocabularySource = 'custom';
  plan.vocabularyError = null;
  const parsed = JSON.parse(formatMigrationReportJson(plan, null));
  assert.equal(parsed.vocabulary, 'custom');
  assert.equal(parsed.vocabularyError, null);
});

test('formatMigrationReportJson: vocabularyError carries the rejection reason for a present-but-invalid topics.yml (vocabulary still "default")', () => {
  const plan = buildPlan();
  plan.vocabularySource = 'default';
  plan.vocabularyError = 'topics.yml: YAML parse error: bad indentation';
  const parsed = JSON.parse(formatMigrationReportJson(plan, null));
  assert.equal(parsed.vocabulary, 'default');
  assert.equal(parsed.vocabularyError, 'topics.yml: YAML parse error: bad indentation');
});

test('formatMigrationReportJson: summary.invalidTopicsShape lists ids with a kept invalid-shape topics field', () => {
  const plan: MigrationPlanLike = {
    dir: '/tmp/corpus',
    mappingPath: null,
    files: [
      {
        id: 'invalid_shape_case',
        path: '/tmp/corpus/invalid_shape_case.md',
        skipped: false,
        changed: false,
        type: kept('feedback'),
        topics: { action: 'kept', value: 'scalar-value', source: 'invalid-shape' },
        created: kept('2026-01-01'),
      },
    ],
  };
  const parsed = JSON.parse(formatMigrationReportJson(plan, null));
  assert.deepEqual(parsed.summary.invalidTopicsShape, ['invalid_shape_case']);
});

test('formatMigrationReportJson: apply=true and summary.applied reflect a real ApplyResult', () => {
  const applyResult = { applied: 3, unchanged: 1, skipped: 1, errored: ['/tmp/x.md: EACCES'] };
  const parsed = JSON.parse(formatMigrationReportJson(buildPlan(), applyResult));
  assert.equal(parsed.apply, true);
  assert.equal(parsed.summary.applied, 3);
  assert.deepEqual(parsed.summary.errored, ['/tmp/x.md: EACCES']);
});

test('formatMigrationReportJson: a metadata.topics hoist is reported as { action: "set", source: "metadata.topics" }', () => {
  const plan: MigrationPlanLike = {
    dir: '/tmp/corpus',
    mappingPath: null,
    files: [
      {
        id: 'hoisted_case',
        path: '/tmp/corpus/hoisted_case.md',
        skipped: false,
        changed: true,
        type: kept('feedback'),
        topics: set(['curated_one', 'curated_two'], 'metadata.topics'),
        created: kept('2026-01-01'),
      },
    ],
  };
  const parsed = JSON.parse(formatMigrationReportJson(plan, null));
  assert.deepEqual(parsed.files[0].topics, {
    action: 'set',
    value: ['curated_one', 'curated_two'],
    source: 'metadata.topics',
  });
});

test('formatMigrationReportJson: a skipped file reports reason: null, not undefined/omitted', () => {
  const plan: MigrationPlanLike = {
    dir: '/tmp/x',
    mappingPath: null,
    files: [
      {
        id: 'ok',
        path: '/tmp/x/ok.md',
        skipped: false,
        changed: false,
        type: kept('reference'),
        topics: kept(['workflow']),
        created: kept('2026-01-01'),
      },
    ],
  };
  const parsed = JSON.parse(formatMigrationReportJson(plan, null));
  assert.equal(parsed.files[0].reason, null);
});
