// Unit tests for src/vocab/loader.ts: the <memoryDir>/topics.yml loader that
// backs both the Topic Gate (src/gates/topic.ts) and the topics linter
// (src/lint/topics.ts). Covers: vocabulary present/absent/broken, custom
// topic match, default fallback, and single-bad-pattern degradation.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const {
  loadVocabulary,
  loadVocabularyOrThrow,
  loadVocabularyResult,
  matchedTopicsForVocabulary,
  defaultVocabulary,
  VocabularyError,
} = require('../src/vocab/loader');
const { TOPIC_PATTERNS } = require('../src/topic-patterns');

const FIXTURE_VOCAB_DIR = path.join(__dirname, 'fixtures', 'vocab');

function makeTmpDir(prefix = 'memory-router-vocab-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVocab(dir: string, contents: string): void {
  fs.writeFileSync(path.join(dir, 'topics.yml'), contents);
}

test('missing topics.yml: default vocabulary, unchanged built-in set', () => {
  const dir = makeTmpDir();
  const vocab = loadVocabularyOrThrow(dir);
  assert.equal(vocab.source, 'default');
  assert.deepEqual(
    [...vocab.topicNames].sort(),
    Object.keys(TOPIC_PATTERNS).sort(),
  );
  // Deep-equal, not the same object: defaultVocabulary() returns a
  // defensive copy (see the isolation test below) so a caller mutating the
  // returned vocabulary can never corrupt the module-level TOPIC_PATTERNS.
  assert.deepEqual(vocab.patterns, TOPIC_PATTERNS);
});

test('defaultVocabulary(): returns a defensive copy — mutating the return value does not leak into TOPIC_PATTERNS or a later call', () => {
  const before = TOPIC_PATTERNS.deployment.length;
  const vocab1 = defaultVocabulary();
  vocab1.patterns.deployment.push(/should-not-leak-anywhere/i);

  assert.equal(
    TOPIC_PATTERNS.deployment.length,
    before,
    'module-level TOPIC_PATTERNS must be untouched by a mutation on the returned vocabulary',
  );

  const vocab2 = defaultVocabulary();
  assert.equal(
    vocab2.patterns.deployment.length,
    before,
    'a second, independent call must not see the first call\'s leaked mutation either',
  );
});

test('undefined memoryDir: default vocabulary, no error', () => {
  const result = loadVocabularyResult(undefined);
  assert.equal(result.error, null);
  assert.equal(result.vocabulary.source, 'default');
});

test('defaultVocabulary(): matches topic-patterns.ts exactly', () => {
  const vocab = defaultVocabulary();
  assert.deepEqual(
    [...vocab.topicNames].sort(),
    Object.keys(TOPIC_PATTERNS).sort(),
  );
});

test('valid custom vocabulary loads and overrides the built-in default', () => {
  const vocab = loadVocabularyOrThrow(FIXTURE_VOCAB_DIR);
  assert.equal(vocab.source, 'custom');
  assert.deepEqual(vocab.topicNames, [
    'deployment',
    'incident_response',
    'data_privacy',
  ]);
  // Custom topic not present in the built-in default at all.
  assert.ok(!('incident_response' in TOPIC_PATTERNS));
});

test('custom topic matches via its declared pattern', () => {
  const vocab = loadVocabularyOrThrow(FIXTURE_VOCAB_DIR);
  const hits = matchedTopicsForVocabulary(
    'we had an outage last night, on-call got paged',
    vocab,
  );
  assert.ok(hits.includes('incident_response'), hits.join(', '));
});

test('custom vocabulary loading does not fall back to defaults for unrelated prompts', () => {
  const vocab = loadVocabularyOrThrow(FIXTURE_VOCAB_DIR);
  // "testing" is a built-in default topic but is NOT part of this custom
  // vocabulary, so a prompt about tests must not match anything.
  const hits = matchedTopicsForVocabulary('let us write more vitest specs', vocab);
  assert.deepEqual(hits, []);
});

test('broken YAML: loadVocabularyOrThrow throws VocabularyError with a clear message', () => {
  const dir = makeTmpDir();
  writeVocab(dir, '- name: [unterminated\n');
  assert.throws(
    () => loadVocabularyOrThrow(dir),
    (err: unknown) => {
      assert.ok(err instanceof VocabularyError);
      assert.match((err as Error).message, /topics\.yml/);
      return true;
    },
  );
});

