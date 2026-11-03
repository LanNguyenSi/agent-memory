const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const fixturesDir = path.join(__dirname, 'fixtures', 'memories');
const distDir = path.join(__dirname, '..', 'dist', 'hooks');

// Preload that turns one dist/router.js export into a thrower whose Error
// message carries the marker phrase; see that file for why the two defensive
// catches in the hooks can only be reached through such a seam.
const PRELOAD = path.join(__dirname, 'fixtures', 'stub-router-preload.cjs');

// Only ever appears inside a thrown error's message (or, for the malformed
// payload cases, inside the payload itself); a leak into stderr means the catch
// printed the message instead of the error summary.
const MARKER = 'PROMPT-MARKER-xyz';

interface RunOptions {
  /** Extra node CLI args, prepended before the script path (e.g. --require). */
  nodeArgs?: string[];
  /** Extra env, applied on top of the hermetic base below. */
  env?: Record<string, string>;
}

function runHook(
  script: string,
  input: unknown,
  opts: RunOptions = {},
): { stdout: string; stderr: string; code: number } {
  // A string input is fed through raw: the malformed-payload cases below must
  // reach JSON.parse inside the hook, which JSON.stringify would undo.
  const payload = typeof input === 'string' ? input : JSON.stringify(input);
  const res = spawnSync(
    'node',
    [...(opts.nodeArgs ?? []), path.join(distDir, script)],
    {
      input: payload,
      env: {
        ...process.env,
        MEMORY_ROUTER_DIR: fixturesDir,
        ...(opts.env ?? {}),
      },
      encoding: 'utf8',
    },
  );
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
  // The hook resolves through resolveBlended. This fixtures dir
  // has no `.memory-router` index, so the semantic path contributes
  // nothing and resolveBlended must degrade to EXACTLY the old sync-only
  // topic-only score (flat 1.00), a post-hoc fix: an earlier version of
  // resolveBlended kept applying the topic-boost/recency/type modifiers
  // even in this degraded case, which is the "identical to today's
  // topic-only degradation" acceptance criterion this pins (see
  // src/router.ts, tests/blend.test.ts's degradation-pinning test).
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /topic · 1\.00/,
    'degraded (no index/provider) topic hits must render the exact pre-blend flat 1.00 score',
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

// --- stderr hygiene on the prompt/tool-input path (src/error-summary.ts) -----
//
// Three catches, three lines, one rule: name the error class (plus its code when
// it carries one) and never the message, because every error reachable here
// arrives with the prompt or the tool input in flight. An SQLite FTS message
// quotes back the phrase it was given, and that phrase is built from the prompt;
// a JSON.parse SyntaxError quotes the stdin payload, i.e. the prompt or the tool
// input itself. The hook's stderr is collected next to the transcript, so
// echoing a message copied that text into the log.

// Premise check for the malformed-payload cases: the payload must actually make
// JSON.parse throw with the marker inside the message, or the assertion below
// would pass for the wrong reason (a V8 message-format change would otherwise
// silently turn this into a no-op).
function assertPayloadCarriesMarker(payload: string): void {
  let message = '';
  try {
    JSON.parse(payload);
  } catch (err: unknown) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.ok(
    message.includes(MARKER),
    `test premise broken: JSON.parse of ${JSON.stringify(payload)} does not put ${MARKER} in its message, got ${JSON.stringify(message)}`,
  );
}

test('user-prompt-submit: a resolver failure names the error class and code, never the message', () => {
  const { stdout, stderr, code } = runHook(
    'user-prompt-submit.js',
    { prompt: 'merge PR 42' },
    {
      nodeArgs: ['--require', PRELOAD],
      env: {
        MEMORY_ROUTER_TEST_STUB_EXPORT: 'resolveBlended',
        MEMORY_ROUTER_TEST_STUB_MARKER: MARKER,
      },
    },
  );
  assert.match(
    stderr,
    /memory-router: memory resolution failed, no context injected: RouterFailure \(SQLITE_ERROR\)/,
  );
  assert.ok(
    !stderr.includes(MARKER),
    `the resolver error message leaked into stderr: ${JSON.stringify(stderr)}`,
  );
  // The failure still degrades instead of blocking the prompt.
  assert.equal(code, 0);
  assert.equal(stdout, '', 'no hits to inject after the failed resolution');
});

test('user-prompt-submit: a pre-resolver failure names the error class, never the stdin payload it failed to parse', () => {
  // Not JSON at all: V8's SyntaxError message quotes the offending input, which
  // is exactly the prompt payload.
  const payload = MARKER;
  assertPayloadCarriesMarker(payload);
  const { stderr, code } = runHook('user-prompt-submit.js', payload);
  assert.match(stderr, /^memory-router user-prompt-submit failed: SyntaxError\n/);
  assert.ok(
    !stderr.includes(MARKER),
    `the stdin payload leaked into stderr: ${JSON.stringify(stderr)}`,
  );
  assert.equal(code, 1);
});

test('pre-tool-use: a pre-resolver failure names the error class, never the tool input it failed to parse', () => {
  const payload = MARKER;
  assertPayloadCarriesMarker(payload);
  const { stderr, code } = runHook('pre-tool-use.js', payload);
  assert.match(stderr, /^memory-router pre-tool-use failed: SyntaxError\n/);
  assert.ok(
    !stderr.includes(MARKER),
    `the stdin payload leaked into stderr: ${JSON.stringify(stderr)}`,
  );
  assert.equal(code, 1);
});
