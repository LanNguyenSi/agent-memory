// Unit coverage for the fail-closed half of acceptRemoteDeletions
// (src/memory-sync/accept-remote-deletions.ts): the adoption removes local
// files only while the pre-apply snapshot that holds their copy exists.
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const snapshotModulePath = require.resolve("../../src/memory-sync/pre-apply-snapshot");
const acceptModulePath = require.resolve("../../src/memory-sync/accept-remote-deletions");
const realSnapshotModule = require(snapshotModulePath);

function sandbox(name: string): string {
  const root = path.join(
    tmpdir(),
    `agent-memory-sync-accept-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  mkdirSync(root, { recursive: true });
  return root;
}

// Loads accept-remote-deletions against a pre-apply-snapshot module whose
// writePreApplySnapshot is wrapped, then puts the real modules back.
function loadAcceptWith(wrapWrite: ((real: (input: unknown) => { id: string; dir: string }) => unknown) | null) {
  const snapshotEntry = require.cache[snapshotModulePath] as NodeJS.Module;
  const originalExports = snapshotEntry.exports;
  const originalAccept = require.cache[acceptModulePath];
  try {
    if (wrapWrite) {
      snapshotEntry.exports = {
        ...realSnapshotModule,
        writePreApplySnapshot: wrapWrite(realSnapshotModule.writePreApplySnapshot)
      };
    }
    delete require.cache[acceptModulePath];
    return require(acceptModulePath);
  } finally {
    snapshotEntry.exports = originalExports;
    if (originalAccept) {
      require.cache[acceptModulePath] = originalAccept;
    } else {
      delete require.cache[acceptModulePath];
    }
  }
}

interface SetupOptions {
  destinations?: string[];
  // Indexes of destination "notes" files that exist on disk but are left out
  // of the collected localFiles, as a file that came back after the
  // collection would be.
  uncollected?: number[];
}

function setup(name: string, options: SetupOptions = {}) {
  const root = sandbox(name);
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const destinations = options.destinations || ["notes"];
  const uncollected = new Set(options.uncollected || []);
  const baseMap: Record<string, string | null> = {};
  const localMap: Record<string, string> = {};
  const localFiles: Array<{ remoteRelativePath: string; absolutePath: string }> = [];
  const remoteMap: Record<string, string | null> = {};
  const filesByDestination: Record<string, string[]> = {};
  for (const destination of destinations) {
    filesByDestination[destination] = [];
    for (let index = 0; index < 10; index += 1) {
      const remoteRelativePath = `${destination}/T${index}.md`;
      const absolutePath = path.join(workspace, remoteRelativePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, `t${index}\n`, "utf8");
      baseMap[remoteRelativePath] = `t${index}\n`;
      localMap[remoteRelativePath] = `t${index}\n`;
      filesByDestination[destination].push(absolutePath);
      if (!(destination === "notes" && uncollected.has(index))) {
        localFiles.push({ remoteRelativePath, absolutePath });
      }
      // The hub dropped the first five of each destination.
      if (index >= 5) {
        remoteMap[remoteRelativePath] = `t${index}\n`;
      }
    }
  }

  let stored: Record<string, string | null> = { ...baseMap };
  let replaced = 0;
  const stateStore = {
    readBaseSnapshots: () => ({ ...stored }),
    replaceBaseSnapshots: (files: Record<string, string | null>) => {
      stored = files;
      replaced += 1;
    }
  };
  const config = {
    stateDir,
    rootDir: workspace,
    repositorySubdir: "shared",
    profile: "unit",
    syncPaths: destinations.map((destination) => ({
      source: path.join(workspace, destination),
      destination,
      kind: "directory"
    }))
  };

  return {
    stateDir,
    run: (accept: { acceptRemoteDeletions: (input: unknown) => unknown }) =>
      accept.acceptRemoteDeletions({
        config,
        stateStore,
        baseMap,
        localMap,
        localFiles,
        remoteMap,
        remoteHead: "abc123"
      }) as { deletedPaths: string[]; snapshots: string[] },
    localFile: (index: number, destinationIndex = 0) => filesByDestination[destinations[destinationIndex]][index],
    baseReplaced: () => replaced
  };
}

test("an adoption whose snapshot is intact deletes the lost local files", () => {
  const ctx = setup("intact");
  const accept = loadAcceptWith(null);

  const result = ctx.run(accept);

  assert.ok(result);
  assert.equal(result.deletedPaths.length, 5);
  assert.equal(existsSync(ctx.localFile(0)), false);
  const snapshotId = result.snapshots[0];
  assert.equal(
    readFileSync(path.join(ctx.stateDir, "snapshots", "notes", snapshotId, "files", "notes", "T0.md"), "utf8"),
    "t0\n"
  );
});

test("an adoption whose snapshot is gone after rotation deletes nothing and reports the failure", () => {
  const ctx = setup("missing-snapshot");
  // The snapshot is written and then removed again, the way a rotation that
  // dropped it would leave things.
  const accept = loadAcceptWith((real) => (input: unknown) => {
    const written = real(input);
    rmSync(written.dir, { recursive: true, force: true });
    return written;
  });

  assert.throws(
    () => ctx.run(accept),
    (error: Error & { exitCode?: number }) =>
      /pre-apply snapshot/.test(error.message) &&
      /No local file was removed/.test(error.message) &&
      error.exitCode === 12 &&
      error.name === "AdoptionSnapshotNotIntactError"
  );

  for (let index = 0; index < 10; index += 1) {
    assert.equal(existsSync(ctx.localFile(index)), true, `T${index}.md is still on disk`);
  }
  assert.equal(ctx.baseReplaced(), 0, "the base snapshot was not moved");
});

test("an adoption whose snapshot lost a stored file deletes nothing", () => {
  const ctx = setup("missing-file");
  const accept = loadAcceptWith((real) => (input: unknown) => {
    const written = real(input);
    rmSync(path.join(written.dir, "files", "notes", "T2.md"), { force: true });
    return written;
  });

  assert.throws(() => ctx.run(accept), /pre-apply snapshot/);

  for (let index = 0; index < 10; index += 1) {
    assert.equal(existsSync(ctx.localFile(index)), true, `T${index}.md is still on disk`);
  }
});

test("an adoption deletes nothing in any destination when only a later destination's snapshot is gone", () => {
  // The adoption walks destinations in sorted order, so "notes" is the second.
  const ctx = setup("two-destinations", { destinations: ["archive", "notes"] });
  // Only the second destination's snapshot disappears; the first stays intact.
  const accept = loadAcceptWith((real) => (input: unknown) => {
    const written = real(input);
    if ((input as { destination: string }).destination === "notes") {
      rmSync(written.dir, { recursive: true, force: true });
    }
    return written;
  });

  assert.throws(
    () => ctx.run(accept),
    (error: Error & { exitCode?: number }) => /'notes'/.test(error.message) && error.exitCode === 12
  );

  for (let index = 0; index < 10; index += 1) {
    assert.equal(existsSync(ctx.localFile(index, 0)), true, `archive/T${index}.md is still on disk`);
    assert.equal(existsSync(ctx.localFile(index, 1)), true, `notes/T${index}.md is still on disk`);
  }
  assert.equal(ctx.baseReplaced(), 0, "the base snapshot was not moved");
});

test("an adoption deletes nothing when a lost path on disk is not in the snapshot", () => {
  // T1 is on disk but was not among the files collected before the fetch, so
  // the snapshot never copied it; removing it would leave it nowhere.
  const ctx = setup("uncollected", { uncollected: [1] });
  const accept = loadAcceptWith(null);

  assert.throws(
    () => ctx.run(accept),
    (error: Error & { exitCode?: number }) =>
      /does not list notes\/T1\.md/.test(error.message) &&
      /No local file was removed/.test(error.message) &&
      error.exitCode === 12
  );

  for (let index = 0; index < 10; index += 1) {
    assert.equal(existsSync(ctx.localFile(index)), true, `T${index}.md is still on disk`);
  }
  assert.equal(ctx.baseReplaced(), 0, "the base snapshot was not moved");
});
