// Smoke test for src/index.ts's public export surface (the programmatic
// entry point, see the module's own header comment). mm-v1-T004 fix-round 2
// LOW #7: resolveBlended (the score-blend resolver every hook/MCP/eval
// caller is now retargeted at, see src/router.ts) was missing from this
// export list — a direct `require('@lannguyensi/memory-router')` consumer
// had no way to reach it even though it's the primary resolver going
// forward. This test pins the export so a future refactor of src/index.ts
// can't silently drop it again.

const test = require('node:test');
const assert = require('node:assert/strict');

const memoryRouter = require('../src/index');

test('src/index.ts exports resolveBlended as a function', () => {
  assert.equal(typeof memoryRouter.resolveBlended, 'function');
});

test('src/index.ts still exports the pre-existing router functions (resolve, resolveConfidence, dedupeAndRank)', () => {
  assert.equal(typeof memoryRouter.resolve, 'function');
  assert.equal(typeof memoryRouter.resolveConfidence, 'function');
  assert.equal(typeof memoryRouter.dedupeAndRank, 'function');
});
