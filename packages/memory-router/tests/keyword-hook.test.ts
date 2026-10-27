// Hook-level contract for the keyword path: with MEMORY_ROUTER_KEYWORD=off
// the UserPromptSubmit hook's stdout (and stderr) must be BYTE-IDENTICAL to
// (a) the same hook with the path on but no keyword match, and (b) the base
// commit's behavior - which for this degraded (everything-below-the-floor)
// fixture is the pinned pre-blend topic-only injection: exactly one flat
// 1.00 topic hit. With a keyword match and the path on, the output is (by
// design) NOT identical: the keyword-admitted memory is injected first.
//
// No network: every prompt is a query-cache hit (the vectors below were
// seeded into the index by this file), so the hook never embeds.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { openIndex } = require('../src/embed/index-store');
const { rebuildIndex, indexPath } = require('../src/embed/indexer');

const MODEL = 'text-embedding-3-small';
const distDir = path.join(__dirname, '..', 'dist', 'hooks');

const NO_MATCH_PROMPT = 'please review and merge this PR';
const MATCH_PROMPT = 'please review and merge this PR 4e7729ab';

function dir2(c: number): number[] {
  const v = new Array(1536).fill(0);
  v[0] = c;
  v[1] = Math.sqrt(1 - c * c);
  return v;
}

function stubFetchOk(): () => void {
  const orig = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { body?: string },
  ) => {
    const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
    const data = body.input.map((_t, idx) => {
      const v = new Array(1536).fill(0);
      v[0] = 0.1;
      v[1] = 0.9;
      return { embedding: v, index: idx };
    });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => {
    if (orig) (globalThis as { fetch: typeof fetch }).fetch = orig;
  };
}

function runHook(
  dir: string,
  prompt: string,
  keywordEnv: Record<string, string> | undefined,
): { stdout: string; stderr: string; code: number } {
  const res = spawnSync('node', [path.join(distDir, 'user-prompt-submit.js')], {
    input: JSON.stringify({ prompt }),
    env: {
      ...process.env,
      MEMORY_ROUTER_DIR: dir,
      OPENAI_API_KEY: 'sk-test-not-real',
      MEMORY_ROUTER_EMBED_PROVIDER: 'openai',
      MEMORY_ROUTER_EMBED_MODEL: MODEL,
      MEMORY_ROUTER_BLEND_MIN_SEMANTIC: '0.99',
      MEMORY_ROUTER_KEYWORD: 'on',
      ...(keywordEnv ?? {}),
    },
    encoding: 'utf8',
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? -1 };
}

test('keyword path is off-switch byte-identical at the hook boundary (on/no-match and base behavior alike)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-keyword-hook-'));
  const savedEnv: Record<string, string | undefined> = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    MEMORY_ROUTER_EMBED_PROVIDER: process.env.MEMORY_ROUTER_EMBED_PROVIDER,
    MEMORY_ROUTER_EMBED_MODEL: process.env.MEMORY_ROUTER_EMBED_MODEL,
  };
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.MEMORY_ROUTER_EMBED_PROVIDER = 'openai';
  process.env.MEMORY_ROUTER_EMBED_MODEL = MODEL;
  const restoreEnv = () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const restore = stubFetchOk();
  try {
    fs.writeFileSync(
      path.join(dir, 'task-memory.md'),
      '---\nname: Task memory 4e7729ab\ndescription: task tracker note\ntype: reference\n---\n\ncarry task 4e7729ab across branches\n',
    );
    fs.writeFileSync(
      path.join(dir, 'workflow-memory.md'),
      '---\nname: Stacked PR base\ndescription: stacked branch base rules\ntype: reference\ntopics: [workflow]\n---\n\nretarget its base to master after landing\n',
    );
    await rebuildIndex(dir);

    // Seed the query cache so the hook resolves both prompts without any
    // embedding HTTP call, and pin every document vector near-orthogonal
    // to the query so the semantic path is silent (everything below the
    // pinned 0.99 floor) and the run degrades.
    const store = openIndex({
      path: indexPath(dir),
      meta: { provider: 'openai', model: MODEL },
      cache: { model: MODEL, capacity: 10 },
    });
    try {
      for (const p of [NO_MATCH_PROMPT, MATCH_PROMPT]) store.putCachedQuery(p, dir2(1));
      for (const e of store.listEntries()) {
        store.upsert(e.id, e.mtime, MODEL, dir2(0.1));
      }
    } finally {
      store.close();
    }

    // (a) off vs on-without-any-keyword-match: byte-identical stdout+stderr.
    const off = runHook(dir, NO_MATCH_PROMPT, { MEMORY_ROUTER_KEYWORD: 'off' });
    const onNoMatch = runHook(dir, NO_MATCH_PROMPT, { MEMORY_ROUTER_KEYWORD: 'on' });
    assert.equal(off.code, 0);
    assert.equal(onNoMatch.code, 0);
    assert.equal(
      off.stdout,
      onNoMatch.stdout,
      'hook stdout must be byte-identical between MEMORY_ROUTER_KEYWORD=off and an on-run with no keyword match',
    );
    assert.equal(
      off.stderr,
      onNoMatch.stderr,
      'hook stderr must be byte-identical too',
    );
    assert.ok(off.stdout.length > 0, 'the degraded topic hit is injected in both runs');

    // (b) off vs the base commit: the base behavior for this fixture is
    // exactly the degraded topic-only injection - the workflow memory at
    // the flat pre-blend 1.00 score, nothing else.
    const parsed = JSON.parse(off.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const ctx2 = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx2, /Stacked PR base/);
    assert.match(ctx2, /topic · 1\.00/);
    assert.ok(
      !/4e7729ab/.test(ctx2),
      'the keyword memory must NOT leak into the off run at all',
    );
    assert.ok(
      !/keyword/.test(ctx2),
      'no keyword attribution may appear with the switch off',
    );
    assert.equal(
      (ctx2.match(/### /g) ?? []).length,
      1,
      'exactly one memory block: the untouched degraded topic output',
    );

    // (c) sanity that the path is actually live when on: the id token
    // in the prompt admits the task memory (degraded path: keyword first,
    // then the topic hit).
    const onMatch = runHook(dir, MATCH_PROMPT, { MEMORY_ROUTER_KEYWORD: 'on' });
    assert.equal(onMatch.code, 0);
    assert.notEqual(onMatch.stdout, off.stdout, 'the keyword match must change the ON output');
    const parsedOn = JSON.parse(onMatch.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const ctxOn = parsedOn.hookSpecificOutput.additionalContext;
    assert.match(ctxOn, /Task memory 4e7729ab/);
    // The hook renders "<gate> · <score>" per block (reasons are an API
    // surface, not injected text), so the distinguishable gate label is
    // what the hook output can and must show.
    assert.match(ctxOn, /keyword · \d/);
    assert.ok(
      ctxOn.indexOf('Task memory') < ctxOn.indexOf('Stacked PR base'),
      'the keyword-admitted memory takes the first slot ahead of the topic-only output',
    );
  } finally {
    restore();
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
