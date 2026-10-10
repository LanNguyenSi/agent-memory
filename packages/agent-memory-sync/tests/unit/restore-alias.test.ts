// Unit coverage for the restore alias check (src/memory-sync/restore-alias.ts).
// The candidate comparison is pure string work and runs on every filesystem;
// whether a candidate is really one file is decided by an injectable
// predicate, with the real stat-based one covered against a temp directory.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  aliasKey,
  findAliasCandidates,
  findAliasedRestorePath,
  pathsShareFile
} = require("../../src/memory-sync/restore-alias");

test("aliasKey folds case and Unicode normalization form", () => {
  assert.equal(aliasKey("/w/logs/Foo.md"), aliasKey("/w/logs/foo.md"));
  assert.equal(aliasKey("/w/logs/café.md"), aliasKey("/w/logs/café.md"));
  assert.notEqual(aliasKey("/w/logs/foo.md"), aliasKey("/w/logs/bar.md"));
});

test("findAliasCandidates pairs paths that differ only by case or normalization", () => {
  assert.deepEqual(findAliasCandidates(["/w/logs/foo.md", "/w/logs/other.md"], ["/w/logs/Foo.md"]), [
    { writePath: "/w/logs/foo.md", removePath: "/w/logs/Foo.md" }
  ]);
  assert.deepEqual(findAliasCandidates(["/w/logs/café.md"], ["/w/logs/café.md"]), [
    { writePath: "/w/logs/café.md", removePath: "/w/logs/café.md" }
  ]);
  // A directory component counts too.
  assert.equal(findAliasCandidates(["/w/logs/sub/x.md"], ["/w/logs/Sub/x.md"]).length, 1);
});

test("findAliasCandidates ignores identical and unrelated paths", () => {
  assert.deepEqual(findAliasCandidates(["/w/logs/foo.md"], ["/w/logs/foo.md"]), []);
  assert.deepEqual(findAliasCandidates(["/w/logs/foo.md"], ["/w/logs/bar.md"]), []);
  assert.deepEqual(findAliasCandidates([], ["/w/logs/Foo.md"]), []);
});

test("findAliasedRestorePath reports a candidate only when the filesystem says it is one file", () => {
  const writes = ["/w/logs/foo.md", "/w/logs/other.md"];
  const removes = ["/w/logs/Foo.md", "/w/logs/gone.md"];
  assert.deepEqual(
    findAliasedRestorePath(writes, removes, () => true),
    { writePath: "/w/logs/foo.md", removePath: "/w/logs/Foo.md" }
  );
  assert.equal(
    findAliasedRestorePath(writes, removes, () => false),
    null,
    "case-sensitive filesystem: two different files, nothing to refuse"
  );
  assert.equal(
    findAliasedRestorePath(writes, ["/w/logs/gone.md"], () => true),
    null,
    "no candidate pair, the predicate is never the deciding factor"
  );
});

test("pathsShareFile compares device and inode, and is false for a missing path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-alias-"));
  try {
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    fs.writeFileSync(a, "a");
    fs.writeFileSync(b, "b");
    fs.linkSync(a, path.join(dir, "a-link.txt"));
    assert.equal(pathsShareFile(a, a), true);
    assert.equal(pathsShareFile(a, path.join(dir, "a-link.txt")), true);
    assert.equal(pathsShareFile(a, b), false);
    assert.equal(pathsShareFile(a, path.join(dir, "missing.txt")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
