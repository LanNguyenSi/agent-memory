const { readFileSync, readdirSync, statSync } = require('node:fs');
const { basename, extname, join } = require('node:path');
const { parse: parseYaml } = require('yaml');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseMemoryFile(path: string, source: string): Memory | null {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return null;

  const frontmatterRaw = match[1];
  const body = (match[2] ?? '').trim();

  let fm: MemoryFrontmatter;
  try {
    fm = parseYaml(frontmatterRaw) as MemoryFrontmatter;
  } catch {
    return null;
  }

  if (!fm || typeof fm !== 'object' || !fm.name || !fm.type) return null;

  const id = basename(path, extname(path));
  return { id, path, frontmatter: fm, body };
}

function loadMemoriesFromDir(dir: string): Memory[] {
  const memories: Memory[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return memories;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    if (entry === 'MEMORY.md') continue;

    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const source = readFileSync(path, 'utf8');
    const memory = parseMemoryFile(path, source);
    if (memory) memories.push(memory);
  }

  return memories;
}

module.exports = { loadMemoriesFromDir, parseMemoryFile };
