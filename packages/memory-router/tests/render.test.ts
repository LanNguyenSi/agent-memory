const test = require('node:test');
const assert = require('node:assert/strict');
const { renderHitsAsContext } = require('../src/render');

function mem(id: string, name: string, body: string): Memory {
  return {
    id,
    path: `/tmp/${id}.md`,
    frontmatter: { name, description: 'x', type: 'feedback' },
    body,
  };
}

test('renderHitsAsContext returns empty string on no hits', () => {
  assert.equal(renderHitsAsContext([]), '');
});

test('renderHitsAsContext renders a single hit with name + body', () => {
  const hit: GateHit = {
    memory: mem('feedback_stacked_pr', 'Stacked PR base', 'Body text here.'),
    gate: 'topic',
    score: 1.0,
    reason: 'topic match: workflow',
  };
  const out = renderHitsAsContext([hit]);
  assert.match(out, /1 relevant memory applies/);
  assert.match(out, /### Stacked PR base/);
  assert.match(out, /_\(topic · 1\.00\)_/);
  assert.match(out, /Body text here\./);
});

test('renderHitsAsContext pluralizes header and joins multiple hits', () => {
  const a: GateHit = {
    memory: mem('a', 'Alpha', 'alpha body'),
    gate: 'topic',
    score: 1,
    reason: 'x',
  };
  const b: GateHit = {
    memory: mem('b', 'Beta', 'beta body'),
    gate: 'tool',
    score: 0.8,
    reason: 'y',
  };
  const out = renderHitsAsContext([a, b]);
  assert.match(out, /2 relevant memories apply/);
  assert.match(out, /### Alpha/);
  assert.match(out, /### Beta/);
  assert.match(out, /_\(tool · 0\.80\)_/);
});
