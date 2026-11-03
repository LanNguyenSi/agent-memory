// Stderr hygiene for the two keyword-degradation warnings (the store-level FTS
// reads in src/embed/index-store.ts and the keyword-pass wrapper in
// src/embed/indexer.ts).
//
// Two properties are pinned here:
//
// 1. Neither warning may echo the error MESSAGE. An SQLite FTS error message
//    can quote back part of the phrase it was given, and that phrase is built
//    from the user's prompt, so `String(err)` copied prompt text into the log.
//    What is printed instead is the error class plus the SQLite result code
//    (SqliteError (SQLITE_ERROR)), and the tests assert that the marker phrase
//    the message carries never reaches stderr.
//
// 2. Both paths share ONE once-per-process flag (src/embed/fts-warning.ts), so
//    a process that trips both failures still writes exactly one keyword
//    warning line. docs/scoring.md and
//    docs/okf/semantic-search-silent-noop.md both promise one line per process;
//    two independent flags used to allow one line per path. Both trigger orders
//    are exercised, because with split flags either order writes two lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const STORE_PATH = require.resolve('../src/embed/index-store');
const INDEXER_PATH = require.resolve('../src/embed/indexer');
const WARN_PATH = require.resolve('../src/embed/fts-warning');
const MODEL = 'text-embedding-3-small';

// Only ever appears inside the thrown error's message; a leak into stderr means
// a warning printed the message instead of the class + code.
const MARKER = 'zzpromptmarkerphrase';

// Matches either path's warning line, so one assertion counts the keyword
// warnings of BOTH kinds together.
const ANY_KEYWORD_WARN_RE =
  /memory-router: (FTS keyword index query failed|keyword search failed), continuing without keyword matches/g;

const { errorSummary } = require('../src/embed/fts-warning');

// Drop all three module caches: the shared flag lives in fts-warning.ts, but it
// is read through the two modules that use it, so a clean flag means a clean
// cache for all three.
function purgeWarningFlags(): void {
  delete require.cache[STORE_PATH];
  delete require.cache[INDEXER_PATH];
  delete require.cache[WARN_PATH];
}

interface PatchedStore {
  ftsDocCount: (phrase: string) => number;
  close: () => void;
}

// require('../src/embed/index-store') with a fresh once-per-process flag and an
// `openIndex` wrapper: every store it hands out can be made to fail its FTS
// document-count read with a SqliteError whose message carries MARKER (that is
// the throw the keyword-pass wrapper catches). `arm`/`disarm` are read per call,
// so one test can first take the real store-level catch on a bad phrase and only
// then arm the pass-level throw (or the other way round).
function freshStoreModule(): {
  openIndex: (opts: Record<string, unknown>) => PatchedStore;
  arm: () => void;
  disarm: () => void;
} {
  purgeWarningFlags();
  const mod = require('../src/embed/index-store');
  const origOpenIndex = mod.openIndex;
  let armed = false;
  const openIndex = (opts: Record<string, unknown>): PatchedStore => {
    const store = origOpenIndex(opts) as PatchedStore;
    const realDocCount = store.ftsDocCount.bind(store);
    store.ftsDocCount = (phrase: string): number => {
      if (armed) {
        const err = new Error(`no such column: ${MARKER}`) as Error & {
          code: string;
        };
        err.name = 'SqliteError';
        err.code = 'SQLITE_ERROR';
        throw err;
      }
      return realDocCount(phrase);
    };
    return store;
  };
  // The wrap goes onto the module exports, so an indexer required afterwards
  // destructures the wrapper, exactly like a real caller does.
  mod.openIndex = openIndex;
  return {
    openIndex,
    arm: () => {
      armed = true;
    },
    disarm: () => {
      armed = false;
    },
  };
}

