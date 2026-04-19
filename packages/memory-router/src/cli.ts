#!/usr/bin/env node
const { listMemoryFiles, planChange, applyChange } = require('./tag/applier');

interface ParsedArgs {
  cmd: string;
  dir?: string;
  apply: boolean;
  only?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let apply = false;
  let only: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--only') only = argv[++i];
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

  return { cmd: positional[0] ?? '', dir: positional[1], apply, only };
}

function printHelp(): void {
  process.stdout.write(`memory-router tag <dir> [--apply] [--only <id>]

Scan a Claude-Code memory directory and propose frontmatter additions
(topics, severity) based on content heuristics. Default is dry-run — pass
--apply to write changes. Use --only <id> to limit to a single file.

Examples:
  memory-router tag ~/.claude/projects/PROJECT/memory
  memory-router tag ~/.claude/projects/PROJECT/memory --apply
  memory-router tag ~/.claude/projects/PROJECT/memory --only feedback_stacked_pr_base
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd !== 'tag') {
    printHelp();
    process.exit(args.cmd === '' ? 0 : 1);
  }
  if (!args.dir) {
    process.stderr.write('error: <dir> is required\n');
    process.exit(1);
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

main();
