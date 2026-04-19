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
