const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadMemoriesFromDir } = require('../src/memory/loader');
const { toolGate } = require('../src/gates/tool');
const { resolve } = require('../src/router');

const fixturesDir = path.join(__dirname, 'fixtures', 'memories');

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
