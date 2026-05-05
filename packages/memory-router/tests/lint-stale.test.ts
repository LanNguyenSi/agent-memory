const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const {
  lintMemoryDirForStale,
  formatStaleReportText,
  formatStaleReportJson,
  __looksLikePath,
  __extractRefsFromBody,
  __extractRefsFromVerify,
} = require('../src/lint/stale');

interface MemDir {
  memDir: string;
  repoRoot: string;
  cleanup: () => void;
}

function tmpMemDirWithRepo(): MemDir {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-stale-'));
  const memDir = path.join(root, 'memories');
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(memDir);
  fs.mkdirSync(repoRoot);
  // Initialize a real git repo so symbol checks run end-to-end.
  spawnSync('git', ['init', '-q'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repoRoot });
  return {
    memDir,
    repoRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeMem(dir: string, name: string, frontmatter: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `---\n${frontmatter}\n---\n\n${body}\n`);
}

function gitCommitAll(repoRoot: string): void {
  spawnSync('git', ['add', '-A'], { cwd: repoRoot });
  spawnSync('git', ['commit', '-m', 'seed', '-q'], { cwd: repoRoot });
}

test('looksLikePath: paths with /', () => {
  assert.equal(__looksLikePath('src/foo.ts'), true);
  assert.equal(__looksLikePath('packages/memory-router/src'), true);
});

test('looksLikePath: extension-only', () => {
  assert.equal(__looksLikePath('foo.ts'), true);
  assert.equal(__looksLikePath('package.json'), true);
  assert.equal(__looksLikePath('Dockerfile'), false, 'no extension and no slash');
});

test('looksLikePath: rejects URLs and prose', () => {
  assert.equal(__looksLikePath('https://example.com/foo.ts'), false);
  assert.equal(__looksLikePath('the file foo.ts'), false, 'spaces disqualify');
  assert.equal(__looksLikePath('foo'), false);
});

test('looksLikePath: rejects placeholders / templates / globs', () => {
  // Pinned by dogfood: branch placeholders, glob patterns, npm-scope
  // expressions, route templates with :param, template angle-brackets,
  // and ellipsis truncation are all NOT real paths the linter should
  // try to stat.
  assert.equal(__looksLikePath('feat/...'), false, 'ellipsis = placeholder');
  assert.equal(__looksLikePath('packages/*'), false, 'glob');
  assert.equal(__looksLikePath('@lannguyensi/foo'), false, 'npm scope');
  assert.equal(__looksLikePath('/api/github/pull-requests/:n/merge'), false, 'route template');
  assert.equal(__looksLikePath('packages/<name>'), false, 'template angle-brackets');
});

test('extractRefsFromBody: deduplicates and picks paths + symbols', () => {
  const body = [
    'See `src/foo.ts` for details.',
    'And `src/foo.ts` again (duplicate).',
    'The function `myFunc()` is gone.',
    '`Class.method()` was removed.',
    'Plain prose with `not a path` ignored.',
    'A URL `https://example.com/foo.ts` ignored.',
  ].join('\n');
  const refs = __extractRefsFromBody(body);
  const paths = refs.filter((r: { kind: string }) => r.kind === 'path').map((r: { value: string }) => r.value);
  const symbols = refs.filter((r: { kind: string }) => r.kind === 'symbol').map((r: { value: string }) => r.value);
  assert.deepEqual(paths, ['src/foo.ts'], 'duplicates collapsed, URL excluded');
  assert.deepEqual(symbols.sort(), ['Class.method()', 'myFunc()'].sort());
});

test('extractRefsFromVerify: keeps path and symbol, surfaces malformed', () => {
  const result = __extractRefsFromVerify([
    { kind: 'path', value: 'src/foo.ts' },
    { kind: 'symbol', value: 'myFn' },
    { kind: 'flag', value: '--verbose' }, // intentionally not checked
    null, // malformed: not an object
    { kind: 'path' }, // malformed: missing value
    { kind: 'symbol', value: '' }, // malformed: empty value
  ]);
  assert.equal(result.refs.length, 2);
  assert.equal(result.malformed.length, 3, 'null + missing-value + empty-value all flagged');
});

test('default mode: body-regex skipped, no findings without verify:', () => {
  const { memDir, repoRoot, cleanup } = tmpMemDirWithRepo();
  // Body references a path that does NOT exist. With v1's strict
  // verify-only default, the absence of a `verify:` block must produce
  // zero hits — the author hasn't opted in to staleness contracts for
  // this memory.
  writeMem(
    memDir,
    'feedback_no_verify.md',
    'name: no verify\ndescription: x\ntype: feedback',
    'See `src/missing-file.ts` which used to exist.',
  );
  try {
    const report = lintMemoryDirForStale(memDir, repoRoot);
    assert.equal(report.hits.length, 0);
    assert.equal(report.refsChecked, 0, 'no verify: refs and body-regex off → 0 refs checked');
  } finally {
    cleanup();
  }
});

test('--scan-body: body regex flags broken path → STALE (source=body-regex)', () => {
  const { memDir, repoRoot, cleanup } = tmpMemDirWithRepo();
  writeMem(
    memDir,
    'feedback_path.md',
    'name: path\ndescription: x\ntype: feedback',
    'See `src/missing-file.ts` which used to exist.',
  );
  try {
    const report = lintMemoryDirForStale(memDir, repoRoot, { scanBody: true });
    const stale = report.hits.filter((h: { status: string }) => h.status === 'missing');
    assert.equal(stale.length, 1);
    assert.equal(stale[0].check, 'path');
    assert.equal(stale[0].ref, 'src/missing-file.ts');
    assert.equal(stale[0].source, 'body-regex');
  } finally {
    cleanup();
  }
});

test('--scan-body: existing path ref → not flagged', () => {
  const { memDir, repoRoot, cleanup } = tmpMemDirWithRepo();
  fs.mkdirSync(path.join(repoRoot, 'src'));
  fs.writeFileSync(path.join(repoRoot, 'src', 'present.ts'), '// stub\n');
  writeMem(
    memDir,
    'feedback_present.md',
    'name: present\ndescription: x\ntype: feedback',
    'See `src/present.ts`.',
  );
  try {
    const report = lintMemoryDirForStale(memDir, repoRoot, { scanBody: true });
    assert.equal(report.hits.length, 0);
    assert.equal(report.refsChecked, 1);
  } finally {
    cleanup();
  }
});

test('--scan-body: symbol ref absent from repo → STALE (no-matches)', () => {
  const { memDir, repoRoot, cleanup } = tmpMemDirWithRepo();
  fs.writeFileSync(path.join(repoRoot, 'main.ts'), 'export const realFn = () => 1;\n');
  gitCommitAll(repoRoot);
  writeMem(
    memDir,
    'feedback_sym.md',
    'name: sym\ndescription: x\ntype: feedback',
    'The function `ghostFn()` was renamed.',
  );
  try {
    const report = lintMemoryDirForStale(memDir, repoRoot, { scanBody: true });
    const stale = report.hits.filter((h: { status: string }) => h.status === 'no-matches');
    assert.equal(stale.length, 1);
    assert.equal(stale[0].check, 'symbol');
    assert.equal(stale[0].ref, 'ghostFn()');
  } finally {
    cleanup();
  }
});

test('verify: frontmatter is checked even without --scan-body', () => {
  const { memDir, repoRoot, cleanup } = tmpMemDirWithRepo();
  fs.writeFileSync(path.join(repoRoot, 'real.ts'), '// real\n');
  // Body mentions `gone.ts` (doesn't exist) but `verify:` claims
  // `real.ts`. Default mode: body is ignored, verify is checked, no
  // hits.
  writeMem(
    memDir,
    'feedback_verify.md',
    'name: verify\ndescription: x\ntype: feedback\nverify:\n  - kind: path\n    value: real.ts',
    'Background: the old `gone.ts` was removed and replaced by `real.ts`.',
  );
  try {
    const report = lintMemoryDirForStale(memDir, repoRoot);
    assert.equal(report.hits.length, 0, 'verify: claim succeeds, body ignored');
    assert.equal(report.refsChecked, 1);
  } finally {
    cleanup();
  }
});

test('verify: present + --scan-body → body-regex still skipped (verify wins)', () => {
  const { memDir, repoRoot, cleanup } = tmpMemDirWithRepo();
  fs.writeFileSync(path.join(repoRoot, 'real.ts'), '// real\n');
  writeMem(
    memDir,
    'feedback_verify_only.md',
    'name: verify only\ndescription: x\ntype: feedback\nverify:\n  - kind: path\n    value: real.ts',
    'But `not-real.ts` was once here too.',
  );
  try {
    const report = lintMemoryDirForStale(memDir, repoRoot, { scanBody: true });
    assert.equal(report.hits.length, 0, 'verify: claims override body-regex even when scanBody is on');
    assert.equal(report.refsChecked, 1);
  } finally {
    cleanup();
  }
});

test('malformed verify entry → flagged as malformed (not phantom missing file)', () => {
  const { memDir, repoRoot, cleanup } = tmpMemDirWithRepo();
  // YAML-empty value in a verify entry would previously surface as a
  // missing 'undefined' file. Now it's an explicit malformed status so
  // the author fixes the YAML.
  writeMem(
    memDir,
    'feedback_bad_verify.md',
    'name: bad\ndescription: x\ntype: feedback\nverify:\n  - kind: path\n    value: ""\n  - kind: symbol\n    value: ""',
    'body',
  );
  try {
    const report = lintMemoryDirForStale(memDir, repoRoot);
    const malformed = report.hits.filter((h: { status: string }) => h.status === 'malformed');
    assert.equal(malformed.length, 2);
    assert.match(malformed[0].detail, /missing a 'value' string/);
  } finally {
    cleanup();
  }
});

test('symbol verify value with non-identifier shape is refused before git grep', () => {
  const { memDir, repoRoot, cleanup } = tmpMemDirWithRepo();
  gitCommitAll(repoRoot);
  // A verify-sourced symbol bypasses the body-regex shape filter, so we
  // refuse anything that isn't a plain identifier (including leading
  // dashes, which would otherwise reach git grep as a flag).
  writeMem(
    memDir,
    'feedback_bad_sym.md',
    'name: bad sym\ndescription: x\ntype: feedback\nverify:\n  - kind: symbol\n    value: "--evil"',
    'body',
  );
  try {
    const report = lintMemoryDirForStale(memDir, repoRoot);
    const malformed = report.hits.filter((h: { status: string }) => h.status === 'malformed');
    assert.equal(malformed.length, 1);
    assert.match(malformed[0].detail, /not a plain identifier/);
  } finally {
    cleanup();
  }
});

test('verify: with stale claim → STALE (source=verify)', () => {
  const { memDir, repoRoot, cleanup } = tmpMemDirWithRepo();
  writeMem(
    memDir,
    'feedback_verify_stale.md',
    'name: verify-stale\ndescription: x\ntype: feedback\nverify:\n  - kind: path\n    value: deleted.ts',
    'Once upon a time `deleted.ts` existed.',
  );
  try {
    const report = lintMemoryDirForStale(memDir, repoRoot);
    assert.equal(report.hits.length, 1);
    assert.equal(report.hits[0].source, 'verify');
    assert.equal(report.hits[0].ref, 'deleted.ts');
  } finally {
    cleanup();
  }
});

test('non-git repoRoot: symbol checks degrade to skipped, paths still work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-stale-nogit-'));
  const memDir = path.join(root, 'memories');
  const repoRoot = path.join(root, 'plain');
  fs.mkdirSync(memDir);
  fs.mkdirSync(repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'real.ts'), '// real\n');
  writeMem(
    memDir,
    'feedback_mixed.md',
    'name: mixed\ndescription: x\ntype: feedback',
    'See `real.ts` and the function `someFn()`.',
  );
  // Capture stderr to confirm the one-time warning fires once.
  const stderrLines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    stderrLines.push(s);
    return true;
  };
  try {
    const report = lintMemoryDirForStale(memDir, repoRoot, { scanBody: true });
    const skipped = report.hits.filter((h: { status: string }) => h.status === 'skipped');
    const realStale = report.hits.filter(
      (h: { status: string }) => h.status === 'missing' || h.status === 'no-matches',
    );
    assert.equal(skipped.length, 1, 'symbol check skipped on non-git repoRoot');
    assert.equal(realStale.length, 0, 'present path not flagged');
    assert.equal(report.symbolCheckDegraded, true);
    const warnings = stderrLines.filter((s) => s.includes('symbol checks skipped'));
    assert.equal(warnings.length, 1, 'warning fires once, not per-symbol');
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('formatStaleReportText: empty report', () => {
  const text = formatStaleReportText({
    hits: [],
    scannedCount: 5,
    refsChecked: 12,
    symbolCheckDegraded: false,
  });
  assert.match(text, /12 ref.* across 5 memor.* checked, none stale/);
});

test('formatStaleReportJson: round-trip', () => {
  const report = {
    hits: [
      {
        memoryPath: '/m/a.md',
        memoryId: 'a',
        check: 'path',
        ref: 'src/gone.ts',
        source: 'body-regex',
        status: 'missing',
        detail: "path 'src/gone.ts' not found at /m/repo/src/gone.ts",
      },
    ],
    scannedCount: 1,
    refsChecked: 1,
    symbolCheckDegraded: false,
  };
  const json = formatStaleReportJson(report);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, report);
});

