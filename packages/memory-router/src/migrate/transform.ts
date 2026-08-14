// Core of `memory-router migrate`: a mechanical, idempotent frontmatter
// backfill to schema v1 (name, description, top-level type, topics:
// >=1 from the vocabulary, created). No LLM, no guessing: whatever isn't
// mechanically derivable stays untouched and is reported, never invented.
//
// Three fields, three independent rules, each additive-only (an existing
// value at the canonical location is NEVER overwritten):
//   - type:    hoist `metadata.type` to top-level `type`, only when no
//              (non-empty, valid) top-level `type` already exists.
//   - topics:  derive top-level `topics`, in order, from: (1) nothing:
//              a non-empty top-level `topics` already exists, kept as-is
//              regardless of shape (an invalid shape, anything other than
//              a non-empty array of strings, is still kept and never
//              overwritten, but flagged in the report as "invalid shape,
//              needs manual review"); (2) `metadata.topics`, HOISTED
//              verbatim (byte-identical values, no dedupe/trim/reorder)
//              when it's a non-empty array of strings, analogous to the
//              `type` hoist above, since the loader (src/memory/loader.ts)
//              already reads `metadata.topics` liberally as a second
//              topics source and a small number of real corpus files (4
//              at the time of writing) carry curated topics only there;
//              an invalid shape (not an array, or an array with a
//              non-string entry) is NOT hoisted and falls through to the
//              next source rather than crashing; (3) the curated --mapping
//              file; (4) a vocabulary pattern match against name+
//              description only (never the body, see README "Topic
//              vocabulary"). No match at any step leaves the file
//              untagged, reported under "untagged topics".
//   - created: stamp today's canonical date from the file's mtime, marked
//              `# approx (mtime)`, only when no `created` key exists yet.
//
// Bodies are never touched: the frontmatter block is parsed with `yaml`'s
// Document API and serialized with `lineWidth: 0` (disables the library's
// default 80-column reflow, which used to silently re-wrap the majority of
// real corpus frontmatter blocks on every write) before being re-glued
// onto the untouched original body text via the original separator,
// captured verbatim from the source and re-emitted as-is rather than a
// hardcoded blank line. This preserves key order and comments and only
// appends new fields, not reordered; it is NOT a byte-for-byte "preserves
// formatting" guarantee, though: `yaml` still normalizes trailing
// whitespace after a key, and a folded/literal block scalar's internal
// line breaks are re-flowed by the library independently of lineWidth
// (that's inherent to the folded-scalar format, not something migrate
// controls). A file with nothing to change is never rewritten at all,
// which is what makes a second migrate run a true no-op rather than
// relying on round-trip fidelity for untouched files.
const { readdirSync, readFileSync, renameSync, statSync, writeFileSync } =
  require('node:fs');
const { basename, join } = require('node:path');
const { parseDocument, Scalar } = require('yaml');
const { VALID_TYPES } = require('../memory/loader');
const { loadVocabularyResult, matchedTopicsForVocabulary } = require('../vocab/loader');
const { matchMapping } = require('./mapping');

// Captures the newline immediately after the closing `---` (group 2,
// absent only when the file ends right at the delimiter) separately from
// everything after it (group 3), so planFile can recover the EXACT
// separator between frontmatter and body (zero, one, or more blank lines,
// in the file's own line-ending style) instead of assuming a fixed shape.
// See the separator/body split in planFile below.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?([\s\S]*)$/;

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
  vocabulary: ReturnType<typeof loadVocabularyResult>['vocabulary'];
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

