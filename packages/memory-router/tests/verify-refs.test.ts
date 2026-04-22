const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { checkMemoryReferences } = require('../src/verify-refs');
const { renderHitsAsContext } = require('../src/render');

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-verify-'));
}

function mem(frontmatter: Partial<MemoryFrontmatter> & { name: string }, body = 'body'): Memory {
  return {
    id: frontmatter.name.toLowerCase().replace(/\s+/g, '_'),
    path: `/tmp/${frontmatter.name}.md`,
    frontmatter: {
      description: 'x',
      type: 'feedback',
      ...frontmatter,
    } as MemoryFrontmatter,
    body,
  };
}

test('checkMemoryReferences: no refs → not stale', () => {
  const r = checkMemoryReferences(undefined);
  assert.equal(r.stale, false);
  assert.deepEqual(r.checks, []);
});

test('checkMemoryReferences: empty list → not stale', () => {
  const r = checkMemoryReferences([]);
  assert.equal(r.stale, false);
});

test('checkMemoryReferences: kind=path pointing at an existing file → not stale', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'hit.md'), '# hi');
  const r = checkMemoryReferences([{ kind: 'path', value: 'hit.md', repoRoot: dir }]);
  assert.equal(r.stale, false);
  assert.equal(r.checks[0].exists, true);
  assert.equal(r.checks[0].skipped, false);
});

test('checkMemoryReferences: kind=path pointing at a missing file → stale', () => {
  const dir = mkTmpDir();
  const r = checkMemoryReferences([{ kind: 'path', value: 'gone.md', repoRoot: dir }]);
  assert.equal(r.stale, true);
  assert.match(r.reason, /gone\.md/);
  assert.equal(r.checks[0].exists, false);
});

test('checkMemoryReferences: mixed refs — any missing → stale', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'present.md'), '');
  const r = checkMemoryReferences([
    { kind: 'path', value: 'present.md', repoRoot: dir },
    { kind: 'path', value: 'absent.md', repoRoot: dir },
  ]);
  assert.equal(r.stale, true);
  assert.match(r.reason, /absent\.md/);
  // Summary should mention all missing, not just the first.
  assert.match(r.reason, /1 referenced item|absent/);
});

test('checkMemoryReferences: kind=symbol is skipped (not claimed stale)', () => {
  const r = checkMemoryReferences([{ kind: 'symbol', value: 'nonExistentSymbol' }]);
  assert.equal(r.stale, false);
  assert.equal(r.checks[0].skipped, true);
  assert.match(r.checks[0].detail, /not checked inline/);
});

test('checkMemoryReferences: kind=flag is skipped', () => {
  const r = checkMemoryReferences([{ kind: 'flag', value: '--nonexistent' }]);
  assert.equal(r.stale, false);
  assert.equal(r.checks[0].skipped, true);
});

test('checkMemoryReferences: refuses relative path that escapes repoRoot', () => {
  const dir = mkTmpDir();
  const r = checkMemoryReferences([
    { kind: 'path', value: '../../../../etc/passwd', repoRoot: dir },
  ]);
  assert.equal(r.stale, true);
  assert.match(r.reason, /escapes repoRoot/);
});

test('checkMemoryReferences: malformed entry does not throw, counted as skipped', () => {
  const r = checkMemoryReferences([null as unknown as MemoryReference]);
  assert.equal(r.stale, false);
  assert.equal(r.checks[0].skipped, true);
});

test('renderHitsAsContext: memory without verify frontmatter renders unchanged', () => {
  const hit: GateHit = {
    memory: mem({ name: 'Clean Memory' }, 'body'),
    gate: 'topic',
    score: 1,
    reason: 'x',
  };
  const out = renderHitsAsContext([hit]);
  assert.doesNotMatch(out, /⚠️/);
  assert.doesNotMatch(out, /stale/);
  assert.match(out, /body/);
});

test('renderHitsAsContext: memory with all-good verify refs renders unchanged', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'ok.md'), '');
  const hit: GateHit = {
    memory: mem(
      {
        name: 'Verified Memory',
        verify: [{ kind: 'path', value: 'ok.md', repoRoot: dir }],
      },
      'body',
    ),
    gate: 'topic',
    score: 1,
    reason: 'x',
  };
  const out = renderHitsAsContext([hit]);
  assert.doesNotMatch(out, /⚠️/);
});

test('renderHitsAsContext: memory with a missing ref gets a loud stale prefix but is NOT suppressed', () => {
  const dir = mkTmpDir();
  const hit: GateHit = {
    memory: mem(
      {
        name: 'Stale Memory',
        verify: [{ kind: 'path', value: 'deleted-file.md', repoRoot: dir }],
      },
      'This memory still has a body the model should see.',
    ),
    gate: 'topic',
    score: 1,
    reason: 'x',
  };
  const out = renderHitsAsContext([hit]);
  // Prefix + body both present — the agent must still see the rule.
  assert.match(out, /⚠️ \*\*stale:\*\*/);
  assert.match(out, /deleted-file\.md/);
  assert.match(out, /This memory still has a body/);
  assert.match(out, /Verify before acting/);
});

test('renderHitsAsContext: symbol/flag refs never trigger the stale prefix', () => {
  const hit: GateHit = {
    memory: mem(
      {
        name: 'Symbol-verify memory',
        verify: [{ kind: 'symbol', value: 'ghostSymbol' }],
      },
      'body',
    ),
    gate: 'topic',
    score: 1,
    reason: 'x',
  };
  const out = renderHitsAsContext([hit]);
  assert.doesNotMatch(out, /⚠️/);
});
