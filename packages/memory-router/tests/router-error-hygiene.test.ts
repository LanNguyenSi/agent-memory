// Stderr hygiene for the semantic-search degradation line in resolveBlended
// (src/router.ts), the blend path the UserPromptSubmit hook, the MCP
// `memory_resolve` tool and `memory-router eval` run on every prompt.
//
// The line must name the error CLASS (plus a machine-readable code when the
// error carries one) and never the message: this catch fires with the user's
// prompt in flight, and a store-level failure on this path can come back with a
// message quoting prompt-derived text (the same `blendedSearch()` call is what
// runs the FTS keyword pass, and an SQLite FTS message echoes back the phrase it
// was given). The hook's and the MCP server's stderr is collected next to the
// transcript, so `String(err)` here used to copy prompt text into that log.
// `src/error-summary.ts` holds the shared summary; the sibling tests for the
// keyword-path warnings are tests/fts-warning-hygiene.test.ts and the tests for
// the other prompt-handling catches live with their own entry points
// (tests/hooks.test.ts, tests/mcp-server.test.ts, tests/cli-test.test.ts).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { resolveBlended, resolve } = require('../src/router');
const { IndexProvenanceMismatchError } = require('../src/error-summary');

// No topics.yml here, so the topic gate falls back to the built-in default
// vocabulary and this prompt matches nothing: the degraded result is then the
// empty hit list, and the only thing this file has to look at is the one
// diagnostic line. Threading ctx.memoryDir keeps the suite hermetic against an
// ambient $MEMORY_ROUTER_DIR (mirrors tests/blend.test.ts's NOVOCAB_DIR).
const NOVOCAB_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'memory-router-router-hygiene-novocab-'),
);
test.after(() => {
  fs.rmSync(NOVOCAB_DIR, { recursive: true, force: true });
});

// Only ever appears inside the thrown error's message; a leak into stderr means
// the catch printed the message instead of the summary.
const MARKER = 'PROMPT-MARKER-xyz';

const PROMPT = 'an unrelated prompt with no topic keywords at all';

function fakeMemory(id: string): Memory {
  return {
    id,
    path: `/nonexistent/${id}.md`,
    frontmatter: { name: id, description: `desc for ${id}`, type: 'feedback' },
    body: `body for ${id}`,
  };
}

// Captures every process.stderr.write call made during `fn`, then restores the
// real stream even if `fn` throws (same shape as tests/floor-drop-hint.test.ts).
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const stderr: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = realWrite;
  }
  return stderr;
}

interface ThrowingSearch {
  (
    prompt: string,
    memories: Memory[],
    memoryDir: string,
    k: number,
  ): Promise<{ memory: Memory; score: number }[]>;
}

// Every shape resolveBlended's catch can be handed, with what the line must
// print for it. `make` is called per test so a mutant that echoes the message
// cannot hide behind a shared error instance.
interface ErrorCase {
  name: string;
  make: () => unknown;
  want: string;
  /** Whether the fixed rebuild hint must follow the summary (only the
   * IndexProvenanceMismatchError case sets it; every other error must keep
   * the short line). */
  hint?: boolean;
}

const ERROR_CASES: ErrorCase[] = [
  {
    name: 'better-sqlite3 error (name + code) prints class and code',
    make: () =>
      Object.assign(new Error(`no such column: ${MARKER}`), {
        name: 'SqliteError',
        code: 'SQLITE_ERROR',
      }),
    want: 'SqliteError (SQLITE_ERROR)',
  },
  {
    name: 'error with a name but no code prints just the class',
    make: () =>
      Object.assign(new Error(`embedding call failed for ${MARKER}`), {
        name: 'TypeError',
      }),
    want: 'TypeError',
  },
  {
    name: 'plain Error prints Error, never the message',
    make: () => new Error(`simulated embeddings API failure on "${MARKER}"`),
    want: 'Error',
  },
  {
    name: 'thrown string is never echoed',
    make: () => MARKER,
    want: 'Error',
  },
  {
    name: 'null degrades to Error',
    make: () => null,
    want: 'Error',
  },
  {
    name: 'index provenance mismatch adds the fixed rebuild hint with the memory dir',
    make: () =>
      new IndexProvenanceMismatchError(
        `embedding index at /some/dir was built with provider=openai model=${MARKER}; Rebuild the index: rm -rf '/some/dir/.memory-router' && memory-router index '/some/dir'`,
      ),
    want: 'IndexProvenanceMismatchError',
    hint: true,
  },
];

// The FIXED hint text (src/error-summary.ts's indexRebuildHint): fixed prose
// plus the caller's own memory dir, never anything from the error message.
const HINT_FRAGMENT = 'if the embedding provider or model changed';

for (const c of ERROR_CASES) {
  test(`resolveBlended semantic-search failure line: ${c.name}`, async () => {
    const throwing: ThrowingSearch = async () => {
      throw c.make();
    };
    const ctx: RouterContext = { prompt: PROMPT, memoryDir: NOVOCAB_DIR };
    const a = fakeMemory('a');
    const stderr = await captureStderr(async () => {
      const hits = await resolveBlended(ctx, [a], NOVOCAB_DIR, {}, {
        semanticSearch: throwing,
      });
      assert.deepEqual(
        hits,
        resolve(ctx, [a], { maxHits: 5 }),
        'the caught failure still degrades to the sync-only result',
      );
    });
    assert.equal(stderr.length, 1, `expected one stderr line, got: ${stderr}`);
    assert.match(
      stderr[0],
      /^memory-router: semantic search failed, degrading to topic\/recency\/type only: /,
    );
    assert.ok(
      stderr[0].includes(c.want),
      `expected the summary "${c.want}" in: ${stderr[0]}`,
    );
    assert.ok(
      !stderr[0].includes(MARKER),
      `the error message leaked into stderr: ${JSON.stringify(stderr[0])}`,
    );
    if (c.hint) {
      assert.ok(
        stderr[0].endsWith(
          `; ${HINT_FRAGMENT}, run \`memory-router index ${NOVOCAB_DIR}\` to rebuild\n`,
        ),
        `expected the fixed hint with the memory dir at the end of: ${JSON.stringify(stderr[0])}`,
      );
    } else {
      assert.ok(
        !stderr[0].includes(HINT_FRAGMENT),
        `a non-provenance error must not print the rebuild hint: ${JSON.stringify(stderr[0])}`,
      );
    }
  });
}
