#!/usr/bin/env node
const { listMemoryFiles, planChange, applyChange } = require('./tag/applier');
const { rebuildIndex } = require('./embed/indexer');
const {
  lintMemoryDirForUnknownTopics,
  formatReportText,
} = require('./lint/topics');
const {
  lintMemoryDirForDrift,
  applyDriftFixes,
  formatDriftReportText,
  formatDriftReportJson,
  formatFixResultText,
} = require('./lint/drift');
const {
  lintMemoryDirForConflicts,
  lintMemoryDirForConflictsWithSemantic,
  formatConflictReportText,
  formatConflictReportJson,
} = require('./lint/conflicts');
const {
  lintMemoryDirForStale,
  lintMemoryDirForStaleWithUrls,
  formatStaleReportText,
  formatStaleReportJson,
} = require('./lint/stale');
const { loadMemoriesFromDir } = require('./memory/loader');
const { resolve, resolveConfidence, dedupeAndRank } = require('./router');
const { runGoldenEval } = require('./eval/runner');
const { formatEvalReportText, formatEvalReportJson } = require('./eval/format');
const { loadMapping } = require('./migrate/mapping');
const { planMigration, applyMigration } = require('./migrate/transform');
const {
  formatMigrationReportText,
  formatMigrationReportJson,
} = require('./migrate/report');
const { loadVocabularyResult } = require('./vocab/loader');
const { runConsolidate, DEFAULT_NEAR_THRESHOLD } = require('./consolidate/analyze');
const {
  formatConsolidateReportText,
  formatConsolidateReportJson,
} = require('./consolidate/report');

interface ParsedArgs {
  cmd: string;
  dir?: string;
  apply: boolean;
  only?: string;
  lintChecks: { drift: boolean; unknownTopics: boolean; conflicts: boolean };
  /** `lint --conflicts --semantic`: enable embedding cosine upgrade. */
  semantic: boolean;
  fix: boolean;
  json: boolean;
  /**
   * `test <prompt>` / `eval <golden.yml>` / `migrate`: corpus dir shared by
   * all three verbs. Resolution order: --dir flag, $MEMORY_ROUTER_DIR env,
   * error. Field name (`testDir`) predates `eval`/`migrate`; all three
   * consume the same generic `--dir` flag parsed below.
   */
  testDir?: string;
  /** `test --semantic`: also run the async confidence gate. */
  testSemantic: boolean;
  /** `test --max-hits <n>`. */
  testMaxHits: number;
  /**
   * `stale` command: list of repo roots a path/symbol ref must resolve
   * against. A ref is STALE only when none of the roots resolves it.
   * When empty, runStale defaults to `[process.cwd()]`. The CLI accepts
   * repeated `--repo-root <p>` flags or a variadic `--repo-roots <p1>
   * <p2> ...` form (terminated by the next flag or end of argv).
   */
  repoRoots: string[];
  /** `stale --scan-body`: also extract refs from memory bodies via regex. */
  scanBody: boolean;
  /** `stale --check-urls`: HEAD-request external URLs (off by default). */
  checkUrls: boolean;
  /**
   * `migrate --mapping <file>`: path to a curated topic-mapping YAML file
   * (see src/migrate/mapping.ts). Optional; when unset, `migrate` derives
   * `topics:` from the vocabulary pattern match alone.
   */
  mappingPath?: string;
  /**
   * `consolidate --near-threshold <n>`: cosine-similarity floor for the
   * near-dupe pass. Default 0.95 (DEFAULT_NEAR_THRESHOLD).
   */
  nearThreshold: number;
}

