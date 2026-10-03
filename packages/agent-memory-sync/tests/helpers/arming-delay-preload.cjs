// Test-only preload (node --require, via NODE_OPTIONS) for
// tests/integration/watch-ready-arming.test.ts. It widens the natural gap
// between chokidar 4.0.3's own `ready` event and its deferred parent-directory
// step for a sync path that is missing at start, so that a test creating such
// a path inside the gap does not depend on CPU load. `watch` no longer hands
// chokidar a missing path (src/commands/watch-arming.ts), so against the
// current code the delay is inert; against code that does, the path created in
// the gap is lost, which is what makes the test that uses this file fail there.
//
// Inert unless one of the environment variables below is set. Every fs.watch()
// call is then logged to stderr as `arm-probe: fs.watch <path>` with a
// synchronous write, so a test can order it against the ready line the command
// prints on the same pipe. The modes, each switched on by its own variable:
//
// AGENT_MEMORY_SYNC_TEST_ARM_DELAY_DIR (delay chokidar's deferred step):
//   - the first fs/promises stat() of that directory that happens after the
//     process opened its first fs.watch() is delayed by
//     AGENT_MEMORY_SYNC_TEST_ARM_DELAY_MS. That stat is the one chokidar's
//     deferred re-add makes on the missing path's nearest existing ancestor
//     before it watches it (chokidar/handler.js, _addToNodeFs);
//
// AGENT_MEMORY_SYNC_TEST_SUPPRESS_SCRATCH_EVENTS=1: the listener of every
//   fs.watch() on a path containing `agent-memory-sync-arm-` (the scratch
//   directory `confirmWatchLive` watches) is replaced by a no-op, so that watch
//   never reports an event and the confirmation can only end by its bound or
//   by a shutdown.
//
// AGENT_MEMORY_SYNC_TEST_FAIL_SCRATCH_SETUP=1: fs.mkdtempSync() of a path
//   containing `agent-memory-sync-arm-` throws, so `confirmWatchLive` cannot
//   set its probe up (as opposed to the probe timing out).
//
// AGENT_MEMORY_SYNC_TEST_HANG_STAT_AFTER_EXISTS_DIR=<path>: after the first
//   stat() of that path that finds it, every later stat() of it never settles.
//   The first one is the tracker noticing the path; the later ones are
//   chokidar's, whose watcher of the appeared path therefore never becomes
//   ready.
//
// AGENT_MEMORY_SYNC_TEST_REMOVE_AFTER_STAT_DIR=<path>: the directory is
//   removed, once, right after the first stat() that found it, so the path is
//   gone again by the time the code that saw it acts on it.
//
// It must run before chokidar is required: chokidar captures fs/promises'
// stat at load time.
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const delayDir = process.env.AGENT_MEMORY_SYNC_TEST_ARM_DELAY_DIR;
const suppressScratchEvents = process.env.AGENT_MEMORY_SYNC_TEST_SUPPRESS_SCRATCH_EVENTS === "1";
const failScratchSetup = process.env.AGENT_MEMORY_SYNC_TEST_FAIL_SCRATCH_SETUP === "1";
const hangStatDir = process.env.AGENT_MEMORY_SYNC_TEST_HANG_STAT_AFTER_EXISTS_DIR;
const removeAfterStatDir = process.env.AGENT_MEMORY_SYNC_TEST_REMOVE_AFTER_STAT_DIR;

if (delayDir || suppressScratchEvents || failScratchSetup || hangStatDir || removeAfterStatDir) {
  const delayMs = Number(process.env.AGENT_MEMORY_SYNC_TEST_ARM_DELAY_MS || 0);
  let watchOpened = false;
  let delayed = false;
  let hangStatFrom = false;
  let removed = false;

  const realStat = fsp.stat;
  fsp.stat = async function stat(target, ...rest) {
    if (delayDir && watchOpened && !delayed && target === delayDir) {
      delayed = true;
      // unref'd: a shutdown test needs the process to end when the watch
      // stops, not when this artificial delay runs out.
      await new Promise((resolve) => setTimeout(resolve, delayMs).unref());
    }
    if (hangStatDir && hangStatFrom && target === hangStatDir) {
      // Never settles; an unsettled promise does not keep the process alive.
      await new Promise(() => undefined);
    }
    const result = await realStat.call(this, target, ...rest);
    if (hangStatDir && target === hangStatDir) {
      hangStatFrom = true;
    }
    if (removeAfterStatDir && !removed && target === removeAfterStatDir) {
      removed = true;
      fs.rmSync(target, { recursive: true, force: true });
    }
    return result;
  };

  const realMkdtempSync = fs.mkdtempSync;
  fs.mkdtempSync = function mkdtempSync(prefix, ...rest) {
    if (failScratchSetup && String(prefix).includes("agent-memory-sync-arm-")) {
      throw new Error("EACCES: scratch directory refused by the test preload");
    }
    return realMkdtempSync.call(this, prefix, ...rest);
  };

  const realWatch = fs.watch;
  fs.watch = function watch(target, ...rest) {
    watchOpened = true;
    fs.writeSync(2, `arm-probe: fs.watch ${target}\n`);
    if (suppressScratchEvents && String(target).includes("agent-memory-sync-arm-")) {
      rest = rest.map((argument) => (typeof argument === "function" ? () => undefined : argument));
    }
    return realWatch.call(this, target, ...rest);
  };
}
