// sqlite-vec-backed vector store for memory embeddings. Table layout is the
// minimum needed for exact-knn cosine search on ~100 memory files; no
// chunking, no metadata beyond (id, mtime) — the memory body itself is
// re-read from disk when we return a hit. Embeddings are blob-serialized
// float32 so sqlite-vec can MATCH them directly via `vec0` virtual tables.

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { createHash } = require('node:crypto');

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
  upsert: (id: string, mtime: number, embedding: number[]) => void;
  remove: (id: string) => void;
  listEntries: () => IndexEntry[];
  search: (queryEmbedding: number[], k: number) => SearchHit[];
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

  const upsertEntry = db.prepare(
    'INSERT INTO entries (id, mtime) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET mtime = excluded.mtime',
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
    (id: string, mtime: number, blob: Buffer) => {
      upsertEntry.run(id, mtime);
      const row = selectRowid.get(id) as { rowid: number };
      const rowid = BigInt(row.rowid);
      deleteVec.run(rowid);
      insertVec.run(rowid, blob);
    },
  );

  function upsert(id: string, mtime: number, embedding: number[]): void {
    if (embedding.length !== opts.dimensions) {
      throw new Error(
        `embedding dimension ${embedding.length} != index dimension ${opts.dimensions}`,
      );
    }
    upsertTx(id, mtime, toBlob(embedding));
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
  const cacheEvictStaleModelStmt = db.prepare(
    'DELETE FROM query_cache WHERE model != ?',
  );
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

  // Wrap the stale-model evict + upsert + LRU-evict trio in a single
  // transaction so a concurrent reader sees consistent state and the
  // count → delete step doesn't race with another writer overshooting
  // the cap.
  const putCachedQueryTx = db.transaction(
    (key: string, model: string, blob: Buffer, now: number, capacity: number) => {
      cacheEvictStaleModelStmt.run(model);
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
    SELECT entries.id AS id, vec.distance AS distance
    FROM vec
    JOIN entries ON entries.rowid = vec.rowid
    WHERE vec.embedding MATCH ?
      AND k = ?
    ORDER BY distance ASC
  `);

  function search(queryEmbedding: number[], k: number): SearchHit[] {
    if (queryEmbedding.length !== opts.dimensions) {
      throw new Error(
        `query dimension ${queryEmbedding.length} != index dimension ${opts.dimensions}`,
      );
    }
    const rows = searchStmt.all(toBlob(queryEmbedding), k) as {
      id: string;
      distance: number;
    }[];
    return rows.map((r) => ({
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
    search,
    getCachedQuery,
    putCachedQuery,
    cacheSize,
    close,
  };
}

module.exports = { openIndex };