// Full-string numeric match (mm-v1-T007 fix round LOW #8): `Number.
// parseFloat` alone silently accepts trailing garbage ("0.5abc" -> 0.5),
// so a typo'd --near-threshold value used to pass validation with a
// truncated, unintended number instead of being rejected. Anchored ^...$
// so the ENTIRE token must be numeric; parseFloat only runs after this
// passes. Accepts an optional sign, a required integer or decimal part,
// and an optional exponent -- the same shapes `--near-threshold=<n>`'s
// inline form is documented to accept.
const STRICT_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseStrictNumber(raw: string): number | null {
  if (!STRICT_NUMBER_RE.test(raw)) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let apply = false;
  let only: string | undefined;
  let driftFlag = false;
  let topicsFlag = false;
  let conflictsFlag = false;
  let semanticFlag = false;
  let fix = false;
  let json = false;

  const repoRoots: string[] = [];
  let scanBody = false;
  let checkUrls = false;
  let testDir: string | undefined;
  let testMaxHits = 5;
  let maxHitsFlag = false;
  let mappingPath: string | undefined;
  let nearThreshold = DEFAULT_NEAR_THRESHOLD;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--only') only = argv[++i];
    else if (a === '--unknown-topics') topicsFlag = true;
    else if (a === '--drift') driftFlag = true;
    else if (a === '--conflicts') conflictsFlag = true;
    else if (a === '--semantic') semanticFlag = true;
    else if (a === '--repo-root') repoRoots.push(argv[++i]);
    else if (a.startsWith('--repo-root=')) {
      repoRoots.push(a.slice('--repo-root='.length));
    } else if (a === '--repo-roots') {
      // Variadic slurp until the next `-`-prefixed token or end of argv.
      // Convention: positional `<dir>` should appear BEFORE --repo-roots
      // so the slurp doesn't swallow it. The validation in runStale
      // catches a missing `<dir>` either way.
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        repoRoots.push(argv[++i]);
      }
    }
    else if (a === '--scan-body') scanBody = true;
    else if (a === '--check-urls') checkUrls = true;
    else if (a === '--dir') testDir = argv[++i];
    else if (a.startsWith('--dir=')) testDir = a.slice('--dir='.length);
    else if (a === '--mapping') {
      // A value starting with `--` is almost certainly the next flag being
      // swallowed as the mapping path (e.g. `--mapping --json`), not a
      // real file path: reject with a clear message rather than silently
      // trying to load a file literally named "--json". Idiom mirrors the
      // --max-hits guard below.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        process.stderr.write(
          `error: --mapping expects a file path${next === undefined ? '' : `, got "${next}"`}\n`,
        );
        process.exit(1);
      }
      mappingPath = next;
      i++;
    }
    else if (a.startsWith('--mapping=')) mappingPath = a.slice('--mapping='.length);
    else if (a === '--near-threshold') {
      // Same swallow-guard idiom as --mapping/--max-hits: refuse to treat
      // the next flag as this one's value.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        process.stderr.write('error: --near-threshold requires a number in (0, 1]\n');
        process.exit(1);
      }
      const n = parseStrictNumber(next);
      if (n === null || n <= 0 || n > 1) {
        process.stderr.write(`error: --near-threshold expects a number in (0, 1], got "${next}"\n`);
        process.exit(1);
      }
      i++;
      nearThreshold = n;
    }
    else if (a.startsWith('--near-threshold=')) {
      const raw = a.slice('--near-threshold='.length);
      const n = parseStrictNumber(raw);
      if (n === null || n <= 0 || n > 1) {
        process.stderr.write(`error: --near-threshold expects a number in (0, 1], got "${raw}"\n`);
        process.exit(1);
      }
      nearThreshold = n;
    }
    else if (a === '--max-hits') {
      // Refuse to swallow the next flag as a value: `--max-hits --json`
      // should error rather than silently default and consume --json.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        process.stderr.write('error: --max-hits requires a positive integer\n');
        process.exit(1);
      }
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`error: --max-hits expects a positive integer, got "${next}"\n`);
        process.exit(1);
      }
      i++;
      testMaxHits = n;
      maxHitsFlag = true;
    }
    else if (a === '--fix') fix = true;
    else if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a.startsWith('--')) {
      process.stderr.write(`unknown flag: ${a}\n`);
      process.exit(1);
    } else {
      positional.push(a);
    }
  }

  // When no check flag is given, run drift + unknown-topics by default.
  // --conflicts is opt-in for now: it scans every feedback memory pair, can
  // surface a long info-level list on a mature corpus, and surfacing it
  // unprompted in CI would be noisy. Authors run it deliberately when
  // adding feedback memories.
  const anyCheck = driftFlag || topicsFlag || conflictsFlag;
  const lintChecks = {
    drift: anyCheck ? driftFlag : true,
    unknownTopics: anyCheck ? topicsFlag : true,
    conflicts: conflictsFlag,
  };

  // --fix only applies to drift today; --json applies to drift and
  // conflicts. Warn loudly when a flag is passed in a no-op context so the
  // user knows the run silently ignored it.
  const jsonNoop = json && !lintChecks.drift && !lintChecks.conflicts;
  const fixNoop = fix && !lintChecks.drift;
  if (fixNoop || jsonNoop) {
    const parts: string[] = [];
    if (fixNoop) parts.push('--fix only applies to --drift');
    if (jsonNoop) parts.push('--json only applies to --drift / --conflicts');
    process.stderr.write(
      `warning: ${parts.join('; ')}; no-op with --unknown-topics alone\n`,
    );
  }

  // --semantic only makes sense with --conflicts (it upgrades INFO→HIGH on
  // top of the regex pass) or with `test` (where it opts the confidence
  // gate into the dry-run). Warn loudly rather than silently ignoring it
  // for the lint case; `test` always passes through to runTest. `eval` gets
  // its own, more specific warning below rather than falling into this
  // generic message.
  if (
    semanticFlag &&
    !conflictsFlag &&
    positional[0] !== 'test' &&
    positional[0] !== 'eval'
  ) {
    process.stderr.write(
      'warning: --semantic only applies with --conflicts and is a no-op otherwise\n',
    );
  }

  // `eval` always attempts the confidence gate itself (via promptToHits,
  // same as the hook) whenever an index + provider are configured — it has
  // no opt-in flag to accept, unlike `test`. Warn loudly rather than
  // silently swallowing --semantic so the run doesn't look like it did
  // something the flag never controls.
  if (semanticFlag && positional[0] === 'eval') {
    process.stderr.write(
      'warning: --semantic is a no-op with eval; eval always attempts the confidence gate automatically when an index and OPENAI_API_KEY are available, mirroring the hook\n',
    );
  }

  // `eval` pins its cap to the same default the hook uses (see
  // src/eval/runner.ts promptToHits), deliberately, so its measurements
  // mirror production. --max-hits has no effect there; warn rather than
  // silently ignore it.
  if (maxHitsFlag && positional[0] === 'eval') {
    process.stderr.write(
      'warning: --max-hits is a no-op with eval; eval pins the cap to the same default the hook uses, so its measurements mirror production\n',
    );
  }

  return {
    cmd: positional[0] ?? '',
    dir: positional[1],
    apply,
    only,
    lintChecks,
    semantic: semanticFlag,
    fix,
    json,
    repoRoots,
    scanBody,
    checkUrls,
    testDir,
    // `test` reuses the existing --semantic flag for the confidence gate
    // upgrade (other verbs only consult it under --conflicts; semanticFlag
    // is conceptually "opt in to the semantic pass" across the CLI).
    testSemantic: semanticFlag,
    testMaxHits,
    mappingPath,
    nearThreshold,
  };
}

