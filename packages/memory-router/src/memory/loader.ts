const { readFileSync, readdirSync, statSync } = require('node:fs');
const { basename, extname, join } = require('node:path');
const { parse: parseYaml } = require('yaml');
const { debug: debugWarn } = require('../debug');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Canonical set of memory types; must stay in sync with the ambient
// `MemoryType` union in types.d.ts. lint/drift.ts imports this set for its
// own field-requirement checks (description required, name/type must be
// strings) on top of parseFrontmatterYaml below, so unknown-type files
// still get drift-lint signal (topics lint loads via this loader and skips
// them).
const VALID_TYPES: ReadonlySet<string> = new Set([
  'user',
  'feedback',
  'project',
  'reference',
]);

// FrontmatterYamlResult is declared globally in types.d.ts (ambient,
// alongside MemoryScanEntry): every consumer that needs to type this
// function's return shape (lint/drift.ts's require()d import, most
// notably, since a plain `require()` resolves to `any` and TypeScript
// never checks a hand-copied annotation against this file's real export)
// references that one name instead of carrying its own copy that can go
// stale without a compile error.
//
// The single frontmatter delimiter-match-plus-YAML-parse step, shared by
// every consumer that needs it: parseMemoryFileWithReason below delegates
// to this and layers its own field-requirement validation on top (read
// path, hot loop); lint/drift.ts's scanMemories consumes it directly for
// drift-specific field checks, including on shapes parseMemoryFileWithReason
// itself would reject (e.g. unknown type; drift still needs signal on those
// files); src/tag/applier.ts's planChange consumes it on the write path and
// layers its own (different) body normalization on top.
// `body` is the raw, unprocessed capture group 2 (whatever text follows the
// closing `---` line, before any trim/strip): each consumer normalizes it
// its own way (parseMemoryFileWithReason below `.trim()`s it,
// applier.ts's planChange strips only a single leading newline so mid-body
// blank lines and trailing whitespace survive the write-path round trip).
// `error` on the yaml-error branch carries the original caught exception
// (not just its stringified `.message`) so a consumer that must reproduce
// the pre-dedup thrown-error identity verbatim (applier.ts's planChange,
// whose YAML parse failures were previously an uncaught `parseYaml()`
// throw propagating to cli.ts's per-file try/catch) can rethrow it as-is;
// `detail` remains the string-only summary the original drift.ts consumer
// uses.
function parseFrontmatterYaml(source: string): FrontmatterYamlResult {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return { ok: false, kind: 'no-delimiter' };
  try {
    const raw = parseYaml(match[1]);
    return { ok: true, raw, body: match[2] };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'yaml-error', detail, error: err };
  }
}

type ParseResult =
  | {
      ok: true;
      memory: Memory;
      /**
       * Raw-frontmatter presence flags, captured before `type`/`topics`
       * resolution overwrites them on the returned `memory.frontmatter`.
       * Exported for consumers (consolidate/schema-metrics.ts) that report
       * on legacy (`metadata.`-nested) vs. canonical (top-level) shape;
       * loadMemoriesFromDir itself ignores these.
       */
      hasTopLevelType: boolean;
      hasMetadataType: boolean;
    }
  | { ok: false; reason: string };

function parseMemoryFileWithReason(path: string, source: string): ParseResult {
  const parsed = parseFrontmatterYaml(source);
  if (!parsed.ok) {
    return {
      ok: false,
      reason:
        parsed.kind === 'no-delimiter'
          ? 'no YAML frontmatter delimiter (`---`) found'
          : `YAML parse error: ${parsed.detail}`,
    };
  }

  const fm = parsed.raw as MemoryFrontmatter;
  const body = parsed.body.trim();

  if (!fm || typeof fm !== 'object') {
    return { ok: false, reason: 'frontmatter is not a YAML object' };
  }
  if (!fm.name) {
    return { ok: false, reason: "missing required field 'name'" };
  }

  // Read liberally, keep canonical: `type`/`topics` may live top-level
  // (canonical) or under `metadata.` (Claude Code auto-memory format).
  // Top-level wins on conflict (falsy top-level `type` falls back).
  // Resolution fills the canonical keys but does not validate the shape of
  // `topics`: a non-list value passes through so lint can still surface it
  // (the topic gate guards with Array.isArray). `type` however is validated
  // at this boundary so nothing outside the ambient MemoryType union flows
  // into typed fields. Trade-off: a typo'd type silently drops the whole
  // memory (debugWarn is off by default) until `lint --drift` surfaces it.
  const resolvedType = fm.type || fm.metadata?.type;
  if (!resolvedType) {
    return { ok: false, reason: "missing required field 'type'" };
  }
  if (typeof resolvedType !== 'string' || !VALID_TYPES.has(resolvedType)) {
    return {
      ok: false,
      reason: `unknown type ${JSON.stringify(resolvedType)} (expected: ${[...VALID_TYPES].join(', ')})`,
    };
  }
  const resolvedTopics = fm.topics ?? fm.metadata?.topics ?? [];

  const id = basename(path, extname(path));
  const frontmatter = { ...fm, type: resolvedType, topics: resolvedTopics };
  return {
    ok: true,
    memory: { id, path, frontmatter, body },
    hasTopLevelType: Boolean(fm.type),
    hasMetadataType: Boolean(fm.metadata?.type),
  };
}

