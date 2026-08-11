const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { loadMemoriesFromDir } = require('../src/memory/loader');
const { resolve } = require('../src/router');
const { topicGate } = require('../src/gates/topic');

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

test('topic gate tolerates non-array topics from the liberal loader', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-topic-'));
  fs.writeFileSync(
    path.join(tmp, 'scalar-topics.md'),
    '---\nname: scalar\ndescription: x\ntype: feedback\nmetadata:\n  topics: workflow\n---\nbody\n',
  );
  fs.writeFileSync(
    path.join(tmp, 'mapping-topics.md'),
    '---\nname: mapping\ndescription: x\ntype: feedback\ntopics:\n  workflow: true\n---\nbody\n',
  );
  fs.writeFileSync(
    path.join(tmp, 'array-topics.md'),
    '---\nname: ok\ndescription: x\ntype: feedback\ntopics: [workflow]\n---\nbody\n',
  );
  try {
    const memories = loadMemoriesFromDir(tmp);
    assert.equal(
      memories.length,
      3,
      'loader does not validate topics shape, all three load',
    );
    assert.equal(
      memories.find((m: Memory) => m.id === 'scalar-topics')?.frontmatter
        .topics,
      'workflow',
      'loader passes non-array topics through uncoerced (lint relies on this)',
    );
    // Must not throw: this path runs synchronously in the
    // user-prompt-submit hook, where an exception kills memory context.
    const hits = topicGate.evaluate({ prompt: 'merge PR 42' }, memories);
    assert.deepEqual(
      hits.map((h: GateHit) => h.memory.id),
      ['array-topics'],
      'non-array topics match nothing, well-formed memory still fires',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