function printHelp(): void {
  process.stdout.write(`memory-router <command> [options]

Commands:
  tag <dir> [--apply] [--only <id>]
    Propose frontmatter additions (topics, severity) based on content
    heuristics. Dry-run by default.

  index <dir>
    Embed each memory file and store a sqlite-vec index at
    <dir>/.memory-router/index.sqlite. Required for the Confidence Gate
    semantic matches. Env: OPENAI_API_KEY (required),
    MEMORY_ROUTER_EMBED_MODEL (default: text-embedding-3-small).

  lint <dir> [--drift] [--unknown-topics] [--conflicts] [--semantic] [--fix] [--json]
    Validate memory files and MEMORY.md. Three checks today:
      --drift           MEMORY.md vs. on-disk corpus (orphan/missing
                        pointers, duplicates, 200-line cap, frontmatter,
                        description length).
      --unknown-topics  topics: values missing from the runtime topic
                        registry (silent no-match at runtime).
      --conflicts       Pairs of feedback memories that share a topic; flags
                        probable contradictions (opposite imperatives in
                        the first body line + subject vocabulary overlap)
                        as HIGH and topic-overlap pairs as INFO. Opt-in.
      --semantic        Only with --conflicts. For each opposite-polarity
                        INFO pair the regex pass kept as INFO, embed both
                        memories' name+body and upgrade to HIGH when
                        cosine similarity >= 0.85. Reuses the live
                        index.sqlite (built by 'memory-router index') when
                        available; otherwise embeds on the fly without
                        persisting. Skips with a stderr warning when
                        OPENAI_API_KEY is unset (fail-open: regex signal
                        still ships, exit code unaffected by the skip).
    When no check flag is given, --drift + --unknown-topics run by default
    (--conflicts stays opt-in). Exits non-zero on any drift/topic finding
    or any HIGH conflict.
    --fix auto-applies drift fixes where safe (appends missing pointers,
    removes duplicate entries). Orphan pointers are never auto-deleted.
    --json emits a machine-readable report for drift and for conflicts;
    the topics check retains its text format. When --drift --json is set
    alongside --conflicts, the drift JSON owns stdout and the conflicts
    JSON is routed to stderr so CI can pipe both fds.

  test <prompt> [--dir <path>] [--semantic] [--max-hits <n>] [--json]
    Dry-run a prompt against the OLD sync-gates-first resolver (Topic Gate
    then Tool Gate; the Confidence Gate only when --semantic is passed) —
    NOT the score-blend resolver (resolveBlended, mm-v1-T004) the
    UserPromptSubmit hook and 'eval' below actually use today. This is a
    deliberate, documented divergence: 'test' stayed on the pre-blend
    resolver to dry-run the deterministic topic/tool gates (and the
    confidence gate in isolation via --semantic) without the blend's
    combined scoring, so its output is NOT a preview of what the hook
    would inject for the same prompt — use 'eval' for that. Prints the
    memories that would fire, their gate (topic / tool / confidence),
    score, and description.
    Corpus dir resolution: --dir flag, then $MEMORY_ROUTER_DIR env. The
    sync gates (topic, tool) always run; --semantic also runs the async
    confidence gate (requires OPENAI_API_KEY; degrades to a stderr
    warning when missing or on API failure).
    --max-hits caps how many matches are printed (default 5).
    --json emits a machine-readable report on stdout.

  eval <golden.yml> [--dir <path>] [--json]
    Run a golden set of (prompt, expected memory ids) pairs against the
    corpus and report precision / recall per prompt plus aggregate
    precision / recall / MRR (mean reciprocal rank), plus how many prompts
    the semantic signal actually contributed a hit to. A REPORT, not a
    gate: exits 0 on any error-free run regardless of how the metrics look.
    Mirrors exactly what the UserPromptSubmit hook selects for each
    prompt: the score-blend resolver (resolveBlended, mm-v1-T004) —
    semantic score (once it clears the MEMORY_ROUTER_BLEND_MIN_SEMANTIC
    relevance floor) as the dominant signal, Topic Gate as a boost,
    recency/type as tie-breakers — unlike the 'test' verb above, which
    stayed on the old pre-blend resolver.
    golden.yml format:
        prompts:
          - prompt: "user prompt text"
            expect: ["memory_id_1", "memory_id_2"]
          - prompt: "a prompt with no expected match"
            expect: []          # negative control
    A negative control (empty expect:) counts as a pass only when the
    corpus returns zero hits; it is scored separately from — and never
    blended into — the aggregate precision/recall/MRR.
    Corpus dir resolution: --dir flag, then $MEMORY_ROUTER_DIR env (same
    as 'test'). Without an embedding index and OPENAI_API_KEY the
    confidence gate stays silent; the report states this explicitly via
    "semantic path: inactive" rather than passing it off as measured.
    --json emits a machine-readable report on stdout (schema documented
    in README.md).

  migrate [--dir <path>] [--apply] [--mapping <file>] [--json]
    Mechanical, idempotent frontmatter backfill to schema v1 (name,
    description, top-level type, topics: >=1, created). No LLM, no
    guessing: whatever isn't mechanically derivable stays untouched and is
    reported instead. Three independent, additive-only rules, none of
    which ever overwrites an existing canonical value:
      type      hoist metadata.type to top-level type, only when no valid
                top-level type already exists.
      topics    resolve top-level topics from, in order: (1) keep a
                non-empty top-level topics as-is, any shape (an invalid
                shape, i.e. not a list of strings, is still kept, never
                overwritten, but flagged "invalid shape, needs manual
                review" instead of silently passed through as normal),
                (2) hoist a valid metadata.topics array verbatim, (3) the
                curated --mapping file (id or filename-prefix -> topics),
                (4) a vocabulary pattern match against name+description
                ONLY (never the body). No source at any step leaves the
                file untagged, reported under "untagged topics".
      created   stamped from the file's mtime, marked '# approx (mtime)',
                only when no created key exists yet.
    The vocabulary step (4) is disclosed up front, not just on failure:
    the report header prints "vocabulary: default (no topics.yml)",
    "vocabulary: custom (topics.yml)", or "vocabulary: default (topics.yml
    rejected: <reason>)" when the corpus has a topics.yml that fails to
    load. A rejected topics.yml is a setup error under --apply (exit 1,
    same as an invalid --mapping file, before anything is written); a dry
    run still runs, with the rejection reason shown as the hint.
    Dry-run by default; --apply writes. Only *.md files are scanned,
    MEMORY.md and non-.md files (topics.yml, golden.yml, ...) are never
    touched. Corpus dir resolution: --dir flag, then $MEMORY_ROUTER_DIR
    env (same as 'test'/'eval'). --mapping <file> points at a curated
    topic-mapping YAML file (see src/migrate/mapping.ts); an invalid
    mapping file is a setup error (exit 1), never silently ignored.
    --json emits a machine-readable report on stdout. Dry-run and
    untagged/missing/invalid-shape findings always exit 0 (a report, not
    a gate, same as 'eval'); --apply exits 1 only when a write actually
    fails for one or more files (a real per-file I/O error, surfaced
    under "errored" in the report).
    mapping file format:
        - prefix: "feedback_"
          topics: [workflow]
        - id: "reference_codebase_oracle"
          topics: [testing, workflow]
    First rule to match (in file order) wins.

  consolidate [--dir <path>] [--near-threshold <n>] [--repo-root <path>] [--repo-roots <p1> <p2> ...] [--json]
    Report-only corpus health check. No LLM, no automatic merges, NEVER
    writes (not even a temp file inside the corpus dir); every finding is
    for the operator to act on by hand. Four independent passes:
      exact dupes   Groups memories whose BODY, after normalization (trim,
                    collapse whitespace runs to a single space, lowercase),
                    hashes identically. Frontmatter is not compared. An
                    empty or whitespace-only body never forms a group (two
                    memories with no content share nothing meaningful);
                    such memories are listed separately under "empty
                    bodies".
      near dupes    Pairwise cosine similarity over EXISTING embedding-
                    index vectors only (<dir>/.memory-router/index.sqlite,
                    built separately by 'memory-router index'); no live
                    embedding API calls are made, and the index is opened
                    read-only. Runs only when the index exists AND is
                    compatible with the currently configured embedding
                    provider (same provenance contract 'memory-router
                    index' enforces, mm-v1-T003); missing, incompatible, or
                    unreadable (a corrupted index file) is SKIPPED with an
                    explicit reason in the report, never a silent gap or a
                    crash. --near-threshold sets the cosine floor (default
                    0.95, strictly validated: a value with trailing
                    non-numeric characters is rejected, not truncated).
                    When some memories have no usable index vector, the
                    report also states whether that's because they were
                    never indexed at all, or because they ARE indexed but
                    under a different embedding model than the one
                    currently active (a rebuild, not a re-index, fixes
                    that case).
      stale refs    Delegates to 'memory-router stale' unchanged (default
                    repo root: process.cwd(), override via --repo-root /
                    --repo-roots, same flag forms as the 'stale' verb
                    below), same verify:-frontmatter contract, same output.
      schema        untagged (the resolved topics value, top-level topics:
                    when present and non-null else metadata.topics, is an
                    empty array), invalid topics shape (that resolved value
                    is present but isn't a list at all, e.g. a string or a
                    map), legacy format (metadata.type present without a
                    top-level type, the pre-schema-v1 shape 'migrate'
                    backfills), and loader rejects (files
                    src/memory/loader.ts silently drops, with the reject
                    reason, since the loader itself only debugWarns them).
    Corpus dir resolution: --dir flag, then $MEMORY_ROUTER_DIR (same as
    'test'/'eval'/'migrate'). Always a report, never a gate: exits 0 on any
    error-free run regardless of how many findings it surfaces.
    --json emits a stable, documented report on stdout.

  stale <dir> [--repo-root <path>] [--repo-roots <p1> <p2> ...] [--scan-body] [--check-urls] [--json]
    Scan every memory in <dir> for stale references against one or more
    repo roots. Default root list: [process.cwd()]. A ref is STALE only
    when it resolves against NONE of the roots; first hit wins for the
    not-stale fast path. Mix and match the two flag forms freely:
        --repo-root ~/git/repoA --repo-root ~/git/repoB
        --repo-roots ~/git/repoA ~/git/repoB ~/git/repoC
    Put '<dir>' BEFORE --repo-roots so the variadic slurp doesn't claim
    it. By default ONLY refs declared in a memory's verify: frontmatter
    are checked:
      - path   : verify: kind=path. fs.statSync against
                 <repo-root>/<value>; missing -> STALE.
      - symbol : verify: kind=symbol. Resolved via 'git grep -l -w'
                 from <repo-root>. Zero matches -> STALE candidate. If
                 <repo-root> is not a git checkout, symbol checks
                 degrade to "skipped" with a one-time stderr warning.
    A date-staleness pass runs unconditionally as INFO: every memory
    whose newest ISO date in the body is older than 90 days AND whose
    frontmatter has no newer 'updatedAt:' is flagged 'possibly-stale'.
    INFO never contributes to exit code.
    --scan-body additionally extracts refs from memory bodies via a
    backtick + path-shape regex. Off by default because real corpora
    contain a lot of backtick'd strings that look like paths but aren't
    (gh-shorthand, branch names, env-var snippets, cross-repo paths).
    --check-urls HEAD-requests every external URL extracted from the
    body. 4xx -> STALE; 5xx and network errors -> 'skipped' (server or
    network problem, not a dead link). Off by default because it's
    network-dependent.
    --json emits a structured report on stdout for CI consumers.
    Exits 1 when any STALE/no-matches/malformed ref is found, 0
    otherwise. 'possibly-stale' and 'skipped' do not flip the exit code.

Examples:
  memory-router tag ~/.claude/projects/PROJECT/memory
  memory-router tag ~/.claude/projects/PROJECT/memory --apply
  memory-router index ~/.claude/projects/PROJECT/memory
  memory-router lint ~/.claude/projects/PROJECT/memory
  memory-router lint ~/.claude/projects/PROJECT/memory --drift --fix
  memory-router stale ~/.claude/projects/PROJECT/memory --repo-root ~/git/myrepo
  memory-router stale ~/.claude/projects/PROJECT/memory --repo-roots ~/git/repoA ~/git/repoB
  memory-router test "rebase the branch onto master" --dir ~/.claude/projects/PROJECT/memory
  MEMORY_ROUTER_DIR=~/.claude/projects/PROJECT/memory \\
    memory-router test "rebase the branch" --semantic --json
  memory-router eval golden.yml --dir ~/.claude/projects/PROJECT/memory
  MEMORY_ROUTER_DIR=~/.claude/projects/PROJECT/memory \\
    memory-router eval golden.yml --json
  memory-router migrate --dir ~/.claude/projects/PROJECT/memory
  memory-router migrate --dir ~/.claude/projects/PROJECT/memory --mapping mapping.yml --apply
  memory-router consolidate --dir ~/.claude/projects/PROJECT/memory
  memory-router consolidate --dir ~/.claude/projects/PROJECT/memory --near-threshold 0.9 --json
`);
}

