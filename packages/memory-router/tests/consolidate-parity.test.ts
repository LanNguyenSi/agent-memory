// Property test for src/consolidate/schema-metrics.ts's scanRawFrontmatter
// against src/memory/loader.ts's loadMemoriesFromDir (mm-v1-T007 fix round
// MEDIUM #3). scanRawFrontmatter deliberately duplicates loader.ts's
// per-file frontmatter regex + parse + validation logic read-only (loader.ts
// is out of scope for this task, see schema-metrics.ts's file-level
// comment); the two implementations can drift independently of each other.
// This asserts they never disagree on WHICH files get accepted: the set of
// ids scanRawFrontmatter(dir).filter(ok) reports as ok must exactly match
// the set of ids loadMemoriesFromDir(dir) actually loads, across a corpus
// deliberately built to probe every tricky edge case both implementations
// have to agree on (missing/falsy name, invalid type, a falsy top-level
// type falling back to a valid metadata.type, empty/non-list topics shapes,
// scalar/null metadata, broken YAML, empty/missing frontmatter, CRLF line
// endings). This does NOT assert the two agree on topics
// tagged/untagged/invalid-shape classification, only on accept/reject: see
// tests/consolidate-schema-metrics.test.ts for the topics-classification
// parity fix (LOW #6), which is a narrower, separately-tested concern.
//
// The corpus below is a synthetic, hand-built shape matrix (not real
// corpus data): each case probes exactly one specific loader/scanner
// decision point.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadMemoriesFromDir } = require('../src/memory/loader');
const { scanRawFrontmatter } = require('../src/consolidate/schema-metrics');

const CASES: Record<string, string> = {
  // Canonical, fully valid shape.
  c01_canonical: '---\nname: a\ntype: feedback\ntopics: [x]\n---\nbody\n',
  // metadata.type only (legacy shape).
  c02_meta_type: '---\nname: a\nmetadata:\n  type: feedback\ntopics: [x]\n---\nbody\n',
  // Both top-level and metadata type present; top-level must win.
  c03_both_types: '---\nname: a\ntype: user\nmetadata:\n  type: feedback\ntopics: [x]\n---\nbody\n',
  // No type anywhere: rejected.
  c04_no_type: '---\nname: a\ntopics: [x]\n---\nbody\n',
  // Invalid top-level type value: rejected.
  c05_bad_type: '---\nname: a\ntype: bogus\ntopics: [x]\n---\nbody\n',
  // Invalid metadata.type value (no top-level type): rejected.
  c06_bad_meta_type: '---\nname: a\nmetadata:\n  type: bogus\n---\nbody\n',
  // Falsy top-level type (empty string) falls back to metadata.type.
  c07_empty_type_str: '---\nname: a\ntype: ""\nmetadata:\n  type: feedback\n---\nbody\n',
  // Empty top-level topics array, present alongside metadata.topics.
  c08_empty_topics_plus_meta:
    '---\nname: a\ntype: feedback\ntopics: []\nmetadata:\n  topics: [x, y]\n---\nbody\n',
  // topics as a non-list scalar (invalid shape, still accepted overall).
  c09_topics_string: '---\nname: a\ntype: feedback\ntopics: notalist\n---\nbody\n',
  // topics as a list of non-strings (still a valid array shape).
  c10_topics_nonstring: '---\nname: a\ntype: feedback\ntopics: [1, 2]\n---\nbody\n',
  // metadata.topics only.
  c11_meta_topics: '---\nname: a\ntype: feedback\nmetadata:\n  topics: [x]\n---\nbody\n',
  // metadata.topics present but empty.
  c12_meta_topics_empty: '---\nname: a\ntype: feedback\nmetadata:\n  topics: []\n---\nbody\n',
  // No topics anywhere.
  c13_no_topics: '---\nname: a\ntype: feedback\n---\nbody\n',
  // metadata is a scalar, not an object.
  c14_meta_scalar: '---\nname: a\ntype: feedback\nmetadata: hello\n---\nbody\n',
  // metadata is explicit YAML null.
  c15_meta_null: '---\nname: a\ntype: feedback\nmetadata:\n---\nbody\n',
  // Broken YAML: rejected.
  c16_broken_yaml: '---\nname: a\ntype: [unclosed\n---\nbody\n',
  // Empty frontmatter block: rejected (no name).
  c17_empty_fm: '---\n---\nbody\n',
  // No frontmatter delimiter at all: rejected.
  c18_no_fm: 'just a body\n',
  // CRLF line endings throughout, otherwise canonical.
  c19_crlf: '---\r\nname: a\r\ntype: feedback\r\ntopics: [x]\r\n---\r\nbody\r\n',
  // Missing name: rejected.
  c20_no_name: '---\ntype: feedback\ntopics: [x]\n---\nbody\n',
  // Falsy name (empty string): rejected.
  c21_name_empty: '---\nname: ""\ntype: feedback\n---\nbody\n',
  // Frontmatter is a scalar, not a YAML object: rejected.
  c22_fm_scalar: '---\njust a string\n---\nbody\n',
  // type is a truthy non-string (number): rejected (not in VALID_TYPES).
  c23_type_number: '---\nname: a\ntype: 7\n---\nbody\n',
  // Explicit YAML null topics falls through to metadata.topics.
  c24_topics_null_meta: '---\nname: a\ntype: feedback\ntopics:\nmetadata:\n  topics: [x]\n---\nbody\n',
  // Top-level type is YAML `false` (falsy, non-string): falls back to metadata.type.
  c25_type_false: '---\nname: a\ntype: false\nmetadata:\n  type: user\n---\nbody\n',
  // topics is a YAML map, not a list.
  c26_topics_map: '---\nname: a\ntype: feedback\ntopics:\n  a: 1\n---\nbody\n',
  // metadata.topics is a non-list scalar.
  c27_meta_topics_string: '---\nname: a\ntype: feedback\nmetadata:\n  topics: notalist\n---\nbody\n',
  // name is YAML `0` (falsy number): rejected, same as a missing name.
  c28_name_zero: '---\nname: 0\ntype: feedback\n---\nbody\n',
};

