const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { loadMemoriesFromDir } = require('../src/memory/loader');

const fixturesDir = path.join(__dirname, 'fixtures', 'memories');

test('legacy memories without new fields still load', () => {
  const memories = loadMemoriesFromDir(fixturesDir);
  const legacy = memories.find((m: Memory) => m.id === 'feedback_legacy');
  assert.ok(legacy, 'legacy fixture should load');
  assert.equal(legacy.frontmatter.topics, undefined);
  assert.equal(legacy.frontmatter.severity, undefined);
  assert.equal(legacy.frontmatter.triggers, undefined);
});

test('MEMORY.md is skipped by the loader', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-loader-'));
  fs.writeFileSync(
    path.join(tmp, 'MEMORY.md'),
    '---\nname: index\ndescription: x\ntype: reference\n---\n\nindex body\n',
  );
  fs.writeFileSync(
    path.join(tmp, 'real.md'),
    '---\nname: real\ndescription: x\ntype: reference\n---\n\nreal body\n',
  );
  try {
    const memories = loadMemoriesFromDir(tmp);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].id, 'real');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('file without frontmatter is rejected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-loader-'));
  fs.writeFileSync(path.join(tmp, 'plain.md'), '# just a heading\n');
  try {
    const memories = loadMemoriesFromDir(tmp);
    assert.equal(memories.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
