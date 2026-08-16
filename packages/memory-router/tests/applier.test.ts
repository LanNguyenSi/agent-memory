const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { planChange, applyChange } = require('../src/tag/applier');

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-applier-'));
}

test('apply preserves existing frontmatter + body and adds new fields', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'feedback_sample.md');
  const original = `---
name: Deploy rule
description: never deploy on Friday afternoons
type: feedback
originSessionId: abc123
---

The deploy must never go out on Friday. A release or rollback on Friday
burns the weekend.

- deploy on Monday
- deploy on Tuesday

Even hotfix deploys wait until Monday.
`;
  fs.writeFileSync(file, original);

  try {
    const change = planChange(file);
    assert.equal(change.skipped, false);
    applyChange(change);

    const after = fs.readFileSync(file, 'utf8');
    assert.match(after, /name: Deploy rule/);
    assert.match(after, /originSessionId: abc123/);
    assert.match(after, /topics:\s*\n\s*-\s*deployment/);
    assert.match(after, /severity: critical/);
    assert.match(after, /burns the weekend\./);
    assert.match(after, /- deploy on Monday/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply is idempotent: second run is a no-op', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'feedback_sample.md');
  fs.writeFileSync(
    file,
    `---
name: Sample
description: deploy release rollback
type: feedback
---

deploy deploy rollback.
`,
  );

  try {
    applyChange(planChange(file));
    const afterFirst = fs.readFileSync(file, 'utf8');
    const secondChange = planChange(file);
    assert.equal(secondChange.skipped, true);
    applyChange(secondChange);
    const afterSecond = fs.readFileSync(file, 'utf8');
    assert.equal(afterFirst, afterSecond);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply preserves CRLF line endings', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'feedback_crlf.md');
  const lines = [
    '---',
    'name: CRLF rule',
    'description: deploy release rollback every time',
    'type: feedback',
    '---',
    '',
    'deploy deploy release rollback',
    '',
  ];
  fs.writeFileSync(file, lines.join('\r\n'));

  try {
    const change = planChange(file);
    assert.equal(change.eol, '\r\n');
    // `eol` is detected independently of the frontmatter regex (a plain
    // /\r\n/.test(source) on the raw file), so it alone does not prove the
    // regex matched CRLF frontmatter correctly. Pin that the delimiter was
    // actually recognized (skipped: false) and that a field was actually
    // proposed and merged in (topics), so a CRLF-blind FRONTMATTER_RE that
    // fails to match and falls through to the no-delimiter skip path
    // cannot pass this test by leaving the already-CRLF file untouched.
    assert.equal(change.skipped, false);
    assert.ok(
      Array.isArray(change.merged.topics) && change.merged.topics.length > 0,
      'topics should have been proposed and merged from the CRLF frontmatter',
    );
    applyChange(change);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes('\r\n'), 'should still contain CRLF');
    assert.ok(!/[^\r]\n/.test(after), 'should not introduce lone LFs');
    assert.match(after, /topics:\s*\r\n\s*-\s*deployment/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listMemoryFiles order is lexicographic code-unit order, independent of readdir order', () => {
  const tmp = mkTmp();
  for (const name of ['alpha.md', 'bravo.md', 'delta.md', 'Zulu.md']) {
    // Content is irrelevant here: listMemoryFiles only stats the entries,
    // it never reads them.
    fs.writeFileSync(path.join(tmp, name), 'body\n');
  }
  // Simulate a hash-ordered filesystem (e.g. ext4 dir_index) with a fixed
  // scrambled readdir result, so this test pins the applier's own sort on
  // every platform instead of the host filesystem's incidental ordering.
  // The applier destructures readdirSync at module load, so patch fs first
  // and require a fresh module instance. The stub is scoped to the fixture
  // dir (everything else passes through) so the cache-miss require below
  // and any other dynamic fs use in the patched window stays unaffected.
  const applierPath = require.resolve('../src/tag/applier');
  const realReaddirSync = fs.readdirSync;
  (fs as unknown as { readdirSync: (dir: string) => string[] }).readdirSync = (
    dir: string,
  ) =>
    dir === tmp
      ? ['bravo.md', 'Zulu.md', 'delta.md', 'alpha.md']
      : (realReaddirSync as unknown as (dir: string) => string[])(dir);
  try {
    delete require.cache[applierPath];
    const { listMemoryFiles: freshList } = require(applierPath);
    // 'Zulu' before 'alpha': uppercase code units sort first. This pins the
    // comparator choice (code-unit order, not locale-aware collation).
    assert.deepEqual(freshList(tmp), [
      path.join(tmp, 'Zulu.md'),
      path.join(tmp, 'alpha.md'),
      path.join(tmp, 'bravo.md'),
      path.join(tmp, 'delta.md'),
    ]);
  } finally {
    (fs as unknown as { readdirSync: typeof realReaddirSync }).readdirSync =
      realReaddirSync;
    delete require.cache[applierPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('file without a frontmatter delimiter is skipped with reason "no frontmatter"', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'feedback_none.md');
  const original = '# just a heading, no frontmatter delimiter\n';
  fs.writeFileSync(file, original);

  try {
    const change = planChange(file);
    assert.equal(change.skipped, true);
    assert.equal(change.reason, 'no frontmatter');
    assert.deepEqual(change.existing, {});
    assert.deepEqual(change.merged, {});
    assert.equal(change.body, '');
    // Still safe to call applyChange on a skipped change: no-op, file
    // untouched.
    applyChange(change);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Pins the pre-dedup fidelity requirement from the parseFrontmatterYaml
// refactor: a delimiter-present-but-malformed-YAML file is NOT the same as
// "no frontmatter". Before this file switched to the shared
// parseFrontmatterYaml export, a broken YAML block made parseYaml() throw
// uncaught out of planChange; cli.ts's per-file try/catch around planChange
// turns that into an "error reading FILE: ..." line and counts it under
// "errored", never "skipped". If this ever regressed to a silent skip, a
// malformed memory file would stop being reported to the operator at all.
test('malformed YAML with a valid delimiter rethrows the original parse error, not silently skipped', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'feedback_badyaml.md');
  fs.writeFileSync(
    file,
    '---\nname: { a: 1\ndescription: broken\ntype: feedback\n---\n\nbody\n',
  );

  try {
    assert.throws(
      () => planChange(file),
      (err: unknown) => {
        // The rethrown error must be the ORIGINAL YAMLParseError, not a
        // re-wrapped generic Error: cli.ts's `${String(err)}` rendering
        // must keep showing "YAMLParseError: ...", the class name a
        // `new Error(detail)` re-wrap would have lost.
        assert.match(String(err), /^YAMLParseError: /);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Pins the write-path body normalization applier.ts layers on top of
// parseFrontmatterYaml's shared, unprocessed `body` capture: only a single
// leading newline is stripped, so an extra blank line right after the
// closing `---` and any trailing blank lines/whitespace survive the
// plan/apply round trip. A `.trim()` (the read path's own normalization in
// loader.ts) would eat both, so this also guards against the two body
// normalizations ever getting folded into one by mistake.
test('body normalization strips only a single leading newline, preserving extra blank lines and trailing whitespace', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'feedback_whitespace.md');
  const original = `---
name: Whitespace body rule
description: deploy release rollback with extra blank lines
type: feedback
---


deploy deploy rollback with a leading blank line above and trailing
whitespace below.


`;
  fs.writeFileSync(file, original);

  try {
    const change = planChange(file);
    assert.equal(change.skipped, false);
    // The frontmatter block is followed by TWO blank lines before the body
    // text; only one leading newline is stripped, so one blank line remains
    // as part of `body`. Trailing blank lines are untouched.
    assert.equal(
      change.body,
      '\ndeploy deploy rollback with a leading blank line above and trailing\nwhitespace below.\n\n\n',
    );
    applyChange(change);
    const after = fs.readFileSync(file, 'utf8');
    assert.match(after, /---\n\n\ndeploy deploy rollback/);
    assert.ok(
      after.endsWith('whitespace below.\n\n\n'),
      `expected trailing blank lines preserved, got: ${JSON.stringify(after.slice(-40))}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory without a topic match keeps its frontmatter unchanged', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'reference_plain.md');
  const original = `---
name: Plain ref
description: something boring
type: reference
---

No topic keywords in here.
`;
  fs.writeFileSync(file, original);

  try {
    const change = planChange(file);
    assert.equal(change.skipped, true);
    // still safe to call applyChange — no-op
    applyChange(change);
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
