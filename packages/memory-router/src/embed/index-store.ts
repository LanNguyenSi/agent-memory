// sqlite-vec-backed vector store for memory embeddings. Table layout is the
// minimum needed for exact-knn cosine search on ~100 memory files:
// one document vector per memory (entries + vec, unchanged since v1), plus
// since schema v3 one vector per body CHUNK for long-memory recall
// (chunks + chunk_vec, see the v3 note below and src/embed/chunking.ts),
// plus since schema v4 one FTS5 keyword row per chunk (chunks_fts, see the
// v4 note below and src/embed/keyword.ts);
// no other metadata beyond (id, mtime) and per-chunk (chunk_index,
// char_offset, model); the memory body itself is re-read from disk when
// we return a hit. Embeddings are blob-serialized float32 so sqlite-vec
// can MATCH them directly via `vec0` virtual tables.
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
// support:
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
//   the caller supplying them. A caller that passes a `dimensions` hint
//   without `opts.meta` gets the lenient path: when that hint disagrees
//   with a stored/physical dimension we already know, the REAL value wins
//   silently (the hint is just ignored) rather than throwing. The
//   `--semantic` path of src/lint/conflicts.ts passes neither a hint nor
//   `opts.meta`: it opens the index `readonly` (see IndexStoreOptions),
//   so it never creates tables or records a width.

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
//
// v3 (2026-10-26): adds the chunk tables for chunked embeddings (long
// memories are findable by any part of their body, not just the first
// 8,000 chars; see src/embed/chunking.ts):
//   - `chunks (id, chunk_index, char_offset, model)`: one row per body
//     chunk; `char_offset` is the chunk's first character in the raw body.
//   - `chunk_vec`: a second vec0 virtual table keyed by `chunks.rowid`
//     (same fixed width as `vec`, same deferred-creation rule: it can only
//     be created once a width is known, so the migration itself does not
//     create it, `replaceChunks` and open do).
//   A freshly migrated index simply has no chunk rows and behaves exactly
//   like v2 (document vectors only) until `rebuildIndex` embeds chunks for
//   every memory that has none (the mtime skip must not hide that, see
//   src/embed/indexer.ts). The per-memory document vector (entries + vec)
//   and `getEmbedding` are deliberately unchanged for near-dupes/lint.
//
// v4 (2026-10-27): adds the FTS5 keyword index (`chunks_fts`) so the router
// can find memories by rare exact tokens (task ids, build tags, identifiers)
// that the dense embedding ranks poorly (see src/embed/keyword.ts):
//   - `chunks_fts`: an fts5 virtual table with three INDEXED text columns
//     (the memory's name, its description, and ONE chunk's text) plus two
//     UNINDEXED key columns (`mid` = memory id, `cidx` = chunk index) so a
//     matched row maps back to (memory id, chunk index). One row per chunk,
//     mirroring `chunks`; name/description repeat per chunk row.
//   Unlike `chunk_vec` this table needs NO deferred creation: it stores no
//     vectors, only text, so the migration itself creates it (FTS5 ships in
//     this build's SQLite, verified 3.53).
//   A freshly migrated index simply has no FTS rows and behaves exactly like
//   v3 (no keyword hits) until `rebuildIndex` back-fills them for every
//   memory that has chunk rows but no FTS rows, under the same mtime-skip
//   rule as the v3 chunk back-fill (see src/embed/indexer.ts).
const SCHEMA_VERSION_BASELINE = 1;
const CURRENT_SCHEMA_VERSION = 4;

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
  {
    from: 2,
    to: 3,
    run: (db) => {
      // Chunk tables (see the v3 note above). `chunk_vec` (vec0) is NOT
      // created here: its FLOAT[N] width must come from a real embedding,
      // and an index can legitimately migrate before anything has ever
      // been embedded (no recorded width yet). ensureChunkVecTable creates
      // it the moment a width is known, same deferred-creation rule as
      // `vec`.
      //
      // Idempotency: same pre-meta-file probe pattern as the 1→2 entry
      // above, so a file that already carries `chunks` never double-applies.
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      if (!tables.some((t) => t.name === 'chunks')) {
        db.exec(`
          CREATE TABLE chunks (
            id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            char_offset INTEGER NOT NULL,
            model TEXT
          );
          CREATE INDEX chunks_id_idx ON chunks(id);
          CREATE UNIQUE INDEX chunks_id_chunk_index_idx ON chunks(id, chunk_index);
        `);
      }
    },
  },
  {
    from: 3,
    to: 4,
    run: (db) => {
      // FTS5 keyword index (see the v4 note above). No deferred creation
      // and no vector width involved, so - unlike the v3 chunk_vec table -
      // the migration itself owns the DDL.
      //
      // Idempotency: same pre-meta-file probe pattern as the 1→2 and 2→3
      // entries above, so a file that already carries `chunks_fts` never
      // double-applies.
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      if (!tables.some((t) => t.name === 'chunks_fts')) {
        db.exec(`
          CREATE VIRTUAL TABLE chunks_fts USING fts5(
            name,
            description,
            text,
            mid UNINDEXED,
            cidx UNINDEXED,
            tokenize = 'unicode61 remove_diacritics 2'
          );
        `);
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
  // or a caller without `opts.meta`, see the module-level comment) may
  // supply it; a store that already has a recorded or
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
  // src/consolidate/near-dupes.ts): the
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
  // for read-write callers such as indexer.ts. The `--semantic` path of
  // lint/conflicts.ts opens with readonly and no dimensions hint, so an
  // index without a recorded width stays without one.
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

// One chunk vector to (re)write for a memory (schema v3 chunk tables).
// `index`/`offset` are the chunk's index within its memory body and its
// character offset into the raw body (see src/embed/chunking.ts).
interface ChunkInput {
  index: number;
  offset: number;
  embedding: number[];
}

// A chunk-level KNN hit: the best (nearest) chunk of one memory id.
interface ChunkSearchHit {
  id: string;
  similarity: number;
  chunkIndex: number;
  charOffset: number;
}

// One FTS keyword row to (re)write for a memory (schema v4 keyword index):
// the chunk's index within its memory body plus its raw text. The memory's
// name/description are passed once per replaceFts call and repeated into
// every row (they are indexed alongside the chunk text).
interface FtsChunkInput {
  index: number;
  text: string;
}

// One row matched by ftsMatch(): the matched memory id, the matched chunk
// index, and the FTS5 bm25 score (lower = better; bm25() rows come back
// ORDER BY score ASC).
interface FtsMatchRow {
  id: string;
  chunkIndex: number;
  score: number;
}

// Best query cosine (same 1 - distance/2 scale as search(), so directly
// comparable to a semantic score) between the query vector and one memory's
// document/chunk vectors.
interface IdSimilarity {
  id: string;
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
  // Schema v3 chunk tables. `replaceChunks` atomically replaces ALL chunk
  // rows of one memory (an empty `chunks` list just deletes them, so a
  // shorter new version of a memory never keeps orphan chunks of the old
  // one). `listChunkIds` returns the distinct ids that have at least one
  // chunk row (lets rebuildIndex detect a freshly migrated index that
  // still needs chunks despite unchanged mtimes). `searchChunks` runs the
  // chunk KNN and returns AT MOST ONE hit per memory id (the nearest
  // chunk), over-fetched so many chunks of one memory cannot crowd other
  // memories out of `k`.
  replaceChunks: (id: string, model: string, chunks: ChunkInput[]) => void;
  listChunkIds: () => string[];
  searchChunks: (
    queryEmbedding: number[],
    k: number,
    expectedModel?: string,
  ) => ChunkSearchHit[];
  // Schema v4 FTS keyword index. `replaceFts` atomically replaces ALL FTS
  // rows of one memory (an empty `chunks` list just deletes them) and, like
  // the name suggests, is kept in lockstep with `replaceChunks` by the
  // indexer (written/replaced/deleted together with the chunk rows).
  // `listFtsIds` returns the distinct ids with at least one FTS row (the
  // v4 back-fill detector, mirroring `listChunkIds`). `ftsDocCount` counts
  // DISTINCT memory ids matching one already-sanitized FTS phrase (the
  // document frequency the keyword gate thresholds on - over MEMORIES, not
  // rows). `ftsMatch` runs one already-sanitized FTS phrase and returns its
  // rows best-bm25-first (lower score = better). The phrase is passed
  // through to MATCH verbatim: sanitizing prompt text into safe phrases is
  // the caller's job (src/embed/keyword.ts).
  replaceFts: (
    id: string,
    fts: { name: string; description: string },
    chunks: FtsChunkInput[],
  ) => void;
  listFtsIds: () => string[];
  ftsDocCount: (phrase: string) => number;
  ftsMatch: (phrase: string, limit: number) => FtsMatchRow[];
  // Best cosine for each of `ids` between a query vector and that memory's
  // document vector / chunk vectors (the MAX over all of them, on search()'s
  // exact 1 - distance/2 scale, computed with sqlite-vec's own
  // vec_distance_cosine so the numbers are directly comparable to a
  // semanticSearch score). Stale-model rows never contribute. This lets the
  // keyword gate corroborate a candidate that fell OUTSIDE the semantic
  // top-k without embedding the prompt a second time (the caller already
  // holds the query vector from the same store session).
  cosinesForIds: (
    queryEmbedding: number[],
    ids: string[],
    expectedModel?: string,
  ) => IdSimilarity[];
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

  // Same physical-width recovery for the schema v3 chunk table (see the v3
  // note above): `chunk_vec` may already exist from an earlier writable
  // open, and its width must agree with `vec`'s (chunk and document
  // vectors come from the same model, so they always share one space).
  const existingChunkVecRow = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_vec'",
    )
    .get() as { sql: string } | undefined;
  let chunkVecTableExists = false;
  let chunkPhysicalDimensions: number | null = null;
  if (existingChunkVecRow) {
    chunkVecTableExists = true;
    const m = existingChunkVecRow.sql.match(/FLOAT\[(\d+)\]/);
    if (!m) {
      throw new Error(
        `cannot determine the embedding dimension of the existing chunk vector table in ${opts.path}; the file may be corrupted`,
      );
    }
    chunkPhysicalDimensions = Number(m[1]);
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

  // Same internal-consistency check for the schema v3 chunk table: chunk
  // and document vectors are produced by the same model, so the two vec0
  // tables must have the same width.
  if (
    chunkPhysicalDimensions !== null &&
    physicalDimensions !== null &&
    chunkPhysicalDimensions !== physicalDimensions
  ) {
    throw new Error(
      `embedding index at ${opts.path} is internally inconsistent: the on-disk vector table is FLOAT[${physicalDimensions}] but the chunk vector table is FLOAT[${chunkPhysicalDimensions}]. The file is likely corrupted - delete it and rebuild.`,
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
  // opts.meta; see the module-level comment for why a caller without
  // opts.meta, such as the lint --semantic read, is exempt).
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
  // a caller without opts.meta (the lint --semantic read) is exempt, same
  // as the provider-mismatch check above.
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

  // --- Schema v3 chunk tables (see the v3 note at the top of the file). ---
  // Whether the `chunks` table exists on THIS connection: true for every
  // writable open (applyMigrations created it above) and for a readonly
  // open of an index some earlier writable open already migrated; false
  // only for a readonly open of a pre-v3 file (readonly never migrates).
  // Every chunk statement below is prepared lazily and every chunk read
  // path checks this flag first, so a readonly pre-v3 open neither creates
  // anything nor throws on the new tables it never had.
  const chunkTablesReady =
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks'",
      )
      .get() !== undefined;

  // Whether the schema v4 FTS table exists on THIS connection: true for
  // every writable open (applyMigrations created it above) and for a
  // readonly open of an index some earlier writable open already migrated
  // to v4; false only for a readonly open of a pre-v4 file (readonly never
  // migrates). Like chunkTablesReady, every FTS statement below is prepared
  // lazily and every FTS read path checks this flag first, so a readonly
  // pre-v4 open neither creates anything nor throws on the table it never
  // had - the exact "v3 file, readonly open, no keyword hits" contract.
  const ftsTablesReady =
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'",
      )
      .get() !== undefined;

  // Same deferred-creation rule as ensureVecTable: chunk_vec's FLOAT[N]
  // width can only come from a known `dimensions` value.
  function ensureChunkVecTable(dim: number): void {
    if (chunkVecTableExists) return;
    if (opts.readonly) return;
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding FLOAT[${dim}] distance_metric=cosine);`,
    );
    chunkVecTableExists = true;
  }

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
  // sqlite-vec rejects a KNN `k` above 4096; the over-fetch in search() is
  // bounded by it.
  const MAX_KNN_K = 4096;
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

  // Chunk-table statements (schema v3), lazily prepared for the same
  // reason as the vec ones: a readonly open of a pre-v3 file has neither
  // table, so preparing any of these eagerly at open would break it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _insertChunk: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _insertChunkVec: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _deleteChunks: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _deleteChunkVecById: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _listChunkIds: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _chunkSearchStmt: any = null;
  function insertChunkStmt() {
    if (!_insertChunk) {
      _insertChunk = db.prepare(
        'INSERT INTO chunks (id, chunk_index, char_offset, model) VALUES (?, ?, ?, ?)',
      );
    }
    return _insertChunk;
  }
  function insertChunkVecStmt() {
    if (!_insertChunkVec) {
      _insertChunkVec = db.prepare(
        'INSERT INTO chunk_vec (rowid, embedding) VALUES (?, ?)',
      );
    }
    return _insertChunkVec;
  }
  function deleteChunksStmt() {
    if (!_deleteChunks) _deleteChunks = db.prepare('DELETE FROM chunks WHERE id = ?');
    return _deleteChunks;
  }
  function deleteChunkVecByIdStmt() {
    if (!_deleteChunkVecById) {
      _deleteChunkVecById = db.prepare(
        'DELETE FROM chunk_vec WHERE rowid IN (SELECT rowid FROM chunks WHERE id = ?)',
      );
    }
    return _deleteChunkVecById;
  }
  function listChunkIdsStmt() {
    if (!_listChunkIds) _listChunkIds = db.prepare('SELECT DISTINCT id FROM chunks');
    return _listChunkIds;
  }
  function chunkSearchStmtLazy() {
    if (!_chunkSearchStmt) {
      _chunkSearchStmt = db.prepare(`
        SELECT chunks.id AS id, chunks.model AS model,
               chunks.chunk_index AS chunkIndex,
               chunks.char_offset AS charOffset,
               chunk_vec.distance AS distance
        FROM chunk_vec
        JOIN chunks ON chunks.rowid = chunk_vec.rowid
        WHERE chunk_vec.embedding MATCH ?
          AND k = ?
        ORDER BY chunk_vec.distance ASC
      `);
    }
    return _chunkSearchStmt;
  }

  // FTS keyword statements (schema v4), lazily prepared like the chunk
  // ones: a readonly open of a pre-v4 file has no `chunks_fts`, so
  // preparing any of these eagerly at open would break it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _insertFts: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _deleteFts: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _listFtsIds: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _ftsDocCount: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _ftsMatch: any = null;
  function insertFtsStmt() {
    if (!_insertFts) {
      _insertFts = db.prepare(
        'INSERT INTO chunks_fts (name, description, text, mid, cidx) VALUES (?, ?, ?, ?, ?)',
      );
    }
    return _insertFts;
  }
  function deleteFtsStmt() {
    if (!_deleteFts) _deleteFts = db.prepare('DELETE FROM chunks_fts WHERE mid = ?');
    return _deleteFts;
  }
  function listFtsIdsStmt() {
    if (!_listFtsIds) _listFtsIds = db.prepare('SELECT DISTINCT mid FROM chunks_fts');
    return _listFtsIds;
  }
  function ftsDocCountStmt() {
    if (!_ftsDocCount) {
      _ftsDocCount = db.prepare(
        'SELECT COUNT(DISTINCT mid) AS n FROM chunks_fts WHERE chunks_fts MATCH ?',
      );
    }
    return _ftsDocCount;
  }
  function ftsMatchStmt() {
    if (!_ftsMatch) {
      _ftsMatch = db.prepare(
        'SELECT mid, cidx, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score ASC LIMIT ?',
      );
    }
    return _ftsMatch;
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

  // Live existence probe for a table. `chunk_vec` is created lazily on
  // the first chunk upsert, possibly by another process after this
  // connection opened, so the open-time `chunkVecTableExists` flag is
  // only a lower bound. A positive probe caches the flag; a
  // lazily-prepared chunk statement is then compiled against a table
  // that exists now. Prepared on first use, so search-only opens skip it.
  let _probeTable: { get: (name: string) => unknown } | null = null;
  function tableExists(name: string): boolean {
    if (!_probeTable) {
      _probeTable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      );
    }
    return _probeTable!.get(name) !== undefined;
  }

  function remove(id: string): void {
    // A removed memory must not leave orphan chunk rows behind either.
    // The chunk deletes run INDEPENDENTLY of the entries-row lookup
    // below: chunk rows can exist without one (they outlived an older
    // build's remove()). Every writable open runs the migrations, so the
    // `chunks` table always exists here; only the lazily created
    // `chunk_vec` delete is guarded, and that guard re-probes
    // sqlite_master instead of trusting the open-time flag.
    if (chunkTablesReady) {
      if (chunkVecTableExists || tableExists('chunk_vec')) {
        chunkVecTableExists = true;
        deleteChunkVecByIdStmt().run(id);
      }
      deleteChunksStmt().run(id);
    }
    // The schema v4 FTS rows go with the chunk rows (one FTS row per
    // chunk): a removed memory must never keep matching a keyword query.
    if (ftsTablesReady) {
      deleteFtsStmt().run(id);
    }
    const row = selectRowid.get(id) as { rowid: number } | undefined;
    if (!row) return;
    deleteVecStmt().run(BigInt(row.rowid));
    deleteEntry.run(id);
  }

  function listEntries(): IndexEntry[] {
    return listStmt.all() as IndexEntry[];
  }

  // Atomically replace all chunk rows of one memory (schema v3). An empty
  // `chunks` list is a pure delete: a memory whose new version is shorter
  // (or whose body became empty) must never keep scoring on orphan chunks
  // of the old version. Width mismatches throw inside the transaction and
  // roll it back, so the previous chunk set stays intact on failure.
  const replaceChunksTx = db.transaction(
    (id: string, model: string, chunks: ChunkInput[]) => {
      deleteChunkVecByIdStmt().run(id);
      deleteChunksStmt().run(id);
      for (const c of chunks) {
        const info = insertChunkStmt().run(id, c.index, c.offset, model);
        insertChunkVecStmt().run(
          BigInt(info.lastInsertRowid as number),
          toBlob(c.embedding),
        );
      }
    },
  );

  function replaceChunks(id: string, model: string, chunks: ChunkInput[]): void {
    if (typeof model !== 'string' || model.length === 0) {
      throw new Error('replaceChunks requires a non-empty model name');
    }
    if (!Array.isArray(chunks)) {
      throw new Error('replaceChunks requires an array of chunks');
    }
    if (dimensions === null) {
      if (chunks.length === 0) return; // nothing to embed, nothing to delete
      // Same deferred width learning as upsert(): a fresh index derives its
      // dimension from the first real embedding it is given.
      dimensions = chunks[0].embedding.length;
      ensureVecTable(dimensions);
      recordProvenance(dimensions);
    }
    ensureChunkVecTable(dimensions);
    for (const c of chunks) {
      if (c.embedding.length !== dimensions) {
        throw new Error(
          `chunk embedding dimension ${c.embedding.length} != index dimension ${dimensions}${dimensionMismatchSuffix()}`,
        );
      }
    }
    replaceChunksTx(id, model, chunks);
  }

  function listChunkIds(): string[] {
    if (!chunkTablesReady) return [];
    return (listChunkIdsStmt().all() as { id: string }[]).map((r) => r.id);
  }

  // Atomically replace all FTS rows of one memory (schema v4). An empty
  // `chunks` list is a pure delete, mirroring replaceChunks: a memory whose
  // new version dropped text must never keep matching a keyword query on
  // the old body. The indexer calls this in lockstep with replaceChunks
  // (same plan, same all-embeds-succeeded gate, same stale-drop-up-front),
  // so the two row sets can only ever diverge on a crash between the two
  // synchronous transactions - and the next rebuild's FTS back-fill rule
  // (a memory with chunks but no FTS rows gets them) self-heals that.
  // A no-op on a store whose FTS table does not exist (readonly pre-v4
  // open, the only caller shape that hits it never writes anyway).
  const replaceFtsTx = db.transaction(
    (
      id: string,
      fts: { name: string; description: string },
      chunks: FtsChunkInput[],
    ) => {
      deleteFtsStmt().run(id);
      for (const c of chunks) {
        insertFtsStmt().run(fts.name, fts.description, c.text, id, c.index);
      }
    },
  );

  function replaceFts(
    id: string,
    fts: { name: string; description: string },
    chunks: FtsChunkInput[],
  ): void {
    if (!ftsTablesReady) return;
    if (!fts || typeof fts.name !== 'string' || typeof fts.description !== 'string') {
      throw new Error('replaceFts requires { name, description } strings');
    }
    if (!Array.isArray(chunks)) {
      throw new Error('replaceFts requires an array of chunks');
    }
    if (opts.readonly) {
      throw new Error('replaceFts requires a writable index connection');
    }
    replaceFtsTx(id, fts, chunks);
  }

  function listFtsIds(): string[] {
    if (!ftsTablesReady) return [];
    return (listFtsIdsStmt().all() as { mid: string }[]).map((r) => r.mid);
  }

  function ftsDocCount(phrase: string): number {
    if (!ftsTablesReady) return 0;
    try {
      const { n } = ftsDocCountStmt().get(phrase) as { n: number };
      return n;
    } catch {
      // Defensive: the sanitizer (src/embed/keyword.ts) guarantees a
      // syntax-clean phrase, but a malformed query must degrade the keyword
      // path to "no match for this term", never take down the search call.
      return 0;
    }
  }

  function ftsMatch(phrase: string, limit: number): FtsMatchRow[] {
    if (!ftsTablesReady) return [];
    try {
      return (
        ftsMatchStmt().all(phrase, Math.max(1, Math.floor(limit))) as {
          mid: string;
          cidx: number;
          score: number;
        }[]
      ).map((r) => ({ id: r.mid, chunkIndex: r.cidx, score: r.score }));
    } catch {
      return [];
    }
  }

  // Best-cosine lookups for keyword corroboration (see the interface docs).
  // Uses sqlite-vec's own vec_distance_cosine scalar + the same
  // 1 - distance/2 mapping as search()/searchChunks(), so a corroboration
  // cosine is directly comparable to a semanticSearch score and to the
  // blend's relevance floor. Per-id instead of one IN(...) query: the
  // candidate set is already bounded by KEYWORD_MAX_DF per qualifying term.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _cosineDocStmt: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _cosineDocModelStmt: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _cosineChunkStmt: any = null;
  function cosineDocStmt() {
    if (!_cosineDocStmt) {
      _cosineDocStmt = db.prepare(`
        SELECT vec_distance_cosine(?, vec.embedding) AS distance
        FROM vec JOIN entries ON entries.rowid = vec.rowid
        WHERE entries.id = ?
      `);
    }
    return _cosineDocStmt;
  }
  function cosineDocModelStmt() {
    if (!_cosineDocModelStmt) {
      _cosineDocModelStmt = db.prepare(`
        SELECT vec_distance_cosine(?, vec.embedding) AS distance
        FROM vec JOIN entries ON entries.rowid = vec.rowid
        WHERE entries.id = ? AND entries.model = ?
      `);
    }
    return _cosineDocModelStmt;
  }
  function cosineChunkStmt() {
    if (!_cosineChunkStmt) {
      _cosineChunkStmt = db.prepare(`
        SELECT vec_distance_cosine(?, chunk_vec.embedding) AS distance
        FROM chunk_vec JOIN chunks ON chunks.rowid = chunk_vec.rowid
        WHERE chunks.id = ? AND chunks.model = ?
      `);
    }
    return _cosineChunkStmt;
  }

  function cosinesForIds(
    queryEmbedding: number[],
    ids: string[],
    expectedModel?: string,
  ): IdSimilarity[] {
    if (dimensions === null || queryEmbedding.length !== dimensions || ids.length === 0) {
      return [];
    }
    if (!vecTableExists && !tableExists('vec')) return []; // nothing embedded yet
    const blob = toBlob(queryEmbedding);
    // Chunk vectors are only comparable when model-tagged like every other
    // read path (a NULL/pre-v2 or different-model row never scores), so the
    // chunk side is only consulted when an expected model was supplied.
    const chunkVecReady =
      expectedModel !== undefined &&
      chunkTablesReady &&
      (chunkVecTableExists || tableExists('chunk_vec'));
    if (chunkVecReady) chunkVecTableExists = true;
    const out: IdSimilarity[] = [];
    for (const id of ids) {
      let bestDistance: number | null = null;
      const docRow = (
        expectedModel === undefined
          ? (cosineDocStmt().get(blob, id) as { distance: number } | undefined)
          : (cosineDocModelStmt().get(blob, id, expectedModel) as
              | { distance: number }
              | undefined)
      );
      if (docRow) bestDistance = docRow.distance;
      if (chunkVecReady) {
        for (const r of cosineChunkStmt().all(blob, id, expectedModel) as {
          distance: number;
        }[]) {
          if (bestDistance === null || r.distance < bestDistance) {
            bestDistance = r.distance;
          }
        }
      }
      if (bestDistance !== null) {
        out.push({ id, similarity: Math.max(0, 1 - bestDistance / 2) });
      }
    }
    return out;
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
    const blob = toBlob(queryEmbedding);
    type Row = { id: string; model: string | null; distance: number };
    let rows: Row[];
    if (expectedModel === undefined) {
      rows = searchStmtLazy().all(blob, k) as Row[];
    } else {
      // The vec0 KNN `LIMIT k` runs before any model filter, so stale-model
      // rows ranking inside the top k would take slots current-model rows
      // just outside it should fill. Over-fetch instead: start at k and
      // grow the fetch window (x4) until k current-model rows are found,
      // the index is exhausted (the query returned fewer rows than asked),
      // or the window hits sqlite-vec's KNN ceiling. Comparing cosines
      // across embedding spaces is meaningless, so a row from a different
      // model (or a pre-v2 NULL row) is never returned.
      let fetch = Math.min(k, MAX_KNN_K);
      for (;;) {
        const all = searchStmtLazy().all(blob, fetch) as Row[];
        rows = all.filter((r) => r.model === expectedModel);
        if (
          rows.length >= k ||
          all.length < fetch ||
          fetch >= MAX_KNN_K
        ) {
          break;
        }
        fetch = Math.min(fetch * 4, MAX_KNN_K);
      }
    }
    return rows.slice(0, k).map((r) => ({
      id: r.id,
      similarity: Math.max(0, 1 - r.distance / 2),
    }));
  }

  // Chunk-level KNN (schema v3). Two differences from search() above:
  // - results are deduplicated to AT MOST ONE hit per memory id (the
  //   nearest chunk wins, so a memory's semantic score stays a single
  //   number and callers keep one hit per memory);
  // - the over-fetch loop widens until k DISTINCT ids survive rather than
  //   until k rows: a single long memory's chunks can legitimately fill
  //   any plain `LIMIT`, which would crowd every other memory out of the
  //   top k. The loop stops when that is satisfied, the index is
  //   exhausted, or the KNN ceiling is hit; the model filter applies to
  //   chunk rows too (stale-model chunks never score).
  function searchChunks(
    queryEmbedding: number[],
    k: number,
    expectedModel?: string,
  ): ChunkSearchHit[] {
    if (dimensions === null || !chunkTablesReady || !chunkVecTableExists) {
      return []; // nothing embedded yet, or an index without chunk support
    }
    if (queryEmbedding.length !== dimensions) {
      throw new Error(
        `query dimension ${queryEmbedding.length} != index dimension ${dimensions}${dimensionMismatchSuffix()}`,
      );
    }
    const blob = toBlob(queryEmbedding);
    type Row = {
      id: string;
      model: string | null;
      chunkIndex: number;
      charOffset: number;
      distance: number;
    };
    // Rows come back ordered by distance ASC, so the FIRST row of an id is
    // its best chunk; insertion order of the Map is therefore already the
    // best-first result order.
    const best = new Map<string, Row>();
    let fetch = Math.min(k, MAX_KNN_K);
    for (;;) {
      const all = chunkSearchStmtLazy().all(blob, fetch) as Row[];
      for (const r of all) {
        if (expectedModel !== undefined && r.model !== expectedModel) continue;
        if (!best.has(r.id)) best.set(r.id, r);
      }
      if (best.size >= k || all.length < fetch || fetch >= MAX_KNN_K) break;
      fetch = Math.min(fetch * 4, MAX_KNN_K);
    }
    return [...best.values()].slice(0, k).map((r) => ({
      id: r.id,
      similarity: Math.max(0, 1 - r.distance / 2),
      chunkIndex: r.chunkIndex,
      charOffset: r.charOffset,
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
    replaceChunks,
    listChunkIds,
    searchChunks,
    replaceFts,
    listFtsIds,
    ftsDocCount,
    ftsMatch,
    cosinesForIds,
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