function diffFields(
  existing: Record<string, unknown>,
  merged: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  for (const key of ['topics', 'severity']) {
    if (existing[key] === undefined && merged[key] !== undefined) {
      lines.push(`+ ${key}: ${JSON.stringify(merged[key])}`);
    }
  }
  return lines;
}

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

async function runIndex(dir: string): Promise<void> {
  const result = await rebuildIndex(dir);
  if (result.reason) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `indexed ${result.embedded} file(s) (${result.skipped} up-to-date, ${result.removed} removed)\n`,
  );
}

async function runLint(
  dir: string,
  checks: { drift: boolean; unknownTopics: boolean; conflicts: boolean },
  semantic: boolean,
  fix: boolean,
  json: boolean,
): Promise<void> {
  // The loader silently treats unreadable dirs as empty, which would let a
  // typo'd CI path produce a green build. Stat upfront so the linter exits
  // 1 with a clear error instead.
  const fs = require('node:fs');
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (err: unknown) {
    process.stderr.write(`error: cannot read ${dir}: ${String(err)}\n`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`error: ${dir} is not a directory\n`);
    process.exit(1);
  }

  let exitCode = 0;

  if (checks.drift) {
    let driftReport;
    try {
      driftReport = lintMemoryDirForDrift(dir);
    } catch (err: unknown) {
      process.stderr.write(`error: ${String(err)}\n`);
      process.exit(1);
    }
    if (fix) {
      const result = applyDriftFixes(dir, driftReport);
      if (json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stdout.write(formatFixResultText(result));
      }
      if (result.remaining.length > 0) exitCode = 1;
    } else {
      if (json) process.stdout.write(formatDriftReportJson(driftReport));
      else process.stdout.write(formatDriftReportText(driftReport));
      if (driftReport.hits.length > 0) exitCode = 1;
    }
  }

  if (checks.unknownTopics) {
    let report;
    try {
      report = lintMemoryDirForUnknownTopics(dir);
    } catch (err: unknown) {
      process.stderr.write(`error: ${String(err)}\n`);
      process.exit(1);
    }
    // --json is drift-only (topics has its own text format today). Log the
    // topics text report to stderr in JSON mode so CI can still see both
    // signals without corrupting the JSON payload on stdout.
    if (json && checks.drift) process.stderr.write(formatReportText(report));
    else process.stdout.write(formatReportText(report));
    if (report.hits.length > 0) exitCode = 1;
    // An invalid topics.yml is a broken vocabulary, not just an unknown-topic
    // hit; it must fail CI even when the built-in-default fallback happens to
    // scan clean, otherwise a purely exit-code-driven caller never sees it.
    if (report.vocabularyError) exitCode = 1;
  }

  if (checks.conflicts) {
    let report;
    try {
      report = semantic
        ? await lintMemoryDirForConflictsWithSemantic(dir, { semantic: true })
        : lintMemoryDirForConflicts(dir);
    } catch (err: unknown) {
      process.stderr.write(`error: ${String(err)}\n`);
      process.exit(1);
    }
    // Same routing convention as topics: when --drift owns stdout (with
    // --json), the conflicts payload goes to stderr so CI sees both signals
    // without corrupting the drift JSON. Otherwise --json picks the
    // machine-readable variant on stdout.
    const conflictsOut = json
      ? formatConflictReportJson(report)
      : formatConflictReportText(report);
    if (json && checks.drift) process.stderr.write(conflictsOut);
    else process.stdout.write(conflictsOut);
    // Only HIGH-severity conflicts fail the build. INFO-level topic overlap
    // is normal on a mature corpus and shouldn't block CI.
    if (report.hits.some((h: { severity: string }) => h.severity === 'high')) {
      exitCode = 1;
    }
  }

  process.exit(exitCode);
}

