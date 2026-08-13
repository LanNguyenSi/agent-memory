// Core of `memory-router migrate`: a mechanical, idempotent frontmatter
// backfill to schema v1 (name, description, top-level type, topics:
// >=1 from the vocabulary, created). No LLM, no guessing: whatever isn't
// mechanically derivable stays untouched and is reported, never invented.
//
// Three fields, three independent rules, each additive-only (an existing
// value at the canonical location is NEVER overwritten):
//   - type:    hoist `metadata.type` to top-level `type`, only when no
//              (non-empty, valid) top-level `type` already exists.
//   - topics:  derive top-level `topics`, in order, from: (1) nothing —
//              a non-empty top-level `topics` already exists, kept as-is;
//              (2) `metadata.topics`, HOISTED verbatim (byte-identical
//              values, no dedupe/trim/reorder) when it's a non-empty array
//              of strings — analogous to the `type` hoist above, since the
//              loader (src/memory/loader.ts) already reads `metadata.topics`
//              liberally as a second topics source and ~230 real corpus
//              files carry curated topics only there; an invalid shape
//              (not an array, or an array with a non-string entry) is NOT
//              hoisted and falls through to the next source rather than
//              crashing; (3) the curated --mapping file; (4) a vocabulary
//              pattern match against name+description only (never the
//              body — see README "Topic vocabulary"). No match at any step
//              leaves the file untagged, reported under "untagged topics".
//   - created: stamp today's canonical date from the file's mtime, marked
//              `# approx (mtime)`, only when no `created` key exists yet.
//
// Bodies are never touched: the frontmatter block is parsed with `yaml`'s
// Document API (round-trips existing key order/formatting; new fields are
// appended, not reordered) and re-glued onto the untouched original body
// text. A file with nothing to change is never rewritten at all, which is
// what makes a second migrate run a true no-op rather than relying on
// round-trip fidelity for untouched files.
const { readdirSync, readFileSync, renameSync, statSync, writeFileSync } =
  require('node:fs');
const { basename, join } = require('node:path');
const { parseDocument, Scalar } = require('yaml');
const { VALID_TYPES } = require('../memory/loader');
const { loadVocabulary, matchedTopicsForVocabulary } = require('../vocab/loader');
const { matchMapping } = require('./mapping');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

type FieldAction = 'kept' | 'set' | 'missing';

interface FieldResult<T> {
  action: FieldAction;
  value?: T;
  source?: string;
}

interface FilePlan {
  id: string;
  path: string;
  skipped: boolean;
  reason?: string;
  changed: boolean;
  type: FieldResult<string>;
  topics: FieldResult<string[]>;
  created: FieldResult<string>;
}

// The writer never sees the yaml Document directly as a plain property (it
// would otherwise ride along into a naive JSON.stringify(plan) and risk
// serializing internal parser state); it's captured in the `render`
// closure instead, which JSON.stringify silently drops like any function
// value. formatMigrationReportJson (report.ts) only ever picks the
// FilePlan-shaped fields explicitly, as a second, independent guard.
interface WritableFilePlan extends FilePlan {
  render?: () => string;
}

interface MigrateContext {
  mappingRules: { id?: string; prefix?: string; topics: string[] }[];
  vocabulary: ReturnType<typeof loadVocabulary>;
}

// Only *.md, excluding MEMORY.md — same exclusion every other verb in this
// package applies (see src/memory/loader.ts, src/tag/applier.ts). Also
// skips topics.yml/golden.yml (non-.md, so the extension filter alone
// already excludes them; called out here because the acceptance criteria
// names them explicitly).
function listMigratableFiles(dir: string): string[] {
  const entries = readdirSync(dir) as string[];
  return entries
    .filter((name: string) => name.endsWith('.md') && name !== 'MEMORY.md')
    .filter((name: string) => statSync(join(dir, name)).isFile())
    .map((name: string) => join(dir, name));
}

function isoDateFromMtime(path: string): string {
  const stat = statSync(path);
  return new Date(stat.mtimeMs).toISOString().slice(0, 10);
}

