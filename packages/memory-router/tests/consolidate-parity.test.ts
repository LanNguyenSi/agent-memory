// Parity tests between src/memory/loader.ts's loadMemoriesFromDir (the hot
// path, body byte-frozen; see the comment directly above its definition)
// and its sibling loadMemoriesFromDirWithRejects (the read-only walk
// src/consolidate/schema-metrics.ts's scanRawFrontmatter is built on).
//
// mm-v1-T008 fix round: the two functions used to duplicate their own
// per-file frontmatter regex + parse + validation logic independently, so
// this suite's original job was catching PARSE-logic drift between them.
// Since then, both walks call the exact same parseMemoryFileWithReason for
// per-file parse/validation (loader.ts's file-level comment), so parse
// drift between them is now structurally impossible to observe from here:
// a mutation to the shared parse function affects both sides identically,
// which is exactly the guarantee sharing it was meant to establish, not a
// gap in this suite.
//
// What CAN still drift, because loadMemoriesFromDirWithRejects duplicates
// its own directory walk rather than sharing loadMemoriesFromDir's body,
// is the file-SELECTION logic each walk applies before a file ever reaches
// parseMemoryFileWithReason: the MEMORY.md exclusion, the `.md`-only
// filter, the readdir sort, and the `!stat.isFile()` guard. This suite's
// actual purpose is to prove the two walks agree on WHICH files they even
// attempt to parse, and in what order:
//   - the tricky-shapes corpus (CASES below) pins that the two walks'
//     accept/reject sets agree file-for-file across a hand-built matrix of
//     frontmatter edge cases (missing/falsy name, invalid type, a falsy
//     top-level type falling back to a valid metadata.type, empty/non-list
//     topics shapes, scalar/null metadata, broken YAML, empty/missing
//     frontmatter, CRLF line endings). Kept as a regression corpus even
//     though most individual cases no longer discriminate the shared parse
//     function on their own.
//   - the walk-parity test below adds cases neither walk should ever even
//     hand to parseMemoryFileWithReason: a MEMORY.md with otherwise-valid
//     frontmatter, a non-.md file with otherwise-valid frontmatter, and a
//     directory literally named `something.md`. A dropped MEMORY.md
//     exclusion, `.md` filter, or `!stat.isFile()` guard in the sibling
//     shows up as an extra accepted-or-rejected entry that
//     loadMemoriesFromDir never produces.
//   - the order test proves the sibling sorts its own readdir results the
//     same way loadMemoriesFromDir does, by forcing a non-alphabetical raw
//     readdir order and comparing OUTPUT ORDER directly, not just the
//     output set: a dropped `entries.sort()` in the sibling can never
//     change WHICH files get accepted (each file's fate depends only on
//     itself, not on iteration order), so only an order-sensitive
//     comparison, not a set-based one, can catch it.
//
// This suite does NOT assert the two walks agree on topics
// tagged/untagged/invalid-shape classification: see
// tests/consolidate-schema-metrics.test.ts for that parity fix (LOW #6),
// which is a narrower, separately-tested concern.

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

