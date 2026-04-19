const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadMemoriesFromDir } = require('../src/memory/loader');
const { resolve } = require('../src/router');

const fixturesDir = path.join(__dirname, 'fixtures', 'memories');

test('topic gate fires on "merge PR 42" → workflow memory injected', () => {
  const memories = loadMemoriesFromDir(fixturesDir);
  assert.ok(memories.length >= 1, 'fixtures loaded');

  const hits = resolve({ prompt: 'merge PR 42' }, memories);
  const ids = hits.map((h: GateHit) => h.memory.id);

  assert.ok(
    ids.includes('feedback_stacked_pr'),
    `expected workflow memory to fire, got: ${ids.join(', ')}`,
  );
  const hit = hits.find((h: GateHit) => h.memory.id === 'feedback_stacked_pr');
  assert.equal(hit?.gate, 'topic');
  assert.equal(hit?.score, 1.0);
});

test('topic gate silent on prompt without topic keywords', () => {
  const memories = loadMemoriesFromDir(fixturesDir);
  const hits = resolve({ prompt: 'rename this variable to fooBar' }, memories);
  assert.equal(hits.length, 0, `expected no hits, got: ${hits.length}`);
});
