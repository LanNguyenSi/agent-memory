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
//
// Empty/whitespace-only bodies (mm-v1-T007 fix round LOW #9) are excluded
// from grouping entirely: two memories that both happen to have no body
// text share nothing meaningful, and would otherwise collapse into a
// false-positive "dupe group" whose only common trait is being empty.
// They're reported separately via findEmptyBodies() instead, so an empty
// body still surfaces as an actionable finding rather than silently
// vanishing from both the dupe report AND the schema-metrics pass.

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

interface EmptyBodyEntry {
  id: string;
  path: string;
}

// Code-unit (UTF-16) order via `<`/`>`, not localeCompare: localeCompare
// depends on the host locale and would make report order machine-dependent
// (same rationale as schema-metrics.ts's byId/byPath and the readdir-walk
// sorts in loader/drift/transform/applier).
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Groups only ever contain memories that were successfully loaded (see
// src/memory/loader.ts's loadMemoriesFromDir); a file the loader rejects
// has no usable body to hash and is instead reported under
// schema.loaderRejects. Memories with an empty/whitespace-only body are
// also excluded here (see the file-level comment above); findEmptyBodies
// reports them separately.
function findExactDupes(memories: Memory[]): ExactDupeGroup[] {
  const byHash = new Map<string, Memory[]>();
  for (const memory of memories) {
    if (normalizeBody(memory.body).length === 0) continue;
    const hash = hashBody(memory.body);
    const group = byHash.get(hash);
    if (group) group.push(memory);
    else byHash.set(hash, [memory]);
  }

  const groups: ExactDupeGroup[] = [];
  for (const [hash, group] of byHash) {
    if (group.length < 2) continue;
    // Deterministic member order within a group: by id (code-unit), not
    // insertion/dir order (which is filesystem-dependent).
    const sorted = group.slice().sort(byId);
    groups.push({
      hash,
      ids: sorted.map((m) => m.id),
      paths: sorted.map((m) => m.path),
    });
  }
  // Deterministic group order: by first (already-sorted) member id
  // (code-unit).
  groups.sort((a, b) => (a.ids[0] < b.ids[0] ? -1 : a.ids[0] > b.ids[0] ? 1 : 0));
  return groups;
}

// Memories whose body normalizes to nothing at all: no content to compare,
// so they're carved out of findExactDupes (see the file-level comment)
// rather than silently forming a meaningless dupe group with each other.
function findEmptyBodies(memories: Memory[]): EmptyBodyEntry[] {
  return memories
    .filter((m) => normalizeBody(m.body).length === 0)
    .map((m) => ({ id: m.id, path: m.path }))
    .sort(byId);
}

module.exports = {
  findExactDupes,
  findEmptyBodies,
  normalizeBody,
  hashBody,
  NORMALIZATION_DESCRIPTION,
};
