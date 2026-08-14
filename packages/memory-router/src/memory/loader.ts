const { readFileSync, readdirSync, statSync } = require('node:fs');
const { basename, extname, join } = require('node:path');
const { parse: parseYaml } = require('yaml');
const { debug: debugWarn } = require('../debug');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Canonical set of memory types; must stay in sync with the ambient
// `MemoryType` union in types.d.ts. lint/drift.ts imports this set for its
// own raw-parse check, so unknown-type files skipped here still get
// drift-lint signal (topics lint loads via this loader and skips them).
const VALID_TYPES: ReadonlySet<string> = new Set([
  'user',
  'feedback',
  'project',
  'reference',
]);

type ParseResult = { ok: true; memory: Memory } | { ok: false; reason: string };

function parseMemoryFileWithReason(path: string, source: string): ParseResult {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) {
    return { ok: false, reason: 'no YAML frontmatter delimiter (`---`) found' };
  }

  const frontmatterRaw = match[1];
  const body = (match[2] ?? '').trim();

  let fm: MemoryFrontmatter;
  try {
    fm = parseYaml(frontmatterRaw) as MemoryFrontmatter;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `YAML parse error: ${detail}` };
  }

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
  return { ok: true, memory: { id, path, frontmatter, body } };
}

function parseMemoryFile(path: string, source: string): Memory | null {
  const result = parseMemoryFileWithReason(path, source);
  return result.ok ? result.memory : null;
}

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

module.exports = { loadMemoriesFromDir, parseMemoryFile, VALID_TYPES };
