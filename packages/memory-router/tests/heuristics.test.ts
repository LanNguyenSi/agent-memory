const test = require('node:test');
const assert = require('node:assert/strict');
const { proposeFrontmatter } = require('../src/tag/heuristics');

test('feedback with deployment-heavy body gets [deployment] + critical', () => {
  const p = proposeFrontmatter({
    id: 'feedback_vps_compose_drift',
    name: 'VPS compose drift',
    description: 'Never carry deployment patches — will destroy deploy state',
    body: 'Deploy via docker compose. Never force-push. Overwrites production safely.',
    type: 'feedback',
  });
  assert.ok(p.topics?.includes('deployment'));
  assert.equal(p.severity, 'critical');
});

test('feedback about vitest mocks gets [testing] + normal severity', () => {
  const p = proposeFrontmatter({
    id: 'feedback_vitest_mock_queue',
    name: 'vitest mock queue leak',
    description: 'vi.clearAllMocks does not drain mockResolvedValueOnce queues',
    body: 'When testing with vitest, prefer mockReset over clearAllMocks for the once-queue. A mild preference.',
    type: 'feedback',
  });
  assert.deepEqual(p.topics, ['testing']);
  assert.equal(p.severity, 'normal');
});

test('single body mention does not trigger tagging', () => {
  const p = proposeFrontmatter({
    id: 'loose_mention',
    name: 'Generic note',
    description: 'A note',
    body: 'This one-off body mentions a test but is not about testing.',
    type: 'feedback',
  });
  assert.equal(p.topics, undefined);
});

test('user-type memory is never topic-tagged', () => {
  const p = proposeFrontmatter({
    id: 'user_profile',
    name: 'User profile',
    description: 'Profile info',
    body: 'Works on deployment, review, test, security all the time.',
    type: 'user',
  });
  assert.equal(p.topics, undefined);
  assert.equal(p.severity, undefined);
});

test('caps at 2 topics even with many matches', () => {
  const p = proposeFrontmatter({
    id: 'release_dogfood',
    name: 'release dogfood deploy test review security',
    description: 'deployment release rollback test mock auth token PR branch review',
    body: 'deploy deploy deploy test test test review review auth auth',
    type: 'feedback',
  });
  assert.ok(p.topics!.length <= 2);
});

test('"nothing critical" in body does NOT flip severity to critical', () => {
  const p = proposeFrontmatter({
    id: 'x',
    name: 'Minor style hint',
    description: 'A mild preference about testing style',
    body: 'You must not worry here — nothing critical. Just a testing preference about mock cleanup.',
    type: 'feedback',
  });
  assert.equal(p.severity, 'normal');
});

test('two distinct critical signals flip to critical', () => {
  const p = proposeFrontmatter({
    id: 'x',
    name: 'Never delete the prod db',
    description: 'Will destroy data and silently drops future writes',
    body: 'deploy deploy deploy',
    type: 'feedback',
  });
  assert.equal(p.severity, 'critical');
});

test('dangerous command hint is extracted from body but not auto-applied', () => {
  const p = proposeFrontmatter({
    id: 'compose_drift',
    name: 'n',
    description: 'd',
    body: 'If this breaks run `git reset --hard origin/master` to recover.',
    type: 'feedback',
  });
  assert.ok(p.commandHints?.some((h: string) => h.includes('git reset --hard')));
});