// Multi-root workspace mode: a ref is STALE only when NO root resolves
// it. Pinned because dogfood against the real corpus produced 80 STALE
// hits that were almost all sibling-repo paths in a pandora-style layout.
test('multi-root: ref present in second root is NOT stale', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-stale-multi-'));
  const memDir = path.join(root, 'memories');
  const repoA = path.join(root, 'repoA');
  const repoB = path.join(root, 'repoB');
  fs.mkdirSync(memDir);
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  // File only exists under repoB — single-root scan against repoA would
  // flag it stale; multi-root must not.
  fs.mkdirSync(path.join(repoB, 'src'));
  fs.writeFileSync(path.join(repoB, 'src', 'shared.ts'), 'export {};\n');
  writeMem(
    memDir,
    'feedback_a.md',
    'name: a\ndescription: x\ntype: feedback\nverify:\n  - kind: path\n    value: src/shared.ts',
    'body',
  );

  try {
    // Regression-pin: legacy single-root form treats it as stale.
    const single = lintMemoryDirForStale(memDir, repoA);
    const singleStale = single.hits.filter(
      (h: { status: string }) => h.status === 'missing',
    );
    assert.equal(singleStale.length, 1, 'single-root form: ref stale against repoA only');

    // Multi-root form: not stale because repoB resolves it.
    const multi = lintMemoryDirForStale(memDir, [repoA, repoB]);
    const multiStale = multi.hits.filter(
      (h: { status: string }) => h.status === 'missing',
    );
    assert.equal(multiStale.length, 0, 'multi-root: repoB has the file, not stale');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('multi-root: ref missing in ALL roots IS stale, with summary detail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-stale-multi-'));
  const memDir = path.join(root, 'memories');
  const repoA = path.join(root, 'repoA');
  const repoB = path.join(root, 'repoB');
  const repoC = path.join(root, 'repoC');
  fs.mkdirSync(memDir);
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  fs.mkdirSync(repoC);
  writeMem(
    memDir,
    'feedback_orphan.md',
    'name: o\ndescription: x\ntype: feedback\nverify:\n  - kind: path\n    value: src/never-existed.ts',
    'body',
  );

  try {
    const report = lintMemoryDirForStale(memDir, [repoA, repoB, repoC]);
    const stale = report.hits.filter(
      (h: { status: string }) => h.status === 'missing',
    );
    assert.equal(stale.length, 1, 'missing in all roots: stale');
    assert.match(stale[0].detail, /not found in any of 3 roots/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('multi-root: empty repoRoots array throws upfront', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-stale-empty-'));
  try {
    assert.throws(
      () => lintMemoryDirForStale(dir, []),
      /at least one repoRoot/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-root: symbol resolved in any root means not stale', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-stale-multi-sym-'));
  const memDir = path.join(root, 'memories');
  const repoA = path.join(root, 'repoA');
  const repoB = path.join(root, 'repoB');
  fs.mkdirSync(memDir);
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  // git init in BOTH so symbol checks fire (no degraded path).
  spawnSync('git', ['init', '-q'], { cwd: repoA });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: repoA });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repoA });
  spawnSync('git', ['init', '-q'], { cwd: repoB });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: repoB });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repoB });
  // Symbol only exists under repoB.
  fs.writeFileSync(path.join(repoB, 'lib.ts'), 'export function widgetFactory() {}\n');
  spawnSync('git', ['add', '-A'], { cwd: repoB });
  spawnSync('git', ['commit', '-m', 's', '-q'], { cwd: repoB });
  writeMem(
    memDir,
    'feedback_sym.md',
    'name: s\ndescription: x\ntype: feedback\nverify:\n  - kind: symbol\n    value: widgetFactory',
    'body',
  );

  try {
    const report = lintMemoryDirForStale(memDir, [repoA, repoB]);
    const stale = report.hits.filter(
      (h: { status: string }) => h.status === 'no-matches',
    );
    assert.equal(stale.length, 0, 'symbol present in repoB → not stale');
    assert.equal(report.symbolCheckDegraded, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('multi-root: symbol-degraded TRUE when every root is non-git', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-stale-multi-sym-allnon-'));
  const memDir = path.join(root, 'memories');
  const repoA = path.join(root, 'repoA');
  const repoB = path.join(root, 'repoB');
  fs.mkdirSync(memDir);
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  // Neither root has git initialised → degraded = true.
  writeMem(
    memDir,
    'feedback_sym.md',
    'name: s\ndescription: x\ntype: feedback\nverify:\n  - kind: symbol\n    value: someSymbol',
    'body',
  );

  try {
    const report = lintMemoryDirForStale(memDir, [repoA, repoB]);
    assert.equal(
      report.symbolCheckDegraded,
      true,
      'all roots non-git: symbol checks fully degraded',
    );
    // The hit must be `skipped`, not `no-matches` (no real check ran).
    assert.equal(
      report.hits.filter((h: { status: string }) => h.status === 'skipped').length,
      1,
    );
    assert.equal(
      report.hits.filter((h: { status: string }) => h.status === 'no-matches').length,
      0,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('multi-root: symbol-degraded FALSE when at least one root is git', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-stale-multi-sym-deg-'));
  const memDir = path.join(root, 'memories');
  const repoA = path.join(root, 'repoA');
  const repoB = path.join(root, 'repoB');
  fs.mkdirSync(memDir);
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  // Only repoA has git initialised.
  spawnSync('git', ['init', '-q'], { cwd: repoA });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: repoA });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repoA });
  fs.writeFileSync(path.join(repoA, 'lib.ts'), 'export function knownFn() {}\n');
  spawnSync('git', ['add', '-A'], { cwd: repoA });
  spawnSync('git', ['commit', '-m', 's', '-q'], { cwd: repoA });
  writeMem(
    memDir,
    'feedback_sym.md',
    'name: s\ndescription: x\ntype: feedback\nverify:\n  - kind: symbol\n    value: knownFn',
    'body',
  );

  try {
    const report = lintMemoryDirForStale(memDir, [repoA, repoB]);
    // repoA finds it → not stale; degraded must be false because repoA
    // is a real git repo.
    assert.equal(
      report.hits.filter((h: { status: string }) => h.status === 'no-matches').length,
      0,
    );
    assert.equal(
      report.symbolCheckDegraded,
      false,
      'one git root among several keeps symbol checks honest',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
