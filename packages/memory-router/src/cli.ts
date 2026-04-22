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

interface ParsedArgs {
  cmd: string;
  dir?: string;
  apply: boolean;
  only?: string;
  lintChecks: { drift: boolean; unknownTopics: boolean };
  fix: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let apply = false;
  let only: string | undefined;
  let driftFlag = false;
  let topicsFlag = false;
  let fix = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--only') only = argv[++i];
    else if (a === '--unknown-topics') topicsFlag = true;
    else if (a === '--drift') driftFlag = true;
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

  // When no check flag is given, run both. A narrowing flag keeps CI green
  // on stacked repos that only care about one dimension.
  const anyCheck = driftFlag || topicsFlag;
  const lintChecks = {
    drift: anyCheck ? driftFlag : true,
    unknownTopics: anyCheck ? topicsFlag : true,
  };

  return {
    cmd: positional[0] ?? '',
    dir: positional[1],
    apply,
    only,
    lintChecks,
    fix,
    json,
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

  lint <dir> [--drift] [--unknown-topics] [--fix] [--json]
    Validate memory files and MEMORY.md. Two checks today:
      --drift           MEMORY.md vs. on-disk corpus (orphan/missing
                        pointers, duplicates, 200-line cap, frontmatter,
                        description length).
      --unknown-topics  topics: values missing from the runtime topic
                        registry (silent no-match at runtime).
    When no check flag is given, both run. Exits non-zero on any finding.
    --fix auto-applies drift fixes where safe (appends missing pointers,
    removes duplicate entries). Orphan pointers are never auto-deleted.
    --json emits a machine-readable report for drift; the topics check
    retains its text format.

Examples:
  memory-router tag ~/.claude/projects/PROJECT/memory
  memory-router tag ~/.claude/projects/PROJECT/memory --apply
  memory-router index ~/.claude/projects/PROJECT/memory
  memory-router lint ~/.claude/projects/PROJECT/memory
  memory-router lint ~/.claude/projects/PROJECT/memory --drift --fix
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

function runLint(
  dir: string,
  checks: { drift: boolean; unknownTopics: boolean },
  fix: boolean,
  json: boolean,
): void {
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

  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd !== 'tag' && args.cmd !== 'index' && args.cmd !== 'lint') {
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
    runLint(args.dir, args.lintChecks, args.fix, args.json);
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
