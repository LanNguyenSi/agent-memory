const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const {
  lintMemoryDirForDrift,
  applyDriftFixes,
  formatDriftReportText,
  formatDriftReportJson,
  formatFixResultText,
} = require('../src/lint/drift');

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-drift-'));
}

function writeMemory(
  dir: string,
  filename: string,
  frontmatter: string,
  body = 'body',
): void {
  fs.writeFileSync(
    path.join(dir, filename),
    `---\n${frontmatter}\n---\n\n${body}\n`,
  );
}

function writeMemoryMd(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), content);
}

function findHits(hits: any[], kind: string): any[] {
  return hits.filter((h) => h.kind === kind);
}

test('clean fixture: no hits', () => {
  const dir = makeTmpDir();
  writeMemory(
    dir,
    'user_profile.md',
    'name: User profile\ndescription: Short user profile\ntype: user',
  );
  writeMemoryMd(dir, '- [User profile](user_profile.md) — Short hook\n');

  const report = lintMemoryDirForDrift(dir);
  assert.equal(report.hits.length, 0);
  assert.equal(report.scannedCount, 1);
  assert.equal(report.memoryMdExists, true);
  assert.equal(report.memoryMdLineCount, 1);
});

test('orphan pointer: MEMORY.md lists a file that does not exist', () => {
  const dir = makeTmpDir();
  writeMemoryMd(dir, '- [Ghost](ghost.md) — never existed\n');

  const report = lintMemoryDirForDrift(dir);
  const orphans = findHits(report.hits, 'orphan_pointer');
  assert.equal(orphans.length, 1);
  assert.match(orphans[0].detail, /ghost\.md/);
  assert.equal(orphans[0].fixable, false);
});

test('missing pointer: memory file exists, not in MEMORY.md', () => {
  const dir = makeTmpDir();
  writeMemory(
    dir,
    'orphan_memory.md',
    'name: Orphan memory\ndescription: Hook text\ntype: feedback',
  );
  writeMemoryMd(dir, '');

  const report = lintMemoryDirForDrift(dir);
  const missing = findHits(report.hits, 'missing_pointer');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].memoryId, 'orphan_memory');
  assert.equal(missing[0].fixable, true);
});

test('missing pointer for invalid memory is not fixable', () => {
  const dir = makeTmpDir();
  writeMemory(
    dir,
    'broken.md',
    'name: Broken\ndescription:\ntype: feedback', // empty description
  );
  writeMemoryMd(dir, '');

  const report = lintMemoryDirForDrift(dir);
  const missing = findHits(report.hits, 'missing_pointer');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].fixable, false);
});

test('duplicate entry: same filename twice in MEMORY.md', () => {
  const dir = makeTmpDir();
  writeMemory(
    dir,
    'a.md',
    'name: a\ndescription: hook\ntype: feedback',
  );
  writeMemoryMd(
    dir,
    '- [A](a.md) — first\n- [A again](a.md) — duplicate\n',
  );

  const report = lintMemoryDirForDrift(dir);
  const dups = findHits(report.hits, 'duplicate_entry');
  assert.equal(dups.length, 1);
  assert.match(dups[0].detail, /line 2/);
  assert.equal(dups[0].fixable, true);
});

test('duplicate name: two memories share frontmatter name (case-insensitive)', () => {
  const dir = makeTmpDir();
  writeMemory(dir, 'a.md', 'name: Shared Name\ndescription: x\ntype: feedback');
  writeMemory(dir, 'b.md', 'name: shared name\ndescription: y\ntype: feedback');
  writeMemoryMd(dir, '- [A](a.md) — x\n- [B](b.md) — y\n');

  const report = lintMemoryDirForDrift(dir);
  const dups = findHits(report.hits, 'duplicate_name');
  assert.equal(dups.length, 1);
  assert.match(dups[0].detail, /shared name/i);
  assert.equal(dups[0].fixable, false);
});

