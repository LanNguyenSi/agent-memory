const { readFileSync, readdirSync, statSync } = require('node:fs');
const { basename, extname, join } = require('node:path');
const { parse: parseYaml } = require('yaml');
const { debug: debugWarn } = require('../debug');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

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
  if (!fm.type) {
    return { ok: false, reason: "missing required field 'type'" };
  }

  const id = basename(path, extname(path));
  return { ok: true, memory: { id, path, frontmatter: fm, body } };
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

module.exports = { loadMemoriesFromDir, parseMemoryFile };
