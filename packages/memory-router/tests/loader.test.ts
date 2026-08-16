const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const {
  loadMemoriesFromDir,
  parseMemoryFileWithReason,
  parseFrontmatterYaml,
} = require('../src/memory/loader');

const fixturesDir = path.join(__dirname, 'fixtures', 'memories');

test('legacy memories without new fields still load', () => {
  const memories = loadMemoriesFromDir(fixturesDir);
  const legacy = memories.find((m: Memory) => m.id === 'feedback_legacy');
  assert.ok(legacy, 'legacy fixture should load');
  assert.deepEqual(legacy.frontmatter.topics, [], 'missing topics normalize to []');
  assert.equal(legacy.frontmatter.severity, undefined);
  assert.equal(legacy.frontmatter.triggers, undefined);
});

test('schema v1: type/topics resolve from metadata. with top-level precedence', () => {
  const dir = path.join(__dirname, 'fixtures', 'schema-v1');
  const memories = loadMemoriesFromDir(dir);
  const byId = new Map<string, Memory>(memories.map((m: Memory) => [m.id, m]));
  const mustGet = (id: string): Memory => {
    const m = byId.get(id);
    if (!m) throw new Error(`fixture ${id} should load`);
    return m;
  };

  const metadataOnly = mustGet('metadata-only');
  assert.equal(metadataOnly.frontmatter.type, 'reference');
  assert.deepEqual(metadataOnly.frontmatter.topics, ['workflow']);
  assert.equal(
    (metadataOnly.frontmatter as unknown as Record<string, unknown>).custom,
    'kept',
    'unknown frontmatter fields are tolerated and preserved',
  );

  const topLevel = mustGet('top-level');
  assert.equal(topLevel.frontmatter.type, 'feedback');
  assert.deepEqual(topLevel.frontmatter.topics, ['security']);

  const conflict = mustGet('mixed-conflict');
  assert.equal(conflict.frontmatter.type, 'project', 'top-level type wins');
  assert.deepEqual(
    conflict.frontmatter.topics,
    ['deployment'],
    'top-level topics win',
  );

  assert.equal(byId.has('no-type'), false, 'no type at either location: skipped');
  assert.equal(memories.length, 3);
});

