// Exact-duplicate detection for `memory-router consolidate`: groups memories
// whose BODY (frontmatter is not part of the comparison: two memories can
// carry different `name`/`topics`/`severity` while saying the exact same
// thing) collapses to the same normalized text.
//
// Normalization (documented here and in README.md, keep both in sync):
//   1. trim leading/trailing whitespace
//   2. collapse every whitespace run (spaces, tabs, newlines) to a single
//      space
//   3. case-fold to lowercase
// The normalized string is then sha256-hashed; memories sharing a hash form
// a group. This is intentionally crude (no punctuation stripping, no
// stemming): the goal is to catch true byte-for-byte-modulo-whitespace
// copies, not paraphrases (that's what the near-dupe cosine pass is for).

const { createHash } = require('node:crypto');

const NORMALIZATION_DESCRIPTION =
  'trim, collapse whitespace runs (spaces/tabs/newlines) to a single space, lowercase, then sha256 the result';

function normalizeBody(body: string): string {
  return body.trim().replace(/\s+/g, ' ').toLowerCase();
}

function hashBody(body: string): string {
  return createHash('sha256').update(normalizeBody(body)).digest('hex');
}

interface ExactDupeGroup {
  hash: string;
  ids: string[];
  paths: string[];
}

// Groups only ever contain memories that were successfully loaded (see
// src/memory/loader.ts's loadMemoriesFromDir); a file the loader rejects
// has no usable body to hash and is instead reported under
// schema.loaderRejects.
function findExactDupes(memories: Memory[]): ExactDupeGroup[] {
  const byHash = new Map<string, Memory[]>();
  for (const memory of memories) {
    const hash = hashBody(memory.body);
    const group = byHash.get(hash);
    if (group) group.push(memory);
    else byHash.set(hash, [memory]);
  }

  const groups: ExactDupeGroup[] = [];
  for (const [hash, group] of byHash) {
    if (group.length < 2) continue;
    // Deterministic member order within a group: by id, not insertion/dir
    // order (which is filesystem-dependent).
    const sorted = group.slice().sort((a, b) => a.id.localeCompare(b.id));
    groups.push({
      hash,
      ids: sorted.map((m) => m.id),
      paths: sorted.map((m) => m.path),
    });
  }
  // Deterministic group order: by first (already-sorted) member id.
  groups.sort((a, b) => a.ids[0].localeCompare(b.ids[0]));
  return groups;
}

module.exports = {
  findExactDupes,
  normalizeBody,
  hashBody,
  NORMALIZATION_DESCRIPTION,
};
