const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { loadMapping, matchMapping, MigrationMappingError } = require('../src/migrate/mapping');

function mkTmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-mapping-'));
  const file = path.join(dir, 'mapping.yml');
  fs.writeFileSync(file, content);
  return file;
}

test('loadMapping: parses id and prefix rules', () => {
  const file = mkTmpFile(
    `- prefix: "feedback_"\n  topics: [workflow]\n- id: "reference_thing"\n  topics: [testing, workflow]\n`,
  );
  const rules = loadMapping(file);
  assert.deepEqual(rules, [
    { prefix: 'feedback_', topics: ['workflow'] },
    { id: 'reference_thing', topics: ['testing', 'workflow'] },
  ]);
});

test('loadMapping: rejects a missing file', () => {
  assert.throws(
    () => loadMapping('/nonexistent/mapping.yml'),
    MigrationMappingError,
  );
});

test('loadMapping: rejects invalid YAML', () => {
  const file = mkTmpFile(': : :\n');
  assert.throws(() => loadMapping(file), /YAML parse error/);
});

test('loadMapping: rejects a non-list top level', () => {
  const file = mkTmpFile('rules:\n  - id: x\n    topics: [a]\n');
  assert.throws(() => loadMapping(file), /expected a top-level list/);
});

test('loadMapping: rejects an entry with neither id nor prefix', () => {
  const file = mkTmpFile('- topics: [a]\n');
  assert.throws(() => loadMapping(file), /must set exactly one of 'id' or 'prefix'/);
});

test('loadMapping: rejects an entry with both id and prefix', () => {
  const file = mkTmpFile('- id: x\n  prefix: y\n  topics: [a]\n');
  assert.throws(() => loadMapping(file), /must set exactly one of 'id' or 'prefix'/);
});

test('loadMapping: rejects missing/empty topics', () => {
  const file = mkTmpFile('- id: x\n');
  assert.throws(() => loadMapping(file), /field 'topics' must be a non-empty list/);
  const file2 = mkTmpFile('- id: x\n  topics: []\n');
  assert.throws(() => loadMapping(file2), /field 'topics' must be a non-empty list/);
});

test('loadMapping: rejects a non-string topic entry', () => {
  const file = mkTmpFile('- id: x\n  topics: [1]\n');
  assert.throws(() => loadMapping(file), /topics\[0\] must be a non-empty string/);
});

test('matchMapping: exact id match', () => {
  const rules = [{ id: 'feedback_a', topics: ['t1'] }];
  assert.deepEqual(matchMapping('feedback_a', rules), ['t1']);
  assert.equal(matchMapping('feedback_b', rules), null);
});

test('matchMapping: prefix match', () => {
  const rules = [{ prefix: 'feedback_', topics: ['t1'] }];
  assert.deepEqual(matchMapping('feedback_anything', rules), ['t1']);
  assert.equal(matchMapping('reference_anything', rules), null);
});

test('matchMapping: first rule wins in file order', () => {
  const rules = [
    { prefix: 'feedback_', topics: ['broad'] },
    { id: 'feedback_specific', topics: ['narrow'] },
  ];
  // The broad prefix rule is declared first, so it wins even though the
  // narrower id rule would also match.
  assert.deepEqual(matchMapping('feedback_specific', rules), ['broad']);
});

test('matchMapping: no rules matches nothing', () => {
  assert.equal(matchMapping('anything', []), null);
});

test('matchMapping: returns a fresh array, not the rule’s own array reference', () => {
  const rules = [{ id: 'x', topics: ['t1'] }];
  const hit = matchMapping('x', rules) as string[];
  hit.push('mutated');
  assert.deepEqual(rules[0].topics, ['t1'], 'the rule set must not be mutated by a caller');
});