test('schema v1: empty top-level type falls back to metadata.type', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-loader-'));
  fs.writeFileSync(
    path.join(tmp, 'empty-type.md'),
    '---\nname: x\ndescription: x\ntype: ""\nmetadata:\n  type: reference\n---\nbody\n',
  );
  try {
    const memories = loadMemoriesFromDir(tmp);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].frontmatter.type, 'reference');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('schema v1: type missing at both locations still warns via debug', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-loader-'));
  fs.writeFileSync(
    path.join(tmp, 'meta-no-type.md'),
    '---\nname: x\ndescription: x\nmetadata:\n  node_type: memory\n---\nbody\n',
  );
  process.env.MEMORY_ROUTER_DEBUG = '1';
  try {
    const { result, lines } = captureStderr(() => loadMemoriesFromDir(tmp));
    assert.equal(result.length, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /meta-no-type\.md: missing required field 'type'/);
  } finally {
    delete process.env.MEMORY_ROUTER_DEBUG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('unknown or non-string type is rejected with a debug warning', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-loader-'));
  fs.writeFileSync(
    path.join(tmp, 'unknown-type.md'),
    '---\nname: x\ndescription: x\ntype: howto\n---\nbody\n',
  );
  fs.writeFileSync(
    path.join(tmp, 'list-type.md'),
    '---\nname: x\ndescription: x\ntype: [user]\n---\nbody\n',
  );
  fs.writeFileSync(
    path.join(tmp, 'good.md'),
    '---\nname: good\ndescription: x\ntype: user\n---\nbody\n',
  );
  process.env.MEMORY_ROUTER_DEBUG = '1';
  try {
    const { result, lines } = captureStderr(() => loadMemoriesFromDir(tmp));
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'good');
    const joined = lines.join('');
    assert.match(
      joined,
      /unknown-type\.md: unknown type "howto" \(expected: user, feedback, project, reference\)/,
    );
    assert.match(joined, /list-type\.md: unknown type \["user"\]/);
  } finally {
    delete process.env.MEMORY_ROUTER_DEBUG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Direct unit test for parseMemoryFileWithReason (required export, see
// module.exports): pins the individual reject-reason strings in isolation,
// independent of any directory walk.
test('parseMemoryFileWithReason: reject reasons are pinned for each rejection cause', () => {
  assert.deepEqual(parseMemoryFileWithReason('x.md', '# heading only, no frontmatter\n'), {
    ok: false,
    reason: 'no YAML frontmatter delimiter (`---`) found',
  });

  const brokenYaml = parseMemoryFileWithReason('x.md', '---\n: : :\nname: x\n---\nbody\n');
  assert.equal(brokenYaml.ok, false);
  assert.match((brokenYaml as { reason: string }).reason, /^YAML parse error: /);

  assert.deepEqual(
    parseMemoryFileWithReason('x.md', '---\ntype: reference\ndescription: x\n---\nbody\n'),
    { ok: false, reason: "missing required field 'name'" },
  );

  assert.deepEqual(
    parseMemoryFileWithReason('x.md', '---\nname: x\ndescription: x\n---\nbody\n'),
    { ok: false, reason: "missing required field 'type'" },
  );

  assert.deepEqual(
    parseMemoryFileWithReason(
      'x.md',
      '---\nname: x\ndescription: x\ntype: howto\n---\nbody\n',
    ),
    {
      ok: false,
      reason: 'unknown type "howto" (expected: user, feedback, project, reference)',
    },
  );
});

// Direct unit test for parseFrontmatterYaml (required export, see
// module.exports): pins its three outcomes in isolation from
// parseMemoryFileWithReason's own field-requirement layer, since drift.ts
// depends on this function alone doing the delimiter-match-plus-YAML-parse
// step and nothing more.
test('parseFrontmatterYaml: ok, no-delimiter, and yaml-error outcomes are pinned', () => {
  const ok = parseFrontmatterYaml('---\nname: x\ndescription: y\ntype: reference\n---\nbody\n');
  assert.equal(ok.ok, true);
  assert.deepEqual((ok as { raw: unknown }).raw, {
    name: 'x',
    description: 'y',
    type: 'reference',
  });
  // `body` is the raw, unprocessed capture (no trim/strip): applier.ts's
  // planChange consumes this directly and applies its own normalization on
  // top (see tests/applier.test.ts's body-normalization tests).
  assert.equal((ok as { body: string }).body, 'body\n');

  const noDelimiter = parseFrontmatterYaml('# heading only, no frontmatter\n');
  assert.deepEqual(noDelimiter, { ok: false, kind: 'no-delimiter' });

  const yamlError = parseFrontmatterYaml('---\n: : :\nname: x\n---\nbody\n');
  assert.equal(yamlError.ok, false);
  assert.equal((yamlError as { kind: string }).kind, 'yaml-error');
  assert.ok(
    (yamlError as { detail: string }).detail.length > 0,
    'yaml-error carries a non-empty detail message',
  );
  // Pin the exact key set on the yaml-error branch, not just individual
  // field presence: catches a stray/renamed key that individual assertions
  // above would miss.
  assert.deepEqual(Object.keys(yamlError).sort(), ['detail', 'error', 'kind', 'ok']);
  // `error` carries the original caught exception (not just its message):
  // applier.ts's planChange rethrows it verbatim to preserve the pre-dedup
  // thrown-error identity (its `${String(err)}` starts with the class name,
  // e.g. "YAMLParseError:", not a generic "Error:").
  const rawError = (yamlError as { error: unknown }).error;
  assert.ok(rawError instanceof Error, 'error is the original Error instance');
  assert.match(String(rawError), /^YAMLParseError: /);
  assert.equal((rawError as Error).message, (yamlError as { detail: string }).detail);
});

// CRLF ok-case: FRONTMATTER_RE's `\r?\n` must match a CRLF-delimited
// frontmatter block exactly like an LF one, both for the delimiter match
// and for what ends up in `raw`/`body`. Without this, a CRLF-blind regex
// mutant only surfaces indirectly through the write path (see
// tests/applier.test.ts's CRLF test); this pins the parse step itself.
test('parseFrontmatterYaml: CRLF-delimited frontmatter parses the same as LF', () => {
  const ok = parseFrontmatterYaml(
    '---\r\nname: x\r\ndescription: y\r\ntype: reference\r\n---\r\n\r\nbody\r\n',
  );
  assert.equal(ok.ok, true);
  assert.deepEqual((ok as { raw: unknown }).raw, {
    name: 'x',
    description: 'y',
    type: 'reference',
  });
  assert.equal((ok as { body: string }).body, '\r\nbody\r\n');
});

test('MEMORY.md is skipped by the loader', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-loader-'));
  fs.writeFileSync(
    path.join(tmp, 'MEMORY.md'),
    '---\nname: index\ndescription: x\ntype: reference\n---\n\nindex body\n',
  );
  fs.writeFileSync(
    path.join(tmp, 'real.md'),
    '---\nname: real\ndescription: x\ntype: reference\n---\n\nreal body\n',
  );
  try {
    const memories = loadMemoriesFromDir(tmp);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].id, 'real');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('corpus load order is lexicographic code-unit order, independent of readdir order', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-loader-'));
  const names = ['alpha.md', 'bravo.md', 'delta.md', 'Zulu.md'];
  for (const name of names) {
    fs.writeFileSync(
      path.join(tmp, name),
      `---\nname: ${path.basename(name, '.md')}\ndescription: x\ntype: reference\n---\nbody\n`,
    );
  }
  // Simulate a hash-ordered filesystem (e.g. ext4 dir_index) with a fixed
  // scrambled readdir result, so this test pins the loader's own sort on
  // every platform instead of the host filesystem's incidental ordering.
  // The loader destructures readdirSync at module load, so patch fs first
  // and require a fresh module instance. The stub is scoped to the fixture
  // dir (everything else passes through) so the cache-miss require below,
  // and any other dynamic fs use in the patched window, stays unaffected.
  const loaderPath = require.resolve('../src/memory/loader');
  const realReaddirSync = fs.readdirSync;
  (fs as unknown as { readdirSync: (dir: string) => string[] }).readdirSync = (
    dir: string,
  ) =>
    dir === tmp
      ? ['bravo.md', 'Zulu.md', 'delta.md', 'alpha.md']
      : (realReaddirSync as unknown as (dir: string) => string[])(dir);
  try {
    delete require.cache[loaderPath];
    const { loadMemoriesFromDir: freshLoad } = require(loaderPath);
    const ids = freshLoad(tmp).map((m: Memory) => m.id);
    // 'Zulu' before 'alpha': uppercase code units sort first. This pins the
    // comparator choice (code-unit order, not locale-aware collation).
    assert.deepEqual(ids, ['Zulu', 'alpha', 'bravo', 'delta']);
  } finally {
    (fs as unknown as { readdirSync: typeof realReaddirSync }).readdirSync =
      realReaddirSync;
    delete require.cache[loaderPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('flat-score ties preserve corpus load order through resolve() (hook injection order)', () => {
  // Companion pin to the loader-sort test above: the loader guarantees
  // lexicographic load order, and this asserts the resolver does not
  // re-order flat-score ties on its own (stable sort over insertion-ordered
  // dedupe). Input order is deliberately non-lexicographic so the test
  // catches any resolver-side re-keying, not just an unstable sort.
  const { resolve } = require('../src/router');
  const mk = (id: string): Memory => ({
    id,
    path: `/corpus/${id}.md`,
    frontmatter: {
      name: id,
      description: 'x',
      type: 'reference',
      topics: ['testing'],
    },
    body: 'body',
  });
  const memories = [mk('zeta'), mk('alpha'), mk('mid')];
  const prevDir = process.env.MEMORY_ROUTER_DIR;
  delete process.env.MEMORY_ROUTER_DIR;
  try {
    const hits = resolve({ prompt: 'please run the tests' }, memories);
    assert.deepEqual(
      hits.map((h: GateHit) => h.memory.id),
      ['zeta', 'alpha', 'mid'],
      'tied hits must come out in the memories-array (load) order',
    );
  } finally {
    if (prevDir !== undefined) process.env.MEMORY_ROUTER_DIR = prevDir;
  }
});

test('file without frontmatter is rejected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-loader-'));
  fs.writeFileSync(path.join(tmp, 'plain.md'), '# just a heading\n');
  try {
    const memories = loadMemoriesFromDir(tmp);
    assert.equal(memories.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Capture writes to process.stderr inside a single test, restoring the
// original write on exit (including thrown exceptions).
function captureStderr<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // Cast through unknown because process.stderr.write has multiple overloads
  // we don't need to satisfy here — only the one-arg string form.
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (
    chunk: string,
  ) => {
    lines.push(chunk);
    return true;
  };
  try {
    return { result: fn(), lines };
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
}

test('debug off (default): broken memories produce no stderr output', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-loader-'));
  fs.writeFileSync(path.join(tmp, 'broken.md'), '---\n: : :\nname: x\n---\nbody\n');
  fs.writeFileSync(path.join(tmp, 'no-frontmatter.md'), '# heading only\n');
  fs.writeFileSync(
    path.join(tmp, 'good.md'),
    '---\nname: good\ndescription: x\ntype: reference\n---\n\nbody\n',
  );
  delete process.env.MEMORY_ROUTER_DEBUG;
  try {
    const { result, lines } = captureStderr(() => loadMemoriesFromDir(tmp));
    assert.equal(result.length, 1, 'only the well-formed memory loads');
    assert.equal(result[0].id, 'good');
    assert.equal(lines.length, 0, 'no stderr output when debug is off');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('debug on: each rejected memory produces exactly one stderr line', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-loader-'));
  fs.writeFileSync(path.join(tmp, 'bad-yaml.md'), '---\n: : :\nname: x\n---\nbody\n');
  fs.writeFileSync(path.join(tmp, 'no-frontmatter.md'), '# heading only\n');
  fs.writeFileSync(
    path.join(tmp, 'no-name.md'),
    '---\ntype: reference\ndescription: x\n---\nbody\n',
  );
  fs.writeFileSync(
    path.join(tmp, 'no-type.md'),
    '---\nname: x\ndescription: x\n---\nbody\n',
  );
  fs.writeFileSync(
    path.join(tmp, 'good.md'),
    '---\nname: good\ndescription: x\ntype: reference\n---\n\nbody\n',
  );
  process.env.MEMORY_ROUTER_DEBUG = '1';
  try {
    const { result, lines } = captureStderr(() => loadMemoriesFromDir(tmp));
    assert.equal(result.length, 1);
    // 4 rejections, one stderr line each. We don't assert the order because
    // readdir order is filesystem-dependent.
    assert.equal(lines.length, 4, `expected 4 warning lines, got ${lines.length}`);
    for (const line of lines) {
      assert.ok(
        line.startsWith('[memory-router] '),
        `expected prefix, got: ${line}`,
      );
      assert.ok(line.endsWith('\n'), 'each warning is a single newline-terminated line');
      // Exactly one trailing newline, no embedded newlines from multi-line
      // YAML parser errors. Keeps `grep`/`awk` filtering predictable.
      assert.equal(
        (line.match(/\n/g) || []).length,
        1,
        `warning must be a single line, got: ${JSON.stringify(line)}`,
      );
    }
    const joined = lines.join('');
    assert.match(joined, /bad-yaml\.md: YAML parse error/);
    assert.match(joined, /no-frontmatter\.md: no YAML frontmatter delimiter/);
    assert.match(joined, /no-name\.md: missing required field 'name'/);
    assert.match(joined, /no-type\.md: missing required field 'type'/);
  } finally {
    delete process.env.MEMORY_ROUTER_DEBUG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('debug on: unreadable directory emits one warning, returns empty list', () => {
  const missing = path.join(os.tmpdir(), `memory-router-missing-${Date.now()}`);
  process.env.MEMORY_ROUTER_DEBUG = '1';
  try {
    const { result, lines } = captureStderr(() => loadMemoriesFromDir(missing));
    assert.equal(result.length, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /could not read memory dir/);
  } finally {
    delete process.env.MEMORY_ROUTER_DEBUG;
  }
});

test('debug on: hook stdout contract is unaffected (loader writes only to stderr)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-loader-'));
  fs.writeFileSync(path.join(tmp, 'broken.md'), '# no frontmatter\n');
  process.env.MEMORY_ROUTER_DEBUG = '1';
  const stdoutChunks: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (
    chunk: string,
  ) => {
    stdoutChunks.push(chunk);
    return true;
  };
  try {
    const { lines } = captureStderr(() => loadMemoriesFromDir(tmp));
    assert.ok(lines.length > 0, 'stderr received the warning');
    assert.equal(stdoutChunks.length, 0, 'stdout must remain untouched');
  } finally {
    (process.stdout as unknown as { write: typeof originalStdout }).write =
      originalStdout;
    delete process.env.MEMORY_ROUTER_DEBUG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
