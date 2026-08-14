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
//
// Embed provenance (provider/model/dimensions), added for multi-provider
// support (mm-v1-T003):
//   The generic `meta` key/value table (already used for `schema_version`)
//   also carries `embed_provider` / `embed_model` / `embed_dimensions` rows,
//   written once (INSERT ... ON CONFLICT DO NOTHING) the first time an
//   embedding is actually written to a fresh index, and never overwritten
//   afterward. This needs no schema_version bump or migration entry — it's
//   just new keys in an existing generic table.
//   Dimensions are never hardcoded: a brand-new index defers creating the
//   `vec` virtual table (whose column width is fixed for the life of the
//   file — sqlite-vec bakes `FLOAT[N]` into the CREATE TABLE text) until the
//   first `upsert()` call, which learns N from the embedding it was actually
//   given. An index that already has data (this process or a prior one)
//   recovers its width from either the recorded `embed_dimensions` meta row
//   or, for a file written before this feature existed, by parsing the
//   physical `FLOAT[N]` out of `sqlite_master.sql` (PRAGMA table_info does
//   not expose vec0 column widths).
//   Provider-level mismatch (an index built under one provider, e.g.
//   'openai', opened under a different one, e.g. 'ollama') throws
//   immediately at open time when the caller passes `opts.meta`, since
//   different providers are never comparable regardless of dimensions. A
//   store that has never recorded provenance (storedProvider === null:
//   brand-new, or a pre-provenance-tracking legacy index) is NOT
//   automatically assumed safe to stamp with the active config either: if
//   it already has rows and any of them are tagged (or NULL-tagged, pre-v2)
//   for a different model, open throws the same rebuild error instead of
//   silently overwriting the store's real provenance with whatever happens
//   to be active right now, see the "Legacy-index provenance guard" block
//   below. A same-provider MODEL NAME change (e.g. switching
//   MEMORY_ROUTER_EMBED_MODEL between two OpenAI models) is deliberately
//   NOT rejected at open time: the pre-existing v2 per-row `entries.model`
//   tag + `expectedModel` filtering in getEmbedding/search already makes
//   that safe by excluding stale rows from any cosine comparison, and
//   tests/query-cache.test.ts already exercises + depends on that graceful
//   (non-throwing) path, PROVIDED the two models share a dimensionality. A
//   genuine DIMENSION mismatch (impossible before this feature, since
//   EMBED_DIMENSIONS was a single hardcoded constant) is not checked at
//   open time at all: it is caught the moment it's actually acted on, by
//   the plain `embedding.length`/`queryEmbedding.length` checks already
//   inside `upsert`, `putCachedQuery` and `search` (a width mismatch at the
//   sqlite-vec layer is undefined behavior, so those fail loud rather than
//   risking silently wrong neighbours); those three throws append the
//   exact rebuild command whenever the caller supplied
//   `opts.rebuildCommand` (rebuildIndex/semanticSearch always do).
//   `opts.meta` (the provider/legacy-index guards above) and
//   `opts.rebuildCommand` (the dimension-throw suffix) are both opt-in via
//   the caller supplying them: src/lint/conflicts.ts (forbidden to modify
//   for this task) opens the index with a legacy hardcoded `dimensions`
//   hint and neither `opts.meta` nor `opts.rebuildCommand`; when that hint
//   disagrees with a stored/physical dimension we already know, the REAL
//   value wins silently (the hint is just ignored) rather than throwing, so
//   that caller keeps working unmodified against a non-1536-dim (e.g.
//   Ollama) index, see `EMBED_DIMENSIONS` in indexer.ts.

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
      const cols = db.prepare('PRAGMA table_info(entries)').all() as {
        name: string;
      }[];
      if (!cols.some((c) => c.name === 'model')) {
        db.exec('ALTER TABLE entries ADD COLUMN model TEXT');
      }
    },
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyMigrations(db: any, registered: Migration[] = migrations): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );

  const selectVersion = db.prepare(
    "SELECT value FROM meta WHERE key = 'schema_version'",
  );
  const insertVersion = db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
  );
  const updateVersion = db.prepare(
    "UPDATE meta SET value = ? WHERE key = 'schema_version'",
  );

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
  // Optional hint. Callers that already know the dimension (fresh index,
  // or a legacy caller like src/lint/conflicts.ts that pre-dates this
  // feature) may supply it; a store that already has a recorded or
  // physical dimension ignores a disagreeing hint (see the module-level
  // comment above) rather than trusting it blindly. Omit entirely to let a
  // brand-new index defer table creation until the first upsert() learns
  // the real dimension from an embedding response.
  dimensions?: number;
  // Provenance to record/validate against a stored index. Only supplied by
  // src/embed/indexer.ts's rebuildIndex/semanticSearch; when present, a
  // provider mismatch against an already-built index throws immediately
  // (see module-level comment). Omit for callers that don't want this
  // check (e.g. tests constructing a bare store, or legacy callers outside
  // embed/).
  meta?: {
    provider: string;
    model: string;
  };
  // Exact remediation command included in a provenance/dimension mismatch
  // error. Optional; a generic fallback is used when omitted.
  rebuildCommand?: string;
  // Query-embedding cache config. Optional so callers that only need the
  // index (e.g. `memory-router index`) don't pay the extra DDL.
  cache?: {
    model: string;
    capacity: number;
  };
  // Open the connection strictly read-only (added for
  // src/consolidate/near-dupes.ts, mm-v1-T007 fix round HIGH #1): the
  // underlying `better-sqlite3` connection is opened with
  // `{ readonly: true, fileMustExist: true }`, and every write path this
  // module would otherwise take at open time is skipped: the
  // `journal_mode = WAL` pragma, every `CREATE TABLE`/`CREATE VIRTUAL
  // TABLE` DDL statement (entries, vec, query_cache), `applyMigrations`,
  // and `recordProvenance`. This is a pure read-only VIEW onto an index
  // that was already built by a normal (non-readonly) `openIndex` call
  // (e.g. `memory-router index`): every table it needs already exists on
  // disk. The provider-mismatch and legacy-index-provenance guards below
  // still run (they only ever READ the `meta` table) and still throw
  // their existing errors when the on-disk provenance disagrees with
  // `opts.meta`: readonly only removes the ability to WRITE, never the
  // ability to detect and report an incompatibility. Omit (default false)
  // for every other caller; existing callsites (indexer.ts,
  // lint/conflicts.ts) are unaffected and keep their full read-write
  // behavior unchanged.
  readonly?: boolean;
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
  upsert: (
    id: string,
    mtime: number,
    model: string,
    embedding: number[],
  ) => void;
  remove: (id: string) => void;
  listEntries: () => IndexEntry[];
  // Pull a stored embedding out by memory id. Returns null when the id is
  // not in the index, or when `expectedModel` is set and the stored row's
  // model differs (including NULL on a pre-v2 file).
  getEmbedding: (id: string, expectedModel?: string) => number[] | null;
  search: (
    queryEmbedding: number[],
    k: number,
    expectedModel?: string,
  ) => SearchHit[];
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
  const db = opts.readonly
    ? new Database(opts.path, { readonly: true, fileMustExist: true })
    : new Database(opts.path);
  sqliteVec.load(db);
  // WAL lets a hook reader coexist with a CLI writer rebuilding the index.
  // busy_timeout gives SQLite 2 seconds to clear a write lock instead of
  // failing the hook immediately on SQLITE_BUSY. Skipped on a readonly
  // connection: switching journal_mode is itself a write, and a readonly
  // caller is only ever pointed at an index some earlier writable open
  // already put in WAL mode (see IndexStoreOptions.readonly above).
  if (!opts.readonly) db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 2000');

  // Metadata table: what we have indexed + the mtime at index time. Skipped
  // on a readonly connection (see IndexStoreOptions.readonly): the table is
  // assumed to already exist, and CREATE TABLE would throw against a
  // readonly connection anyway.
  if (!opts.readonly) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL
      );
    `);
  }

  // Recover the physical width of an already-existing `vec` virtual table,
  // if any, from its stored CREATE TABLE text — sqlite-vec's vec0 columns
  // don't surface their width via PRAGMA table_info, but sqlite_master.sql
  // retains the literal "FLOAT[N]" from creation time.
  const existingVecRow = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec'",
    )
    .get() as { sql: string } | undefined;
  let vecTableExists = false;
  let physicalDimensions: number | null = null;
  if (existingVecRow) {
    vecTableExists = true;
    const m = existingVecRow.sql.match(/FLOAT\[(\d+)\]/);
    if (!m) {
      throw new Error(
        `cannot determine the embedding dimension of the existing vector table in ${opts.path}; the file may be corrupted`,
      );
    }
    physicalDimensions = Number(m[1]);
  }

  // Run migrations BEFORE preparing statements that reference v2 columns
  // (or the embed-provenance meta rows below). The query_cache table is
  // created later but applyMigrations only operates on entries/meta here;
  // it's safe to apply now. Skipped on a readonly connection (see
  // IndexStoreOptions.readonly): applyMigrations both creates the `meta`
  // table and writes the schema_version row, both writes; a readonly
  // caller is only ever pointed at an index a prior writable open already
  // migrated to CURRENT_SCHEMA_VERSION.
  if (!opts.readonly) applyMigrations(db);

  // --- Embed provenance: which provider/model/dimensions this index was
  // built under (see the module-level comment above). ---
  const metaGetStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
  const metaSetIfAbsentStmt = db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
  );
  function metaValue(key: string): string | null {
    const row = metaGetStmt.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }
  const storedProvider = metaValue('embed_provider');
  const storedModel = metaValue('embed_model');
  const storedDimensionsRaw = metaValue('embed_dimensions');
  const storedDimensions =
    storedDimensionsRaw !== null ? Number(storedDimensionsRaw) : null;

  if (
    storedDimensions !== null &&
    physicalDimensions !== null &&
    storedDimensions !== physicalDimensions
  ) {
    throw new Error(
      `embedding index at ${opts.path} is internally inconsistent: recorded dimensions=${storedDimensions} but the on-disk vector table is FLOAT[${physicalDimensions}]. The file is likely corrupted — delete it and rebuild.`,
    );
  }

  // dimensions: the authoritative value for THIS open, preferring what the
  // file itself already knows (recorded meta, then physical width) over
  // anything the caller merely hints at via opts.dimensions.
  let dimensions: number | null = storedDimensions ?? physicalDimensions;

  function rebuildHint(): string {
    return (
      opts.rebuildCommand ??
      'delete the index file and re-run `memory-router index <dir>`'
    );
  }

  // Appended to the raw dimension-mismatch throws in upsert/putCachedQuery/
  // search below (the guards a same-provider, different-dimensionality
  // model switch actually hits, see the module-level comment's "genuine
  // DIMENSION mismatch" paragraph). Only when the caller supplied an exact
  // `opts.rebuildCommand` (rebuildIndex/semanticSearch): a bare test-only
  // caller (no rebuildCommand, no opts.meta, e.g. tests/index-store.test.ts
  // constructing a store directly) keeps getting the original terse message
  // unchanged, since a generic "delete the index file..." fallback hint
  // wasn't part of that contract and several tests pin the exact original
  // string.
  function dimensionMismatchSuffix(): string {
    return opts.rebuildCommand
      ? ` Rebuild the index: ${opts.rebuildCommand}`
      : '';
  }

  // Provider-mismatch check (only enforced when the caller supplies
  // opts.meta — see module-level comment for why src/lint/conflicts.ts's
  // legacy call, which doesn't pass opts.meta, is exempt).
  if (
    opts.meta &&
    storedProvider !== null &&
    storedProvider !== opts.meta.provider
  ) {
    throw new Error(
      `embedding index at ${opts.path} was built with provider=${storedProvider} model=${storedModel ?? 'unknown'}` +
        `${dimensions !== null ? ` (dimensions=${dimensions})` : ''}; current configuration is ` +
        `provider=${opts.meta.provider} model=${opts.meta.model}. Embeddings from different providers are ` +
        `never comparable. Rebuild the index: ${rebuildHint()}`,
    );
  }

  // Legacy-index provenance guard: a store that has never recorded
  // provenance (storedProvider === null) is either brand-new (rowCount 0,
  // nothing to protect) or a pre-provenance-tracking index whose rows
  // already carry a v2 `entries.model` tag (or NULL, pre-v2), the actual
  // source of truth for what embedding space is on disk. recordProvenance()
  // below must never blindly stamp the ACTIVE config onto such a store when
  // its existing rows disagree with it: a later search would then trust a
  // provenance meta row that lies about what's actually indexed. Only
  // reachable when opts.meta is supplied (rebuildIndex/semanticSearch);
  // src/lint/conflicts.ts's legacy call (no opts.meta) is exempt, same as
  // the provider-mismatch check above.
  if (opts.meta && storedProvider === null) {
    const { n: rowCount } = db
      .prepare('SELECT COUNT(*) AS n FROM entries')
      .get() as { n: number };
    if (rowCount > 0) {
      const { n: mismatched } = db
        .prepare(
          'SELECT COUNT(*) AS n FROM entries WHERE model IS NULL OR model != ?',
        )
        .get(opts.meta.model) as { n: number };
      if (mismatched > 0) {
        throw new Error(
          `embedding index at ${opts.path} has ${mismatched} existing entr(y/ies) not tagged for model=${opts.meta.model} (provider=${opts.meta.provider})` +
            `${dimensions !== null ? ` (dimensions=${dimensions})` : ''}; the index predates provider/model provenance ` +
            `tracking and its rows belong to a different embedding space. Rebuild the index: ${rebuildHint()}`,
        );
      }
    }
  }

  if (dimensions === null && opts.dimensions !== undefined) {
    dimensions = opts.dimensions;
  }

  // Vector table: sqlite-vec virtual table keyed by rowid that we map to
  // `entries.rowid`. This keeps the vec storage tight and lets us join back
  // on integer rowids instead of shipping the id through the vector table.
  // sqlite-vec's rowid binding needs BigInt (not a plain JS number) — see
  // `toBigIntRowid` below. Column width is fixed for the life of the file
  // (CREATE ... IF NOT EXISTS is a no-op on an existing table), so this
  // only actually creates the table the first time `dimensions` becomes
  // known — either now (existing file, or a caller-supplied hint) or later
  // from inside upsert() the first time a fresh index learns its dimension
  // from a real embedding response.
  function ensureVecTable(dim: number): void {
    if (vecTableExists) return;
    // Readonly connections never create tables (see IndexStoreOptions.
    // readonly). In practice this is unreachable for a real readonly
    // caller, since an already-built index this option is meant for
    // always has its vec table already, and `vecTableExists` would
    // already be true above; kept as a defensive no-op rather than an
    // attempted write that would throw.
    if (opts.readonly) return;
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec USING vec0(embedding FLOAT[${dim}] distance_metric=cosine);`,
    );
    vecTableExists = true;
  }
  if (dimensions !== null) ensureVecTable(dimensions);

  // Record provenance the first time it's known, whether that's now (an
  // existing file/hint being opened for the first time under this feature)
  // or later from upsert(). ON CONFLICT DO NOTHING means this is a no-op
  // once a baseline is recorded.
  function recordProvenance(dim: number): void {
    // Readonly connections never write provenance (see IndexStoreOptions.
    // readonly). The call sites below only reach here when
    // storedDimensions === null, which a real already-built index (the
    // only thing a readonly caller is meant to point at) never hits.
    if (opts.readonly) return;
    if (opts.meta) {
      metaSetIfAbsentStmt.run('embed_provider', opts.meta.provider);
      metaSetIfAbsentStmt.run('embed_model', opts.meta.model);
    }
    metaSetIfAbsentStmt.run('embed_dimensions', String(dim));
  }
  if (dimensions !== null && storedDimensions === null) {
    recordProvenance(dimensions);
  }

  const upsertEntry = db.prepare(
    'INSERT INTO entries (id, mtime, model) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET mtime = excluded.mtime, model = excluded.model',
  );
  const selectRowid = db.prepare('SELECT rowid FROM entries WHERE id = ?');
  const deleteEntry = db.prepare('DELETE FROM entries WHERE id = ?');
  const listStmt = db.prepare('SELECT id, mtime FROM entries');

  // Statements that reference the `vec` table are prepared lazily
  // (memoized) because a brand-new index with no dimension hint defers
  // creating that table until upsert() learns the real width. By the time
  // any of these getters is actually invoked, `dimensions` is guaranteed
  // non-null and `ensureVecTable` has already run (upsert() calls it before
  // touching any of these; entries can only exist once upsert() has run at
  // least once, so remove()'s early-return on a missing row means it never
  // reaches deleteVecStmt() on a table-less store either).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _insertVec: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _deleteVec: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _selectEmbeddingStmt: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _searchStmt: any = null;
  function insertVecStmt() {
    if (!_insertVec)
      _insertVec = db.prepare(
        'INSERT INTO vec (rowid, embedding) VALUES (?, ?)',
      );
    return _insertVec;
  }
  function deleteVecStmt() {
    if (!_deleteVec) _deleteVec = db.prepare('DELETE FROM vec WHERE rowid = ?');
    return _deleteVec;
  }
  function selectEmbeddingStmtLazy() {
    if (!_selectEmbeddingStmt) {
      _selectEmbeddingStmt = db.prepare(
        'SELECT entries.model AS model, vec.embedding AS embedding FROM vec JOIN entries ON entries.rowid = vec.rowid WHERE entries.id = ?',
      );
    }
    return _selectEmbeddingStmt;
  }
  function searchStmtLazy() {
    if (!_searchStmt) {
      _searchStmt = db.prepare(`
        SELECT entries.id AS id, entries.model AS model, vec.distance AS distance
        FROM vec
        JOIN entries ON entries.rowid = vec.rowid
        WHERE vec.embedding MATCH ?
          AND k = ?
        ORDER BY distance ASC
      `);
    }
    return _searchStmt;
  }

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
      deleteVecStmt().run(rowid);
      insertVecStmt().run(rowid, blob);
    },
  );

  function upsert(
    id: string,
    mtime: number,
    model: string,
    embedding: number[],
  ): void {
    // Validate model first: a v1 caller using the old 3-arg signature
    // would land `embedding` in this slot and get a confusing TypeError
    // when we read embedding.length on the actual `embedding` arg below.
    // The friendly error names the missing arg explicitly.
    if (typeof model !== 'string' || model.length === 0) {
      throw new Error('upsert requires a non-empty model name');
    }
    if (!Array.isArray(embedding)) {
      throw new Error(
        `embedding dimension undefined != index dimension ${dimensions ?? 'unknown'}`,
      );
    }
    if (dimensions === null) {
      // First embedding this store has ever seen: derive + persist the
      // dimension (and provenance, if tracked) from it now, rather than
      // trusting a hardcoded constant — see module-level comment.
      dimensions = embedding.length;
      ensureVecTable(dimensions);
      recordProvenance(dimensions);
    } else if (embedding.length !== dimensions) {
      throw new Error(
        `embedding dimension ${embedding.length} != index dimension ${dimensions}${dimensionMismatchSuffix()}`,
      );
    }
    upsertTx(id, mtime, model, toBlob(embedding));
  }

  function remove(id: string): void {
    const row = selectRowid.get(id) as { rowid: number } | undefined;
    if (!row) return;
    deleteVecStmt().run(BigInt(row.rowid));
    deleteEntry.run(id);
  }

  function listEntries(): IndexEntry[] {
    return listStmt.all() as IndexEntry[];
  }

  const countStaleModelStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM entries WHERE model IS NULL OR model != ?',
  );

  function getEmbedding(id: string, expectedModel?: string): number[] | null {
    if (dimensions === null) return null; // nothing has ever been embedded
    const row = selectEmbeddingStmtLazy().get(id) as
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
  // expected to leave the cache intact. Skipped on a readonly connection
  // (see IndexStoreOptions.readonly): a readonly caller never passes
  // `opts.cache` either (near-dupes.ts only reads embeddings), so the
  // table is never actually needed there; a real already-built index
  // already has it from its original writable open regardless.
  if (!opts.readonly) {
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
  }

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
    const hasStale = (
      db
        .prepare(
          'SELECT EXISTS(SELECT 1 FROM query_cache WHERE model != ?) AS has',
        )
        .get(cacheModel) as { has: number }
    ).has;
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
    (
      key: string,
      model: string,
      blob: Buffer,
      now: number,
      capacity: number,
    ) => {
      cacheUpsertStmt.run(key, model, blob, now);
      const { n } = cacheCountStmt.get() as { n: number };
      if (n > capacity) {
        cacheEvictOldestStmt.run(n - capacity);
      }
    },
  );

  function putCachedQuery(prompt: string, embedding: number[]): void {
    if (!cacheModel || cacheCapacity <= 0) return;
    if (dimensions !== null && embedding.length !== dimensions) {
      throw new Error(
        `cached embedding dimension ${embedding.length} != index dimension ${dimensions}${dimensionMismatchSuffix()}`,
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
  function search(
    queryEmbedding: number[],
    k: number,
    expectedModel?: string,
  ): SearchHit[] {
    if (dimensions === null) return []; // nothing has ever been embedded
    if (queryEmbedding.length !== dimensions) {
      throw new Error(
        `query dimension ${queryEmbedding.length} != index dimension ${dimensions}${dimensionMismatchSuffix()}`,
      );
    }
    const rows = searchStmtLazy().all(toBlob(queryEmbedding), k) as {
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
