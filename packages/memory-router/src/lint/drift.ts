// MEMORY.md drift linter.
//
// MEMORY.md is the canonical index Claude-Code loads at session start. It
// drifts: pointers to deleted files linger, new memory files never get an
// entry, duplicates sneak in, the file grows past the ~200-line truncation
// cap. This linter walks the directory and reports each drift condition
// with a dedicated hit kind so CI can gate on them.
//
// Separate module from lint/topics.ts because the concerns are orthogonal:
// topics.ts validates the runtime topic gate, drift.ts validates the index
// file's consistency with the on-disk corpus.
const {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  existsSync,
} = require('node:fs');
const { basename, extname, join } = require('node:path');
const { parse: parseYaml } = require('yaml');

const LINE_CAP = 200;
const DESCRIPTION_CAP = 150;
const MEMORY_MD = 'MEMORY.md';
const VALID_TYPES: ReadonlySet<string> = new Set([
  'user',
  'feedback',
  'project',
  'reference',
]);
const REQUIRED_FIELDS: readonly string[] = ['name', 'description', 'type'];

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
// Match markdown link whose target ends in .md. Restrictive on the URL side
// (no whitespace, no nested parens) so we do not misparse prose that
// happens to contain parentheses.
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+?\.md)\)/g;

export type DriftKind =
  | 'orphan_pointer'
  | 'missing_pointer'
  | 'duplicate_entry'
  | 'duplicate_name'
  | 'length_warning'
  | 'invalid_frontmatter'
  | 'description_too_long';

export interface DriftHit {
  kind: DriftKind;
  path: string;
  memoryId?: string;
  detail: string;
  fixable: boolean;
}

export interface DriftReport {
  hits: DriftHit[];
  scannedCount: number;
  memoryMdLineCount: number;
  memoryMdExists: boolean;
}

export interface DriftFixResult {
  applied: DriftHit[];
  remaining: DriftHit[];
  wrote: boolean;
}

interface MemoryMdEntry {
  title: string;
  filename: string;
  hook: string;
  lineNo: number;
}

interface ParsedMemoryMd {
  path: string;
  raw: string;
  lines: string[];
  trailingNewline: boolean;
  entries: MemoryMdEntry[];
  lineCount: number;
  exists: boolean;
}

interface ScannedMemory {
  path: string;
  id: string;
  filename: string;
  frontmatter?: MemoryFrontmatter;
  validationErrors: string[];
}

function parseMemoryMd(dir: string): ParsedMemoryMd {
  const path = join(dir, MEMORY_MD);
  if (!existsSync(path)) {
    return {
      path,
      raw: '',
      lines: [],
      trailingNewline: false,
      entries: [],
      lineCount: 0,
      exists: false,
    };
  }
  const raw = readFileSync(path, 'utf8');
  const trailingNewline = raw.endsWith('\n');
  const trimmed = trailingNewline ? raw.slice(0, -1) : raw;
  const lines = raw === '' ? [] : trimmed.split(/\r?\n/);

  const entries: MemoryMdEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    LINK_RE.lastIndex = 0;
    const match = LINK_RE.exec(line);
    if (!match) continue;
    const title = match[1];
    const filename = match[2];
    const afterIdx = match.index + match[0].length;
    const hook = line.slice(afterIdx).replace(/^[\s—–\-:]+/, '').trim();
    entries.push({ title, filename, hook, lineNo: i + 1 });
  }

  return {
    path,
    raw,
    lines,
    trailingNewline,
    entries,
    lineCount: lines.length,
    exists: true,
  };
}

function validateFrontmatter(raw: unknown): {
  errors: string[];
  frontmatter?: MemoryFrontmatter;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['frontmatter is not a YAML mapping'] };
  }
  const fm = raw as Record<string, unknown>;
  const errors: string[] = [];

  const missing = REQUIRED_FIELDS.filter((key) => {
    const v = fm[key];
    return v === undefined || v === null || v === '';
  });
  if (missing.length > 0) {
    errors.push(`missing required field(s): ${missing.join(', ')}`);
  }
  for (const key of REQUIRED_FIELDS) {
    const v = fm[key];
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'string') {
      errors.push(`field '${key}' must be a string (got ${typeof v})`);
    }
  }
  if (typeof fm.type === 'string' && !VALID_TYPES.has(fm.type)) {
    errors.push(
      `unknown type '${fm.type}' (expected: ${[...VALID_TYPES].join(', ')})`,
    );
  }

  if (errors.length > 0) return { errors };
  return { errors: [], frontmatter: fm as unknown as MemoryFrontmatter };
}

