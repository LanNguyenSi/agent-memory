// Stderr-hygiene preload for the two defensive resolution catches
// (src/hooks/user-prompt-submit.ts and src/mcp/server.ts). Those catches are
// the outer "never block a prompt" layer: the resolver they call
// (resolveBlended) already swallows every semantic-search failure internally,
// so no realistic corpus or provider configuration makes it throw on demand in
// a test. The preload therefore replaces exactly ONE export of the already
// loaded dist/router.js with a thrower whose Error message carries the marker
// phrase in MEMORY_ROUTER_TEST_STUB_MARKER, so the test can pin what the catch
// prints. dist/router.js ends in `module.exports = { ... }`, so the patched
// property is the one the entry point destructures when it requires the module
// AFTER this preload ran.
const path = require('node:path');

const ROUTER = require.resolve(
  path.join(__dirname, '..', '..', 'dist', 'router.js'),
);
const MARKER =
  process.env.MEMORY_ROUTER_TEST_STUB_MARKER || 'zzpromptmarkerphrase';
const STUBABLE = ['resolve', 'resolveConfidence', 'resolveBlended'];

const exportName = process.env.MEMORY_ROUTER_TEST_STUB_EXPORT;
if (!STUBABLE.includes(exportName)) {
  throw new Error(
    `stub-router-preload: MEMORY_ROUTER_TEST_STUB_EXPORT must be one of ${STUBABLE.join(', ')}`,
  );
}

const router = require(ROUTER);
router[exportName] = async () => {
  const err = new Error(`resolver input: ${MARKER}`);
  err.name = 'RouterFailure';
  err.code = 'SQLITE_ERROR';
  throw err;
};
