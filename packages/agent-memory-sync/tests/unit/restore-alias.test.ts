// Unit coverage for the restore alias check (src/memory-sync/restore-alias.ts).
// The pairing logic takes an injectable identity lookup, so it runs the same on
// every filesystem; the real lstat-based lookup is covered against a temp
// directory with a hard link.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileIdentity, followedFileIdentity, findAliasedRestorePath } = require("../../src/memory-sync/restore-alias");

// An identity table standing in for the filesystem: paths that map to the same
// value are one entry; a path absent from the table does not exist.
function lookupFrom(table: Record<string, string>) {
  return (absolutePath: string) => table[absolutePath] ?? null;
}

test("a removable path with the identity of a write target under another string is an alias", () => {
  const identify = lookupFrom({
    "/w/logs/Grüße.md": "1:10",
    "/w/logs/GRÜSSE.md": "1:10",
    "/w/logs/other.md": "1:11"
  });
  assert.deepEqual(findAliasedRestorePath(["/w/logs/Grüße.md", "/w/logs/other.md"], ["/w/logs/GRÜSSE.md"], identify), {
    writePath: "/w/logs/Grüße.md",
    removePath: "/w/logs/GRÜSSE.md"
  });
});

test("no string key is involved: names that fold under no ASCII or NFC rule still pair by identity", () => {
  const identify = lookupFrom({ "/w/logs/ΟΔΟΣ.md": "2:5", "/w/logs/οδος.md": "2:5" });
  assert.notEqual(
    "/w/logs/ΟΔΟΣ.md".normalize("NFC").toLowerCase(),
    "/w/logs/οδος.md".normalize("NFC").toLowerCase(),
    "precondition: a case-fold string key does not see this pair"
  );
  assert.deepEqual(findAliasedRestorePath(["/w/logs/ΟΔΟΣ.md"], ["/w/logs/οδος.md"], identify), {
    writePath: "/w/logs/ΟΔΟΣ.md",
    removePath: "/w/logs/οδος.md"
  });
});

test("a directory-level alias is found through the file identity", () => {
  const identify = lookupFrom({ "/w/logs/sub/x.md": "1:20", "/w/logs/Sub/x.md": "1:20" });
  assert.deepEqual(findAliasedRestorePath(["/w/logs/sub/x.md"], ["/w/logs/Sub/x.md"], identify), {
    writePath: "/w/logs/sub/x.md",
    removePath: "/w/logs/Sub/x.md"
  });
});

test("different identities and missing paths are not aliases", () => {
  // Case-sensitive filesystem: foo.md and Foo.md are two files.
  assert.equal(
    findAliasedRestorePath(
      ["/w/logs/foo.md"],
      ["/w/logs/Foo.md"],
      lookupFrom({ "/w/logs/foo.md": "1:1", "/w/logs/Foo.md": "1:2" })
    ),
    null
  );
  // The write target does not exist yet.
  assert.equal(
    findAliasedRestorePath(["/w/logs/foo.md"], ["/w/logs/Foo.md"], lookupFrom({ "/w/logs/Foo.md": "1:2" })),
    null
  );
  // Nothing to write, or nothing to remove.
  assert.equal(findAliasedRestorePath([], ["/w/logs/Foo.md"], lookupFrom({ "/w/logs/Foo.md": "1:2" })), null);
  assert.equal(findAliasedRestorePath(["/w/logs/foo.md"], [], lookupFrom({ "/w/logs/foo.md": "1:1" })), null);
});

test("a path that is both written and removed is refused, identical strings included", () => {
  // Two syncPaths entries can cover one local file: it is then restored and
  // removed in the same run.
  assert.deepEqual(
    findAliasedRestorePath(["/w/logs/foo.md"], ["/w/logs/foo.md"], lookupFrom({ "/w/logs/foo.md": "1:1" })),
    { writePath: "/w/logs/foo.md", removePath: "/w/logs/foo.md" }
  );
});

test("a write target is registered under the identity it resolves to as well as its own", () => {
  const own = lookupFrom({ "/w/a.md": "1:1", "/w/b.md": "1:2" });
  const followed = lookupFrom({ "/w/a.md": "1:2", "/w/b.md": "1:2" });
  // a.md is a link whose write lands in b.md, which the restore would remove.
  assert.deepEqual(findAliasedRestorePath(["/w/a.md"], ["/w/b.md"], own, followed), {
    writePath: "/w/a.md",
    removePath: "/w/b.md"
  });
  // The removal side is not followed: a removable symlink is unlinked itself.
  assert.equal(findAliasedRestorePath(["/w/b.md"], ["/w/a.md"], own, followed), null);
  // A dangling write target resolves to nothing and keeps only its own identity.
  assert.equal(findAliasedRestorePath(["/w/a.md"], ["/w/b.md"], own, lookupFrom({})), null);
});

test("a later removable path is found, and the first aliased pair wins", () => {
  const identify = lookupFrom({ "/w/a": "1:1", "/w/b": "1:2", "/w/A": "1:1", "/w/B": "1:2" });
  assert.deepEqual(findAliasedRestorePath(["/w/a", "/w/b"], ["/w/gone", "/w/B", "/w/A"], identify), {
    writePath: "/w/b",
    removePath: "/w/B"
  });
});

test("fileIdentity is the device and inode, null for a missing path, and does not follow a symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-alias-"));
  try {
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    fs.writeFileSync(a, "a");
    fs.writeFileSync(b, "b");
    fs.linkSync(a, path.join(dir, "a-link.txt"));
    fs.symlinkSync(a, path.join(dir, "a-symlink.txt"));

    assert.equal(fileIdentity(a), fileIdentity(a));
    assert.equal(fileIdentity(a), fileIdentity(path.join(dir, "a-link.txt")), "a hard link is the same inode");
    assert.notEqual(fileIdentity(a), fileIdentity(b));
    assert.notEqual(fileIdentity(a), fileIdentity(path.join(dir, "a-symlink.txt")), "a symlink is its own entry");
    assert.equal(fileIdentity(path.join(dir, "missing.txt")), null);

    // The real lookup refuses a hard-linked pair too: documented, safe direction.
    assert.deepEqual(findAliasedRestorePath([a], [path.join(dir, "a-link.txt")]), {
      writePath: a,
      removePath: path.join(dir, "a-link.txt")
    });
    assert.equal(findAliasedRestorePath([a], [b]), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a write target that is a real symlink to a removable file is an alias, a dangling one is not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-alias-link-"));
  try {
    const a = path.join(dir, "a.md");
    const b = path.join(dir, "b.md");
    fs.writeFileSync(b, "b");
    fs.symlinkSync(b, a);

    assert.equal(followedFileIdentity(a), fileIdentity(b), "the followed identity of a link is its target's");
    assert.deepEqual(findAliasedRestorePath([a], [b]), { writePath: a, removePath: b });
    // The removal side is the link itself: unlinking a.md leaves b.md alone.
    assert.equal(findAliasedRestorePath([b], [a]), null);

    const dangling = path.join(dir, "dangling.md");
    fs.symlinkSync(path.join(dir, "nowhere.md"), dangling);
    assert.equal(followedFileIdentity(dangling), null);
    assert.equal(followedFileIdentity(path.join(dir, "missing.md")), null);
    assert.equal(findAliasedRestorePath([dangling], [b]), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
