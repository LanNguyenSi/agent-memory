// Preload for a CLI test (NODE_OPTIONS=--require <this file>): every
// pre-apply snapshot the run writes is removed again right after it is
// written, the way a rotation that dropped it would leave things. Only active
// while AGENT_MEMORY_SYNC_TEST_DROP_SNAPSHOT is set.
const Module = require("node:module");
const { rmSync } = require("node:fs");

const originalLoad = Module._load;
const wrapped = new WeakMap();

Module._load = function load(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (!process.env.AGENT_MEMORY_SYNC_TEST_DROP_SNAPSHOT || !/pre-apply-snapshot$/.test(request)) {
    return loaded;
  }
  if (!wrapped.has(loaded)) {
    wrapped.set(loaded, {
      ...loaded,
      writePreApplySnapshot: (input) => {
        const written = loaded.writePreApplySnapshot(input);
        rmSync(written.dir, { recursive: true, force: true });
        return written;
      }
    });
  }
  return wrapped.get(loaded);
};