function parseMemoryFile(path: string, source: string): Memory | null {
  const result = parseMemoryFileWithReason(path, source);
  return result.ok ? result.memory : null;
}

// The sibling loadMemoriesFromDirWithRejects below mirrors this walk; keep file selection in sync.
function loadMemoriesFromDir(dir: string): Memory[] {
  const memories: Memory[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    debugWarn(`could not read memory dir ${dir}: ${detail}`);
    return memories;
  }

  // readdir order is filesystem-dependent (ext4 dir_index returns hash
  // order), and on score ties the final hit order falls back to load order,
  // so hook injection and eval MRR must not inherit the filesystem's order.
  // Plain Array#sort (UTF-16 code-unit order) rather than localeCompare:
  // localeCompare depends on the host locale and would reintroduce
  // machine-dependent ordering.
  entries.sort();

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    if (entry === 'MEMORY.md') continue;

    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      debugWarn(`skipped ${path}: stat failed: ${detail}`);
      continue;
    }
    if (!stat.isFile()) continue;

    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      debugWarn(`skipped ${path}: read failed: ${detail}`);
      continue;
    }

    const result = parseMemoryFileWithReason(path, source);
    if (result.ok) {
      memories.push(result.memory);
    } else {
      debugWarn(`skipped ${path}: ${result.reason}`);
    }
  }

  return memories;
}

// Same directory walk as loadMemoriesFromDir (readdir, sort, *.md filter,
// MEMORY.md exclusion, stat, read, parse), but reports every file's outcome
// instead of silently dropping rejects: for consumers (consolidate/
// schema-metrics.ts) that need reject reasons and the raw-shape flags
// alongside the accepted set. loadMemoriesFromDir itself is untouched and
// keeps its own debugWarn-and-drop behavior; this is an additive sibling,
// not a replacement. Returns the ambient MemoryScanEntry[] (types.d.ts)
// rather than a type derived from this file's own ParseResult, so a
// producer/consumer field-name drift is a typecheck error at construction
// time here, not a silent structural pass at the consumer.
function loadMemoriesFromDirWithRejects(dir: string): MemoryScanEntry[] {
  const out: MemoryScanEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    debugWarn(`could not read memory dir ${dir}: ${detail}`);
    return out;
  }

  entries.sort();

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    if (entry === 'MEMORY.md') continue;

    const path = join(dir, entry);
    const id = basename(path, extname(path));

    let stat;
    try {
      stat = statSync(path);
    } catch (err) {
      const reason = `stat failed: ${String(err)}`;
      const detail = err instanceof Error ? err.message : String(err);
      debugWarn(`skipped ${path}: stat failed: ${detail}`);
      out.push({ path, id, ok: false, reason });
      continue;
    }
    if (!stat.isFile()) continue;

    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch (err) {
      const reason = `read failed: ${String(err)}`;
      const detail = err instanceof Error ? err.message : String(err);
      debugWarn(`skipped ${path}: read failed: ${detail}`);
      out.push({ path, id, ok: false, reason });
      continue;
    }

    const result = parseMemoryFileWithReason(path, source);
    if (result.ok) {
      out.push({ path, id, ...result });
    } else {
      debugWarn(`skipped ${path}: ${result.reason}`);
      out.push({ path, id, ok: false, reason: result.reason });
    }
  }

  return out;
}

module.exports = {
  loadMemoriesFromDir,
  loadMemoriesFromDirWithRejects,
  parseMemoryFile,
  parseMemoryFileWithReason,
  parseFrontmatterYaml,
  VALID_TYPES,
};
