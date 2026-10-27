// End-to-end tests for the schema v4 FTS keyword index: the migration and
// rebuild lifecycle (against a real better-sqlite3/sqlite-vec store, with
// the embedding HTTP layer stubbed like tests/blend.test.ts does), the
// document-frequency cap over DISTINCT memories, the corroboration cosine
// for candidates OUTSIDE the semantic top-k, prompt sanitizing against FTS
// syntax, and the "Bonsai-Baum" negative control kept quiet by phrase
// adjacency.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const { openIndex } = require('../src/embed/index-store');
const {
  rebuildIndex,
  semanticSearch,
  blendedSearch,
  indexPath,
} = require('../src/embed/indexer');
const { loadMemoriesFromDir } = require('../src/memory/loader');
const { resolveBlended, resolve } = require('../src/router');

const MODEL = 'text-embedding-3-small';

// --- env pinning (hermetic against the ambient provider config) -----------

const ENV_NAMES = [
  'OPENAI_API_KEY',
  'MEMORY_ROUTER_EMBED_PROVIDER',
  'MEMORY_ROUTER_EMBED_MODEL',
  'MEMORY_ROUTER_OLLAMA_EMBED_MODEL',
  'MEMORY_ROUTER_BLEND_MIN_SEMANTIC',
  'MEMORY_ROUTER_KEYWORD',
  'MEMORY_ROUTER_KEYWORD_CORROBORATION',
  'MEMORY_ROUTER_KEYWORD_BOOST',
];
const savedEnv: Record<string, string | undefined> = {};
test.before(() => {
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.MEMORY_ROUTER_EMBED_PROVIDER = 'openai';
  process.env.MEMORY_ROUTER_EMBED_MODEL = MODEL;
  delete process.env.MEMORY_ROUTER_OLLAMA_EMBED_MODEL;
  process.env.MEMORY_ROUTER_BLEND_MIN_SEMANTIC = '0.78';
  delete process.env.MEMORY_ROUTER_KEYWORD;
  delete process.env.MEMORY_ROUTER_KEYWORD_CORROBORATION;
  delete process.env.MEMORY_ROUTER_KEYWORD_BOOST;
});
test.after(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

// --- deterministic embedding stub (same shape as tests/blend.test.ts) -----

function deterministicVector(seed: number): number[] {
  const DIMENSIONS = 1536;
  const out: number[] = [];
  let s = seed || 1;
  for (let i = 0; i < DIMENSIONS; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out.push(s / 0x7fffffff);
  }
  return out;
}

interface FetchStub {
  restore: () => void;
  callCount: () => number;
}

function stubFetch(opts: { fail?: boolean } = {}): FetchStub {
  const orig = (globalThis as { fetch?: typeof fetch }).fetch;
  let calls = 0;
  let nextSeed = 1;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { body?: string },
  ) => {
    calls++;
    if (opts.fail) {
      return {
        ok: false,
        status: 500,
        statusText: 'boom',
        json: async () => ({}),
        text: async () => 'stub failure',
      } as unknown as Response;
    }
    const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
    const data = body.input.map((_text, idx) => ({
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
  return {
    restore: () => {
      if (orig) (globalThis as { fetch: typeof fetch }).fetch = orig;
    },
    callCount: () => calls,
  };
}

// --- corpus helpers ---------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-keyword-'));
}

function writeMemory(
  dir: string,
  file: string,
  body: string,
  description = 'desc',
  topics?: string[],
): string {
  const p = path.join(dir, `${file}.md`);
  const topicLine = topics ? `topics: [${topics.join(', ')}]\n` : '';
  fs.writeFileSync(
    p,
    `---\nname: ${file}\ndescription: ${description}\ntype: reference\n${topicLine}---\n\n${body}\n`,
  );
  return p;
}

// Unit vectors in the e1/e2 plane; dir2(c) has raw cosine c with dir2(1).
function dir2(c: number): number[] {
  const v = new Array(1536).fill(0);
  v[0] = c;
  v[1] = Math.sqrt(1 - c * c);
  return v;
}

// The sqlite-vec KNN similarity scale this store reports: 1 - (1-c)/2.
function reportedCosine(rawCosine: number): number {
  return (1 + rawCosine) / 2;
}

// Pin the query vector(s) and (optionally) every memory's document/chunk
// vectors so the semantic AND keyword halves of blendedSearch see fully
// controlled, equal-scale cosines. putCachedQuery makes those prompts
// query-cache hits: blendedSearch runs with ZERO embedding HTTP calls.
function pinVectors(
  dir: string,
  promptToVec: Record<string, number[]>,
  vectorByMemory: Record<string, number[]> = {},
): void {
  const store = openIndex({
    path: indexPath(dir),
    meta: { provider: 'openai', model: MODEL },
    cache: { model: MODEL, capacity: 100 },
  });
  try {
    for (const [prompt, vec] of Object.entries(promptToVec)) {
      store.putCachedQuery(prompt, vec);
    }
    for (const [id, vec] of Object.entries(vectorByMemory)) {
      const entry = store.listEntries().find((e: { id: string }) => e.id === id);
      if (!entry) throw new Error(`no entries row for ${id}`);
      store.upsert(id, entry.mtime, MODEL, vec);
      const raw = new Database(indexPath(dir));
      let chunkRows: { chunk_index: number }[];
      try {
        chunkRows = raw
          .prepare('SELECT chunk_index FROM chunks WHERE id = ?')
          .all(id) as { chunk_index: number }[];
      } finally {
        raw.close();
      }
      store.replaceChunks(
        id,
        MODEL,
        chunkRows.map((r) => ({ index: r.chunk_index, offset: 0, embedding: vec })),
      );
    }
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// AC3: migration lifecycle
// ---------------------------------------------------------------------------

test('v4 migration: a v3 file migrates to v4 on the first writable open, keeps its data, and has no keyword hits until a rebuild', async () => {
  const dir = tmpDir();
  writeMemory(dir, 'task-notes', 'carry task 4e7729ab across branches');
  writeMemory(dir, 'plain-note', 'a note about rocks');
  const stub = stubFetch();
  try {
    await rebuildIndex(dir);
    // Deterministic query vector for the prompt under test (and for the
    // rerun after the downgrade): query-cache hit, no stub dependence.
    pinVectors(dir, { '4e7729ab': dir2(0.5) });
    // Downgrade the file to a freshly v3-migrated-but-not-rebuilt state:
    // version 3, FTS table gone (its rows belong to a rebuild we removed).
    const raw = new Database(indexPath(dir));
    raw.exec('DROP TABLE chunks_fts');
    raw.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    const chunksBefore = (raw.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number })
      .n;
    raw.close();
    assert.ok(chunksBefore > 0, 'sanity: the corpus was chunked before the downgrade');

    const before = await semanticSearch('4e7729ab', loadMemoriesFromDir(dir), dir, 5);

    // First writable open migrates 3 -> 4.
    const store = openIndex({ path: indexPath(dir), meta: { provider: 'openai', model: MODEL } });
    try {
      const raw2 = new Database(indexPath(dir));
      let version: string;
      try {
        version = (
          raw2
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string }
        ).value;
      } finally {
        raw2.close();
      }
      assert.equal(version, '4', 'the 3->4 migration must bump the version');
      assert.deepEqual(store.listFtsIds(), [], 'a migrated index has NO FTS rows before a rebuild');
      assert.deepEqual(store.ftsMatch('"4e7729ab"', 10), []);
    } finally {
      store.close();
    }

    // v3 behavior preserved: identical semantic results, no keyword hits.
    const after = await semanticSearch('4e7729ab', loadMemoriesFromDir(dir), dir, 5);
    assert.deepEqual(
      after.map((h: { memory: Memory; score: number }) => [h.memory.id, h.score.toFixed(6)]),
      before.map((h: { memory: Memory; score: number }) => [h.memory.id, h.score.toFixed(6)]),
    );
    const outcome = await blendedSearch('4e7729ab', loadMemoriesFromDir(dir), dir, 5);
    assert.deepEqual(outcome.keyword, [], 'no keyword hits before the rebuild back-fill');
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuild back-fill: unchanged mtimes + existing chunks still get FTS rows with ZERO new embedding calls', async () => {
  const dir = tmpDir();
  writeMemory(dir, 'task-notes', 'carry task 4e7729ab across branches');
  const stub = stubFetch();
  try {
    await rebuildIndex(dir);
    const raw = new Database(indexPath(dir));
    raw.exec('DROP TABLE chunks_fts');
    raw.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    raw.close();

    const callsBefore = stub.callCount();
    const result = await rebuildIndex(dir); // migrates + back-fills
    assert.equal(stub.callCount(), callsBefore, 'the keyword back-fill must not embed anything');
    assert.equal(result.embedded, 0, 'the mtime skip must still hold (no document re-embeds)');

    const store = openIndex({ path: indexPath(dir), meta: { provider: 'openai', model: MODEL } });
    try {
      assert.deepEqual(store.listFtsIds(), ['task-notes']);
      const rows = store.ftsMatch('"4e7729ab"', 10);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'task-notes');
      // name/description are indexed too (the file's name is task-notes):
      assert.equal(store.ftsMatch('"task notes"', 10).length, 1);
    } finally {
      store.close();
    }

    const outcome = await blendedSearch('4e7729ab', loadMemoriesFromDir(dir), dir, 5);
    assert.equal(outcome.keyword.length, 1);
    assert.deepEqual(outcome.keyword[0].strongTerms, ['4e7729ab']);
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('re-embedding a memory REPLACES its FTS rows (the old body stops matching, the new one starts)', async () => {
  const dir = tmpDir();
  const file = writeMemory(dir, 'task-notes', 'carry task oldbuild across branches');
  const stub = stubFetch();
  try {
    await rebuildIndex(dir);
    const store = openIndex({ path: indexPath(dir), meta: { provider: 'openai', model: MODEL } });
    try {
      assert.equal(store.ftsMatch('"oldbuild"', 10).length, 1);
    } finally {
      store.close();
    }

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('oldbuild', 'newbuild'));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    await rebuildIndex(dir);

    const store2 = openIndex({ path: indexPath(dir), meta: { provider: 'openai', model: MODEL } });
    try {
      assert.deepEqual(store2.ftsMatch('"oldbuild"', 10), [], 'old body text must not keep matching');
      assert.equal(store2.ftsMatch('"newbuild"', 10).length, 1);
      assert.deepEqual(store2.listFtsIds(), ['task-notes'], 'still exactly one row set');
    } finally {
      store2.close();
    }
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remove() and the deleted-file rebuild purge delete the memory FTS rows', async () => {
  const dir = tmpDir();
  writeMemory(dir, 'task-notes', 'carry task 4e7729ab across branches');
  writeMemory(dir, 'other', 'unrelated body');
  const stub = stubFetch();
  try {
    await rebuildIndex(dir);
    let store = openIndex({ path: indexPath(dir), meta: { provider: 'openai', model: MODEL } });
    try {
      store.remove('task-notes');
      assert.deepEqual(store.ftsMatch('"4e7729ab"', 10), [], 'remove() must delete the FTS rows');
    } finally {
      store.close();
    }

    // And the rebuild path: a deleted memory file leaves no rows behind.
    fs.rmSync(path.join(dir, 'other.md'));
    await rebuildIndex(dir);
    store = openIndex({ path: indexPath(dir), meta: { provider: 'openai', model: MODEL } });
    try {
      assert.ok(!store.listFtsIds().includes('other'));
    } finally {
      store.close();
    }
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readonly open of a v3 file does NOT migrate it and sees no keyword layer', async () => {
  const dir = tmpDir();
  writeMemory(dir, 'task-notes', 'carry task 4e7729ab across branches');
  const stub = stubFetch();
  try {
    await rebuildIndex(dir);
    const raw = new Database(indexPath(dir));
    raw.exec('DROP TABLE chunks_fts');
    raw.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    raw.close();

    const store = openIndex({ path: indexPath(dir), readonly: true });
    try {
      assert.deepEqual(store.listFtsIds(), []);
      assert.deepEqual(store.ftsMatch('"4e7729ab"', 10), []);
      assert.equal(store.ftsDocCount('"4e7729ab"'), 0);
    } finally {
      store.close();
    }
    const check = new Database(indexPath(dir));
    try {
      const version = (
        check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
          value: string;
        }
      ).value;
      assert.equal(version, '3', 'a readonly open must never migrate the file');
      const fts = check
        .prepare("SELECT name FROM sqlite_master WHERE name = 'chunks_fts'")
        .get();
      assert.equal(fts, undefined, 'a readonly open must never create the FTS table');
    } finally {
      check.close();
    }
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed rebuild never leaves FTS rows of the old body (the chunks guarantee, extended)', async () => {
  const dir = tmpDir();
  const file = writeMemory(dir, 'task-notes', 'carry task oldbuild across branches');
  const stub = stubFetch();
  try {
    await rebuildIndex(dir);

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('oldbuild', 'newbuild'));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);

    const failing = stubFetch({ fail: true });
    await assert.rejects(() => rebuildIndex(dir));
    failing.restore();

    let store = openIndex({ path: indexPath(dir), meta: { provider: 'openai', model: MODEL } });
    try {
      assert.deepEqual(
        store.ftsMatch('"oldbuild"', 10),
        [],
        'the stale FTS rows were dropped up front: a failed rebuild must not keep them',
      );
      assert.deepEqual(store.ftsMatch('"newbuild"', 10), []);
    } finally {
      store.close();
    }

    // The next successful rebuild writes the new rows.
    await rebuildIndex(dir);
    store = openIndex({ path: indexPath(dir), meta: { provider: 'openai', model: MODEL } });
    try {
      assert.equal(store.ftsMatch('"newbuild"', 10).length, 1);
    } finally {
      store.close();
    }
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC1 #5: document frequency over MEMORIES caps term qualification
// ---------------------------------------------------------------------------

test('df cap: a term contained by 13 memories does not qualify (df > KEYWORD_MAX_DF); at 2 memories it does', async () => {
  const dir = tmpDir();
  const stub = stubFetch();
  try {
    // 13 memories containing commonx -> df 13 > 12.
    for (let i = 0; i < 13; i++) {
      writeMemory(dir, `cmn-${i}`, `note ${i} about commonx handling`);
    }
    await rebuildIndex(dir);
    let outcome = await blendedSearch('the commonx thing', loadMemoriesFromDir(dir), dir, 5);
    assert.deepEqual(
      outcome.keyword,
      [],
      'a corpus-common token must be filtered by the df cap before it can admit anything',
    );

    const dir2 = tmpDir();
    writeMemory(dir2, 'rare-1', 'note about rarex handling');
    writeMemory(dir2, 'rare-2', 'another rarex note');
    await rebuildIndex(dir2);
    outcome = await blendedSearch('the rarex thing', loadMemoriesFromDir(dir2), dir2, 5);
    assert.equal(outcome.keyword.length, 2, 'df 2 qualifies');
    assert.deepEqual(outcome.keyword[0].matchedTerms, ['rarex']);
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The TRAP: corroboration cosine for a candidate OUTSIDE the semantic top-k
// ---------------------------------------------------------------------------

test('corroboration: a plain-word candidate outside the semantic top-k carries its real query cosine from the store (no second embed)', async () => {
  const dir = tmpDir();
  const stub = stubFetch();
  try {
    writeMemory(dir, 'target', 'the strata layer of the rock cycle');
    for (let i = 0; i < 6; i++) writeMemory(dir, `near-${i}`, `quartz vein formation note ${i}`);

    await rebuildIndex(dir);
    // Query = e1. The six near memories sit at raw cosine 0.6 (reported
    // 0.8, inside the top-5 and above the 0.78 floor); the target sits at
    // raw cosine 0.5 (reported 0.75) -> ranked 7th, OUTSIDE the top-5, and
    // below the floor even if it were not.
    pinVectors(
      dir,
      { 'describe the strata': dir2(1) },
      {
        target: dir2(0.5),
        'near-0': dir2(0.6),
        'near-1': dir2(0.6),
        'near-2': dir2(0.6),
        'near-3': dir2(0.6),
        'near-4': dir2(0.61),
        'near-5': dir2(0.62),
      },
    );

    const callsBefore = stub.callCount();
    const outcome = await blendedSearch('describe the strata', loadMemoriesFromDir(dir), dir, 5);
    assert.equal(stub.callCount(), callsBefore, 'the query vector came from the cache: zero embeds');

    assert.equal(outcome.semantic.length, 5, 'k=5: the target is NOT in the semantic result');
    assert.ok(!outcome.semantic.some((h: { memory: Memory }) => h.memory.id === 'target'));
    assert.equal(outcome.keyword.length, 1);
    assert.equal(outcome.keyword[0].memory.id, 'target');
    assert.deepEqual(outcome.keyword[0].matchedTerms, ['strata'], 'one plain qualifying term');
    assert.deepEqual(outcome.keyword[0].strongTerms, []);
    assert.ok(
      outcome.keyword[0].cosine !== null &&
        Math.abs(outcome.keyword[0].cosine - reportedCosine(0.5)) < 1e-6,
      `expected the corroboration cosine ${reportedCosine(0.5)} (raw 0.5) computed by the store, got ${outcome.keyword[0].cosine}`,
    );
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('corroboration end-to-end: the outside-top-k plain-word memory is admitted by resolveBlended (default search, no deps seam)', async () => {
  const dir = tmpDir();
  const stub = stubFetch();
  try {
    writeMemory(dir, 'target', 'the strata layer of the rock cycle');
    for (let i = 0; i < 6; i++) writeMemory(dir, `near-${i}`, `quartz vein formation note ${i}`);
    await rebuildIndex(dir);
    pinVectors(
      dir,
      { 'describe the strata': dir2(1) },
      {
        target: dir2(0.5),
        'near-0': dir2(0.6),
        'near-1': dir2(0.6),
        'near-2': dir2(0.61),
        'near-3': dir2(0.62),
        'near-4': dir2(0.63),
        'near-5': dir2(0.64),
      },
    );

    const ctx: RouterContext = { prompt: 'describe the strata', memoryDir: dir };
    // maxHits 8 > the 7 memories: nothing is evicted by the cap itself, the
    // admission happens or does not on its own merits.
    const hits = await resolveBlended(ctx, loadMemoriesFromDir(dir), dir, { maxHits: 8 });
    const target = hits.find((h: GateHit) => h.memory.id === 'target');
    assert.ok(
      target,
      `the plain-word memory at cosine 0.75 >= 0.70 must be admitted, got ${hits.map((h: GateHit) => h.memory.id).join(', ')}`,
    );
    assert.equal(target!.gate, 'keyword');
    assert.match(target!.reason, /keyword match \(corroborated: strata\)/);
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Degraded path end-to-end (router + search + store, no deps seam)
// ---------------------------------------------------------------------------

test('degraded path end-to-end: silent semantic path + strong keyword match -> keyword hit first, then the exact topic-only output', async () => {
  const dir = tmpDir();
  const stub = stubFetch();
  try {
    writeMemory(dir, 'task-memory', 'carry task 4e7729ab across branches', 'task tracker note');
    writeMemory(dir, 'workflow-memory', 'retarget the stacked branch base', 'review flow', [
      'workflow',
    ]);
    await rebuildIndex(dir);
    // Every vector ~orthogonal to the query: every semantic score lands
    // well below the pinned 0.78 floor -> degraded path.
    pinVectors(
      dir,
      { 'please review and merge this PR 4e7729ab': dir2(1) },
      { 'task-memory': dir2(0.1), 'workflow-memory': dir2(0.1) },
    );

    const memories = loadMemoriesFromDir(dir);
    const ctx: RouterContext = {
      prompt: 'please review and merge this PR 4e7729ab',
      memoryDir: dir,
    };
    const hits = await resolveBlended(ctx, memories, dir);
    assert.equal(hits[0].memory.id, 'task-memory');
    assert.equal(hits[0].gate, 'keyword');
    assert.match(hits[0].reason, /keyword match \(strong: 4e7729ab\)/);

    const topicOnly = resolve(ctx, memories, { maxHits: 5 });
    assert.ok(
      topicOnly.some((h: GateHit) => h.memory.id === 'workflow-memory'),
      'fixture sanity: the workflow memory is a topic hit',
    );
    assert.deepEqual(
      hits.slice(1),
      topicOnly.filter((h: GateHit) => h.memory.id !== 'task-memory'),
      'the remaining slots are exactly today degraded topic-only output, deduplicated',
    );
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC2: FTS syntax safety
// ---------------------------------------------------------------------------

test('FTS safety: operator-laden, quoted, emoji and 5,000-char prompts run without error and match literally', async () => {
  const dir = tmpDir();
  const stub = stubFetch();
  try {
    writeMemory(dir, 'task-notes', 'carry task 4e7729ab across branches');
    writeMemory(dir, 'strata-note', 'die Schicht und die Strata der Gesteine');
    await rebuildIndex(dir);
    const memories = loadMemoriesFromDir(dir);
    // [name, prompt, mustLiterallyMatchTaskNotes]
    const prompts: Array<[string, string, boolean]> = [
      ['quote', 'look up "4e7729ab" now', true],
      ['star', 'search 4e7729ab* and * patterns', true],
      ['minus', '-4e7729ab exclusion attempt', true],
      ['near', 'NEAR(strata, 5) proximity', false],
      ['parens', '(4e7729ab) grouping', true],
      ['caret', 'look 4e7729ab ^3 here', true],
      ['colon', '4e7729ab: column:query', true],
      ['boolean', '4e7729ab AND strata OR schicht NOT geologie', true],
      ['lone-quote', 'unterminated 4e7729ab " quote', true],
      ['emoji', 'find 4e7729ab 🎉 please', true],
      ['long', `filler ${'x'.repeat(5000)} tail 4e7729ab`, true],
    ];
    for (const [name, prompt, mustMatch] of prompts) {
      const outcome = await blendedSearch(prompt, memories, dir, 5);
      assert.ok(Array.isArray(outcome.keyword), `${name}: keyword result is an array`);
      if (!mustMatch) continue;
      assert.ok(
        outcome.keyword.some((k: { memory: Memory }) => k.memory.id === 'task-notes'),
        `${name}: the exact token 4e7729ab must still match LITERALLY, got ${JSON.stringify(outcome.keyword.map((k: { memory: Memory }) => k.memory.id))}`,
      );
    }
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FTS safety: NEAR( is carried as literal phrase text, not operator semantics', async () => {
  const dir = tmpDir();
  const stub = stubFetch();
  try {
    // strata appears NOWHERE adjacent to "near": an operator-semantics NEAR
    // would match, the literal quoted phrase must not.
    writeMemory(dir, 'strata-note', 'die Schicht und die Strata der Gesteine');
    await rebuildIndex(dir);
    const outcome = await blendedSearch('NEAR(strata)', loadMemoriesFromDir(dir), dir, 5);
    assert.deepEqual(outcome.keyword, [], 'no memory contains the adjacent words "near strata"');
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC4 (second half): the "Bonsai-Baum" negative control stays quiet because
// the phrase query only matches ADJACENT words.
// ---------------------------------------------------------------------------

test('Bonsai-Baum negative control: bonsai alone would qualify (df 9), but the phrase "bonsai baum" matches nothing unless the words are adjacent', async () => {
  const dir = tmpDir();
  const stub = stubFetch();
  try {
    for (let i = 0; i < 9; i++) {
      writeMemory(dir, `bonsai-${i}`, `Wie gieße ich meinen Bonsai richtig im Sommer ${i}`);
    }
    await rebuildIndex(dir);
    const store = openIndex({ path: indexPath(dir), meta: { provider: 'openai', model: MODEL } });
    try {
      assert.equal(store.ftsDocCount('"bonsai"'), 9, 'df 9 <= 12: the plain word alone WOULD qualify');
      assert.deepEqual(
        store.ftsMatch('"bonsai baum"', 10),
        [],
        'the phrase only matches adjacent words - none of the 9 notes spells "Bonsai Baum" out',
      );
    } finally {
      store.close();
    }

    // The discriminating decoy: BOTH words present, but not adjacent. An
    // unquoted/bare FTS query would implicitly AND the terms and match
    // this memory; the quoted phrase literal must not.
    writeMemory(dir, 'bonsai-under-tree', 'Der Bonsai steht im Sommer unter dem Baum');
    await rebuildIndex(dir);

    const outcome = await blendedSearch(
      'Wie pflege ich einen Bonsai-Baum',
      loadMemoriesFromDir(dir),
      dir,
      5,
    );
    assert.deepEqual(
      outcome.keyword,
      [],
      'the negative control admits nothing: wie/ich/einen are stopwords, pflege matches nothing, and the strong phrase "bonsai baum" matches nothing - not even the decoy carrying both words non-adjacent',
    );

    // And when the compound IS spelled out somewhere, the phrase finds it.
    writeMemory(dir, 'bonsai-tree', 'Der Bonsai Baum braucht Kalk');
    await rebuildIndex(dir);
    const store2 = openIndex({ path: indexPath(dir), meta: { provider: 'openai', model: MODEL } });
    try {
      const rows = store2.ftsMatch('"bonsai baum"', 10);
      assert.deepEqual(rows.map((r: { id: string }) => r.id), ['bonsai-tree']);
    } finally {
      store2.close();
    }
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
