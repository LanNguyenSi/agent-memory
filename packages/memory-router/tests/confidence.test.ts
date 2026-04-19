const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeAmbiguity,
  confidenceThreshold,
} = require('../src/gates/confidence');

test('low ambiguity: specific prompt with path + noun', () => {
  const a = computeAmbiguity('fix Tippfehler in foo.ts:12');
  assert.ok(a <= 0.4, `expected low ambiguity, got ${a}`);
  const t = confidenceThreshold(a);
  assert.ok(t >= 0.7, `expected high threshold, got ${t}`);
});

test('high ambiguity: vague verb, no path, no noun', () => {
  const a = computeAmbiguity('kannst du mal schauen');
  assert.ok(a >= 0.8, `expected high ambiguity, got ${a}`);
  const t = confidenceThreshold(a);
  assert.ok(t <= 0.6, `expected low threshold, got ${t}`);
});

test('confidenceThreshold is clamped to [0, 0.85]', () => {
  assert.equal(confidenceThreshold(0), 0.85);
  assert.equal(confidenceThreshold(1), 0.5);
  assert.equal(confidenceThreshold(10), 0);
});
