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

function setup(name: string) {
  const root = sandbox(name);
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const baseMap: Record<string, string | null> = {};
  const localMap: Record<string, string> = {};
  const localFiles: Array<{ remoteRelativePath: string; absolutePath: string }> = [];
  for (let index = 0; index < 10; index += 1) {
    const remoteRelativePath = `notes/T${index}.md`;
    const absolutePath = path.join(workspace, remoteRelativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, `t${index}\n`, "utf8");
    baseMap[remoteRelativePath] = `t${index}\n`;
    localMap[remoteRelativePath] = `t${index}\n`;
    localFiles.push({ remoteRelativePath, absolutePath });
  }
  // The hub dropped the first five.
  const remoteMap: Record<string, string | null> = {};
  for (let index = 5; index < 10; index += 1) {
    remoteMap[`notes/T${index}.md`] = `t${index}\n`;
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
    syncPaths: [{ source: path.join(workspace, "notes"), destination: "notes", kind: "directory" }]
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
    localFile: (index: number) => localFiles[index].absolutePath,
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
    (error: Error) => /pre-apply snapshot/.test(error.message) && /No local file was removed/.test(error.message)
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
