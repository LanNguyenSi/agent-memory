const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { loadMemoriesFromDir } = require('../src/memory/loader');
const { resolve } = require('../src/router');
const { topicGate } = require('../src/gates/topic');

const fixturesDir = path.join(__dirname, 'fixtures', 'memories');
// A foreign corpus vocabulary that does NOT declare `workflow` (or any of
// the other built-in default topics) at all — used below to prove
// ctx.memoryDir wins over an ambient $MEMORY_ROUTER_DIR rather than being
// silently overridden by it (mm-v1-T002 review round 2, fixes 1 and 3).
const FIXTURE_VOCAB_DIR = path.join(__dirname, 'fixtures', 'vocab');

test('topic gate fires on "merge PR 42" → workflow memory injected', () => {
  const memories = loadMemoriesFromDir(fixturesDir);
  assert.ok(memories.length >= 1, 'fixtures loaded');

  const hits = resolve(
    { prompt: 'merge PR 42', memoryDir: fixturesDir },
    memories,
  );
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
  const hits = resolve(
    { prompt: 'rename this variable to fooBar', memoryDir: fixturesDir },
    memories,
  );
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
    const hits = topicGate.evaluate(
      { prompt: 'merge PR 42', memoryDir: tmp },
      memories,
    );
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

// --- Hermeticity: ctx.memoryDir must win over ambient $MEMORY_ROUTER_DIR
// (MEDIUM fix 3, enabled by fix 1's dir-threading) -------------------------

test('hermetic: ctx.memoryDir wins over an ambient $MEMORY_ROUTER_DIR pointing at a foreign vocabulary', () => {
  const memories = loadMemoriesFromDir(fixturesDir);
  // FIXTURE_VOCAB_DIR's topics.yml replaces the built-in default wholesale
  // and does not declare a `workflow` topic at all. If ambient env ever won
  // over ctx.memoryDir here, "merge PR 42" would stop matching entirely.
  withMemoryRouterDir(FIXTURE_VOCAB_DIR, () => {
    const hits = resolve(
      { prompt: 'merge PR 42', memoryDir: fixturesDir },
      memories,
    );
    assert.ok(
      hits.map((h: GateHit) => h.memory.id).includes('feedback_stacked_pr'),
      'ctx.memoryDir must win over ambient MEMORY_ROUTER_DIR',
    );
  });
});

// --- Loud degrade: unconditional stderr line on an invalid topics.yml
// (LOW fix 10) --------------------------------------------------------------

function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any): boolean => {
    captured += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test('gate path writes one unconditional stderr line when topics.yml fails to load (loud degrade, not silent)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-topic-loud-'));
  fs.writeFileSync(path.join(tmp, 'topics.yml'), '- name: [unterminated\n');
  const originalDebug = process.env.MEMORY_ROUTER_DEBUG;
  delete process.env.MEMORY_ROUTER_DEBUG; // isolate from the debug()-gated line
  try {
    const memories = loadMemoriesFromDir(fixturesDir);
    const captured = captureStderr(() => {
      topicGate.evaluate({ prompt: 'merge PR 42', memoryDir: tmp }, memories);
    });
    // Distinct from debug.ts's opt-in `[memory-router] ...` convention:
    // this is the unconditional `memory-router: ...` line, same style as
    // gates/tool.ts's unsafe-command_pattern rejection notice.
    const matching = captured
      .split('\n')
      .filter((l) => l.startsWith('memory-router: '));
    assert.equal(
      matching.length,
      1,
      `expected exactly one unconditional stderr line, got:\n${captured}`,
    );
    assert.match(matching[0], /topics\.yml/);
  } finally {
    if (originalDebug === undefined) delete process.env.MEMORY_ROUTER_DEBUG;
    else process.env.MEMORY_ROUTER_DEBUG = originalDebug;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gate path stays silent on the unconditional stderr line when topics.yml is valid (or absent)', () => {
  const memories = loadMemoriesFromDir(fixturesDir);
  const captured = captureStderr(() => {
    topicGate.evaluate(
      { prompt: 'merge PR 42', memoryDir: fixturesDir },
      memories,
    );
  });
  assert.equal(
    captured.split('\n').filter((l) => l.startsWith('memory-router: ')).length,
    0,
  );
});
