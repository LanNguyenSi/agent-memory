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
  // top of the regex pass). Warn loudly rather than silently ignoring it.
  if (semanticFlag && !conflictsFlag) {
    process.stderr.write(
      'warning: --semantic only applies with --conflicts and is a no-op otherwise\n',
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (
    args.cmd !== 'tag' &&
    args.cmd !== 'index' &&
    args.cmd !== 'lint' &&
    args.cmd !== 'stale'
  ) {
    printHelp();
    process.exit(args.cmd === '' ? 0 : 1);
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
