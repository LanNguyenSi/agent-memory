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
    applyChange(change);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes('\r\n'), 'should still contain CRLF');
    assert.ok(!/[^\r]\n/.test(after), 'should not introduce lone LFs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listMemoryFiles order is lexicographic code-unit order, independent of readdir order', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-applier-'));
  for (const name of ['alpha.md', 'bravo.md', 'delta.md', 'Zulu.md']) {
    fs.writeFileSync(
      path.join(tmp, name),
      `---\nname: ${path.basename(name, '.md')}\ndescription: x\ntype: reference\n---\nbody\n`,
    );
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
