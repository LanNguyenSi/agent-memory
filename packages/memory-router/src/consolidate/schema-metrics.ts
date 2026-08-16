// Schema-metrics collection for `memory-router consolidate`: untagged
// count, "legacy format" (metadata.type without a top-level type) count/
// rate, and loader-reject reasons.
//
// src/memory/loader.ts's loadMemoriesFromDir() silently drops any file it
// can't parse/validate (a debugWarn call only, off by default) and, for
// files it DOES accept, overwrites the raw frontmatter's `type`/`topics`
// with their already-resolved values before returning the Memory. That
// means by the time a Memory reaches this package's other consumers, two
// things loader.ts itself still knows are gone:
//   1. WHY a rejected file was rejected.
//   2. WHETHER an accepted file's `type`/`topics` came from the top level or
//      the legacy `metadata.` nesting (both look identical post-resolution).
// loader.ts's loadMemoriesFromDirWithRejects() is the sibling walk that
// keeps both: it reuses the exact same per-file parse/validation
// (parseMemoryFileWithReason) the hot-path loader uses, so this file no
// longer duplicates that regex/parse/validate logic; it only derives its
// own topics-shape bucketing (below) from the walk's output.
//
// topics classification (mm-v1-T007 fix round LOW #6): mirrors loader.ts's
// own resolution precedence EXACTLY (`fm.topics ?? fm.metadata?.topics ??
// []`) rather than checking "is there a non-empty array at either
// location" independently of each other. A top-level `topics:` key wins
// whenever it is present and non-null, REGARDLESS of its shape or
// emptiness: an explicit `topics: []` shadows a non-empty
// `metadata.topics` exactly the way it shadows it in the loader (both end
// up UNTAGGED), and only an actually-nullish top-level `topics:` (absent,
// or an explicit YAML null) falls through to `metadata.topics`. A resolved
// value that isn't a list at all (a scalar, string, or map) is neither
// "tagged" nor "untagged": it's reported under its own `invalid-shape`
// bucket, the same way `src/migrate/transform.ts` treats the identical
// shape, instead of being silently folded into "no topics". The walk's
// `memory.frontmatter.topics` already IS that same resolved value (loader.ts
// computes it with the identical `??` precedence), so this classification
// reads it straight off the accepted Memory instead of re-deriving it.

const { loadMemoriesFromDirWithRejects } = require('../memory/loader');

interface RawScanEntry {
  path: string;
  id: string;
  ok: boolean;
  /** Only set when ok === false. */
  reason?: string;
  /** Only set when ok === true. */
  hasTopLevelType?: boolean;
  hasMetadataType?: boolean;
  /** Non-empty-array presence checks, independent of precedence. Kept for
   * their existing, narrower meaning; `topicsShape` below is what
   * buildSchemaMetrics actually buckets on. */
  hasTopLevelTopics?: boolean;
  hasMetadataTopics?: boolean;
  /**
   * loader.ts-mirrored topics classification (see the file-level comment):
   *   'tagged'        the resolved value is a non-empty array
   *   'untagged'      the resolved value is an array of length 0
   *   'invalid-shape' the resolved value is present but not an array
   * Only set when ok === true.
   */
  topicsShape?: 'tagged' | 'untagged' | 'invalid-shape';
}

// Read-only directory walk built on loader.ts's own loadMemoriesFromDirWithRejects
// (same file selection, same per-file parse/validation), reshaped into the
// reject-reason-plus-topics-shape view this module's consumers expect.
function scanRawFrontmatter(dir: string): RawScanEntry[] {
  return loadMemoriesFromDirWithRejects(dir).map(
    (entry: {
      path: string;
      id: string;
      ok: boolean;
      reason?: string;
      memory?: Memory;
      hasTopLevelType?: boolean;
      hasMetadataType?: boolean;
      hasTopLevelTopics?: boolean;
      hasMetadataTopics?: boolean;
    }): RawScanEntry => {
      if (!entry.ok) {
        return { path: entry.path, id: entry.id, ok: false, reason: entry.reason };
      }
      const resolvedTopics = entry.memory!.frontmatter.topics;
      const topicsShape: 'tagged' | 'untagged' | 'invalid-shape' = !Array.isArray(resolvedTopics)
        ? 'invalid-shape'
        : resolvedTopics.length > 0
          ? 'tagged'
          : 'untagged';
      return {
        path: entry.path,
        id: entry.id,
        ok: true,
        hasTopLevelType: entry.hasTopLevelType,
        hasMetadataType: entry.hasMetadataType,
        hasTopLevelTopics: entry.hasTopLevelTopics,
        hasMetadataTopics: entry.hasMetadataTopics,
        topicsShape,
      };
    },
  );
}

interface SchemaMetrics {
  scannedCount: number;
  untaggedCount: number;
  untaggedIds: string[];
  legacyFormatCount: number;
  // 0 when scannedCount is 0 (nothing to divide by, not NaN/Infinity).
  legacyFormatRate: number;
  legacyFormatIds: string[];
  /**
   * Files whose resolved topics value (top-level `topics` when present and
   * non-null, else `metadata.topics`, exactly mirroring loader.ts) is
   * present but not a list at all (a scalar, string, or map). Distinct
   * from `untagged`: an invalid shape isn't "no topics", it's "topics
   * that can't be used as topics", the same distinction `migrate` already
   * makes.
   */
  invalidTopicsShapeCount: number;
  invalidTopicsShapeIds: string[];
  loaderRejects: { path: string; reason: string }[];
}

// Code-unit (UTF-16) order via `<`/`>`, not localeCompare: localeCompare
// depends on the host locale and would make report order machine-dependent
// (same rationale as the readdir-walk sorts in loader/drift/transform/applier).
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function buildSchemaMetrics(dir: string): SchemaMetrics {
  const rawEntries = scanRawFrontmatter(dir);
  const ok = rawEntries.filter((e) => e.ok);
  const loaderRejects = rawEntries
    .filter((e) => !e.ok)
    .map((e) => ({ path: e.path, reason: e.reason as string }))
    .sort(byPath);

  // "untagged": the loader-mirrored resolved topics value is an empty
  // array (see scanRawFrontmatter's topicsShape comment for the exact
  // precedence this mirrors).
  const untagged = ok
    .filter((e) => e.topicsShape === 'untagged')
    .sort(byId);
  // "legacy format": metadata.type carries the type, but top-level `type`
  // does not: the pre-schema-v1 Claude Code auto-memory shape (see
  // src/migrate/transform.ts's `type` hoist, which fixes exactly this).
  const legacyFormat = ok
    .filter((e) => !e.hasTopLevelType && e.hasMetadataType)
    .sort(byId);
  // "invalid topics shape": the resolved topics value exists but isn't a
  // list at all.
  const invalidTopicsShape = ok
    .filter((e) => e.topicsShape === 'invalid-shape')
    .sort(byId);

  return {
    scannedCount: ok.length,
    untaggedCount: untagged.length,
    untaggedIds: untagged.map((e) => e.id),
    legacyFormatCount: legacyFormat.length,
    legacyFormatRate: ok.length > 0 ? legacyFormat.length / ok.length : 0,
    legacyFormatIds: legacyFormat.map((e) => e.id),
    invalidTopicsShapeCount: invalidTopicsShape.length,
    invalidTopicsShapeIds: invalidTopicsShape.map((e) => e.id),
    loaderRejects,
  };
}

module.exports = { scanRawFrontmatter, buildSchemaMetrics };
