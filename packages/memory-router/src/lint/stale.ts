// Stale-memory detector. Catches memories whose path / symbol references
// no longer exist in the configured repoRoot. The runtime side of this is
// `verify-refs.ts` (used by the router to prefix the stale prefix on a
// memory at recall time); this file is the proactive cron / CLI side
// that scans the whole corpus on demand.
//
// What v1 covers:
//   1. **Path refs** — taken from `verify:` frontmatter `kind: 'path'`
//      entries. `fs.statSync` against `<repoRoot>/<value>`; missing
//      means STALE.
//   2. **Symbol refs** — taken from `verify:` `kind: 'symbol'`. Resolved
//      via `git grep -l -w <symbol>` from `repoRoot`. Zero matches
//      means STALE. If `repoRoot` is not a git repo, the symbol check
//      degrades to "skipped" with a one-time stderr warning rather than
//      crashing.
//
// Body-regex extraction (turning backtick'd path-shape strings and
// function-call forms into refs) is OPT-IN behind the `scanBody` option
// because dogfooding the regex against a real 49-memory corpus produced
// ~88% false positives: gh-shorthand (`LanNguyenSi/foo`), git refs
// (`origin/main`, `feat/...`), env-var snippets (`$XDG_CONFIG_HOME/...`),
// `~/...` paths, and cross-repo siblings all pattern-match a backtick'd
// span without being filesystem paths against any single repoRoot. Until
// the regex grows a corpus-aware reject list, the default is the strict
// `verify:`-only contract: authors who care about staleness opt in
// per-memory by writing the contract down.
//
// What v1 does not cover (filed as separate follow-ups):
//   - Date-based "possibly stale" hints.
//   - External URL HEAD checks.
//   - Walking git log for renames.
//
// Multi-repo workspace mode (this file): a memory in a shared corpus may
// reference paths in any of several sibling repos (a pandora-style layout
// has agent-memory next to project-pilot, agent-relay, codebase-oracle,
// ...). Pass a list of roots and a ref is STALE only when none of them
// resolves it. First-hit wins for the not-stale fast path; the report
// records which root the ref was found in.

const { statSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadMemoriesFromDir } = require('../memory/loader');

export type StaleCheckKind = 'path' | 'symbol';
export type StaleStatus = 'missing' | 'no-matches' | 'skipped' | 'malformed';

export interface StaleHit {
  memoryPath: string;
  memoryId: string;
  check: StaleCheckKind;
  ref: string;
  /** Where the ref came from: `verify:` frontmatter or body regex. */
  source: 'verify' | 'body-regex';
  status: StaleStatus;
  detail: string;
}

export interface StaleReport {
  hits: StaleHit[];
  scannedCount: number;
  refsChecked: number;
  /** True when symbol checks were degraded due to a non-git repoRoot. */
  symbolCheckDegraded: boolean;
}

export interface StaleOptions {
  /**
   * When true, also extract refs from a memory's body via the backtick +
   * path-shape regex. Default: false (only `verify:` frontmatter is
   * checked). Body-regex extraction is too noisy on real corpora to be a
   * safe default — see the file-level comment block.
   */
  scanBody?: boolean;
}

// File extensions that count as a path-shape signal even without a `/`.
// Conservative: missing one (e.g. obscure extensions) leaves the ref
// out of the scan, which is the right failure mode for a heuristic.
const PATH_EXTENSIONS = new Set<string>([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'yml', 'yaml', 'toml',
  'md', 'mdx',
  'py', 'rb', 'go', 'rs', 'java', 'kt',
  'sh', 'bash', 'zsh',
  'sql',
  'html', 'css', 'scss',
  'lock',
]);

const URL_PREFIX_RE = /^(?:https?:\/\/|file:\/\/|mailto:)/;

// Function-call symbol form: `myFunc()`, `Class.method()`. Picks up
// parentheses so we don't match arbitrary CamelCase prose.
const SYMBOL_CALL_RE = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(\)$/;

// Acceptable shape for any symbol value (verify:- or body-regex-sourced)
// when passing it through to `git grep`. Plain identifier tokens with
// optional dotted segments and an optional trailing `()` (the body-regex
// preserves the call form for display). Anything else might be malformed
// YAML or an attempt to inject a flag, so we refuse early instead of
// shelling out.
const SYMBOL_VALUE_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;

interface ExtractedRef {
  kind: StaleCheckKind;
  value: string;
}

// Characters that disqualify a backtick'd span from being a path. Real
// filesystem paths don't carry these on POSIX (or carry them rarely
// enough that the false-negative cost is much lower than the
// false-positive cost on prose like `feat/...`, `@scope/pkg`, route
// templates `/foo/:id`, and globs `packages/*`).
const PATH_PLACEHOLDER_RE = /[*?<>:@]|\.\.\./;