function buildCorpus(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-parity-'));
  for (const [id, content] of Object.entries(CASES)) {
    fs.writeFileSync(path.join(dir, id + '.md'), content);
  }
  return dir;
}

test('parity: scanRawFrontmatter and loadMemoriesFromDir agree on exactly which files are accepted, across the full tricky-shapes corpus', () => {
  const dir = buildCorpus();
  try {
    const loadedIds = loadMemoriesFromDir(dir)
      .map((m: { id: string }) => m.id)
      .sort();
    const scannedOkIds = scanRawFrontmatter(dir)
      .filter((e: { ok: boolean }) => e.ok)
      .map((e: { id: string }) => e.id)
      .sort();

    assert.deepEqual(
      scannedOkIds,
      loadedIds,
      'scanRawFrontmatter must accept exactly the same files loadMemoriesFromDir loads',
    );
    // Sanity: the corpus actually exercises both outcomes, so this
    // assertion isn't vacuously true over an all-accept or all-reject set.
    assert.ok(loadedIds.length > 0, 'at least one case must be accepted');
    assert.ok(
      loadedIds.length < Object.keys(CASES).length,
      'at least one case must be rejected',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parity: every case id in the corpus is accounted for by exactly one of loader-accept or scan-reject (no id silently drops out of both)', () => {
  const dir = buildCorpus();
  try {
    const loadedIds = new Set(loadMemoriesFromDir(dir).map((m: { id: string }) => m.id));
    const scanned = scanRawFrontmatter(dir) as { id: string; ok: boolean }[];
    const scannedIds = new Set(scanned.map((e) => e.id));

    assert.deepEqual(
      [...scannedIds].sort(),
      Object.keys(CASES).sort(),
      'scanRawFrontmatter must enumerate every file in the corpus, accepted or not',
    );
    for (const id of Object.keys(CASES)) {
      const scanEntry = scanned.find((e) => e.id === id)!;
      assert.equal(
        scanEntry.ok,
        loadedIds.has(id),
        `case ${id}: scan ok=${scanEntry.ok} must match loader accepted=${loadedIds.has(id)}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
