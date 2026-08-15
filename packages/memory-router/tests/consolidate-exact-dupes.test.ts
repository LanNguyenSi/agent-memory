// Direct unit tests for src/consolidate/exact-dupes.ts.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findExactDupes,
  findEmptyBodies,
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

// mm-v1-T007 fix round LOW #9: empty/whitespace-only bodies never form a
// dupe group; they're reported separately.
test('findExactDupes: two memories with empty bodies never form a dupe group', () => {
  const memories = [memory('empty_a', ''), memory('empty_b', '   \n\t  ')];
  assert.deepEqual(findExactDupes(memories), []);
});

test('findExactDupes: an empty-body memory does not suppress a real dupe group among the others', () => {
  const memories = [
    memory('empty_only', ''),
    memory('z_second', 'Always run tests.  Always run tests.'),
    memory('a_first', 'always run tests. always run tests.'),
  ];
  const groups = findExactDupes(memories);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ['a_first', 'z_second']);
});

test('findEmptyBodies: reports empty and whitespace-only bodies, sorted by id, non-empty bodies excluded', () => {
  const memories = [
    memory('z_blank', '   '),
    memory('a_blank', ''),
    memory('has_content', 'something here'),
  ];
  assert.deepEqual(findEmptyBodies(memories), [
    { id: 'a_blank', path: '/corpus/a_blank.md' },
    { id: 'z_blank', path: '/corpus/z_blank.md' },
  ]);
});

test('findEmptyBodies: a corpus with no empty bodies returns an empty list', () => {
  assert.deepEqual(findEmptyBodies([memory('only', 'nothing to see here')]), []);
});

test('findEmptyBodies: empty corpus returns an empty list', () => {
  assert.deepEqual(findEmptyBodies([]), []);
});

test('findExactDupes: member order within a group is code-unit (Zulu before alpha), not locale order', () => {
  const groups = findExactDupes([
    memory('alpha', 'shared body'),
    memory('Zulu', 'shared body'),
  ]);
  assert.equal(groups.length, 1);
  // Uppercase 'Z' (code unit 90) before lowercase 'a' (97); an en-US
  // localeCompare would order alpha first. Pins the byId comparator.
  assert.deepEqual(groups[0].ids, ['Zulu', 'alpha']);
});

test('findExactDupes: group order is code-unit by first member id, not locale order', () => {
  const groups = findExactDupes([
    memory('ag', 'second group body'),
    memory('zz8', 'second group body'),
    memory('Zg', 'first group body'),
    memory('zz9', 'first group body'),
  ]);
  assert.equal(groups.length, 2);
  // Group led by 'Zg' sorts before the group led by 'ag' in code-unit
  // order; locale collation would invert them. Pins the group comparator.
  assert.deepEqual(groups.map((g: { ids: string[] }) => g.ids[0]), ['Zg', 'ag']);
});

test('findEmptyBodies: order is code-unit (Zempty before aempty), not locale order', () => {
  const entries = findEmptyBodies([
    memory('aempty', '   '),
    memory('Zempty', ''),
    memory('kept', 'real body'),
  ]);
  // Pins the byId comparator on the empty-body list.
  assert.deepEqual(entries.map((e: { id: string }) => e.id), ['Zempty', 'aempty']);
});
