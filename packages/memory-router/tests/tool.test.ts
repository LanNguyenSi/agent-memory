const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { loadMemoriesFromDir } = require('../src/memory/loader');
const { toolGate, isSafePattern } = require('../src/gates/tool');
const { resolve } = require('../src/router');

const fixturesDir = path.join(__dirname, 'fixtures', 'memories');

test('tool gate tolerates non-array triggers.tools from the liberal loader', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-tool-'));
  fs.writeFileSync(
    path.join(tmp, 'mapping-tools.md'),
    '---\nname: mapping\ndescription: x\ntype: feedback\ntriggers:\n  tools:\n    Bash: true\n---\nbody\n',
  );
  fs.writeFileSync(
    path.join(tmp, 'scalar-tools.md'),
    '---\nname: scalar\ndescription: x\ntype: feedback\ntriggers:\n  tools: Bash\n---\nbody\n',
  );
  fs.writeFileSync(
    path.join(tmp, 'array-tools.md'),
    '---\nname: ok\ndescription: x\ntype: feedback\ntriggers:\n  tools: [Bash]\n---\nbody\n',
  );
  try {
    const memories = loadMemoriesFromDir(tmp);
    assert.equal(
      memories.length,
      3,
      'loader does not validate triggers shape, all three load',
    );
    // Must not throw: this path runs synchronously in the
    // user-prompt-submit hook, where an exception kills memory context.
    const hits = toolGate.evaluate(
      { tool: { name: 'Bash', args: { command: 'ls' } } },
      memories,
    );
    assert.deepEqual(
      hits.map((h: GateHit) => h.memory.id),
      ['array-tools'],
      'non-array tools match nothing, well-formed memory still fires',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tool gate fires before Bash(git push --force) → destructive memory', () => {
  const memories = loadMemoriesFromDir(fixturesDir);
  const hits = resolve(
    {
      tool: {
        name: 'Bash',
        args: { command: 'git push --force origin master' },
      },
    },
    memories,
    { gates: [toolGate] },
  );

  const ids = hits.map((h: { memory: { id: string } }) => h.memory.id);
  assert.ok(
    ids.includes('feedback_force_push'),
    `expected force-push memory to fire, got: ${ids.join(', ')}`,
  );
});

test('tool gate silent on Bash(ls)', () => {
  const memories = loadMemoriesFromDir(fixturesDir);
  const hits = resolve(
    { tool: { name: 'Bash', args: { command: 'ls -la' } } },
    memories,
    { gates: [toolGate] },
  );
  assert.equal(hits.length, 0);
});