test('broken YAML: loadVocabularyResult never throws, falls back to default with .error set', () => {
  const dir = makeTmpDir();
  writeVocab(dir, '- name: [unterminated\n');
  const result = loadVocabularyResult(dir);
  assert.equal(result.vocabulary.source, 'default');
  assert.ok(result.error && /topics\.yml/.test(result.error));
});

test('loadVocabulary(): never throws, plain vocabulary return on broken file', () => {
  const dir = makeTmpDir();
  writeVocab(dir, '- name: [unterminated\n');
  const vocab = loadVocabulary(dir);
  assert.equal(vocab.source, 'default');
});

test('missing required field "name" is rejected', () => {
  const dir = makeTmpDir();
  writeVocab(dir, '- description: no name here\n  patterns: ["foo"]\n');
  assert.throws(() => loadVocabularyOrThrow(dir), /name/);
});

test('duplicate topic names are rejected', () => {
  const dir = makeTmpDir();
  writeVocab(
    dir,
    '- name: dup\n  patterns: ["foo"]\n- name: dup\n  patterns: ["bar"]\n',
  );
  assert.throws(() => loadVocabularyOrThrow(dir), /duplicate/i);
});

test('non-list top-level value is rejected', () => {
  const dir = makeTmpDir();
  writeVocab(dir, 'name: not-a-list\n');
  assert.throws(() => loadVocabularyOrThrow(dir), /top-level list/);
});

test('empty vocabulary (empty list) is rejected', () => {
  const dir = makeTmpDir();
  writeVocab(dir, '[]\n');
  assert.throws(() => loadVocabularyOrThrow(dir), /empty/);
});

test('non-list "patterns" field is rejected', () => {
  const dir = makeTmpDir();
  writeVocab(dir, '- name: bad\n  patterns: "not-a-list"\n');
  assert.throws(() => loadVocabularyOrThrow(dir), /patterns/);
});

test('non-string entry in "patterns" is rejected', () => {
  const dir = makeTmpDir();
  writeVocab(dir, '- name: bad\n  patterns: [42]\n');
  assert.throws(() => loadVocabularyOrThrow(dir), /patterns\[0\]/);
});

test('single non-compiling pattern degrades to keyword match on the topic name, does not throw or drop the topic', () => {
  const dir = makeTmpDir();
  writeVocab(
    dir,
    '- name: broken_pattern_topic\n  patterns:\n    - "(unclosed"\n    - "\\\\bvalid\\\\b"\n',
  );
  const vocab = loadVocabularyOrThrow(dir); // must not throw
  assert.equal(vocab.topicNames.length, 1);
  assert.equal(vocab.patterns.broken_pattern_topic.length, 2);

  // The valid sibling pattern still works.
  assert.ok(
    matchedTopicsForVocabulary('this is valid input', vocab).includes(
      'broken_pattern_topic',
    ),
  );
  // The broken pattern degraded to a keyword match on the topic's own name.
  assert.ok(
    matchedTopicsForVocabulary(
      'mentions broken_pattern_topic by name',
      vocab,
    ).includes('broken_pattern_topic'),
  );
});

test('topic entry with no "patterns" at all falls back to keyword match on its name', () => {
  const dir = makeTmpDir();
  writeVocab(dir, '- name: no_patterns_topic\n  description: bare topic\n');
  const vocab = loadVocabularyOrThrow(dir);
  assert.equal(vocab.patterns.no_patterns_topic.length, 1);
  assert.ok(
    matchedTopicsForVocabulary(
      'talking about no_patterns_topic today',
      vocab,
    ).includes('no_patterns_topic'),
  );
  assert.deepEqual(
    matchedTopicsForVocabulary('unrelated prompt', vocab),
    [],
  );
});

test('entry that is not a mapping (e.g. a bare string) is rejected', () => {
  const dir = makeTmpDir();
  writeVocab(dir, '- just-a-string\n');
  assert.throws(() => loadVocabularyOrThrow(dir), /not a mapping/);
});

// --- ReDoS safety screen (HIGH fix) --------------------------------------

