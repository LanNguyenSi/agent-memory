// Test-only preload (node --require, via NODE_OPTIONS) for
// tests/integration/watch-ready-arming.test.ts. It makes the natural gap
// between chokidar's own `ready` event and the deferred parent-directory
// watch of a sync path that is missing at start wide and deterministic,
// instead of load dependent.
//
// Inert unless AGENT_MEMORY_SYNC_TEST_ARM_DELAY_DIR names a directory. When it
// does:
//   - the first fs/promises stat() of that directory that happens after the
//     process opened its first fs.watch() is delayed by
//     AGENT_MEMORY_SYNC_TEST_ARM_DELAY_MS. That stat is the one chokidar's
//     deferred re-add makes on the missing path's nearest existing ancestor
//     before it watches it (chokidar/handler.js, _addToNodeFs);
//   - every fs.watch() call is logged to stderr as `arm-probe: fs.watch <path>`
//     with a synchronous write, so the test can order it against the ready
//     line the command prints on the same pipe.
// It must run before chokidar is required: chokidar captures fs/promises'
// stat at load time.
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const delayDir = process.env.AGENT_MEMORY_SYNC_TEST_ARM_DELAY_DIR;

if (delayDir) {
  const delayMs = Number(process.env.AGENT_MEMORY_SYNC_TEST_ARM_DELAY_MS || 0);
  let watchOpened = false;
  let delayed = false;

  const realStat = fsp.stat;
  fsp.stat = async function stat(target, ...rest) {
    if (watchOpened && !delayed && target === delayDir) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return realStat.call(this, target, ...rest);
  };

  const realWatch = fs.watch;
  fs.watch = function watch(target, ...rest) {
    watchOpened = true;
    fs.writeSync(2, `arm-probe: fs.watch ${target}\n`);
    return realWatch.call(this, target, ...rest);
  };
}