test('length warning fires at 201 lines', () => {
  const dir = makeTmpDir();
  writeMemory(dir, 'a.md', 'name: A\ndescription: x\ntype: feedback');
  const lines = ['- [A](a.md) — x'];
  for (let i = 0; i < 200; i++) lines.push(`- line ${i}`);
  writeMemoryMd(dir, lines.join('\n') + '\n');

  const report = lintMemoryDirForDrift(dir);
  const warns = findHits(report.hits, 'length_warning');
  assert.equal(warns.length, 1);
  assert.match(warns[0].detail, /201 lines/);
  assert.equal(warns[0].fixable, false);
});

test('length warning does NOT fire at exactly 200 lines', () => {
  const dir = makeTmpDir();
  writeMemory(dir, 'a.md', 'name: A\ndescription: x\ntype: feedback');
  const lines = ['- [A](a.md) — x'];
  for (let i = 0; i < 199; i++) lines.push(`- line ${i}`);
  writeMemoryMd(dir, lines.join('\n') + '\n');

  const report = lintMemoryDirForDrift(dir);
  assert.equal(findHits(report.hits, 'length_warning').length, 0);
});

test('invalid frontmatter: missing required fields', () => {
  const dir = makeTmpDir();
  writeMemory(dir, 'bad.md', 'name: only-name');
  writeMemoryMd(dir, '');

  const report = lintMemoryDirForDrift(dir);
  const bad = findHits(report.hits, 'invalid_frontmatter');
  assert.equal(bad.length, 1);
  assert.match(bad[0].detail, /description.*type|type.*description/);
});

test('invalid frontmatter: unknown type', () => {
  const dir = makeTmpDir();
  writeMemory(
    dir,
    'weird-type.md',
    'name: x\ndescription: y\ntype: banana',
  );
  writeMemoryMd(dir, '- [x](weird-type.md) — y\n');

  const report = lintMemoryDirForDrift(dir);
  const bad = findHits(report.hits, 'invalid_frontmatter');
  assert.equal(bad.length, 1);
  assert.match(bad[0].detail, /unknown type 'banana'/);
});

test('invalid frontmatter: broken YAML', () => {
  const dir = makeTmpDir();
  // Unbalanced flow mapping — yaml rejects this one outright.
  fs.writeFileSync(
    path.join(dir, 'brokenyaml.md'),
    '---\nname: { a: 1\n---\n\nbody\n',
  );
  writeMemoryMd(dir, '');

  const report = lintMemoryDirForDrift(dir);
  const bad = findHits(report.hits, 'invalid_frontmatter');
  assert.equal(bad.length, 1);
  assert.match(bad[0].detail, /parse error/);
});

test('invalid frontmatter: no frontmatter block at all', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(
    path.join(dir, 'noheader.md'),
    'just plain markdown, no frontmatter\n',
  );
  writeMemoryMd(dir, '');

  const report = lintMemoryDirForDrift(dir);
  const bad = findHits(report.hits, 'invalid_frontmatter');
  assert.equal(bad.length, 1);
  assert.match(bad[0].detail, /missing YAML frontmatter/);
});

test('description too long: > 150 chars', () => {
  const dir = makeTmpDir();
  const longDesc = 'x'.repeat(151);
  writeMemory(
    dir,
    'longdesc.md',
    `name: Long\ndescription: ${longDesc}\ntype: reference`,
  );
  writeMemoryMd(dir, '- [Long](longdesc.md) — ...\n');

  const report = lintMemoryDirForDrift(dir);
  const long = findHits(report.hits, 'description_too_long');
  assert.equal(long.length, 1);
  assert.match(long[0].detail, /151 chars/);
});

test('description exactly 150 chars is OK', () => {
  const dir = makeTmpDir();
  const desc = 'x'.repeat(150);
  writeMemory(
    dir,
    'edge.md',
    `name: Edge\ndescription: ${desc}\ntype: reference`,
  );
  writeMemoryMd(dir, '- [Edge](edge.md) — x\n');

  const report = lintMemoryDirForDrift(dir);
  assert.equal(findHits(report.hits, 'description_too_long').length, 0);
});

