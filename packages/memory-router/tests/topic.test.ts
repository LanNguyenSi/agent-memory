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

// The gate has no memoryDir slot in its `evaluate(ctx, memories)` signature
// (the shared Gate interface), so it reads $MEMORY_ROUTER_DIR directly —
// same convention the hooks/mcp server already use to locate the memory
// dir. These tests mutate process.env for the duration of one call and
// always restore it, since these are in-process calls (not subprocesses).
function withMemoryRouterDir<T>(dir: string | undefined, fn: () => T): T {
  const original = process.env.MEMORY_ROUTER_DIR;
  if (dir === undefined) delete process.env.MEMORY_ROUTER_DIR;
  else process.env.MEMORY_ROUTER_DIR = dir;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.MEMORY_ROUTER_DIR;
    else process.env.MEMORY_ROUTER_DIR = original;
  }
}

test('custom topics.yml at $MEMORY_ROUTER_DIR overrides the built-in default corpus-wide', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-topic-vocab-'));
  fs.writeFileSync(
    path.join(tmp, 'topics.yml'),
    "- name: incident_response\n  description: Outages and on-call.\n  patterns:\n    - '\\boutage\\b'\n",
  );
  fs.writeFileSync(
    path.join(tmp, 'feedback_incident.md'),
    '---\nname: incident memory\ndescription: x\ntype: feedback\ntopics: [incident_response]\n---\nbody\n',
  );
  try {
    const memories = loadMemoriesFromDir(tmp);
    withMemoryRouterDir(tmp, () => {
      const hits = topicGate.evaluate(
        { prompt: 'we had an outage last night' },
        memories,
      );
      assert.deepEqual(
        hits.map((h: GateHit) => h.memory.id),
        ['feedback_incident'],
      );
      assert.match(hits[0].reason, /incident_response/);

      // Built-in default topic keywords ("merge", "PR") must NOT fire once
      // a custom vocabulary is loaded — the custom set fully replaces the
      // default, it is not merged with it.
      const noHits = topicGate.evaluate({ prompt: 'merge PR 42' }, memories);
      assert.equal(noHits.length, 0);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('$MEMORY_ROUTER_DIR set but no topics.yml present: built-in default still applies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-topic-novocab-'));
  try {
    const memories = loadMemoriesFromDir(fixturesDir);
    withMemoryRouterDir(tmp, () => {
      const hits = topicGate.evaluate({ prompt: 'merge PR 42' }, memories);
      assert.ok(
        hits.map((h: GateHit) => h.memory.id).includes('feedback_stacked_pr'),
      );
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('broken topics.yml at $MEMORY_ROUTER_DIR: gate never throws, falls back to built-in default', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-topic-badvocab-'));
  fs.writeFileSync(path.join(tmp, 'topics.yml'), '- name: [unterminated\n');
  try {
    const memories = loadMemoriesFromDir(fixturesDir);
    withMemoryRouterDir(tmp, () => {
      assert.doesNotThrow(() => {
        const hits = topicGate.evaluate({ prompt: 'merge PR 42' }, memories);
        assert.ok(
          hits
            .map((h: GateHit) => h.memory.id)
            .includes('feedback_stacked_pr'),
        );
      });
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