function scanMemories(dir: string): ScannedMemory[] {
  const entries = readdirSync(dir);
  const memories: ScannedMemory[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    if (entry === MEMORY_MD) continue;
    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const source = readFileSync(path, 'utf8');
    const id = basename(entry, extname(entry));
    const record: ScannedMemory = {
      path,
      id,
      filename: entry,
      validationErrors: [],
    };

    const fmMatch = FRONTMATTER_RE.exec(source);
    if (!fmMatch) {
      record.validationErrors.push('missing YAML frontmatter block');
      memories.push(record);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(fmMatch[1]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      record.validationErrors.push(`frontmatter YAML parse error: ${msg}`);
      memories.push(record);
      continue;
    }

    const { errors, frontmatter } = validateFrontmatter(parsed);
    record.validationErrors = errors;
    if (frontmatter) record.frontmatter = frontmatter;
    memories.push(record);
  }
  return memories;
}

export function lintMemoryDirForDrift(dir: string): DriftReport {
  const stat = statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }

  const memoryMd = parseMemoryMd(dir);
  const memories = scanMemories(dir);

  const hits: DriftHit[] = [];

  if (memoryMd.exists && memoryMd.lineCount > LINE_CAP) {
    hits.push({
      kind: 'length_warning',
      path: memoryMd.path,
      detail: `${memoryMd.lineCount} lines > ${LINE_CAP} cap; lines after ${LINE_CAP} are truncated when loaded into context`,
      fixable: false,
    });
  }

  const seenInIndex = new Set<string>();
  for (const entry of memoryMd.entries) {
    if (seenInIndex.has(entry.filename)) {
      hits.push({
        kind: 'duplicate_entry',
        path: memoryMd.path,
        detail: `'${entry.filename}' listed again at line ${entry.lineNo}`,
        fixable: true,
      });
    } else {
      seenInIndex.add(entry.filename);
    }
  }

  const memoryFilenames = new Set(memories.map((m) => m.filename));
  for (const filename of seenInIndex) {
    if (!memoryFilenames.has(filename)) {
      hits.push({
        kind: 'orphan_pointer',
        path: memoryMd.path,
        detail: `points to '${filename}' but no such memory file exists`,
        fixable: false,
      });
    }
  }

  for (const memory of memories) {
    if (!seenInIndex.has(memory.filename)) {
      hits.push({
        kind: 'missing_pointer',
        path: memory.path,
        memoryId: memory.id,
        detail: `'${memory.filename}' is not listed in MEMORY.md`,
        fixable: memory.validationErrors.length === 0,
      });
    }
  }

  for (const memory of memories) {
    for (const err of memory.validationErrors) {
      hits.push({
        kind: 'invalid_frontmatter',
        path: memory.path,
        memoryId: memory.id,
        detail: err,
        fixable: false,
      });
    }
  }

  const byName = new Map<string, ScannedMemory[]>();
  for (const memory of memories) {
    if (!memory.frontmatter) continue;
    const desc = memory.frontmatter.description ?? '';
    if (desc.length > DESCRIPTION_CAP) {
      hits.push({
        kind: 'description_too_long',
        path: memory.path,
        memoryId: memory.id,
        detail: `description is ${desc.length} chars > ${DESCRIPTION_CAP} cap (MEMORY.md line budget)`,
        fixable: false,
      });
    }
    const key = memory.frontmatter.name.trim().toLowerCase();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(memory);
  }
  for (const group of byName.values()) {
    if (group.length <= 1) continue;
    const first = group[0];
    for (const memory of group.slice(1)) {
      hits.push({
        kind: 'duplicate_name',
        path: memory.path,
        memoryId: memory.id,
        detail: `frontmatter 'name: ${memory.frontmatter!.name}' collides with ${first.filename} (case-insensitive)`,
        fixable: false,
      });
    }
  }

  return {
    hits,
    scannedCount: memories.length,
    memoryMdLineCount: memoryMd.lineCount,
    memoryMdExists: memoryMd.exists,
  };
}

