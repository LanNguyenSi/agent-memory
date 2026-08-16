// Fix-round finding (agent-tasks 65380570-fix, LOW #6a): direct unit
// coverage for filterUnmappedBaseMap (src/memory-sync/config.ts), the
// helper both pull.ts's and push.ts's base-snapshot writes and push.ts's
// base-snapshot read route through. Every syncPaths entry below sets an
// explicit `kind`, so resolveSyncPathKind never touches the filesystem.
// These tests exercise the pure filtering logic without needing a real
// sandbox directory on disk.
const test = require("node:test");
const assert = require("node:assert/strict");
const { filterUnmappedBaseMap } = require("../../src/memory-sync/config");

function baseConfig() {
  return {
    rootDir: "/workspace",
    repositorySubdir: "shared",
    syncPaths: [
      { source: "MEMORY.md", destination: "MEMORY.md", kind: "file" },
      { source: "logs", destination: "logs", kind: "directory" }
    ]
  };
}

test("filterUnmappedBaseMap keeps a mapped file entry", () => {
  const result = filterUnmappedBaseMap(baseConfig(), { "MEMORY.md": "content\n" });
  assert.deepEqual(result, { "MEMORY.md": "content\n" });
});

test("filterUnmappedBaseMap keeps a mapped nested-directory entry", () => {
  const result = filterUnmappedBaseMap(baseConfig(), { "logs/2026-01-01.md": "entry\n" });
  assert.deepEqual(result, { "logs/2026-01-01.md": "entry\n" });
});

test("filterUnmappedBaseMap drops an unmapped entry", () => {
  const result = filterUnmappedBaseMap(baseConfig(), { "unmapped-notes.md": "orphan\n" });
  assert.deepEqual(result, {});
});

test("filterUnmappedBaseMap drops a traversal-escaping key resolving outside its mapped directory", () => {
  // "logs/../../etc/passwd" passes normalizeRemoteRelativePath's own check
  // (it does not itself start with "..") but resolves, via path.resolve
  // against the mapped directory's absoluteSource, to a path outside it.
  // mapRemotePathToLocalAbsolute's own traversal guard returns null for
  // this shape (not a CliError throw), which filterUnmappedBaseMap must
  // treat the same as any other unmapped key: dropped, not crashed on.
  const result = filterUnmappedBaseMap(baseConfig(), { "logs/../../etc/passwd": "evil\n" });
  assert.deepEqual(result, {});
});

test("filterUnmappedBaseMap keeps a mapped entry whose value is null (a recorded delete)", () => {
  const result = filterUnmappedBaseMap(baseConfig(), { "MEMORY.md": null });
  assert.deepEqual(result, { "MEMORY.md": null });
});

// Fix-round finding (agent-tasks 65380570-fix, LOW #6c): a key that fails
// normalizeRemoteRelativePath outright (empty, or starting with "..") must
// not crash filterUnmappedBaseMap when it appears in an on-disk base
// snapshot store. mapRemotePathToLocalAbsolute catches the thrown CliError
// and treats the key as unmapped instead of propagating it. See the
// "malformed key" integration test in memory-sync.test.ts for the same
// guard exercised through a real push against a store seeded on disk.
test("filterUnmappedBaseMap drops a malformed key instead of throwing", () => {
  const result = filterUnmappedBaseMap(baseConfig(), {
    "": "empty key\n",
    "../escape": "leading traversal\n",
    "MEMORY.md": "still kept\n"
  });
  assert.deepEqual(result, { "MEMORY.md": "still kept\n" });
});