test('aggregates hits across multiple files and kinds', () => {
  const dir = makeTmpDir();
  writeMemory(
    dir,
    'a.md',
    'name: A\ndescription: hook\ntype: feedback',
  );
  writeMemory(
    dir,
    'b.md',
    'name: B\ndescription: hook\ntype: feedback',
  );
  writeMemoryMd(
    dir,
    '- [A](a.md) — hook\n- [A](a.md) — dup\n- [Ghost](ghost.md) — gone\n',
  );

  const report = lintMemoryDirForDrift(dir);
  assert.equal(findHits(report.hits, 'duplicate_entry').length, 1);
  assert.equal(findHits(report.hits, 'orphan_pointer').length, 1);
  assert.equal(findHits(report.hits, 'missing_pointer').length, 1);
});

test('--fix appends missing pointers using frontmatter name + description', () => {
  const dir = makeTmpDir();
  writeMemory(
    dir,
    'new_memory.md',
    'name: New Memory\ndescription: Expected hook text\ntype: feedback',
  );
  writeMemoryMd(dir, '');

  const report = lintMemoryDirForDrift(dir);
  const result = applyDriftFixes(dir, report);
  assert.equal(result.wrote, true);
  assert.equal(result.applied.length, 1);
  assert.equal(result.remaining.length, 0);

  const after = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  assert.match(after, /\[New Memory\]\(new_memory\.md\) — Expected hook text/);
});

test('--fix removes duplicate entries, keeping the first', () => {
  const dir = makeTmpDir();
  writeMemory(dir, 'a.md', 'name: A\ndescription: hook\ntype: feedback');
  writeMemoryMd(
    dir,
    '- [A](a.md) — first\n- [A dup](a.md) — duplicate\n',
  );

  const report = lintMemoryDirForDrift(dir);
  const result = applyDriftFixes(dir, report);
  assert.equal(result.wrote, true);
  assert.ok(result.applied.some((h: any) => h.kind === 'duplicate_entry'));

  const after = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  const matches = after.match(/a\.md/g) ?? [];
  assert.equal(matches.length, 1, `expected 1 occurrence, got: ${after}`);
  assert.match(after, /— first/);
  assert.doesNotMatch(after, /— duplicate/);
});

test('--fix does NOT delete orphan pointers', () => {
  const dir = makeTmpDir();
  writeMemoryMd(dir, '- [Ghost](ghost.md) — gone\n');

  const report = lintMemoryDirForDrift(dir);
  const result = applyDriftFixes(dir, report);
  assert.equal(result.wrote, false);
  assert.equal(result.applied.length, 0);
  assert.ok(result.remaining.some((h: any) => h.kind === 'orphan_pointer'));

  const after = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  assert.match(after, /ghost\.md/);
});

test('--fix does NOT touch invalid frontmatter or duplicate names', () => {
  const dir = makeTmpDir();
  writeMemory(dir, 'a.md', 'name: X\ndescription: x\ntype: feedback');
  writeMemory(dir, 'b.md', 'name: x\ndescription: y\ntype: feedback');
  writeMemory(dir, 'c.md', 'name: C'); // missing description + type
  writeMemoryMd(dir, '- [X](a.md) — x\n- [x](b.md) — y\n');

  const report = lintMemoryDirForDrift(dir);
  const result = applyDriftFixes(dir, report);
  // c.md missing pointer is NOT fixable (validation errors)
  assert.equal(result.applied.length, 0);
  assert.ok(
    result.remaining.some((h: any) => h.kind === 'duplicate_name'),
  );
  assert.ok(
    result.remaining.some((h: any) => h.kind === 'invalid_frontmatter'),
  );
});

test('--fix preserves trailing newline behavior', () => {
  const dir = makeTmpDir();
  writeMemory(dir, 'a.md', 'name: A\ndescription: h\ntype: feedback');
  // MEMORY.md without trailing newline
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '');

  const report = lintMemoryDirForDrift(dir);
  applyDriftFixes(dir, report);

  const after = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  // When creating content, we add a trailing newline for POSIX-friendliness.
  assert.ok(after.endsWith('\n'));
});

test('missing MEMORY.md: every memory is reported as missing pointer', () => {
  const dir = makeTmpDir();
  writeMemory(dir, 'a.md', 'name: A\ndescription: h\ntype: feedback');
  writeMemory(dir, 'b.md', 'name: B\ndescription: h\ntype: reference');

  const report = lintMemoryDirForDrift(dir);
  assert.equal(report.memoryMdExists, false);
  assert.equal(findHits(report.hits, 'missing_pointer').length, 2);
});