test('parity: the two walks agree on file SELECTION (MEMORY.md exclusion, .md-only filter, directories never handed to the parser)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-parity-walk-'));
  try {
    // Valid frontmatter on purpose: if the MEMORY.md exclusion is dropped
    // in the sibling, this becomes an extra accepted entry, not a
    // coincidentally-unparsable one that would pass either way.
    fs.writeFileSync(
      path.join(dir, 'MEMORY.md'),
      '---\nname: memory-index\ntype: reference\ntopics: [x]\n---\nbody\n',
    );
    // Same reasoning for the .md filter: valid frontmatter, wrong extension.
    fs.writeFileSync(
      path.join(dir, 'not-markdown.txt'),
      '---\nname: not-markdown\ntype: reference\ntopics: [x]\n---\nbody\n',
    );
    // A directory literally named `something.md`: passes both the .md
    // filter and the MEMORY.md check, so only `!stat.isFile()` keeps it
    // out. If that guard is dropped, readFileSync() on a directory throws
    // (EISDIR), which the sibling's read-failure branch turns into an
    // explicit reject entry the correct code never produces.
    fs.mkdirSync(path.join(dir, 'something.md'));
    // One normal file, so both sides have at least one real hit too.
    fs.writeFileSync(
      path.join(dir, 'real.md'),
      '---\nname: real\ntype: reference\ntopics: [x]\n---\nbody\n',
    );

    const loadedIds = loadMemoriesFromDir(dir).map((m: { id: string }) => m.id);
    const scanned = scanRawFrontmatter(dir) as { id: string; ok: boolean }[];
    const scannedOkIds = scanned.filter((e) => e.ok).map((e) => e.id);
    const scannedAllIds = scanned.map((e) => e.id);

    assert.deepEqual(loadedIds, ['real'], 'only the real memory loads');
    assert.deepEqual(
      scannedOkIds,
      loadedIds,
      'the sibling must accept exactly the same files loadMemoriesFromDir loads',
    );
    // Neither walk ever surfaces MEMORY.md, the non-.md file, or the
    // directory: not accepted, not rejected, not present at all. Their ids
    // must be absent from scanRawFrontmatter's ENTIRE output, accepted or
    // not, the same way they never make it into loadMemoriesFromDir's set.
    for (const excludedId of ['MEMORY', 'not-markdown', 'something']) {
      assert.ok(
        !scannedAllIds.includes(excludedId),
        `${excludedId} must never appear in the sibling's output (accepted or rejected)`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parity: the sibling sorts entries the same way loadMemoriesFromDir does, not just the same SET (mutation coverage for entries.sort() in the sibling)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-parity-order-'));
  const names = ['bravo.md', 'Zulu.md', 'delta.md', 'alpha.md'];
  for (const name of names) {
    fs.writeFileSync(
      path.join(dir, name),
      `---\nname: ${path.basename(name, '.md')}\ntype: reference\ntopics: [x]\n---\nbody\n`,
    );
  }

  // Sort order alone can never change WHICH files get accepted (each
  // file's outcome depends only on its own content), so a plain
  // set-comparison test structurally cannot catch a dropped
  // `entries.sort()` in the sibling. Force a non-alphabetical raw readdir
  // order and compare OUTPUT ORDER directly instead. Both
  // loadMemoriesFromDir and loadMemoriesFromDirWithRejects live in
  // loader.ts and share one module-scope `readdirSync` destructure, so a
  // single fresh require of loader.ts (after patching fs.readdirSync)
  // covers both; schema-metrics.ts must also be re-required fresh, in that
  // order, so its own `require('../memory/loader')` resolves to the
  // already-fresh (patched) loader.ts instance rather than a stale cached
  // one. Same pattern as the readdir-order pins in loader.test.ts and
  // consolidate-schema-metrics.test.ts.
  const loaderPath = require.resolve('../src/memory/loader');
  const metricsPath = require.resolve('../src/consolidate/schema-metrics');
  const realReaddirSync = fs.readdirSync;
  (fs as unknown as { readdirSync: (d: string) => string[] }).readdirSync = (d: string) =>
    d === dir
      ? ['delta.md', 'Zulu.md', 'alpha.md', 'bravo.md']
      : (realReaddirSync as unknown as (d: string) => string[])(d);
  try {
    delete require.cache[loaderPath];
    delete require.cache[metricsPath];
    const { loadMemoriesFromDir: freshLoad } = require(loaderPath) as {
      loadMemoriesFromDir: (d: string) => { id: string }[];
    };
    const { scanRawFrontmatter: freshScan } = require(metricsPath) as {
      scanRawFrontmatter: (d: string) => { id: string; ok: boolean }[];
    };

    const loadedOrder = freshLoad(dir).map((m) => m.id);
    const scannedOrder = freshScan(dir)
      .filter((e) => e.ok)
      .map((e) => e.id);

    // Ground truth: loadMemoriesFromDir's own body is untouched and always
    // sorts, so its output is code-unit order regardless of the scrambled
    // raw readdir order forced above.
    assert.deepEqual(loadedOrder, ['Zulu', 'alpha', 'bravo', 'delta']);
    // The sibling must match IN ORDER: if its own entries.sort() is
    // dropped, this list follows the scrambled raw readdir order instead
    // and diverges from loadedOrder, even though the accepted SET would
    // still be identical.
    assert.deepEqual(scannedOrder, loadedOrder);
  } finally {
    (fs as unknown as { readdirSync: typeof realReaddirSync }).readdirSync = realReaddirSync;
    delete require.cache[loaderPath];
    delete require.cache[metricsPath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