async function runStale(
  dir: string,
  repoRoots: string[],
  json: boolean,
  scanBody: boolean,
  checkUrls: boolean,
): Promise<void> {
  const fs = require('node:fs');
  for (const candidate of [dir, ...repoRoots]) {
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch (err: unknown) {
      process.stderr.write(`error: cannot read ${candidate}: ${String(err)}\n`);
      process.exit(1);
    }
    if (!stat.isDirectory()) {
      process.stderr.write(`error: ${candidate} is not a directory\n`);
      process.exit(1);
    }
  }

  let report;
  try {
    report = checkUrls
      ? await lintMemoryDirForStaleWithUrls(dir, repoRoots, { scanBody, checkUrls })
      : lintMemoryDirForStale(dir, repoRoots, { scanBody });
  } catch (err: unknown) {
    process.stderr.write(`error: ${String(err)}\n`);
    process.exit(1);
  }

  if (json) {
    process.stdout.write(formatStaleReportJson(report));
  } else {
    process.stdout.write(formatStaleReportText(report));
  }
  // 'skipped' (e.g. non-git repoRoot for symbol checks) does not fail the
  // build; only verifiable failures do. 'malformed' DOES fail because a
  // broken verify: contract is the author's bug to fix.
  const realStale = report.hits.some(
    (h: { status: string }) =>
      h.status === 'missing' || h.status === 'no-matches' || h.status === 'malformed',
  );
  process.exit(realStale ? 1 : 0);
}

