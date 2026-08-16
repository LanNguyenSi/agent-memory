const {
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { basename, join } = require('node:path');
const { stringify: stringifyYaml } = require('yaml');
const { proposeFrontmatter } = require('./heuristics');
// Shared frontmatter delimiter-match-plus-YAML-parse step; see the comment
// on parseFrontmatterYaml in loader.ts for the full rationale. This file
// used to carry its own byte-identical FRONTMATTER_RE + parseYaml() copy
// (the last write-path holdout after lint/drift.ts moved onto the shared
// export; see loader.ts's parseFrontmatterYaml comment).
const { parseFrontmatterYaml } = require('../memory/loader');

interface FileChange {
  path: string;
  id: string;
  existing: Record<string, unknown>;
  merged: Record<string, unknown>;
  body: string;
  eol: '\n' | '\r\n';
  commandHints: string[];
  skipped: boolean;
  reason?: string;
}

function listMemoryFiles(dir: string, onlyId?: string): string[] {
  const entries = readdirSync(dir) as string[];
  // Code-unit sort, same rationale as loadMemoriesFromDir in
  // src/memory/loader.ts. Fixes tag-apply processing and report order
  // across machines.
  entries.sort();
  return entries
    .filter((name: string) => name.endsWith('.md') && name !== 'MEMORY.md')
    .filter((name: string) => {
      const stat = statSync(join(dir, name));
      if (!stat.isFile()) return false;
      if (onlyId && name !== `${onlyId}.md`) return false;
      return true;
    })
    .map((name: string) => join(dir, name));
}

function planChange(path: string): FileChange {
  const id = basename(path, '.md');
  const source = readFileSync(path, 'utf8') as string;
  // Detect the file's line-ending style so we preserve it on write.
  const eol: '\n' | '\r\n' = /\r\n/.test(source) ? '\r\n' : '\n';
  const parsed = parseFrontmatterYaml(source);

  if (!parsed.ok) {
    if (parsed.kind === 'yaml-error') {
      // Pre-dedup fidelity: this file has a `---` delimiter but malformed
      // YAML inside it, which used to surface as an uncaught parseYaml()
      // throw propagating out of this function. Rethrow the original
      // caught error object (not a re-wrapped Error) so cli.ts's per-file
      // try/catch around planChange still reports the error's own
      // `${String(err)}` rendering (e.g. "YAMLParseError: ...") under
      // "errored", not silently under "skipped" the way the no-delimiter
      // case below is.
      throw parsed.error;
    }
    return {
      path,
      id,
      existing: {},
      merged: {},
      body: '',
      eol,
      commandHints: [],
      skipped: true,
      reason: 'no frontmatter',
    };
  }

  const existing = (parsed.raw ?? {}) as Record<string, unknown>;
  // parseFrontmatterYaml's body is the raw, unprocessed capture (shared with
  // parseMemoryFileWithReason's own body handling in loader.ts, which
  // instead `.trim()`s it for the read path). The write path here strips
  // only a single leading newline so mid-body blank lines and trailing
  // whitespace survive the plan/apply round trip unchanged; `.trim()` would
  // eat them.
  const body = parsed.body.replace(/^\r?\n/, '');

  if (
    typeof existing.name !== 'string' ||
    typeof existing.type !== 'string'
  ) {
    return {
      path,
      id,
      existing,
      merged: existing,
      body,
      eol,
      commandHints: [],
      skipped: true,
      reason: 'frontmatter missing name/type',
    };
  }

  const proposal = proposeFrontmatter({
    id,
    name: existing.name as string,
    description: typeof existing.description === 'string' ? existing.description : '',
    body,
    type: existing.type as MemoryType,
  });

  const merged: Record<string, unknown> = { ...existing };
  let added = false;
  if (proposal.topics && merged.topics === undefined) {
    merged.topics = proposal.topics;
    added = true;
  }
  if (proposal.severity && merged.severity === undefined) {
    merged.severity = proposal.severity;
    added = true;
  }

  return {
    path,
    id,
    existing,
    merged,
    body,
    eol,
    commandHints: proposal.commandHints ?? [],
    skipped: !added,
    reason: added ? undefined : 'no new fields to add',
  };
}

function renderFile(
  merged: Record<string, unknown>,
  body: string,
  eol: '\n' | '\r\n',
): string {
  // yaml.stringify emits LF; normalize to the file's original ending before
  // glueing frontmatter + body back together.
  const yaml = stringifyYaml(merged).trimEnd().replace(/\n/g, eol);
  return `---${eol}${yaml}${eol}---${eol}${eol}${body}`;
}

function applyChange(change: FileChange): void {
  if (change.skipped) return;
  const contents = renderFile(change.merged, change.body, change.eol);
  // Atomic write: a Ctrl-C mid-writeFileSync would leave the target truncated.
  // write tmp then rename — rename is atomic on a single filesystem.
  const tmp = `${change.path}.memrouter.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, change.path);
}

module.exports = { listMemoryFiles, planChange, applyChange, renderFile };