// A real blendedSearch needs a provider config and an embed endpoint; the
// endpoint is stubbed with deterministic vectors, same as
// tests/keyword-fts-warning.test.ts.
const ENV_NAMES = [
  'OPENAI_API_KEY',
  'MEMORY_ROUTER_EMBED_PROVIDER',
  'MEMORY_ROUTER_EMBED_MODEL',
  'MEMORY_ROUTER_OLLAMA_EMBED_MODEL',
  'MEMORY_ROUTER_KEYWORD',
  'MEMORY_ROUTER_KEYWORD_BOOST',
];
const savedEnv: Record<string, string | undefined> = {};
test.before(() => {
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.MEMORY_ROUTER_EMBED_PROVIDER = 'openai';
  process.env.MEMORY_ROUTER_EMBED_MODEL = MODEL;
  delete process.env.MEMORY_ROUTER_OLLAMA_EMBED_MODEL;
  delete process.env.MEMORY_ROUTER_KEYWORD;
  delete process.env.MEMORY_ROUTER_KEYWORD_BOOST;
});
test.after(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function deterministicVector(seed: number): number[] {
  const out: number[] = [];
  let s = seed || 1;
  for (let i = 0; i < 1536; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out.push(s / 0x7fffffff);
  }
  return out;
}

function stubFetch(): () => void {
  const orig = (globalThis as { fetch?: typeof fetch }).fetch;
  let nextSeed = 1;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { body?: string },
  ) => {
    const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
    const data = body.input.map((_text: string, idx: number) => ({
      embedding: deterministicVector(nextSeed + idx),
      index: idx,
    }));
    nextSeed += body.input.length;
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

// Capture every process.stderr.write chunk while `fn` runs.
async function captureStderr(
  fn: () => Promise<unknown> | void,
): Promise<string> {
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  (process.stderr as unknown as { write: typeof origWrite }).write = ((
    chunk: string | Uint8Array,
  ) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof origWrite;
  try {
    await fn();
  } finally {
    process.stderr.write = origWrite;
  }
  return captured;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-fts-hygiene-'));
}

// A memory dir whose only file carries the id token the keyword pass matches,
// plus a real v4 index (entries + vec + chunks + chunks_fts). Needs the fetch
// stub in place, and needs the indexer to be required AFTER the openIndex wrap.
function memoryFixture(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'task.md'),
    '---\nname: task\ndescription: task tracker\ntype: reference\n---\n\ncarry task 4e7729ab across branches\n',
  );
}

const countWarnings = (captured: string): number =>
  (captured.match(ANY_KEYWORD_WARN_RE) ?? []).length;

// The prompt whose single id token reaches the FTS reads.
const PROMPT = 'look up 4e7729ab';

// --- 1. the message never reaches stderr ------------------------------------

// The store-level catch, through a REAL SQLite error: an FTS5 column-filter
// phrase ('{token}') names a column that does not exist, so the resulting
// "no such column: <token>" message echoes the queried phrase back.
test('store path: warns with the error class and the SQLite code, never the message', async () => {
  const dir = tmpDir();
  const { openIndex } = freshStoreModule();
  try {
    const store = openIndex({
      path: path.join(dir, 'index.sqlite'),
      dimensions: 4,
    });
    try {
      const captured = await captureStderr(() => {
        assert.equal(
          store.ftsDocCount(`{${MARKER}}`),
          0,
          'the failing read degrades to "no match"',
        );
      });
      assert.match(
        captured,
        /FTS keyword index query failed, continuing without keyword matches: SqliteError \(SQLITE_ERROR\)/,
      );
      assert.ok(
        !captured.includes(MARKER),
        `the queried phrase leaked into stderr: ${JSON.stringify(captured)}`,
      );
      assert.equal(countWarnings(captured), 1);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The keyword-pass wrapper's own catch: a throw that escapes the whole pass. The
// store-level reads swallow their own errors, so it is the store handed out by
// the wrapped openIndex that fails here.
test('keyword-pass path: warns with the error class and the SQLite code, never the message', async () => {
  const restoreFetch = stubFetch();
  let dir = '';
  try {
    const { arm } = freshStoreModule();
    // Required AFTER the wrap, so its module-level destructuring of openIndex
    // picks up the wrapper.
    const { rebuildIndex, blendedSearch } = require('../src/embed/indexer');
    dir = tmpDir();
    memoryFixture(dir);
    await rebuildIndex(dir);
    const { loadMemoriesFromDir } = require('../src/memory/loader');
    const memories = loadMemoriesFromDir(dir);
    arm();
    const captured = await captureStderr(() =>
      blendedSearch(PROMPT, memories, dir, 5),
    );
    assert.match(
      captured,
      /keyword search failed, continuing without keyword matches: SqliteError \(SQLITE_ERROR\)/,
    );
    assert.ok(
      !captured.includes(MARKER),
      `the error message leaked into stderr: ${JSON.stringify(captured)}`,
    );
    assert.equal(countWarnings(captured), 1);
    assert.deepEqual(
      (await blendedSearch(PROMPT, memories, dir, 5)).keyword,
      [],
      'the keyword pass degrades to no matches',
    );
  } finally {
    restoreFetch();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 2. one shared once-per-process flag ------------------------------------

// Both failures in one process, store-level catch first: still exactly ONE line.
test('both paths in one process write exactly one keyword warning line (store path first)', async () => {
  const restoreFetch = stubFetch();
  let dir = '';
  try {
    const { openIndex, arm } = freshStoreModule();
    const { rebuildIndex, blendedSearch, indexPath } = require('../src/embed/indexer');
    dir = tmpDir();
    memoryFixture(dir);
    await rebuildIndex(dir);
    const { loadMemoriesFromDir } = require('../src/memory/loader');
    const memories = loadMemoriesFromDir(dir);

    const store = openIndex({
      path: indexPath(dir),
      meta: { provider: 'openai', model: MODEL },
    });
    try {
      const first = await captureStderr(() => {
        assert.equal(store.ftsDocCount(`{${MARKER}}`), 0);
      });
      assert.equal(countWarnings(first), 1, 'the store path warned once');
      arm();
      const second = await captureStderr(() =>
        blendedSearch(PROMPT, memories, dir, 5),
      );
      assert.equal(
        countWarnings(second),
        0,
        'the keyword-pass path adds no second line',
      );
    } finally {
      store.close();
    }
  } finally {
    restoreFetch();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The reverse order: with two independent flags this case also produced two
// lines, the store path having never seen a warning of its own.
test('both paths in one process write exactly one keyword warning line (keyword-pass path first)', async () => {
  const restoreFetch = stubFetch();
  let dir = '';
  try {
    const { openIndex, arm, disarm } = freshStoreModule();
    const { rebuildIndex, blendedSearch, indexPath } = require('../src/embed/indexer');
    dir = tmpDir();
    memoryFixture(dir);
    await rebuildIndex(dir);
    const { loadMemoriesFromDir } = require('../src/memory/loader');
    const memories = loadMemoriesFromDir(dir);

    arm();
    const first = await captureStderr(() =>
      blendedSearch(PROMPT, memories, dir, 5),
    );
    assert.equal(
      countWarnings(first),
      1,
      'the keyword-pass path warned once',
    );
    // Disarmed again, so the second failure is a real SQLite error inside the
    // store's own catch rather than the armed throw.
    disarm();
    const store = openIndex({
      path: indexPath(dir),
      meta: { provider: 'openai', model: MODEL },
    });
    try {
      const second = await captureStderr(() => {
        assert.equal(store.ftsDocCount(`{${MARKER}}`), 0);
      });
      assert.equal(
        countWarnings(second),
        0,
        'the store path adds no second line',
      );
    } finally {
      store.close();
    }
  } finally {
    restoreFetch();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- errorSummary: class + code, for every error shape ----------------------

interface SummaryCase {
  name: string;
  err: unknown;
  want: string;
}

const SUMMARY_CASES: SummaryCase[] = [
  {
    name: 'better-sqlite3 error (name + code) prints class and code',
    err: Object.assign(new Error(`no such column: ${MARKER}`), {
      name: 'SqliteError',
      code: 'SQLITE_ERROR',
    }),
    want: 'SqliteError (SQLITE_ERROR)',
  },
  {
    name: 'a different SQLite code is still only the code',
    err: Object.assign(new Error(`database is locked ${MARKER}`), {
      name: 'SqliteError',
      code: 'SQLITE_BUSY',
    }),
    want: 'SqliteError (SQLITE_BUSY)',
  },
  {
    name: 'error with a name but no SQLite code',
    err: Object.assign(new Error(MARKER), { name: 'TypeError' }),
    want: 'TypeError',
  },
  {
    name: 'plain Error: message never printed',
    err: new Error(MARKER),
    want: 'Error',
  },
  {
    name: 'object without a usable name but with a code',
    err: { code: 'SQLITE_ERROR', message: MARKER },
    want: 'Error (SQLITE_ERROR)',
  },
  {
    name: 'thrown string is never echoed',
    err: MARKER,
    want: 'Error',
  },
  {
    name: 'null',
    err: null,
    want: 'Error',
  },
  {
    name: 'undefined',
    err: undefined,
    want: 'Error',
  },
];

for (const c of SUMMARY_CASES) {
  test(`errorSummary: ${c.name}`, () => {
    const got = errorSummary(c.err);
    assert.equal(got, c.want);
    assert.ok(!got.includes(MARKER), 'the message is never part of the summary');
  });
}
