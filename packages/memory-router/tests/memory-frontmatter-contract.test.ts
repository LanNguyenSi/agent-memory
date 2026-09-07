const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadMemoriesFromDirWithRejects } = require('../src/memory/loader');

const contractRoot = path.join(__dirname, '..', 'contracts', 'memory-frontmatter-v1');
const casesDir = path.join(contractRoot, 'cases');
const manifest = JSON.parse(fs.readFileSync(path.join(contractRoot, 'manifest.json'), 'utf8')) as {
  schema: string;
  cases: { file: string; accepted: boolean; resolvedType?: string }[];
};

test('memory-frontmatter/v1 manifest fully specifies runtime loader outcomes', () => {
  assert.equal(manifest.schema, 'memory-frontmatter/v1');
  assert.ok(manifest.cases.length > 0);

  const seenFiles = new Set<string>();
  for (const entry of manifest.cases) {
    assert.match(entry.file, /^cases\/[a-z0-9-]+\.md$/);
    assert.ok(!seenFiles.has(entry.file), `duplicate manifest case ${entry.file}`);
    seenFiles.add(entry.file);
    if (entry.accepted) {
      assert.equal(typeof entry.resolvedType, 'string', `${entry.file} needs resolvedType`);
    } else {
      assert.equal('resolvedType' in entry, false, `${entry.file} must not have resolvedType`);
    }
  }

  const corpusFiles = fs
    .readdirSync(casesDir)
    .filter((file: string) => file.endsWith('.md'))
    .map((file: string) => `cases/${file}`)
    .sort();
  assert.deepEqual([...seenFiles].sort(), corpusFiles, 'manifest accounts for every case');

  const outcomes = new Map<string, MemoryScanEntry>(
    loadMemoriesFromDirWithRejects(casesDir).map(
      (entry: MemoryScanEntry): [string, MemoryScanEntry] => [
        `cases/${path.basename(entry.path)}`,
        entry,
      ],
    ),
  );
  assert.equal(outcomes.size, manifest.cases.length, 'runtime visits every manifest case');

  for (const expected of manifest.cases) {
    const outcome = outcomes.get(expected.file);
    assert.ok(outcome, `${expected.file} has a runtime outcome`);
    if (!outcome) throw new Error(`${expected.file} has no runtime outcome`);
    assert.equal(outcome.ok, expected.accepted, `${expected.file} accepted state`);
    if (expected.accepted) {
      assert.equal(
        (outcome as { ok: true; memory: Memory }).memory.frontmatter.type,
        expected.resolvedType,
        `${expected.file} resolved type`,
      );
    }
  }
});

test('memory-frontmatter/v1 preserves CRLF bytes for the CRLF case', () => {
  const bytes = fs.readFileSync(path.join(casesDir, 'crlf.md'));
  assert.ok(bytes.includes(Buffer.from('\r\n')), 'CRLF delimiter bytes are present');
  assert.equal(bytes.every((byte: number, index: number) => byte !== 10 || index > 0 && bytes[index - 1] === 13), true);
});
