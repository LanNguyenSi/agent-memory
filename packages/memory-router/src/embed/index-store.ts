// sqlite-vec-backed vector store for memory embeddings. Table layout is the
// minimum needed for exact-knn cosine search on ~100 memory files; no
// chunking, no metadata beyond (id, mtime) — the memory body itself is
// re-read from disk when we return a hit. Embeddings are blob-serialized
// float32 so sqlite-vec can MATCH them directly via `vec0` virtual tables.

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

interface IndexStoreOptions {
  path: string;
  dimensions: number;
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

  return { upsert, remove, listEntries, search, close };
}

module.exports = { openIndex };
