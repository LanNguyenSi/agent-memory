const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const {
  lintMemoryDirForUnknownTopics,
  formatReportText,
  __nearestKnownTopic,
  __levenshtein,
} = require('../src/lint/topics');
const { TOPIC_PATTERNS } = require('../src/topic-patterns');

const KNOWN_TOPICS = Object.keys(TOPIC_PATTERNS);

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

function makeTmpDir(prefix = 'memory-router-lint-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('all-known fixtures: empty hits, exit-0 signal', () => {
  const dir = makeTmpDir();
  writeMemory(
    dir,
    'all-known.md',
    'name: a\ndescription: x\ntype: feedback\ntopics:\n  - workflow\n  - testing',
  );

  const report = lintMemoryDirForUnknownTopics(dir);
  assert.equal(report.hits.length, 0);
  assert.equal(report.scannedCount, 1);
});

test('flags unknown topic alongside known ones', () => {
  const dir = makeTmpDir();
  writeMemory(
    dir,
    'mixed.md',
    'name: a\ndescription: x\ntype: feedback\ntopics:\n  - workflow\n  - foo-bar',
  );

  const report = lintMemoryDirForUnknownTopics(dir);
  assert.equal(report.hits.length, 1);
  assert.equal(report.hits[0].unknownTopic, 'foo-bar');
  assert.equal(report.hits[0].memoryId, 'mixed');
  assert.equal(report.hits[0].suggestion, null); // distance > 2 from anything
});

test('suggests nearest known topic when distance ≤ 2', () => {
  const dir = makeTmpDir();
  writeMemory(
    dir,
    'typo.md',
    'name: a\ndescription: x\ntype: feedback\ntopics:\n  - tesing',
  );

  const report = lintMemoryDirForUnknownTopics(dir);
  assert.equal(report.hits.length, 1);
  assert.equal(report.hits[0].suggestion, 'testing');
});

test('memories without topics field are not flagged', () => {
  const dir = makeTmpDir();
  writeMemory(dir, 'no-topics.md', 'name: a\ndescription: x\ntype: feedback');

  const report = lintMemoryDirForUnknownTopics(dir);
  assert.equal(report.hits.length, 0);
  assert.equal(report.scannedCount, 1);
});

test('aggregates hits across multiple files', () => {
  const dir = makeTmpDir();
  writeMemory(
    dir,
    'a.md',
    'name: a\ndescription: x\ntype: feedback\ntopics:\n  - alpha',
  );
  writeMemory(
    dir,
    'b.md',
    'name: b\ndescription: x\ntype: feedback\ntopics:\n  - beta\n  - workflow',
  );

  const report = lintMemoryDirForUnknownTopics(dir);
  assert.equal(report.hits.length, 2);
  const unknowns = report.hits.map((h: any) => h.unknownTopic).sort();
  assert.deepEqual(unknowns, ['alpha', 'beta']);
});

test('formatReportText: success message when hits empty', () => {
  const text = formatReportText({ hits: [], scannedCount: 5 });
  assert.match(text, /no unknown topics/);
  assert.match(text, /5 memory file/);
});

test('formatReportText: per-hit line + summary when hits present', () => {
  const text = formatReportText({
    hits: [
      {
        path: '/x/foo.md',
        memoryId: 'foo',
        unknownTopic: 'bar',
        suggestion: 'baz',
      },
    ],
    scannedCount: 1,
  });
  assert.match(text, /\/x\/foo\.md/);
  assert.match(text, /unknown topic 'bar'/);
  assert.match(text, /did you mean 'baz'/);
});

test('Levenshtein helper: known distances', () => {
  assert.equal(__levenshtein('', ''), 0);
  assert.equal(__levenshtein('abc', 'abc'), 0);
  assert.equal(__levenshtein('abc', 'abd'), 1);
  assert.equal(__levenshtein('tesing', 'testing'), 1);
  assert.equal(__levenshtein('kitten', 'sitting'), 3);
});

test('nearestKnownTopic returns null beyond max distance', () => {
  const result = __nearestKnownTopic('completely-unrelated', KNOWN_TOPICS);
  assert.equal(result, null);
});

test('nearestKnownTopic returns closest within distance', () => {
  assert.equal(__nearestKnownTopic('tesing', KNOWN_TOPICS), 'testing');
  assert.equal(__nearestKnownTopic('workfow', KNOWN_TOPICS), 'workflow');
});