test('unsafe pattern (nested-quantifier ReDoS shape) is rejected, degrades to keyword match on the topic name, does not throw or drop the topic', () => {
  const dir = makeTmpDir();
  writeVocab(
    dir,
    '- name: redos_topic\n  patterns:\n    - "^(a+)+$"\n    - "\\\\bvalid\\\\b"\n',
  );
  const vocab = loadVocabularyOrThrow(dir); // must not throw
  assert.equal(vocab.topicNames.length, 1);
  assert.equal(vocab.patterns.redos_topic.length, 2);

  // The valid sibling pattern still works.
  assert.ok(
    matchedTopicsForVocabulary('this is valid input', vocab).includes(
      'redos_topic',
    ),
  );
  // The unsafe pattern degraded to a keyword match on the topic's own name
  // rather than being compiled and run.
  assert.ok(
    matchedTopicsForVocabulary('mentions redos_topic by name', vocab).includes(
      'redos_topic',
    ),
  );
});

test('unsafe pattern never reaches RegExp: a classic catastrophic-backtracking input resolves in milliseconds', () => {
  const dir = makeTmpDir();
  writeVocab(dir, '- name: redos_topic\n  patterns:\n    - "^(a+)+$"\n');
  const vocab = loadVocabularyOrThrow(dir);

  // Bait string: against the raw `^(a+)+$` on a vulnerable engine this
  // would blow past any reasonable per-gate time budget. Against the
  // keyword-fallback regex it degraded to, it's a plain substring scan.
  const evilInput = 'a'.repeat(35) + '!';
  const start = Date.now();
  matchedTopicsForVocabulary(evilInput, vocab);
  const elapsedMs = Date.now() - start;
  assert.ok(
    elapsedMs < 500,
    `gate run must stay in the millisecond range, took ${elapsedMs}ms`,
  );
});

test('overlong pattern (> 200 chars) is rejected by the same ReDoS screen, degrades to keyword match', () => {
  const dir = makeTmpDir();
  const overlong = 'a'.repeat(201);
  writeVocab(dir, `- name: overlong_topic\n  patterns:\n    - "${overlong}"\n`);
  const vocab = loadVocabularyOrThrow(dir);
  assert.ok(
    matchedTopicsForVocabulary('mentions overlong_topic by name', vocab).includes(
      'overlong_topic',
    ),
  );
});

// --- Name hygiene (MEDIUM fix): trimming + keyword-fallback boundary -----

test('name is trimmed before it becomes the topic key: whitespace-padded "name:" behaves identically to the trimmed form', () => {
  const dir = makeTmpDir();
  writeVocab(
    dir,
    '- name: "  deployment  "\n  patterns:\n    - "\\\\bship\\\\b"\n',
  );
  const vocab = loadVocabularyOrThrow(dir);
  assert.deepEqual(vocab.topicNames, ['deployment']);
  assert.ok('deployment' in vocab.patterns);
  assert.ok(
    matchedTopicsForVocabulary('time to ship', vocab).includes('deployment'),
  );
});

test('topic named ".env" with no patterns matches its own name via keyword fallback (lookaround boundary, not \\b)', () => {
  const dir = makeTmpDir();
  writeVocab(dir, '- name: .env\n');
  const vocab = loadVocabularyOrThrow(dir);
  // \b\.env\b can never match ".env" at all (the boundary immediately
  // touching the non-word '.' requires the OTHER side to be a word char,
  // which is never guaranteed for a name that starts on punctuation) — this
  // is exactly the bug the lookaround fix closes.
  assert.ok(
    matchedTopicsForVocabulary('check the .env file before committing', vocab)
      .includes('.env'),
  );
  assert.ok(
    matchedTopicsForVocabulary('.env holds secrets', vocab).includes('.env'),
  );
});

test('topic named "c++" with no patterns matches its own name via keyword fallback', () => {
  const dir = makeTmpDir();
  writeVocab(dir, '- name: "c++"\n');
  const vocab = loadVocabularyOrThrow(dir);
  assert.ok(
    matchedTopicsForVocabulary('I love c++ programming', vocab).includes(
      'c++',
    ),
  );
  assert.ok(
    matchedTopicsForVocabulary('rewrite it in c++', vocab).includes('c++'),
  );
});
