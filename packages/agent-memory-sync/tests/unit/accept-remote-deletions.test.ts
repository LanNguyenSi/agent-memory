// Unit coverage for the fail-closed half of acceptRemoteDeletions
// (src/memory-sync/accept-remote-deletions.ts): the adoption removes local
// files only while the pre-apply snapshot that holds their copy exists.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} = require("node:fs");
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

// The hub dropped T0..T4, so the lost paths are T0 (first), T1 and T4 (last).
// A file that came back and was left out of the snapshot must stop the
// adoption wherever it sits in the list of paths to remove.
for (const missing of [0, 1, 4]) {
  test(`an adoption deletes nothing when lost path T${missing} on disk is not in the snapshot`, () => {
    // The file is on disk but was not among the files collected before the
    // fetch, so the snapshot never copied it; removing it would leave it
    // nowhere.
    const ctx = setup(`uncollected-${missing}`, { uncollected: [missing] });
    const accept = loadAcceptWith(null);

    assert.throws(
      () => ctx.run(accept),
      (error: Error & { exitCode?: number }) =>
        new RegExp(
          `--accept-mass-delete stopped: notes/T${missing}\\.md exists on disk but is not a regular file the sync collects`
        ).test(error.message) &&
        /No local file was removed, no snapshot was written and the base snapshot was not moved/.test(error.message) &&
        error.exitCode === 12
    );

    for (let index = 0; index < 10; index += 1) {
      assert.equal(existsSync(ctx.localFile(index)), true, `T${index}.md is still on disk`);
    }
    assert.equal(ctx.baseReplaced(), 0, "the base snapshot was not moved");
    assert.equal(existsSync(path.join(ctx.stateDir, "snapshots")), false, "no snapshot was written");
  });
}

test("an adoption stops on a lost path that is a symlink the sync does not collect", () => {
  const ctx = setup("symlink", { uncollected: [1] });
  const target = path.join(path.dirname(ctx.localFile(1)), "elsewhere.txt");
  writeFileSync(target, "target\n", "utf8");
  rmSync(ctx.localFile(1));
  symlinkSync(target, ctx.localFile(1));
  const accept = loadAcceptWith(null);

  assert.throws(
    () => ctx.run(accept),
    (error: Error & { exitCode?: number }) =>
      /notes\/T1\.md exists on disk but is not a regular file the sync collects/.test(error.message) &&
      /run the push again first\. Only if it stops again at the same path, move notes\/T1\.md aside and run the push again/.test(
        error.message
      ) &&
      error.exitCode === 12
  );

  for (let index = 0; index < 10; index += 1) {
    assert.equal(existsSync(ctx.localFile(index)), true, `T${index}.md is still on disk`);
  }
  assert.equal(ctx.baseReplaced(), 0, "the base snapshot was not moved");
});

// A destination that is a path prefix of another, or only a string prefix of
// it, must not claim the other's files: each destination's snapshot holds
// exactly its own share, and every lost file of every destination is removed.
for (const destinations of [
  ["notes", "notes/sub"],
  ["notes", "notes2"]
]) {
  test(`an adoption with destinations ${destinations.join(" and ")} deletes the lost files of both`, () => {
    const ctx = setup(`prefix-${destinations[1].replace("/", "-")}`, { destinations });
    const accept = loadAcceptWith(null);

    const result = ctx.run(accept);

    assert.ok(result);
    assert.equal(result.deletedPaths.length, 10);
    assert.equal(result.snapshots.length, 2);
    for (const [destinationIndex, destination] of destinations.entries()) {
      for (let index = 0; index < 10; index += 1) {
        assert.equal(
          existsSync(ctx.localFile(index, destinationIndex)),
          index >= 5,
          `${destination}/T${index}.md ${index >= 5 ? "is kept" : "is removed"}`
        );
      }
      const snapshotted = result.snapshots.some((id: string) =>
        existsSync(path.join(ctx.stateDir, "snapshots", destination, id, "files", destination, "T0.md"))
      );
      assert.equal(snapshotted, true, `${destination}/T0.md is in a snapshot`);
    }
  });
}

// A removal that throws part way: the earlier ones are done, the error says
// which and where their content is, and the base snapshot has not moved.
test("an adoption whose removal fails part way names the removed paths and the snapshot, and leaves the base alone", (t: {
  skip: (reason: string) => void;
}) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("a read-only directory does not stop root");
    return;
  }
  const ctx = setup("partial-delete", { destinations: ["notes", "notes/sub"] });
  const accept = loadAcceptWith(null);
  // notes/T0..T4 are removed first (sorted order), then notes/sub/T0 hits the read-only directory.
  const readOnly = path.dirname(ctx.localFile(0, 1));
  chmodSync(readOnly, 0o555);
  try {
    assert.throws(
      () => ctx.run(accept),
      (error: Error & { exitCode?: number }) =>
        error.name === "PartialApplyError" &&
        error.exitCode === 13 &&
        /removing notes\/sub\/T0\.md failed/.test(error.message) &&
        /Already removed \(5 of 10\): notes\/T0\.md, notes\/T1\.md, notes\/T2\.md, notes\/T3\.md, notes\/T4\.md/.test(
          error.message
        ) &&
        /'notes' \S+, 'notes\/sub' \S+/.test(error.message) &&
        /base snapshot was not moved/.test(error.message) &&
        error.message.includes(`${ctx.stateDir}/snapshots/<destination>/<id>`) &&
        /every rerun takes a new snapshot and rotates older generations away, so copy the generation named above aside \(or pause the scheduled sync\) before retrying/.test(
          error.message
        )
    );
  } finally {
    chmodSync(readOnly, 0o755);
  }

  assert.equal(existsSync(ctx.localFile(0, 0)), false, "the earlier removals stay done");
  assert.equal(existsSync(ctx.localFile(0, 1)), true, "the failing path is still there");
  assert.equal(ctx.baseReplaced(), 0, "the base snapshot was not moved");
  const snapshotDir = path.join(ctx.stateDir, "snapshots", "notes");
  const [generation] = readdirSync(snapshotDir).filter((name: string) => name !== "sub");
  assert.equal(readFileSync(path.join(snapshotDir, generation, "files", "notes", "T0.md"), "utf8"), "t0\n");
});