// A top-level `topics` counts as "present" the moment it's anything but
// genuinely empty: undefined/null (key absent or blank), an empty string,
// or an empty array. Anything else — even an invalid shape, like a scalar
// string or a plain object — is a real value the author or an upstream
// tool already wrote, so it is always kept, never guessed over. This
// mirrors resolveType's leniency for `type` above: migrate is
// additive-only and never overwrites an existing value, valid or not.
function isPresentTopLevelValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function resolveTopics(
  fm: PlainFrontmatter,
  id: string,
  name: string,
  description: string,
  ctx: MigrateContext,
): FieldResult<string[]> {
  const topLevel = fm.topics;
  if (isPresentTopLevelValue(topLevel)) {
    if (Array.isArray(topLevel)) {
      return { action: 'kept', value: topLevel };
    }
    // Present but not a non-empty array of strings: kept as-is (never
    // overwritten) but flagged so the report surfaces it for manual
    // review instead of silently passing it off as a normal canonical
    // `topics:` list. See src/migrate/report.ts's describeField/
    // buildSummary for how `source: 'invalid-shape'` renders.
    return {
      action: 'kept',
      value: topLevel as unknown as string[],
      source: 'invalid-shape',
    };
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

// Standalone so planMigration's per-file try/catch (below) can also build a
// skipped entry for a truly unexpected throw, not just the known failure
// modes planFile already handles internally via its own `skippedPlan`
// closure (which just delegates here).
function makeSkippedPlan(path: string, reason: string): WritableFilePlan {
  return {
    id: basename(path, '.md'),
    path,
    skipped: true,
    reason,
    changed: false,
    type: { action: 'missing' },
    topics: { action: 'missing' },
    created: { action: 'missing' },
  };
}

function planFile(path: string, ctx: MigrateContext): WritableFilePlan {
  const id = basename(path, '.md');
  const source = readFileSync(path, 'utf8') as string;
  const eol: '\n' | '\r\n' = /\r\n/.test(source) ? '\r\n' : '\n';
  const match = FRONTMATTER_RE.exec(source);

  const skippedPlan = (reason: string): WritableFilePlan => makeSkippedPlan(path, reason);

  if (!match) return skippedPlan('no YAML frontmatter delimiter (`---`) found');

  const frontmatterRaw = match[1];
  // The separator between the closing `---` and the body: match[2] is the
  // newline that terminates the delimiter line itself (absent only when
  // the file ends right at the delimiter); match[3] is everything after
  // that, which may start with further blank-line newlines before the
  // real body content. Captured verbatim (not reconstructed from `eol`)
  // so a file with no blank line after frontmatter round-trips with no
  // blank line, and a file with one keeps exactly one — see render()
  // below, which used to hardcode a forced blank line here.
  const closingNewline = match[2] ?? '';
  const afterClosing = match[3] ?? '';
  const separatorExtra = (afterClosing.match(/^(?:\r\n|\n)*/) ?? [''])[0];
  const separator = closingNewline + separatorExtra;
  const body = afterClosing.slice(separatorExtra.length);

  const doc = parseDocument(frontmatterRaw);
  if (doc.errors.length > 0) {
    return skippedPlan(`YAML parse error: ${doc.errors[0].message}`);
  }

  // Plain-object view for all read-only resolution below; `doc` itself is
  // reserved for the `render` closure's mutation + serialization (see the
  // PlainFrontmatter comment above resolveType). An empty or non-mapping
  // frontmatter block (e.g. `---\n\n---`, or a bare YAML list/scalar
  // between the delimiters) parses without a YAML error but `toJS()`s to
  // `null`/a non-object/an array; guarded the same way src/memory/
  // loader.ts guards its own `parseYaml` result, rather than letting the
  // `fm.name` access below throw on a null/array `fm`.
  const fm = doc.toJS() as PlainFrontmatter;
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
    return skippedPlan('frontmatter is not a YAML object');
  }

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
    // lineWidth: 0 disables yaml's default 80-column reflow: without it,
    // any existing scalar (most commonly `description:`) longer than 80
    // columns gets silently re-wrapped across two lines on every write,
    // even though nothing about that field changed. See the module header
    // comment above for what lineWidth: 0 does NOT guarantee (trailing
    // whitespace is still normalized; a folded/literal block scalar's
    // internal wrapping is controlled by the format itself, not by this
    // option).
    const yamlText = (doc.toString({ lineWidth: 0 }) as string).trimEnd().replace(/\n/g, eol);
    return `---${eol}${yamlText}${eol}---${separator}${body}`;
  };

  return plan;
}

interface MigrationPlan {
  dir: string;
  mappingPath: string | null;
  // Which topic vocabulary this run resolved against, and why, disclosed
  // up front rather than only surfacing on failure — see
  // src/migrate/report.ts's "vocabulary:" header line and --json fields.
  vocabularySource: 'default' | 'custom';
  vocabularyError: string | null;
  files: WritableFilePlan[];
}

function planMigration(
  dir: string,
  opts: {
    mappingRules?: { id?: string; prefix?: string; topics: string[] }[];
    mappingPath?: string | null;
    // Lets a caller (cli.ts) load the vocabulary once, gate --apply on a
    // broken topics.yml BEFORE any write is attempted, and hand the same
    // already-loaded result in here instead of loading topics.yml twice.
    // Defaults to loading it from `dir` itself, same as before.
    vocabularyResult?: ReturnType<typeof loadVocabularyResult>;
  } = {},
): MigrationPlan {
  const vocabularyResult = opts.vocabularyResult ?? loadVocabularyResult(dir);
  const ctx: MigrateContext = {
    mappingRules: opts.mappingRules ?? [],
    vocabulary: vocabularyResult.vocabulary,
  };
  // A single unreadable/malformed file must never abort the whole run: an
  // unforeseen throw inside planFile (beyond the known failure modes it
  // already turns into a skippedPlan itself, e.g. a file that becomes
  // unreadable between listing and reading) is caught here and turned into
  // a skipped entry named after the file, same "never abort on one bad
  // file" contract src/cli.ts's non-migrate verbs already apply.
  const files = listMigratableFiles(dir).map((f) => {
    try {
      return planFile(f, ctx);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return makeSkippedPlan(f, `unexpected error: ${detail}`);
    }
  });
  return {
    dir,
    mappingPath: opts.mappingPath ?? null,
    vocabularySource: vocabularyResult.vocabulary.source,
    vocabularyError: vocabularyResult.error,
    files,
  };
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