function looksLikePath(span: string): boolean {
  if (URL_PREFIX_RE.test(span)) return false;
  if (span.includes(' ')) return false;
  if (PATH_PLACEHOLDER_RE.test(span)) return false;
  if (span.includes('/')) return true;
  const dotIdx = span.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === span.length - 1) return false;
  const ext = span.slice(dotIdx + 1).toLowerCase();
  return PATH_EXTENSIONS.has(ext);
}

function extractRefsFromBody(body: string): ExtractedRef[] {
  // Local regex instance: a `/g` pattern carries `lastIndex` state across
  // calls, and sharing one at module level invites a footgun the moment
  // someone forgets to reset it. Compile cost is negligible per body.
  const backtickSpanRe = /`([^`\n]+)`/g;
  const refs: ExtractedRef[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = backtickSpanRe.exec(body)) !== null) {
    const span = match[1].trim();
    if (span.length === 0) continue;

    if (looksLikePath(span)) {
      const key = `path:${span}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ kind: 'path', value: span });
      }
      continue;
    }
    const symMatch = SYMBOL_CALL_RE.exec(span);
    if (symMatch) {
      // Use the dotted form ("Class.method") as the ref but `git grep` on
      // the bare last segment, which is what the user actually expects to
      // find in source. Stored value retains the dotted form for the
      // report so the reader sees the original.
      const key = `symbol:${span}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ kind: 'symbol', value: span });
      }
    }
  }
  return refs;
}

interface VerifyExtractionResult {
  refs: ExtractedRef[];
  /**
   * Verify entries that exist but cannot be checked because the YAML is
   * malformed (missing or empty `value`, etc.). We surface these as a
   * separate `malformed` status so the author fixes the YAML rather than
   * chasing a phantom missing file.
   */
  malformed: { kind: StaleCheckKind | 'unknown'; raw: unknown }[];
}

function extractRefsFromVerify(verify: MemoryReference[] | undefined): VerifyExtractionResult {
  if (!Array.isArray(verify)) return { refs: [], malformed: [] };
  const refs: ExtractedRef[] = [];
  const malformed: VerifyExtractionResult['malformed'] = [];
  for (const v of verify) {
    if (!v || typeof v !== 'object') {
      malformed.push({ kind: 'unknown', raw: v });
      continue;
    }
    if (v.kind !== 'path' && v.kind !== 'symbol') {
      // 'flag' is intentionally not checked from the linter side; the
      // runtime side handles it. Don't treat it as malformed.
      continue;
    }
    if (typeof v.value !== 'string' || v.value.length === 0) {
      malformed.push({ kind: v.kind, raw: v });
      continue;
    }
    refs.push({ kind: v.kind, value: v.value });
  }
  return { refs, malformed };
}

// Partial hit: helpers return only the fields they own. The caller fills
// in `memoryPath` / `memoryId` / `source` from its own context so the
// helpers stay pure.
type PartialHit = Pick<StaleHit, 'check' | 'ref' | 'status' | 'detail'>;

// Single-root path check. Returns null when the file exists, otherwise a
// "missing" PartialHit explaining where it was looked for. Multi-root
// callers fold the per-root results below.
function checkPathInRoot(repoRoot: string, value: string): PartialHit | null {
  const full = isAbsolute(value) ? value : join(repoRoot, value);

  if (!isAbsolute(value)) {
    const resolvedRoot = resolve(repoRoot);
    const resolvedFull = resolve(full);
    if (
      resolvedFull !== resolvedRoot &&
      !resolvedFull.startsWith(resolvedRoot + '/') &&
      !resolvedFull.startsWith(resolvedRoot + '\\')
    ) {
      return {
        check: 'path',
        ref: value,
        status: 'missing',
        detail: `path '${value}' escapes repoRoot ${repoRoot}`,
      };
    }
  }

  try {
    statSync(full);
    return null;
  } catch {
    return {
      check: 'path',
      ref: value,
      status: 'missing',
      detail: `path '${value}' not found at ${full}`,
    };
  }
}

// Multi-root path check. First root that resolves wins. Otherwise returns
// a single missing hit summarising every attempt.
function checkPath(repoRoots: string[], value: string): PartialHit | null {
  const failures: string[] = [];
  for (const root of repoRoots) {
    const partial = checkPathInRoot(root, value);
    if (partial === null) return null;
    failures.push(partial.detail);
  }
  if (failures.length === 1) {
    // Single-root case: keep the v1 detail format verbatim so existing
    // text-format consumers don't break.
    return {
      check: 'path',
      ref: value,
      status: 'missing',
      detail: failures[0],
    };
  }
  return {
    check: 'path',
    ref: value,
    status: 'missing',
    detail: `path '${value}' not found in any of ${repoRoots.length} roots: ${failures.join('; ')}`,
  };
}

interface SymbolRootState {
  // Whether we've already determined `git` works against this repoRoot.
  // null = untested, true = works, false = degraded (non-git or missing).
  available: boolean | null;
  warned: boolean;
}

// Per-scan symbol-check state: one SymbolRootState per repoRoot, lazily
// probed. Lookup keyed by root path.
type SymbolStateMap = Map<string, SymbolRootState>;

function getOrCreateRootState(map: SymbolStateMap, repoRoot: string): SymbolRootState {
  let state = map.get(repoRoot);
  if (!state) {
    state = { available: null, warned: false };
    map.set(repoRoot, state);
  }
  return state;
}

function checkSymbolInRoot(
  repoRoot: string,
  value: string,
  state: SymbolRootState,
): PartialHit | null {
  // Defense for verify:-sourced symbols, which bypass the body-regex
  // shape filter. Refuse anything that isn't an identifier-like token so
  // an accidentally-quoted multi-line string or a leading-dash flag never
  // gets passed to `git grep`.
  if (!SYMBOL_VALUE_RE.test(value)) {
    return {
      check: 'symbol',
      ref: value,
      status: 'malformed',
      detail: `symbol '${value}' is not a plain identifier; refused without checking`,
    };
  }

  // Symbol refs may include a dotted prefix ("Class.method") and / or
  // trailing call parens ("myFn()"). `git grep -w` wants the bare
  // identifier source files would carry: strip both before grepping.
  const bare = value.replace(/\(\)$/, '');
  const parts = bare.split('.');
  const grepTerm = parts[parts.length - 1];

  // Probe git availability lazily, once per scan.
  if (state.available === null) {
    const probe = spawnSync('git', ['rev-parse', '--git-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    state.available = probe.status === 0;
    if (!state.available && !state.warned) {
      process.stderr.write(
        `[memory-router] symbol checks skipped: ${repoRoot} is not a git repo (or git is unavailable)\n`,
      );
      state.warned = true;
    }
  }

  if (!state.available) {
    return {
      check: 'symbol',
      ref: value,
      status: 'skipped',
      detail: 'symbol check requires a git repoRoot',
    };
  }

  const result = spawnSync('git', ['grep', '-l', '-w', grepTerm], {
    cwd: repoRoot,
    encoding: 'utf8',
    // Cap memory; a runaway grep on a large repo shouldn't hang the
    // detector.
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.status === 0) {
    return null;
  }
  if (result.status === 1) {
    return {
      check: 'symbol',
      ref: value,
      status: 'no-matches',
      detail: `symbol '${value}' not found anywhere in ${repoRoot}`,
    };
  }
  // Other exit codes: tool error. Treat as skipped, not stale.
  return {
    check: 'symbol',
    ref: value,
    status: 'skipped',
    detail: `git grep failed for '${value}' (exit ${result.status})`,
  };
}

// Multi-root symbol check. A symbol is STALE only when NO root finds it.
// `skipped` and `malformed` per-root outcomes are folded conservatively:
// if every root either skipped or had no-matches, prefer `no-matches`
// when at least one root checked successfully; otherwise prefer the
// v1-compatible `skipped`. `malformed` short-circuits on the first root.
function checkSymbol(
  repoRoots: string[],
  value: string,
  states: SymbolStateMap,
): PartialHit | null {
  let skippedDetail: string | null = null;
  let noMatchDetail: string | null = null;
  for (const root of repoRoots) {
    const state = getOrCreateRootState(states, root);
    const partial = checkSymbolInRoot(root, value, state);
    if (partial === null) return null;
    if (partial.status === 'malformed') return partial;
    if (partial.status === 'no-matches') {
      noMatchDetail = noMatchDetail ?? partial.detail;
    } else if (partial.status === 'skipped') {
      skippedDetail = skippedDetail ?? partial.detail;
    }
  }
  if (noMatchDetail !== null) {
    if (repoRoots.length === 1) {
      return { check: 'symbol', ref: value, status: 'no-matches', detail: noMatchDetail };
    }
    return {
      check: 'symbol',
      ref: value,
      status: 'no-matches',
      detail: `symbol '${value}' not found in any of ${repoRoots.length} roots`,
    };
  }
  // Every root skipped: surface a single `skipped` entry. Detail names
  // the first non-git root; the others are degraded the same way.
  return {
    check: 'symbol',
    ref: value,
    status: 'skipped',
    detail: skippedDetail ?? `symbol '${value}' could not be checked`,
  };
}

export function lintMemoryDirForStale(
  dir: string,
  repoRoot: string | string[],
  options: StaleOptions = {},
): StaleReport {
  // Accept legacy single-string form for backward compat. An empty
  // array would silently treat every ref as resolved by zero roots
  // (vacuously stale), so reject upfront with a clear error rather than
  // a confusing report.
  const repoRoots: string[] = Array.isArray(repoRoot) ? repoRoot.slice() : [repoRoot];
  if (repoRoots.length === 0) {
    throw new Error('lintMemoryDirForStale requires at least one repoRoot');
  }

  const memories = loadMemoriesFromDir(dir);
  const hits: StaleHit[] = [];
  let refsChecked = 0;
  const symbolStates: SymbolStateMap = new Map();

  for (const memory of memories) {
    const verifyResult = extractRefsFromVerify(memory.frontmatter.verify);

    // Surface malformed verify entries as a separate hit so the author
    // fixes the YAML rather than chasing a phantom "missing" file.
    for (const m of verifyResult.malformed) {
      const detail =
        m.kind === 'unknown'
          ? `verify entry is not an object: ${JSON.stringify(m.raw)}`
          : `verify entry of kind '${m.kind}' is missing a 'value' string`;
      hits.push({
        memoryPath: memory.path,
        memoryId: memory.id,
        check: m.kind === 'symbol' ? 'symbol' : 'path',
        ref: '',
        source: 'verify',
        status: 'malformed',
        detail,
      });
    }

    // verify: refs are always checked. body-regex refs are checked only
    // when the caller opts in via { scanBody: true }: see the file-level
    // comment for why this isn't the default.
    let refs = verifyResult.refs;
    let source: StaleHit['source'] = 'verify';
    if (refs.length === 0 && options.scanBody) {
      refs = extractRefsFromBody(memory.body);
      source = 'body-regex';
    }

    for (const ref of refs) {
      refsChecked++;
      let partial: PartialHit | null = null;
      if (ref.kind === 'path') {
        partial = checkPath(repoRoots, ref.value);
      } else if (ref.kind === 'symbol') {
        partial = checkSymbol(repoRoots, ref.value, symbolStates);
      }
      if (partial) {
        hits.push({
          memoryPath: memory.path,
          memoryId: memory.id,
          source,
          ...partial,
        });
      }
    }
  }

  // "degraded" means EVERY probed root was non-git. A single git root
  // among several is enough to keep symbol checks honest.
  const probedStates = [...symbolStates.values()];
  const symbolCheckDegraded =
    probedStates.length > 0 && probedStates.every((s) => s.available === false);

  return {
    hits,
    scannedCount: memories.length,
    refsChecked,
    symbolCheckDegraded,
  };
}

export function formatStaleReportText(report: StaleReport): string {
  if (report.hits.length === 0) {
    return `memory-router stale: ${report.refsChecked} ref(s) across ${report.scannedCount} memor(y/ies) checked, none stale\n`;
  }

  const lines: string[] = [];
  // Group by memory for readability.
  const byMemory = new Map<string, StaleHit[]>();
  for (const hit of report.hits) {
    const key = hit.memoryPath;
    const list = byMemory.get(key);
    if (list) list.push(hit);
    else byMemory.set(key, [hit]);
  }

  for (const [memPath, group] of byMemory) {
    lines.push(memPath);
    for (const hit of group) {
      lines.push(`  [${hit.check}/${hit.status}] ${hit.ref} (from ${hit.source})`);
      lines.push(`    ${hit.detail}`);
    }
    lines.push('');
  }

  const stale = report.hits.filter((h) => h.status !== 'skipped').length;
  const skipped = report.hits.length - stale;
  lines.push(
    `memory-router stale: ${stale} stale ref(s)` +
      (skipped > 0 ? ` (${skipped} skipped)` : '') +
      ` across ${report.scannedCount} memor(y/ies), ${report.refsChecked} ref(s) total`,
  );
  if (report.symbolCheckDegraded) {
    lines.push('warning: symbol checks were degraded (repoRoot is not a git repo)');
  }
  return lines.join('\n') + '\n';
}

export function formatStaleReportJson(report: StaleReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}

module.exports = {
  lintMemoryDirForStale,
  formatStaleReportText,
  formatStaleReportJson,
  // Re-exported for tests; private otherwise.
  __looksLikePath: looksLikePath,
  __extractRefsFromBody: extractRefsFromBody,
  __extractRefsFromVerify: extractRefsFromVerify,
};