test('non-list topics scalar does not trip drift linter', () => {
  // The topics linter covers that — drift should not double-report it as
  // invalid frontmatter.
  const dir = makeTmpDir();
  writeMemory(
    dir,
    'scalar-topic.md',
    'name: S\ndescription: h\ntype: feedback\ntopics: workflow',
  );
  writeMemoryMd(dir, '- [S](scalar-topic.md) — h\n');

  const report = lintMemoryDirForDrift(dir);
  assert.equal(findHits(report.hits, 'invalid_frontmatter').length, 0);
});

test('--fix preserves CRLF line endings', () => {
  const dir = makeTmpDir();
  writeMemory(dir, 'a.md', 'name: A\ndescription: hook\ntype: feedback');
  // CRLF MEMORY.md with a duplicate — needs a --fix that rewrites.
  fs.writeFileSync(
    path.join(dir, 'MEMORY.md'),
    '- [A](a.md) — first\r\n- [A again](a.md) — dup\r\n',
  );

  const report = lintMemoryDirForDrift(dir);
  applyDriftFixes(dir, report);

  const after = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  assert.ok(after.includes('\r\n'), `expected CRLF preserved, got: ${JSON.stringify(after)}`);
  assert.ok(!/[^\r]\n/.test(after), `expected no bare LF, got: ${JSON.stringify(after)}`);
});

test('multiple links on one line: all are captured', () => {
  const dir = makeTmpDir();
  writeMemory(dir, 'a.md', 'name: A\ndescription: h\ntype: feedback');
  writeMemory(dir, 'b.md', 'name: B\ndescription: h\ntype: feedback');
  // One MEMORY.md line mentions both files. Previously only the first
  // link was captured, so `b.md` was falsely reported as missing.
  writeMemoryMd(dir, '- see [A](a.md) and [B](b.md) — shared hook\n');

  const report = lintMemoryDirForDrift(dir);
  assert.equal(findHits(report.hits, 'missing_pointer').length, 0);
  assert.equal(findHits(report.hits, 'orphan_pointer').length, 0);
});

test('formatDriftReportText: no-hit message', () => {
  const text = formatDriftReportText({
    hits: [],
    scannedCount: 3,
    memoryMdLineCount: 5,
    memoryMdExists: true,
  });
  assert.match(text, /no drift found/);
  assert.match(text, /5 line/);
});

test('formatDriftReportText: hit lines + summary', () => {
  const text = formatDriftReportText({
    hits: [
      {
        kind: 'orphan_pointer',
        path: '/x/MEMORY.md',
        detail: "points to 'ghost.md'",
        fixable: false,
      },
    ],
    scannedCount: 1,
    memoryMdLineCount: 1,
    memoryMdExists: true,
  });
  assert.match(text, /orphan pointer/);
  assert.match(text, /ghost\.md/);
  assert.match(text, /1 finding/);
});

test('formatDriftReportJson: round-trips', () => {
  const report = {
    hits: [
      {
        kind: 'orphan_pointer',
        path: '/x/MEMORY.md',
        detail: 'd',
        fixable: false,
      },
    ],
    scannedCount: 0,
    memoryMdLineCount: 1,
    memoryMdExists: true,
  };
  const json = formatDriftReportJson(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.hits.length, 1);
  assert.equal(parsed.hits[0].kind, 'orphan_pointer');
});

test('formatFixResultText: applied + remaining sections', () => {
  const text = formatFixResultText({
    applied: [
      {
        kind: 'missing_pointer',
        path: '/x/a.md',
        detail: 'added',
        fixable: true,
      },
    ],
    remaining: [
      {
        kind: 'orphan_pointer',
        path: '/x/MEMORY.md',
        detail: 'gone',
        fixable: false,
      },
    ],
    wrote: true,
  });
  assert.match(text, /applied 1 fix/);
  assert.match(text, /1 finding\(s\) need manual/);
  assert.match(text, /MEMORY\.md updated/);
});