export function applyDriftFixes(
  dir: string,
  report: DriftReport,
): DriftFixResult {
  const memoryMd = parseMemoryMd(dir);
  const memories = scanMemories(dir);
  const byFilename = new Map(memories.map((m) => [m.filename, m]));

  const applied: DriftHit[] = [];
  const remaining: DriftHit[] = [];
  let newLines = [...memoryMd.lines];

  // Duplicates first — they reference existing lines, and removing them
  // shifts indices of later lines. Walk the current lines to find dup
  // indices to drop (keeping the first occurrence).
  const seenDup = new Set<string>();
  const dropIndices: number[] = [];
  for (let i = 0; i < newLines.length; i++) {
    LINK_RE.lastIndex = 0;
    const m = LINK_RE.exec(newLines[i]);
    if (!m) continue;
    const fn = m[2];
    if (seenDup.has(fn)) dropIndices.push(i);
    else seenDup.add(fn);
  }
  for (let i = dropIndices.length - 1; i >= 0; i--) {
    newLines.splice(dropIndices[i], 1);
  }
  for (const hit of report.hits) {
    if (hit.kind === 'duplicate_entry') applied.push(hit);
  }

  // Missing-pointer appends. Only fixable when the target memory parsed
  // cleanly — otherwise we would synthesize a link from bad data.
  for (const hit of report.hits) {
    if (hit.kind !== 'missing_pointer') continue;
    if (!hit.fixable) {
      remaining.push(hit);
      continue;
    }
    const memory = hit.memoryId
      ? byFilename.get(`${hit.memoryId}.md`)
      : undefined;
    if (!memory || !memory.frontmatter) {
      remaining.push(hit);
      continue;
    }
    const { name, description } = memory.frontmatter;
    newLines.push(`- [${name}](${memory.filename}) — ${description}`);
    applied.push(hit);
  }

  // Every other hit kind is out of --fix scope.
  for (const hit of report.hits) {
    if (applied.includes(hit)) continue;
    if (hit.kind === 'missing_pointer') continue; // already partitioned
    remaining.push(hit);
  }

  const changed =
    dropIndices.length > 0 ||
    applied.some((h) => h.kind === 'missing_pointer');

  if (changed) {
    // Always end with one newline — standard POSIX, friendlier to diffs and
    // to downstream readers that parse line-by-line.
    const content = newLines.join('\n') + '\n';
    writeFileSync(memoryMd.path, content, 'utf8');
  }

  return { applied, remaining, wrote: changed };
}

const KIND_LABELS: Record<DriftKind, string> = {
  orphan_pointer: 'orphan pointer',
  missing_pointer: 'missing pointer',
  duplicate_entry: 'duplicate entry',
  duplicate_name: 'duplicate name',
  length_warning: 'length warning',
  invalid_frontmatter: 'invalid frontmatter',
  description_too_long: 'description too long',
};

export function formatDriftReportText(report: DriftReport): string {
  const lines: string[] = [];
  if (report.hits.length === 0) {
    lines.push(
      `memory-router drift: ${report.scannedCount} memory file(s) scanned, MEMORY.md ${
        report.memoryMdExists
          ? `${report.memoryMdLineCount} line(s)`
          : 'missing'
      }, no drift found`,
    );
    return lines.join('\n') + '\n';
  }
  for (const hit of report.hits) {
    const tag = KIND_LABELS[hit.kind];
    const id = hit.memoryId ? ` (${hit.memoryId})` : '';
    lines.push(`${hit.path}: ${tag}${id}: ${hit.detail}`);
  }
  lines.push('');
  lines.push(
    `memory-router drift: ${report.hits.length} finding(s) across ${report.scannedCount} scanned memory file(s)`,
  );
  return lines.join('\n') + '\n';
}

export function formatDriftReportJson(report: DriftReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}

export function formatFixResultText(result: DriftFixResult): string {
  const lines: string[] = [];
  if (result.applied.length === 0 && result.remaining.length === 0) {
    lines.push('memory-router drift --fix: no findings, nothing to do');
    return lines.join('\n') + '\n';
  }
  if (result.applied.length > 0) {
    lines.push(`applied ${result.applied.length} fix(es):`);
    for (const hit of result.applied) {
      lines.push(`  ${KIND_LABELS[hit.kind]}: ${hit.detail}`);
    }
  }
  if (result.remaining.length > 0) {
    lines.push(`${result.applied.length > 0 ? '' : 'no fixes applied; '}${result.remaining.length} finding(s) need manual attention:`);
    for (const hit of result.remaining) {
      lines.push(`  ${KIND_LABELS[hit.kind]}: ${hit.detail}`);
    }
  }
  lines.push('');
  lines.push(
    result.wrote
      ? 'memory-router drift --fix: MEMORY.md updated'
      : 'memory-router drift --fix: MEMORY.md unchanged',
  );
  return lines.join('\n') + '\n';
}

module.exports = {
  lintMemoryDirForDrift,
  applyDriftFixes,
  formatDriftReportText,
  formatDriftReportJson,
  formatFixResultText,
  // Private; re-exported for tests.
  __parseMemoryMd: parseMemoryMd,
  __scanMemories: scanMemories,
};
