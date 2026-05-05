// sqlite-vec-backed vector store for memory embeddings. Table layout is the
// minimum needed for exact-knn cosine search on ~100 memory files; no
// chunking, no metadata beyond (id, mtime) — the memory body itself is
// re-read from disk when we return a hit. Embeddings are blob-serialized
// float32 so sqlite-vec can MATCH them directly via `vec0` virtual tables.
//
// Schema migration contract:
//   The `meta` table holds a single `schema_version` row that tracks the
//   on-disk schema. CURRENT_SCHEMA_VERSION is the version this code expects.
//   `applyMigrations` runs AFTER the v1 baseline DDL (entries, vec) and
//   BEFORE any prepared statement that references a v>=2 column, so a
//   migration like `ALTER TABLE entries ADD COLUMN …` always sees the
//   table it operates on AND the prepared statements always see the
//   final column set. New tables introduced after v1 must be created by
//   their own migration entry, not by adding to the baseline DDL.
//   Pre-meta files (written before this contract existed) carry no version
//   row but already contain the v1 tables. We tag them as v1 (the baseline)
//   and fall through to the migration loop, so any 1→2…N→CURRENT migrations
//   still run on those files. This also makes fresh DBs and pre-meta DBs
//   take the exact same code path.
//   Concurrency: the read-and-migrate sequence runs inside a BEGIN IMMEDIATE
//   transaction so two processes opening the same DB simultaneously cannot
//   both decide migrations are needed and double-apply them. better-sqlite3
//   transactions auto-rollback on exception, so a throwing migration leaves
//   the on-disk version row untouched.

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { createHash } = require('node:crypto');

// SCHEMA_VERSION_BASELINE is the version every shipped DB has at minimum:
// fresh DBs and pre-meta DBs both start here. CURRENT_SCHEMA_VERSION is what
// this code expects on disk; when CURRENT > BASELINE, every open runs
// migrations BASELINE→...→CURRENT against existing files.
//
// v2 (2026-05-05): adds `model TEXT` to `entries` so cross-model embedding
// mixing is detectable. Pre-v2 rows get NULL on the new column; readers
// that pass an `expectedModel` reject NULL rows (forcing a rebuild), so a
// silent meaningless-cosine result is no longer possible.
const SCHEMA_VERSION_BASELINE = 1;
const CURRENT_SCHEMA_VERSION = 2;

interface Migration {
  from: number;
  to: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (db: any) => void;
}

// Migrations are applied in order to bring an older DB up to
// CURRENT_SCHEMA_VERSION. The 0→1 entry is reachable only when a caller
// explicitly seeds `schema_version=0` (see tests); real pre-meta files take
// the no-row path in `applyMigrations` and are tagged at BASELINE directly.
// The entry is kept so the migration framework has at least one registered
// transition, which is exercised by the rollback test.
const migrations: Migration[] = [
  {
    from: 0,
    to: 1,
    run: () => {
      // v1 is the baseline. The v1 tables (entries, vec, query_cache) are
      // created idempotently by `openIndex` itself, so this migration has no
      // schema work to do. Future entries (1→2, ...) own their own DDL.
    },
  },
  {
    from: 1,
    to: 2,
    run: (db) => {
      // Add `model` column to `entries`. Existing rows get NULL; readers
      // with `expectedModel` set reject NULL → forces a rebuild so the
      // user has to deliberately re-embed under a known model. SQLite
      // doesn't support adding a column with a non-constant default, so
      // the NULL backfill is the cleanest path.
      //
      // Idempotency: a pre-meta file that already has `model` (e.g. one
      // written by this code, then had its meta table dropped to
      // simulate an old build) must not double-apply. Probe the column
      // list and no-op when it's already there.
      const cols = db.prepare('PRAGMA table_info(entries)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'model')) {
        db.exec('ALTER TABLE entries ADD COLUMN model TEXT');
      }
    },
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyMigrations(db: any, registered: Migration[] = migrations): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  const selectVersion = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'");
  const insertVersion = db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)");
  const updateVersion = db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'");

  const migrate = db.transaction(() => {
    const row = selectVersion.get() as { value: string } | undefined;
    let current: number;
    if (!row) {
      // Either a fresh DB or a pre-meta file. Both are tagged at BASELINE so
      // future BASELINE→N migrations still run on pre-meta files. Inserting
      // CURRENT here would be a silent skip the day a real migration lands.
      insertVersion.run(String(SCHEMA_VERSION_BASELINE));
      current = SCHEMA_VERSION_BASELINE;
    } else {
      current = Number(row.value);
      if (!Number.isInteger(current) || current < 0) {
        throw new Error(`invalid schema_version ${row.value} in meta table`);
      }
    }

    if (current > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `on-disk schema_version ${current} is newer than this code supports (${CURRENT_SCHEMA_VERSION}); upgrade memory-router`,
      );
    }

    while (current < CURRENT_SCHEMA_VERSION) {
      const next = current;
      const m = registered.find((x) => x.from === next);
      if (!m) {
        throw new Error(`no migration registered from schema_version ${next}`);
      }
      m.run(db);
      updateVersion.run(String(m.to));
      current = m.to;
    }
  });
  migrate.immediate();
}

