const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const fixturesDir = path.join(__dirname, 'fixtures', 'memories');
const distDir = path.join(__dirname, '..', 'dist', 'hooks');

function runHook(
  script: string,
  input: unknown,
): { stdout: string; stderr: string; code: number } {
  const res = spawnSync('node', [path.join(distDir, script)], {
    input: JSON.stringify(input),
    env: { ...process.env, MEMORY_ROUTER_DIR: fixturesDir },
    encoding: 'utf8',
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    code: res.status ?? -1,
  };
}

test('user-prompt-submit emits hookSpecificOutput.additionalContext for a topic hit', () => {
  const { stdout, code } = runHook('user-prompt-submit.js', {
    prompt: 'merge PR 42',
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.hookSpecificOutput);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /Stacked PR base/);
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /retarget its base to master/,
  );
  // mm-v1-T004: the hook now resolves through resolveBlended, so a topic
  // hit's rendered score is a blended value, not the old flat "1.00" —
  // that flat score is exactly the "identical top-5" symptom the blend
  // resolver replaces (see src/router.ts, tests/blend.test.ts).
  assert.doesNotMatch(
    parsed.hookSpecificOutput.additionalContext,
    /topic · 1\.00/,
    'topic hits must no longer render a flat 1.00 score',
  );
});

test('user-prompt-submit emits no stdout when no hits', () => {
  const { stdout, code } = runHook('user-prompt-submit.js', {
    prompt: 'rename this variable to fooBar',
  });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('pre-tool-use emits hookSpecificOutput for git push --force', () => {
  const { stdout, code } = runHook('pre-tool-use.js', {
    tool_name: 'Bash',
    tool_input: { command: 'git push --force origin master' },
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /No force-push to shared branches/,
  );
});

test('pre-tool-use emits no stdout for Bash(ls)', () => {
  const { stdout, code } = runHook('pre-tool-use.js', {
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
  });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});