async function runTest(
  prompt: string,
  dir: string,
  semantic: boolean,
  maxHits: number,
  json: boolean,
): Promise<void> {
  const fs = require('node:fs');
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (err: unknown) {
    process.stderr.write(`error: cannot read ${dir}: ${String(err)}\n`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`error: ${dir} is not a directory\n`);
    process.exit(1);
  }

  const memories = loadMemoriesFromDir(dir);
  // memoryDir threaded explicitly (not left to the MEMORY_ROUTER_DIR env
  // fallback in gates/topic.ts) so `test --dir <path>` always matches
  // against THAT dir's topics.yml, even when $MEMORY_ROUTER_DIR is unset or
  // points somewhere else — see src/gates/topic.ts and README "Topic
  // vocabulary".
  const ctx = { prompt, cwd: process.cwd(), memoryDir: dir };

  const syncHits: GateHit[] = resolve(ctx, memories, { maxHits });
  let allHits: GateHit[] = syncHits;

  if (semantic) {
    try {
      const semHits: GateHit[] = await resolveConfidence(ctx, memories, dir, {
        maxHits,
      });
      allHits = dedupeAndRank([...syncHits, ...semHits], maxHits);
    } catch (err: unknown) {
      process.stderr.write(
        `warning: --semantic confidence gate failed, sync hits only: ${String(err)}\n`,
      );
    }
  }

  if (json) {
    process.stdout.write(formatTestReportJson(allHits, dir, prompt));
    return;
  }
  process.stdout.write(formatTestReportText(allHits, dir, prompt, memories.length));
}

