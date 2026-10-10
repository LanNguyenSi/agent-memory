const { lstatSync } = require("node:fs");

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

type FileIdentityLookup = (absolutePath: string) => string | null;

// "<device>:<inode>" of the entry the path names (a symlink is not followed:
// the entry itself is what a write replaces and a removal unlinks), or null
// when the path does not exist, cannot be read, or the filesystem reports no
// usable inode.
function fileIdentity(absolutePath: string): string | null {
  try {
    const stats = lstatSync(absolutePath, { bigint: true });
    if (stats.ino === 0n) {
      return null;
    }
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return null;
  }
}

// The first (write, remove) pair that names one entry on this filesystem under
// different strings, or null. `identify` is injectable so the pairing logic
// can be tested without a case-insensitive filesystem.
function findAliasedRestorePath(
  writePaths: string[],
  removePaths: string[],
  identify: FileIdentityLookup = fileIdentity
): { writePath: string; removePath: string } | null {
  const writesByIdentity = new Map<string, string[]>();
  for (const writePath of writePaths) {
    const identity = identify(writePath);
    if (identity !== null) {
      writesByIdentity.set(identity, [...(writesByIdentity.get(identity) || []), writePath]);
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
    const writePath = (writesByIdentity.get(identity) || []).find((candidate) => candidate !== removePath);
    if (writePath !== undefined) {
      return { writePath, removePath };
    }
  }

  return null;
}

module.exports = { fileIdentity, findAliasedRestorePath };
