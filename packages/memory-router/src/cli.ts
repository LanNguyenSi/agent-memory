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
   * `test <prompt>` / `eval <golden.yml>`: corpus dir for both verbs.
   * Resolution order: --dir flag, $MEMORY_ROUTER_DIR env, error. Shared
   * field name (`testDir`) predates the `eval` verb; both consume the
   * same generic `--dir` flag parsed below.
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (
    args.cmd !== 'tag' &&
    args.cmd !== 'index' &&
    args.cmd !== 'lint' &&
    args.cmd !== 'stale' &&
    args.cmd !== 'test' &&
    args.cmd !== 'eval'
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
