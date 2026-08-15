// Schema-metrics collection for `memory-router consolidate`: untagged
// count, "legacy format" (metadata.type without a top-level type) count/
// rate, and loader-reject reasons.
//
// src/memory/loader.ts's loadMemoriesFromDir() silently drops any file it
// can't parse/validate (a debugWarn call only, off by default, see
// loader.ts) and, for files it DOES accept, overwrites the raw frontmatter's
// `type`/`topics` with their already-resolved values before returning the
// Memory. That means by the time a Memory reaches this package's other
// consumers, two things loader.ts itself still knows are gone:
//   1. WHY a rejected file was rejected.
//   2. WHETHER an accepted file's `type`/`topics` came from the top level or
//      the legacy `metadata.` nesting (both look identical post-resolution).
// loader.ts is out of scope for this task (forbidden_changes), so this file
// duplicates its per-file frontmatter regex + parse + validation logic
// (parseMemoryFileWithReason) read-only, rather than modifying loader.ts to
// export what it already computes internally and throws away. VALID_TYPES
// itself is IMPORTED (not copied) from loader.ts's public export so the
// type whitelist can't drift between the two independently of this file.
// Keep this logic in sync with loader.ts's parseMemoryFileWithReason if that
// ever changes.
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
// shape, instead of being silently folded into "no topics".

const { readFileSync, readdirSync, statSync } = require('node:fs');
const { basename, extname, join } = require('node:path');
const { parse: parseYaml } = require('yaml');
const { VALID_TYPES } = require('../memory/loader');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

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

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

// Read-only directory walk mirroring loadMemoriesFromDir's own file
// selection (*.md, MEMORY.md excluded, regular files only) and per-file
// parse/validation (parseMemoryFileWithReason), but returning the reject
// REASON and the raw frontmatter shape instead of a resolved Memory | null.
function scanRawFrontmatter(dir: string): RawScanEntry[] {
  const out: RawScanEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Same fail-quiet-to-empty contract as loader.ts; the CLI's own
    // statSync(dir) preflight (shared --dir resolution with migrate/eval)
    // is what actually surfaces an unreadable dir to the operator before
    // runConsolidate is ever called.
    return out;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    if (entry === 'MEMORY.md') continue;

    const path = join(dir, entry);
    const id = basename(path, extname(path));

    let stat;
    try {
      stat = statSync(path);
    } catch (err: unknown) {
      out.push({ path, id, ok: false, reason: `stat failed: ${String(err)}` });
      continue;
    }
    if (!stat.isFile()) continue;

    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch (err: unknown) {
      out.push({ path, id, ok: false, reason: `read failed: ${String(err)}` });
      continue;
    }

    const match = FRONTMATTER_RE.exec(source);
    if (!match) {
      out.push({
        path,
        id,
        ok: false,
        reason: 'no YAML frontmatter delimiter (`---`) found',
      });
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fm: any;
    try {
      fm = parseYaml(match[1]);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      out.push({ path, id, ok: false, reason: `YAML parse error: ${detail}` });
      continue;
    }

    if (!fm || typeof fm !== 'object') {
      out.push({ path, id, ok: false, reason: 'frontmatter is not a YAML object' });
      continue;
    }
    if (!fm.name) {
      out.push({ path, id, ok: false, reason: "missing required field 'name'" });
      continue;
    }

    const resolvedType = fm.type || fm.metadata?.type;
    if (!resolvedType) {
      out.push({ path, id, ok: false, reason: "missing required field 'type'" });
      continue;
    }
    if (typeof resolvedType !== 'string' || !VALID_TYPES.has(resolvedType)) {
      out.push({
        path,
        id,
        ok: false,
        reason: `unknown type ${JSON.stringify(resolvedType)} (expected: ${[...VALID_TYPES].join(', ')})`,
      });
      continue;
    }

    // Mirrors loader.ts's `fm.topics ?? fm.metadata?.topics ?? []` exactly:
    // a NULLISH top-level topics (absent, or an explicit YAML `topics:`
    // with no value) falls through to metadata.topics; anything else at
    // the top level (including an explicit `[]`, or a non-array value)
    // wins outright. See the file-level comment for why this differs from
    // the independent hasTopLevelTopics/hasMetadataTopics booleans above.
    const hasOwnTopLevelTopics = fm.topics !== undefined && fm.topics !== null;
    const resolvedTopics = hasOwnTopLevelTopics ? fm.topics : (fm.metadata?.topics ?? []);
    const topicsShape: 'tagged' | 'untagged' | 'invalid-shape' = !Array.isArray(resolvedTopics)
      ? 'invalid-shape'
      : resolvedTopics.length > 0
        ? 'tagged'
        : 'untagged';

    out.push({
      path,
      id,
      ok: true,
      hasTopLevelType: Boolean(fm.type),
      hasMetadataType: Boolean(fm.metadata?.type),
      hasTopLevelTopics: hasNonEmptyArray(fm.topics),
      hasMetadataTopics: hasNonEmptyArray(fm.metadata?.topics),
      topicsShape,
    });
  }
  return out;
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
