const { lstatSync, statSync } = require("node:fs");

// A path a destination restore is about to write and a path it is about to
// remove can be one file on disk even though the strings differ: on a
// case-insensitive filesystem (default APFS and NTFS) a case-only rename
// leaves local logs/Foo.md where the hub has logs/foo.md, and the folding
// rules go well beyond ASCII case (a final sigma, the German sharp s, ligature
// names, precomposed against decomposed spellings). The write lands in the
// existing file and the removal of the "extra" path then deletes what was just
// restored.
//
// No string comparison can reproduce every filesystem's folding table, so the
// filesystem is asked instead: a path's identity is its device and inode, and
// a removable path that has the identity of a write target under a different
// string is an alias. Two names that are merely hard links of one inode are
// refused as well; that is the safe direction, since removing one of them is
// not a loss of the content but the restore cannot tell the two cases apart.
//
// A write goes through a symlink into its target (writeFileSync follows it),
// while a removal unlinks the symlink entry itself. So a write target is
// registered under both identities, the entry's own and the one it resolves
// to, and a removable path is looked up under its own entry only. A write
// target that is a symlink to a removable file is thereby refused; a dangling
// symlink resolves to nothing and keeps only its own identity.

type FileIdentityLookup = (absolutePath: string) => string | null;

function identityOf(stats: { dev: bigint; ino: bigint }): string | null {
  if (stats.ino === 0n) {
    return null;
  }
  return `${stats.dev}:${stats.ino}`;
}

// "<device>:<inode>" of the entry the path names (a symlink is not followed:
// the entry itself is what a removal unlinks), or null when the path does not
// exist, cannot be read, or the filesystem reports no usable inode.
function fileIdentity(absolutePath: string): string | null {
  try {
    return identityOf(lstatSync(absolutePath, { bigint: true }));
  } catch {
    return null;
  }
}

// The same, with a symlink followed to what it points at: where a write lands.
// Null for a dangling symlink as well as for a missing path.
function followedFileIdentity(absolutePath: string): string | null {
  try {
    return identityOf(statSync(absolutePath, { bigint: true }));
  } catch {
    return null;
  }
}

// The first (write, remove) pair that names one entry on this filesystem under
// different strings, or null. A pair of identical strings counts too (two
// syncPaths entries can cover one local file, which is then both written and
// removed). The lookups are injectable so the pairing logic can be tested
// without a case-insensitive filesystem or a symlink.
function findAliasedRestorePath(
  writePaths: string[],
  removePaths: string[],
  identify: FileIdentityLookup = fileIdentity,
  identifyFollowed: FileIdentityLookup = followedFileIdentity
): { writePath: string; removePath: string } | null {
  const writesByIdentity = new Map<string, string[]>();
  for (const writePath of writePaths) {
    for (const identity of new Set([identify(writePath), identifyFollowed(writePath)])) {
      if (identity !== null) {
        writesByIdentity.set(identity, [...(writesByIdentity.get(identity) || []), writePath]);
      }
    }
  }

  if (writesByIdentity.size === 0) {
    return null;
  }

  for (const removePath of removePaths) {
    const identity = identify(removePath);
    if (identity === null) {
      continue;
    }
    const writePath = (writesByIdentity.get(identity) || [])[0];
    if (writePath !== undefined) {
      return { writePath, removePath };
    }
  }

  return null;
}

module.exports = { fileIdentity, followedFileIdentity, findAliasedRestorePath };