// All read-only presence/value checks below work off `doc.toJS()`, a plain
// JS object, rather than `doc.get(...)` directly: for a scalar value `.get`
// happily auto-unwraps to a plain string, but for a collection (a `topics:`
// list) it returns the internal YAMLSeq node, not a plain array — `Array.
// isArray()` on that node is false, which would silently misclassify every
// already-canonical `topics:` list as absent. `doc` itself is still used
// (in planFile's `render` closure below) for the actual mutation and
// order/comment-preserving serialization; toJS() is read-only and never
// touches doc's own node tree.
interface PlainFrontmatter {
  type?: unknown;
  topics?: unknown;
  created?: unknown;
  metadata?: { type?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

function resolveType(fm: PlainFrontmatter): FieldResult<string> {
  const topLevel = fm.type;
  if (typeof topLevel === 'string' && topLevel.trim() !== '') {
    return { action: 'kept', value: topLevel };
  }
  const meta = fm.metadata?.type;
  if (
    typeof meta === 'string' &&
    meta.trim() !== '' &&
    (VALID_TYPES as Set<string>).has(meta.trim())
  ) {
    return { action: 'set', value: meta.trim(), source: 'metadata.type' };
  }
  return { action: 'missing' };
}

// A valid hoist candidate: a non-empty array where every entry is a string
// (empty strings included — the hoist copies values byte-identically and
// does not second-guess their content, same lenient contract the top-level
// `topics` "kept" check above already applies). Anything else (not an
// array at all, or an array containing a non-string entry) is an invalid
// shape: not hoisted, falls through to (3)/(4)/(5), never throws.
function isHoistableTopics(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((t) => typeof t === 'string')
  );
}

function resolveTopics(
  fm: PlainFrontmatter,
  id: string,
  name: string,
  description: string,
  ctx: MigrateContext,
): FieldResult<string[]> {
  const topLevel = fm.topics;
  if (Array.isArray(topLevel) && topLevel.length > 0) {
    return { action: 'kept', value: topLevel };
  }

  const metaTopics = fm.metadata?.topics;
  if (isHoistableTopics(metaTopics)) {
    return { action: 'set', value: metaTopics, source: 'metadata.topics' };
  }

  const mapped = matchMapping(id, ctx.mappingRules);
  if (mapped && mapped.length > 0) {
    return { action: 'set', value: mapped, source: 'mapping' };
  }

  const patternHits = matchedTopicsForVocabulary(
    `${name} ${description}`,
    ctx.vocabulary,
  );
  if (patternHits.length > 0) {
    return { action: 'set', value: patternHits, source: 'vocabulary-pattern' };
  }

  return { action: 'missing' };
}

function resolveCreated(fm: PlainFrontmatter, path: string): FieldResult<string> {
  const existing = fm.created;
  const hasCreated =
    existing !== undefined && existing !== null && String(existing).trim() !== '';
  if (hasCreated) {
    return { action: 'kept', value: String(existing) };
  }
  return { action: 'set', value: isoDateFromMtime(path), source: 'mtime (approx)' };
}

function planFile(path: string, ctx: MigrateContext): WritableFilePlan {
  const id = basename(path, '.md');
  const source = readFileSync(path, 'utf8') as string;
  const eol: '\n' | '\r\n' = /\r\n/.test(source) ? '\r\n' : '\n';
  const match = FRONTMATTER_RE.exec(source);

  const skippedPlan = (reason: string): WritableFilePlan => ({
    id,
    path,
    skipped: true,
    reason,
    changed: false,
    type: { action: 'missing' },
    topics: { action: 'missing' },
    created: { action: 'missing' },
  });

  if (!match) return skippedPlan('no YAML frontmatter delimiter (`---`) found');

  const frontmatterRaw = match[1];
  const body = (match[2] ?? '').replace(/^\r?\n/, '');

  const doc = parseDocument(frontmatterRaw);
  if (doc.errors.length > 0) {
    return skippedPlan(`YAML parse error: ${doc.errors[0].message}`);
  }

  // Plain-object view for all read-only resolution below; `doc` itself is
  // reserved for the `render` closure's mutation + serialization (see the
  // PlainFrontmatter comment above resolveType).
  const fm = doc.toJS() as PlainFrontmatter;

  const name = fm.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return skippedPlan("missing required field 'name'");
  }
  const description = typeof fm.description === 'string' ? fm.description : '';

  const type = resolveType(fm);
  const topics = resolveTopics(fm, id, name, description, ctx);
  const created = resolveCreated(fm, path);

  const changed = type.action === 'set' || topics.action === 'set' || created.action === 'set';

  const plan: WritableFilePlan = {
    id,
    path,
    skipped: false,
    changed,
    type,
    topics,
    created,
  };

  if (!changed) return plan;

  plan.render = () => {
    if (type.action === 'set') doc.set('type', type.value);
    if (topics.action === 'set') doc.set('topics', topics.value);
    if (created.action === 'set') {
      const node = doc.createNode(created.value);
      if (node instanceof Scalar) node.comment = ' approx (mtime)';
      doc.set('created', node);
    }
    const yamlText = (doc.toString() as string).trimEnd().replace(/\n/g, eol);
    return `---${eol}${yamlText}${eol}---${eol}${eol}${body}`;
  };

  return plan;
}

interface MigrationPlan {
  dir: string;
  mappingPath: string | null;
  files: WritableFilePlan[];
}

function planMigration(
  dir: string,
  opts: { mappingRules?: { id?: string; prefix?: string; topics: string[] }[]; mappingPath?: string | null } = {},
): MigrationPlan {
  const ctx: MigrateContext = {
    mappingRules: opts.mappingRules ?? [],
    vocabulary: loadVocabulary(dir),
  };
  const files = listMigratableFiles(dir).map((f) => planFile(f, ctx));
  return { dir, mappingPath: opts.mappingPath ?? null, files };
}

interface ApplyResult {
  applied: number;
  unchanged: number;
  skipped: number;
  errored: string[];
}

function applyMigration(plan: MigrationPlan): ApplyResult {
  let applied = 0;
  let unchanged = 0;
  let skipped = 0;
  const errored: string[] = [];

  for (const file of plan.files) {
    if (file.skipped) {
      skipped++;
      continue;
    }
    if (!file.changed || !file.render) {
      unchanged++;
      continue;
    }
    try {
      const contents = file.render();
      // Atomic write: temp file + rename, same pattern as tag/applier.ts.
      const tmp = `${file.path}.memrouter.${process.pid}.tmp`;
      writeFileSync(tmp, contents);
      renameSync(tmp, file.path);
      applied++;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errored.push(`${file.path}: ${detail}`);
    }
  }

  return { applied, unchanged, skipped, errored };
}

module.exports = {
  listMigratableFiles,
  planFile,
  planMigration,
  applyMigration,
};