// Full sha256 hex (64 chars). A truncated prefix would be small enough that
// a collision returns the wrong embedding silently — the row is keyed by
// hash alone, so two prompts with the same prefix would map to one cache
// entry. Embedding rows are ~6 KB each; the extra 48 bytes per key are noise.
function promptKey(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

interface IndexStoreOptions {
  path: string;
  dimensions: number;
  // Query-embedding cache config. Optional so callers that only need the
  // index (e.g. `memory-router index`) don't pay the extra DDL.
  cache?: {
    model: string;
    capacity: number;
  };
}

interface IndexEntry {
  id: string;
  mtime: number;
}

interface SearchHit {
  id: string;
  // Cosine similarity in [0, 1] (sqlite-vec returns cosine *distance*, we
  // invert to similarity so higher = closer).
  similarity: number;
}

function openIndex(opts: IndexStoreOptions): {
  // Stores the embedding under `model`. Readers that pass an
  // `expectedModel` to getEmbedding/search reject rows whose stored model
  // differs (or is NULL from a pre-v2 file), forcing a rebuild instead of
  // silently mixing incompatible embedding spaces.
  upsert: (id: string, mtime: number, model: string, embedding: number[]) => void;
  remove: (id: string) => void;
  listEntries: () => IndexEntry[];
  // Pull a stored embedding out by memory id. Returns null when the id is
  // not in the index, or when `expectedModel` is set and the stored row's
  // model differs (including NULL on a pre-v2 file).
  getEmbedding: (id: string, expectedModel?: string) => number[] | null;
  search: (queryEmbedding: number[], k: number, expectedModel?: string) => SearchHit[];
  // Count of `entries` rows whose `model` is NULL or mismatches the
  // argument. Surfaces "you ran with model A, the index has model B" so
  // CLI callers can warn the user without re-running their own probes.
  countEntriesWithStaleModel: (expectedModel: string) => number;
  // Query-embedding cache. Returns null when the cache is disabled or the
  // entry is missing / stored under a different model. `putCachedQuery`
  // overwrites stale-model rows lazily and enforces the LRU cap.
  getCachedQuery: (prompt: string) => number[] | null;
  putCachedQuery: (prompt: string, embedding: number[]) => void;
  cacheSize: () => number;
  close: () => void;
} {
  const db = new Database(opts.path);
  sqliteVec.load(db);
  // WAL lets a hook reader coexist with a CLI writer rebuilding the index.
  // busy_timeout gives SQLite 2 seconds to clear a write lock instead of
  // failing the hook immediately on SQLITE_BUSY.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 2000');

  // Metadata table: what we have indexed + the mtime at index time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL
    );
  `);

  // Vector table: sqlite-vec virtual table keyed by rowid that we map to
  // `entries.rowid`. This keeps the vec storage tight and lets us join back
  // on integer rowids instead of shipping the id through the vector table.
  // sqlite-vec's rowid binding needs BigInt (not a plain JS number) — see
  // `toBigIntRowid` below.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec
      USING vec0(embedding FLOAT[${opts.dimensions}] distance_metric=cosine);
  `);

  // Run migrations BEFORE preparing statements that reference v2 columns.
  // The query_cache table is created later but applyMigrations only
  // operates on entries here; it's safe to apply now.
  applyMigrations(db);

  const upsertEntry = db.prepare(
    'INSERT INTO entries (id, mtime, model) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET mtime = excluded.mtime, model = excluded.model',
  );
  const selectRowid = db.prepare('SELECT rowid FROM entries WHERE id = ?');
  const deleteVec = db.prepare('DELETE FROM vec WHERE rowid = ?');
  const insertVec = db.prepare('INSERT INTO vec (rowid, embedding) VALUES (?, ?)');
  const deleteEntry = db.prepare('DELETE FROM entries WHERE id = ?');
  const listStmt = db.prepare('SELECT id, mtime FROM entries');

  function toBlob(vec: number[]): Buffer {
    const f32 = new Float32Array(vec);
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  }

  // Wrap entries + vec writes in a single transaction so a concurrent
  // reader never observes an entries row whose vec row has been deleted
  // but not yet reinserted. better-sqlite3 transactions are synchronous.
  const upsertTx = db.transaction(
    (id: string, mtime: number, model: string, blob: Buffer) => {
      upsertEntry.run(id, mtime, model);
      const row = selectRowid.get(id) as { rowid: number };
      const rowid = BigInt(row.rowid);
      deleteVec.run(rowid);
      insertVec.run(rowid, blob);
    },
  );

  function upsert(id: string, mtime: number, model: string, embedding: number[]): void {
    // Validate model first: a v1 caller using the old 3-arg signature
    // would land `embedding` in this slot and get a confusing TypeError
    // when we read embedding.length on the actual `embedding` arg below.
    // The friendly error names the missing arg explicitly.
    if (typeof model !== 'string' || model.length === 0) {
      throw new Error('upsert requires a non-empty model name');
    }
    if (!Array.isArray(embedding) || embedding.length !== opts.dimensions) {
      throw new Error(
        `embedding dimension ${Array.isArray(embedding) ? embedding.length : 'undefined'} != index dimension ${opts.dimensions}`,
      );
    }
    upsertTx(id, mtime, model, toBlob(embedding));
  }

  function remove(id: string): void {
    const row = selectRowid.get(id) as { rowid: number } | undefined;
    if (!row) return;
    deleteVec.run(BigInt(row.rowid));
    deleteEntry.run(id);
  }

  function listEntries(): IndexEntry[] {
    return listStmt.all() as IndexEntry[];
  }

  const selectEmbeddingStmt = db.prepare(
    'SELECT entries.model AS model, vec.embedding AS embedding FROM vec JOIN entries ON entries.rowid = vec.rowid WHERE entries.id = ?',
  );
  const countStaleModelStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM entries WHERE model IS NULL OR model != ?',
  );

  function getEmbedding(id: string, expectedModel?: string): number[] | null {
    const row = selectEmbeddingStmt.get(id) as
      | { model: string | null; embedding: Buffer }
      | undefined;
    if (!row) return null;
    if (expectedModel !== undefined && row.model !== expectedModel) return null;
    return vecFromBlob(row.embedding);
  }

  function countEntriesWithStaleModel(expectedModel: string): number {
    const row = countStaleModelStmt.get(expectedModel) as { n: number };
    return row.n;
  }

  // Query-embedding cache. Identical prompts (e.g. "kannst du helfen") hit
  // the Confidence Gate every session and re-pay an OpenAI embedding call —
  // this table memoizes the prompt→vector mapping so repeats become a single
  // sqlite SELECT. Lives in the same file as the index because both already
  // share an open connection and a `memory-router index --rebuild` is
  // expected to leave the cache intact.
  db.exec(`
    CREATE TABLE IF NOT EXISTS query_cache (
      prompt_sha TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      embedding BLOB NOT NULL,
      accessed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS query_cache_accessed_at_idx
      ON query_cache(accessed_at);
  `);

  const cacheModel = opts.cache?.model;
  const cacheCapacity = opts.cache?.capacity ?? 0;

  const cacheSelectStmt = db.prepare(
    'SELECT model, embedding FROM query_cache WHERE prompt_sha = ?',
  );
  const cacheTouchStmt = db.prepare(
    'UPDATE query_cache SET accessed_at = ? WHERE prompt_sha = ?',
  );
  const cacheUpsertStmt = db.prepare(
    `INSERT INTO query_cache (prompt_sha, model, embedding, accessed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(prompt_sha) DO UPDATE SET
       model = excluded.model,
       embedding = excluded.embedding,
       accessed_at = excluded.accessed_at`,
  );
  // Connection-scoped one-shot: if the cache holds rows under a different
  // model, nuke them once at open time. Subsequent puts under `cacheModel`
  // no longer touch rows from other models — that used to thrash the cache
  // to size 1 whenever two processes alternated `MEMORY_ROUTER_EMBED_MODEL`.
  if (cacheModel !== undefined) {
    const hasStale = (db
      .prepare('SELECT EXISTS(SELECT 1 FROM query_cache WHERE model != ?) AS has')
      .get(cacheModel) as { has: number }).has;
    if (hasStale) {
      db.prepare('DELETE FROM query_cache WHERE model != ?').run(cacheModel);
    }
  }

  const cacheCountStmt = db.prepare('SELECT COUNT(*) AS n FROM query_cache');
  // Evict oldest rows beyond the cap. We pre-compute how many to drop
  // because SQLite's DELETE doesn't accept LIMIT without a build flag.
  const cacheEvictOldestStmt = db.prepare(
    `DELETE FROM query_cache
     WHERE prompt_sha IN (
       SELECT prompt_sha FROM query_cache
       ORDER BY accessed_at ASC
       LIMIT ?
     )`,
  );

  function vecFromBlob(blob: Buffer): number[] {
    const f32 = new Float32Array(
      blob.buffer,
      blob.byteOffset,
      blob.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
    return Array.from(f32);
  }

  function getCachedQuery(prompt: string): number[] | null {
    if (!cacheModel) return null;
    const row = cacheSelectStmt.get(promptKey(prompt)) as
      | { model: string; embedding: Buffer }
      | undefined;
    if (!row) return null;
    if (row.model !== cacheModel) return null;
    cacheTouchStmt.run(Date.now(), promptKey(prompt));
    return vecFromBlob(row.embedding);
  }

  // Wrap upsert + LRU-evict in a single transaction so a concurrent reader
  // sees consistent state and the count → delete step doesn't race with
  // another writer overshooting the cap. Stale-model eviction is no longer
  // in the hot path (see the one-shot above).
  const putCachedQueryTx = db.transaction(
    (key: string, model: string, blob: Buffer, now: number, capacity: number) => {
      cacheUpsertStmt.run(key, model, blob, now);
      const { n } = cacheCountStmt.get() as { n: number };
      if (n > capacity) {
        cacheEvictOldestStmt.run(n - capacity);
      }
    },
  );

  function putCachedQuery(prompt: string, embedding: number[]): void {
    if (!cacheModel || cacheCapacity <= 0) return;
    if (embedding.length !== opts.dimensions) {
      throw new Error(
        `cached embedding dimension ${embedding.length} != index dimension ${opts.dimensions}`,
      );
    }
    putCachedQueryTx(
      promptKey(prompt),
      cacheModel,
      toBlob(embedding),
      Date.now(),
      cacheCapacity,
    );
  }

  function cacheSize(): number {
    const { n } = cacheCountStmt.get() as { n: number };
    return n;
  }

  // sqlite-vec's MATCH returns cosine *distance* in [0, 2]; similarity =
  // 1 - distance/2 maps it back to [0, 1] so callers can compare to a
  // threshold expressed as similarity.
  const searchStmt = db.prepare(`
    SELECT entries.id AS id, entries.model AS model, vec.distance AS distance
    FROM vec
    JOIN entries ON entries.rowid = vec.rowid
    WHERE vec.embedding MATCH ?
      AND k = ?
    ORDER BY distance ASC
  `);

  function search(
    queryEmbedding: number[],
    k: number,
    expectedModel?: string,
  ): SearchHit[] {
    if (queryEmbedding.length !== opts.dimensions) {
      throw new Error(
        `query dimension ${queryEmbedding.length} != index dimension ${opts.dimensions}`,
      );
    }
    const rows = searchStmt.all(toBlob(queryEmbedding), k) as {
      id: string;
      model: string | null;
      distance: number;
    }[];
    // Filter rows whose stored model differs from the caller's. Comparing
    // cosines across embedding spaces is meaningless, so a row from a
    // different model (or a pre-v2 NULL row) is dropped instead of being
    // returned with a misleading similarity.
    const filtered =
      expectedModel === undefined
        ? rows
        : rows.filter((r) => r.model === expectedModel);
    return filtered.map((r) => ({
      id: r.id,
      similarity: Math.max(0, 1 - r.distance / 2),
    }));
  }

  function close(): void {
    db.close();
  }

  return {
    upsert,
    remove,
    listEntries,
    getEmbedding,
    countEntriesWithStaleModel,
    search,
    getCachedQuery,
    putCachedQuery,
    cacheSize,
    close,
  };
}

// `applyMigrations` and `CURRENT_SCHEMA_VERSION` are exported for tests that
// need to inject a custom migrations array (e.g. rollback / failure paths).
// Production callers should only use `openIndex`.
module.exports = { openIndex, applyMigrations, CURRENT_SCHEMA_VERSION };