function formatTestReportText(
  hits: GateHit[],
  dir: string,
  prompt: string,
  corpusSize: number,
): string {
  const lines: string[] = [];
  lines.push(`prompt: ${prompt}`);
  lines.push(`corpus: ${dir} (${corpusSize} memorie${corpusSize === 1 ? '' : 's'})`);
  lines.push('');
  if (hits.length === 0) {
    lines.push('no match.');
    lines.push('');
    return lines.join('\n');
  }
  lines.push(
    hits.length === 1 ? '1 match:' : `${hits.length} matches:`,
  );
  for (const h of hits) {
    const desc = h.memory.frontmatter.description ?? '';
    lines.push(
      `  ${h.gate} · ${h.score.toFixed(2)}  ${h.memory.id}  — ${desc}`,
    );
    if (h.reason) lines.push(`      reason: ${h.reason}`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatTestReportJson(
  hits: GateHit[],
  dir: string,
  prompt: string,
): string {
  return (
    JSON.stringify(
      {
        prompt,
        dir,
        hits: hits.map((h) => ({
          id: h.memory.id,
          name: h.memory.frontmatter.name,
          description: h.memory.frontmatter.description ?? null,
          gate: h.gate,
          score: h.score,
          reason: h.reason ?? null,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

async function runEval(goldenPath: string, dir: string, json: boolean): Promise<void> {
  const fs = require('node:fs');
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (err: unknown) {
    process.stderr.write(`error: cannot read ${dir}: ${String(err)}\n`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`error: ${dir} is not a directory\n`);
    process.exit(1);
  }

  let report;
  try {
    report = await runGoldenEval(goldenPath, dir);
  } catch (err: unknown) {
    process.stderr.write(`error: ${String(err)}\n`);
    process.exit(1);
  }

  if (json) {
    process.stdout.write(formatEvalReportJson(report));
  } else {
    process.stdout.write(formatEvalReportText(report));
  }
}

async function runMigrate(
  dir: string,
  mappingPath: string | undefined,
  apply: boolean,
  json: boolean,
): Promise<void> {
  const fs = require('node:fs');
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (err: unknown) {
    process.stderr.write(`error: cannot read ${dir}: ${String(err)}\n`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`error: ${dir} is not a directory\n`);
    process.exit(1);
  }

  let mappingRules: { id?: string; prefix?: string; topics: string[] }[] = [];
  if (mappingPath) {
    try {
      mappingRules = loadMapping(mappingPath);
    } catch (err: unknown) {
      // MigrationMappingError extends Error, so this catches it (and any
      // other thrown error) uniformly without needing an `instanceof`
      // narrowing against a require()-imported (untyped `any`) class.
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${detail}\n`);
      process.exit(1);
    }
  }

  // Vocabulary is loaded once here (not inside planMigration) so a broken
  // topics.yml can be gated the same way an invalid --mapping file already
  // is: a --apply setup error, exit 1, before any write is attempted. A
  // dry run still proceeds; the rejection reason is disclosed via the
  // report's "vocabulary:" header line / --json vocabularyError instead.
  const vocabularyResult = loadVocabularyResult(dir);
  if (apply && vocabularyResult.error) {
    process.stderr.write(`error: topics.yml rejected: ${vocabularyResult.error}\n`);
    process.exit(1);
  }

  const plan = planMigration(dir, {
    mappingRules,
    mappingPath: mappingPath ?? null,
    vocabularyResult,
  });
  const applyResult = apply ? applyMigration(plan) : null;

  if (json) {
    process.stdout.write(formatMigrationReportJson(plan, applyResult));
  } else {
    process.stdout.write(formatMigrationReportText(plan, applyResult));
  }

  // A report, not a gate, for a dry run or for untagged/missing/invalid-
  // shape findings alone: those always exit 0, same as `eval`. A non-empty
  // `errored` list under --apply means a real per-file write failed, which
  // does gate the exit code.
  if (applyResult && applyResult.errored.length > 0) {
    process.exit(1);
  }
}

async function runConsolidateCli(
  dir: string,
  nearThreshold: number,
  repoRoots: string[],
  json: boolean,
): Promise<void> {
  const fs = require('node:fs');
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (err: unknown) {
    process.stderr.write(`error: cannot read ${dir}: ${String(err)}\n`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`error: ${dir} is not a directory\n`);
    process.exit(1);
  }

  let report;
  try {
    report = runConsolidate(dir, { nearThreshold, repoRoots });
  } catch (err: unknown) {
    process.stderr.write(`error: ${String(err)}\n`);
    process.exit(1);
  }

  if (json) {
    process.stdout.write(formatConsolidateReportJson(report));
  } else {
    process.stdout.write(formatConsolidateReportText(report));
  }
  // Report, not a gate: same contract as `eval`/`migrate`'s dry-run path,
  // exit 0 on any error-free run regardless of how many findings surfaced.
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (
    args.cmd !== 'tag' &&
    args.cmd !== 'index' &&
    args.cmd !== 'lint' &&
    args.cmd !== 'stale' &&
    args.cmd !== 'test' &&
    args.cmd !== 'eval' &&
    args.cmd !== 'migrate' &&
    args.cmd !== 'consolidate'
  ) {
    printHelp();
    process.exit(args.cmd === '' ? 0 : 1);
  }

  if (args.cmd === 'test') {
    const prompt = args.dir; // for `test`, positional[1] is the prompt
    if (!prompt) {
      process.stderr.write('error: test <prompt> is required\n');
      process.exit(1);
    }
    const dir = args.testDir ?? process.env.MEMORY_ROUTER_DIR;
    if (!dir) {
      process.stderr.write(
        'error: --dir <path> or $MEMORY_ROUTER_DIR is required\n',
      );
      process.exit(1);
    }
    await runTest(prompt, dir, args.testSemantic, args.testMaxHits, args.json);
    return;
  }

  if (args.cmd === 'eval') {
    const goldenPath = args.dir; // for `eval`, positional[1] is the golden.yml path
    if (!goldenPath) {
      process.stderr.write('error: eval <golden.yml> is required\n');
      process.exit(1);
    }
    const dir = args.testDir ?? process.env.MEMORY_ROUTER_DIR;
    if (!dir) {
      process.stderr.write(
        'error: --dir <path> or $MEMORY_ROUTER_DIR is required\n',
      );
      process.exit(1);
    }
    await runEval(goldenPath, dir, args.json);
    return;
  }

  if (args.cmd === 'migrate') {
    const dir = args.testDir ?? process.env.MEMORY_ROUTER_DIR;
    if (!dir) {
      process.stderr.write(
        'error: --dir <path> or $MEMORY_ROUTER_DIR is required\n',
      );
      process.exit(1);
    }
    await runMigrate(dir, args.mappingPath, args.apply, args.json);
    return;
  }

  if (args.cmd === 'consolidate') {
    const dir = args.testDir ?? process.env.MEMORY_ROUTER_DIR;
    if (!dir) {
      process.stderr.write(
        'error: --dir <path> or $MEMORY_ROUTER_DIR is required\n',
      );
      process.exit(1);
    }
    await runConsolidateCli(dir, args.nearThreshold, args.repoRoots, args.json);
    return;
  }

  if (!args.dir) {
    process.stderr.write('error: <dir> is required\n');
    process.exit(1);
  }

  if (args.cmd === 'index') {
    await runIndex(args.dir);
    return;
  }

  if (args.cmd === 'lint') {
    await runLint(args.dir, args.lintChecks, args.semantic, args.fix, args.json);
    return;
  }

  if (args.cmd === 'stale') {
    await runStale(
      args.dir,
      args.repoRoots.length > 0 ? args.repoRoots : [process.cwd()],
      args.json,
      args.scanBody,
      args.checkUrls,
    );
    return;
  }

  let files: string[];
  try {
    files = listMemoryFiles(args.dir, args.only);
  } catch (err: unknown) {
    process.stderr.write(`error: ${String(err)}\n`);
    process.exit(1);
  }

  if (args.only && files.length === 0) {
    process.stderr.write(`error: no file matched --only ${args.only}\n`);
    process.exit(1);
  }

  let changed = 0;
  let skipped = 0;
  let errored = 0;
  const hintedFiles: FileChange[] = [];

  for (const file of files) {
    let change: FileChange;
    try {
      change = planChange(file);
    } catch (err: unknown) {
      // Never abort the whole run on a single unreadable/malformed file —
      // an --apply partial state is worse than a skipped file.
      process.stderr.write(`error reading ${file}: ${String(err)}\n`);
      errored++;
      continue;
    }

    if (change.skipped) {
      skipped++;
      if (change.commandHints.length > 0) hintedFiles.push(change);
      continue;
    }

    const diff = diffFields(change.existing, change.merged);
    process.stdout.write(`${change.id}\n`);
    for (const line of diff) process.stdout.write(`  ${line}\n`);

    if (args.apply) {
      try {
        applyChange(change);
      } catch (err: unknown) {
        process.stderr.write(`error writing ${file}: ${String(err)}\n`);
        errored++;
        continue;
      }
    }
    changed++;

    if (change.commandHints.length > 0) hintedFiles.push(change);
  }

  process.stdout.write(
    `\n${args.apply ? 'applied' : 'would apply'} to ${changed} file(s), skipped ${skipped}${errored ? `, errored ${errored}` : ''}\n`,
  );

  if (hintedFiles.length > 0) {
    process.stderr.write('\n--- triggers.command_pattern hints ---\n');
    process.stderr.write(
      'The following files mention shell commands that might warrant a Tool-Gate trigger.\n',
    );
    process.stderr.write('These are NOT auto-applied — review and add manually.\n\n');
    for (const h of hintedFiles) {
      process.stderr.write(`${h.id}:\n`);
      for (const hint of h.commandHints) process.stderr.write(`  • \`${hint}\`\n`);
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${String(err)}\n`);
  process.exit(1);
});
