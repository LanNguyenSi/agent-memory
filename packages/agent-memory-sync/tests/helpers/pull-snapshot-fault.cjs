// Preload for a CLI test (NODE_OPTIONS=--require <this file>): damages what a
// pull sees or writes around its pre-apply snapshot, the way a race with
// another process or a rotation would. Only active while
// AGENT_MEMORY_SYNC_TEST_PULL_FAULTS is set, to a JSON array of
//   { "kind": "drop-snapshot", "destination": "notes" }
//       the destination's snapshot generation is removed right after it is written
//   { "kind": "omit-from-snapshot", "destination": "notes", "path": "notes/a.md" }
//       the snapshot is written without that file, which stays on disk, as if
//       it had changed hands after the local files were collected
//   { "kind": "hide-from-collection", "path": "notes/a.md" }
//       the collected local files do not list that file, which stays on disk,
//       as if it had been created after the collection
const Module = require("node:module");
const { rmSync } = require("node:fs");

const originalLoad = Module._load;
const wrapped = new Map();

function faults() {
  return JSON.parse(process.env.AGENT_MEMORY_SYNC_TEST_PULL_FAULTS);
}

Module._load = function load(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (!process.env.AGENT_MEMORY_SYNC_TEST_PULL_FAULTS) {
    return loaded;
  }
  const isSnapshotModule = /pre-apply-snapshot$/.test(request);
  const isConfigModule = request === "./config";
  if (!isSnapshotModule && !isConfigModule) {
    return loaded;
  }
  if (!wrapped.has(loaded)) {
    if (isSnapshotModule) {
      wrapped.set(loaded, {
        ...loaded,
        writePreApplySnapshot: (input) => {
          const hidden = faults()
            .filter((fault) => fault.kind === "omit-from-snapshot" && fault.destination === input.destination)
            .map((fault) => fault.path);
          const written = loaded.writePreApplySnapshot({
            ...input,
            files: input.files.filter((file) => !hidden.includes(file.remoteRelativePath))
          });
          if (faults().some((fault) => fault.kind === "drop-snapshot" && fault.destination === input.destination)) {
            rmSync(written.dir, { recursive: true, force: true });
          }
          return written;
        }
      });
    } else {
      wrapped.set(loaded, {
        ...loaded,
        collectLocalSyncFiles: (...args) => {
          const hidden = faults()
            .filter((fault) => fault.kind === "hide-from-collection")
            .map((fault) => fault.path);
          return loaded.collectLocalSyncFiles(...args).filter((file) => !hidden.includes(file.remoteRelativePath));
        }
      });
    }
  }
  return wrapped.get(loaded);
};
