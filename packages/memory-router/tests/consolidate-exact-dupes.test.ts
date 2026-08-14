// Direct unit tests for src/consolidate/exact-dupes.ts.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findExactDupes,
  normalizeBody,
  hashBody,
  NORMALIZATION_DESCRIPTION,
} = require('../src/consolidate/exact-dupes');

function memory(id: string, body: string): Memory {
  return {
    id,
    path: `/corpus/${id}.md`,
    frontmatter: { name: id, description: '', type: 'reference' },
    body,
  };
}

test('normalizeBody: trims, collapses whitespace runs, lowercases', () => {
  assert.equal(
    normalizeBody('  Always  Run\n\tTests  '),
    'always run tests',
  );
});

test('hashBody: two bodies differing only by whitespace/case hash identically', () => {
  const a = hashBody('Always run the test suite.  Always run the   test suite.');
  const b = hashBody('always run the test suite. always run the test suite.');
  assert.equal(a, b);
});

test('hashBody: genuinely different bodies hash differently', () => {
  const a = hashBody('one thing');
  const b = hashBody('a completely different thing');
  assert.notEqual(a, b);
});

test('findExactDupes: groups memories whose normalized body matches, ids/paths sorted deterministically', () => {
  const memories = [
    memory('z_second', 'Always run tests.  Always run tests.'),
    memory('a_first', 'always run tests. always run tests.'),
    memory('unique', 'nothing else says this'),
  ];
  const groups = findExactDupes(memories);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ['a_first', 'z_second']);
  assert.deepEqual(groups[0].paths, ['/corpus/a_first.md', '/corpus/z_second.md']);
});

test('findExactDupes: a group of 3+ members is reported as one group, not pairwise', () => {
  const memories = [
    memory('c', 'same text'),
    memory('a', 'same text'),
    memory('b', 'SAME TEXT'),
  ];
  const groups = findExactDupes(memories);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ['a', 'b', 'c']);
});

test('findExactDupes: singletons (no other memory shares the hash) produce no group', () => {
  const memories = [memory('only', 'nothing to duplicate here')];
  assert.deepEqual(findExactDupes(memories), []);
});

test('findExactDupes: empty corpus returns no groups', () => {
  assert.deepEqual(findExactDupes([]), []);
});

test('NORMALIZATION_DESCRIPTION is a non-empty documented string', () => {
  assert.equal(typeof NORMALIZATION_DESCRIPTION, 'string');
  assert.ok(NORMALIZATION_DESCRIPTION.length > 0);
});
