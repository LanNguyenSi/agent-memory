const { statSync } = require("node:fs");

// A path a destination restore is about to write and a path it is about to
// remove can be one file on disk even though the strings differ: on a
// case-insensitive filesystem (default APFS and NTFS) a case-only rename
// leaves local logs/Foo.md where the hub has logs/foo.md, and APFS also
// treats a precomposed and a decomposed spelling of the same name as one
// entry. The write lands in the existing file and the removal of the "extra"
// path then deletes what was just restored.

// The comparison key: equal keys with different strings are a candidate alias.
// Pure string work, so it is the same on every filesystem; the filesystem is
// only asked afterwards (see pathsShareFile) whether a candidate really is one
// file here.
function aliasKey(absolutePath: string): string {
  return absolutePath.normalize("NFC").toLowerCase();
}

// Every (write, remove) pair whose paths differ as strings but compare equal
// under aliasKey.
function findAliasCandidates(
  writePaths: string[],
  removePaths: string[]
): Array<{ writePath: string; removePath: string }> {
  const writesByKey = new Map<string, string[]>();
  for (const writePath of writePaths) {
    const key = aliasKey(writePath);
    writesByKey.set(key, [...(writesByKey.get(key) || []), writePath]);
  }

  const candidates: Array<{ writePath: string; removePath: string }> = [];
  for (const removePath of removePaths) {
    for (const writePath of writesByKey.get(aliasKey(removePath)) || []) {
      if (writePath !== removePath) {
        candidates.push({ writePath, removePath });
      }
    }
  }

  return candidates;
}

// True when both paths exist and are the same file (same device and inode).
// On a case-sensitive filesystem the two spellings are different files or one
// of them does not exist, so a candidate pair is not an alias there and the
// restore proceeds as before.
function pathsShareFile(first: string, second: string): boolean {
  try {
    const a = statSync(first);
    const b = statSync(second);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

// The first write/remove pair that is one file on this filesystem, or null.
// `sameFile` is injectable so the candidate logic can be tested without a
// case-insensitive filesystem.
function findAliasedRestorePath(
  writePaths: string[],
  removePaths: string[],
  sameFile: (first: string, second: string) => boolean = pathsShareFile
): { writePath: string; removePath: string } | null {
  for (const candidate of findAliasCandidates(writePaths, removePaths)) {
    if (sameFile(candidate.writePath, candidate.removePath)) {
      return candidate;
    }
  }

  return null;
}

module.exports = { aliasKey, findAliasCandidates, findAliasedRestorePath, pathsShareFile };
