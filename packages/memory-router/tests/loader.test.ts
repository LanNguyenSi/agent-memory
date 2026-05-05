const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { loadMemoriesFromDir } = require('../src/memory/loader');

const fixturesDir = path.join(__dirname, 'fixtures', 'memories');

test('legacy memories without new fields still load', () => {
  const memories = loadMemoriesFromDir(fixturesDir);
  const legacy = memories.find((m: Memory) => m.id === 'feedback_legacy');
  assert.ok(legacy, 'legacy fixture should load');
  assert.equal(legacy.frontmatter.topics, undefined);
  assert.equal(legacy.frontmatter.severity, undefined);
  assert.equal(legacy.frontmatter.triggers, undefined);
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
