const { mkdirSync, statSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { loadMemoriesFromDir } = require('../memory/loader');
const {
  embedBatch,
  resolveProviderConfig,
  resolveEmbedTimeoutMs,
  resolveHookEmbedTimeoutMs,
  INDEX_DEFAULT_TIMEOUT_MS,
} = require('./provider');
const { openIndex } = require('./index-store');
const { chunkBody } = require('./chunking');
const {
  KEYWORD_MAX_DF,
  loadKeywordConfig,
  extractKeywordTerms,
  isIdToken,
  quotePhrase,
} = require('./keyword');
const { debug } = require('../debug');

// Legacy constant, kept only as a backward-compatible export of this
// module (a test pins it); no module in src/ uses it any more since
// src/lint/conflicts.ts opens the index readonly without a hint.
// Dimensions are not hardcoded anywhere in THIS file, see
// "Dimensionality" below: index-store.ts derives the real dimension from
// the index's own recorded/physical state and silently ignores a
// disagreeing caller hint when it has no `opts.meta`, so an external
// caller that still passes this constant keeps working against a
// non-1536-dim (e.g. Ollama) index.
const EMBED_DIMENSIONS = 1536;

const INDEX_SUBDIR = '.memory-router';
const INDEX_FILENAME = 'index.sqlite';

// Shell single-quotes a value for safe interpolation into the
// rebuildCommand string below (embedded single quotes are escaped via the
// standard '\'' idiom: close the quote, emit an escaped quote, reopen).
// Without this, a memoryDir containing a space or another shell
// metacharacter would turn the printed remediation command into something
// that either fails outright or, worse, silently `rm -rf`s the wrong path
// if a user copy-pastes it.
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Exact remediation text for an index built under a different
// provider/model/dimensions than the current configuration — see
// index-store.ts's provenance mismatch errors.
function rebuildCommandFor(memoryDir: string): string {
  const indexDir = join(memoryDir, INDEX_SUBDIR);
  return `rm -rf ${shellSingleQuote(indexDir)} && memory-router index ${shellSingleQuote(memoryDir)}`;
}

// Warned at most once per process (a long-lived caller, e.g. the MCP
// server, can call semanticSearch many times per session): repeating this
// on every single missing-index call would just be stderr noise once the
// user has already seen the hint. Module-level flag, same
// once-per-process shape as the stale-model warning below.
let missingIndexWarned = false;

// Same once-per-process shape for the stale-model warning in semanticSearch:
// a long-lived caller (the MCP server, eval) would otherwise repeat the
// line on every query against the same stale index. Set only when a call
// actually finds stale rows, so a process whose index was clean when first
// searched still warns once if it later goes stale.
let staleModelWarned = false;

// Enriches an embedBatch() failure (a raw fetch/HTTP error) with the
// resolved provider + baseUrl the call was actually made against, so a
// user staring at "fetch failed" or a bare timeout knows WHICH endpoint
// misbehaved instead of guessing between OpenAI and a local Ollama daemon.
// For ollama specifically, folds in the two most common fixes verbatim
// from docs/scoring.md's Embedding provider section (`ollama serve`,
// `ollama pull <model>`) since an unreachable/missing-model local daemon is the
// overwhelmingly likely cause on that path.
function describeEmbedError(
  err: unknown,
  cfg: { provider: string; baseUrl?: string; model: string },
): Error {
  const causeMessage = err instanceof Error ? err.message : String(err);
  const parts = [
    `embedding call failed (provider=${cfg.provider} baseUrl=${cfg.baseUrl ?? 'default'} model=${cfg.model}): ${causeMessage}`,
  ];
  if (cfg.provider === 'ollama') {
    parts.push(
      `If this is a local Ollama daemon: run \`ollama serve\` (or start the app) and \`ollama pull ${cfg.model}\` if the model isn't downloaded yet.`,
    );
  }
  return new Error(parts.join(' '));
}

// Hard cap on the query-embedding cache. Evicts oldest by `accessed_at`
// once exceeded. 1000 covers the long tail of repeated vague prompts
// without bloating the sqlite file (~6 MB at 1536 floats × 4 bytes).
const QUERY_CACHE_CAPACITY = 1000;

function indexPath(memoryDir: string): string {
  return join(memoryDir, INDEX_SUBDIR, INDEX_FILENAME);
}

// FTS name/description columns (schema v4) take strings. The loader only
// requires a truthy frontmatter `name`: `description` is optional (so it can
// be undefined or null), and an unquoted `name: 2026` parses as a NUMBER, so
// a raw pass-through makes replaceFts throw and breaks the whole rebuild.
// Normalize to the tolerance buildEmbedInput's `.filter(Boolean)` already
// gives them: missing/null become '', any non-string is stringified. The
// store keeps its own typeof guard as a real-programming-error check.
function ftsField(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function buildEmbedInput(memory: Memory): string {
  // Concatenate the signal-dense fields: a memory's `name` and `description`
  // are the human summary; the body has the rule. Trimmed to keep request
  // payloads small.
  const parts = [
    memory.frontmatter.name,
    memory.frontmatter.description,
    memory.body,
  ];
  return parts.filter(Boolean).join('\n').slice(0, 8000);
}

// Chunk-level embed input (schema v3): the same name + description prefix
// as the document input above, followed by ONE chunk of the body instead
// of the whole body, under the same 8,000-char cap. Chunks come from
// src/embed/chunking.ts, so a long memory's deeper text gets its own vector
// instead of being cut off by the document input's cap.
function buildChunkEmbedInput(memory: Memory, chunkText: string): string {
  const parts = [
    memory.frontmatter.name,
    memory.frontmatter.description,
    chunkText,
  ];
  return parts.filter(Boolean).join('\n').slice(0, 8000);
}

interface IndexResult {
  total: number;
  embedded: number;
  removed: number;
  skipped: number;
  // Chunk vectors (re)written by this run (schema v3 chunked embeddings).
  chunksEmbedded: number;
  reason?: string;
}

// One semanticSearch result: a memory plus its score = max(document vector
// similarity, best chunk similarity). `chunk` is set only when a CHUNK
// vector is what produced that score, carrying the winning chunk's index
// within the body and its char offset, so a later task can highlight the
// matching region; existing callers ignore the field.
interface SemanticHit {
  memory: Memory;
  score: number;
  chunk?: { index: number; offset: number };
}

async function rebuildIndex(memoryDir: string): Promise<IndexResult> {
  // autoDetectOllama: true — this is THE call that lets the semantic path
  // live on a machine with no OpenAI key. See
  // provider.ts's ResolveProviderConfigOptions doc for why this opt-in
  // flag exists instead of being the unconditional default.
  const cfg = resolveProviderConfig({ autoDetectOllama: true });
  if (!cfg) {
    return {
      total: 0,
      embedded: 0,
      removed: 0,
      skipped: 0,
      chunksEmbedded: 0,
      reason:
        'MEMORY_ROUTER_EMBED_PROVIDER=openai selected but OPENAI_API_KEY is not set - confidence gate will remain silent',
    };
  }

  const memories = loadMemoriesFromDir(memoryDir);
  mkdirSync(join(memoryDir, INDEX_SUBDIR), { recursive: true });
  // No `dimensions` hint: a fresh index derives it from the first real
  // embedding response (see index-store.ts); an existing one already knows
  // its own dimension. `meta` + `rebuildCommand` let index-store.ts throw a
  // clear, actionable error instead of silently mixing embedding spaces if
  // this directory's index was built under a different provider/model.
  const store = openIndex({
    path: indexPath(memoryDir),
    meta: { provider: cfg.provider, model: cfg.model },
    rebuildCommand: rebuildCommandFor(memoryDir),
  });

  try {
    const existing = new Map<string, number>(
      store
        .listEntries()
        .map((e: { id: string; mtime: number }) => [e.id, e.mtime]),
    );
    // Ids that already have at least one chunk row. A v3-migrated index
    // has none for ANY memory while its `entries` mtimes are all still
    // current, so the mtime skip alone would never build chunks: the
    // chunk pass below keys off this set instead (and off a changed
    // document, which makes existing chunks stale too).
    const chunkedIds = new Set<string>(store.listChunkIds());
    // Same back-fill rule, one version later (schema v4): ids that already
    // have at least one FTS keyword row. A v3-migrated index has chunk
    // rows (or will get them) but NO FTS rows despite unchanged mtimes, so
    // the keyword pass keys off this set too - a memory with chunks and no
    // FTS rows gets them on this run without re-embedding anything.
    const ftsedIds = new Set<string>(store.listFtsIds());
    const seen = new Set<string>();

    // One flat queue for BOTH document and chunk embeds, so batching is
    // per INPUT (see the BATCH comment below): chunks make the input count
    // much larger than the memory count. A job with `chunk` set embeds that
    // chunk's text; a job without it embeds the whole document.
    interface EmbedJob {
      memory: Memory;
      mtime: number;
      chunk?: { index: number; offset: number; text: string };
    }
    const jobs: EmbedJob[] = [];
    // Memories whose chunk rows get rewritten wholesale by this run (in
    // plan order), their planned chunks, and the vectors collected per
    // chunk index while the batches run. `replaceChunks` for a memory
    // runs only after all embeds succeeded; a stale document is paired
    // with dropping that memory's old chunk rows up front (see the
    // docStale guard in the planning loop), so an interrupted run leaves
    // no memory scoring on chunks of a body it no longer has.
    const chunkPlan: string[] = [];
    const plannedChunks = new Map<string, { index: number; offset: number; text: string }[]>();
    const chunkVectors = new Map<string, number[][]>();
    // Name/description fed into each planned memory's FTS rows (schema v4).
    // Written in lockstep with the chunk rows below: same all-embeds-
    // succeeded gate, same stale-drop-up-front, so an interrupted run never
    // leaves FTS rows of an old body - the chunks' guarantee, extended.
    const plannedFtsMeta = new Map<string, { name: string; description: string }>();
    // Keyword-only back-fill (no embeds involved): memories whose chunk rows
    // and document are current but that have no FTS rows yet.
    const ftsOnlyPlan: {
      id: string;
      meta: { name: string; description: string };
      chunks: { index: number; text: string }[];
    }[] = [];

    for (const memory of memories) {
      seen.add(memory.id);
      const mtime = Math.floor(statSync(memory.path).mtimeMs);
      const prev = existing.get(memory.id);
      const docStale = prev !== mtime;
      const ftsMeta = {
        name: ftsField(memory.frontmatter.name),
        description: ftsField(memory.frontmatter.description),
      };
      if (docStale) jobs.push({ memory, mtime });
      // A stale document's body is gone: drop this memory's FTS rows right
      // now, exactly like its chunk rows are dropped below, so an
      // interrupted run cannot leave keyword matches on text the memory no
      // longer contains.
      if (docStale && ftsedIds.has(memory.id)) {
        store.replaceFts(memory.id, ftsMeta, []);
      }
      if (docStale || !chunkedIds.has(memory.id)) {
        const chunks = chunkBody(memory.body);
        // Only schedule work when there is something to write or an old
        // chunk set to delete (a memory whose body became empty must have
        // its orphan chunks removed).
        if (chunks.length > 0 || chunkedIds.has(memory.id)) {
          chunkPlan.push(memory.id);
          plannedChunks.set(memory.id, chunks);
          chunkVectors.set(memory.id, []);
          plannedFtsMeta.set(memory.id, ftsMeta);
          // A stale document's new mtime commits as soon as its batch
          // lands, while this memory's new chunk vectors only land after
          // ALL embed requests succeeded. Drop the old chunk rows right
          // now so an interrupted run cannot leave them paired with the
          // new mtime: the next run sees "no chunk rows" and re-chunks
          // the memory (document-only scoring in the meantime), instead
          // of skipping it forever while it ranks on text its body no
          // longer contains.
          if (docStale && chunkedIds.has(memory.id)) {
            store.replaceChunks(memory.id, cfg.model, []);
          }
          for (const chunk of chunks) {
            jobs.push({ memory, mtime, chunk });
          }
        }
      } else if (!ftsedIds.has(memory.id)) {
        // Chunks + document current, FTS rows missing (fresh v3→v4
        // migration): back-fill keyword rows from the same chunkBody
        // output. Text only - no embed job, the chunk vectors are untouched.
        const chunks = chunkBody(memory.body);
        if (chunks.length > 0) {
          ftsOnlyPlan.push({
            id: memory.id,
            meta: ftsMeta,
            chunks: chunks.map((c: { index: number; text: string }) => ({
              index: c.index,
              text: c.text,
            })),
          });
        }
      }
    }

    let removed = 0;
    for (const [id] of existing) {
      if (seen.has(id)) continue;
      store.remove(id);
      removed++;
    }
    // Chunk rows whose id has neither an entries row nor a memory file
    // (orphans an older build's remove() could leave behind) are
    // invisible to the loop above, which iterates entries: purge them by
    // chunk id too, so no memory-less chunk ever scores.
    for (const id of store.listChunkIds()) {
      if (!seen.has(id) && !existing.has(id)) {
        store.replaceChunks(id, cfg.model, []);
      }
    }
    // Same purge for the FTS rows (schema v4): the two row sets are written
    // and deleted together, so a FTS orphan means a chunk orphan - or a
    // crash between the two writes, which this also self-heals.
    for (const id of store.listFtsIds()) {
      if (!seen.has(id) && !existing.has(id)) {
        store.replaceFts(id, { name: '', description: '' }, []);
      }
    }

    // OpenAI accepts up to ~2048 inputs per call; for 20 memories we can
    // always do a single batch. For safety when the corpus grows, chunk at
    // 64 per REQUEST (inputs, not memories: a long memory contributes many
    // chunk inputs); still one HTTP round-trip per ~1000 inputs.
    const BATCH = 64;
    let embedded = 0;
    let chunksEmbedded = 0;
    for (let i = 0; i < jobs.length; i += BATCH) {
      const batch = jobs.slice(i, i + BATCH);
      let vectors: number[][];
      try {
        vectors = await embedBatch({
          apiKey: cfg.apiKey,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          inputs: batch.map((b) =>
            b.chunk === undefined
              ? buildEmbedInput(b.memory)
              : buildChunkEmbedInput(b.memory, b.chunk.text),
          ),
          // Index rebuild gets its own, larger budget than embedBatch's
          // hook-tight default — see INDEX_DEFAULT_TIMEOUT_MS in provider.ts
          // for the measured Ollama batch times that motivated this.
          timeoutMs: resolveEmbedTimeoutMs(INDEX_DEFAULT_TIMEOUT_MS),
        });
      } catch (err) {
        throw describeEmbedError(err, cfg);
      }
      for (let j = 0; j < batch.length; j++) {
        const job = batch[j];
        // embedBatch() sorts the response by `index`, so vectors[j] is the
        // embedding of inputs[j] = this exact job (document or chunk).
        if (job.chunk === undefined) {
          store.upsert(job.memory.id, job.mtime, cfg.model, vectors[j]);
          embedded++;
        } else {
          chunkVectors.get(job.memory.id)![job.chunk.index] = vectors[j];
          chunksEmbedded++;
        }
      }
    }

    // Write each planned memory's full chunk set in one transaction: old
    // rows for the id are deleted first, so a shorter new version of a
    // memory can never keep scoring on orphan chunks of the old one. The
    // FTS rows are rewritten in the same step, from the same chunk texts
    // (schema v4): keyword matches can therefore never survive (or lag
    // behind) the chunk vectors they shadow.
    for (const id of chunkPlan) {
      const chunks = plannedChunks.get(id) ?? [];
      const vectors = chunkVectors.get(id) ?? [];
      store.replaceChunks(
        id,
        cfg.model,
        chunks.map((c, n) => ({
          index: c.index,
          offset: c.offset,
          embedding: vectors[n],
        })),
      );
      const ftsMeta = plannedFtsMeta.get(id);
      if (ftsMeta) {
        store.replaceFts(
          id,
          ftsMeta,
          chunks.map((c) => ({ index: c.index, text: c.text })),
        );
      }
    }

    // Keyword-only back-fill (no embeds were needed for these).
    for (const plan of ftsOnlyPlan) {
      store.replaceFts(plan.id, plan.meta, plan.chunks);
    }

    return {
      total: memories.length,
      embedded,
      removed,
      skipped: memories.length - embedded,
      chunksEmbedded,
    };
  } finally {
    store.close();
  }
}

// One keyword match collected by blendedSearch: a memory matched by one or
// more QUALIFYING (df-capped) id tokens, with the matched tokens and the
// best bm25. Only id tokens (see isIdToken in src/embed/keyword.ts) are
// ever queried, so every hit here is an exact-identifier match.
interface KeywordHit {
  memory: Memory;
  idTerms: string[];
  bm25: number;
}

interface BlendedSearchResult {
  semantic: SemanticHit[];
  keyword: KeywordHit[];
}

// Warned at most once per process (same shape as missingIndexWarned above):
// a keyword-path failure must degrade to "no keyword matches", never take
// the semantic search down with it, and never spam stderr per call.
let keywordWarned = false;

// FTS rows fetched per qualifying term: terms are df-capped at
// KEYWORD_MAX_DF MEMORIES, but each memory contributes one row per chunk,
// so the row cap is a multiple of the memory cap. Rows come back
// best-bm25-first, so a cap only ever drops the weakest rows.
const KEYWORD_ROW_CAP = KEYWORD_MAX_DF * 32;

// Shared body of semanticSearch + blendedSearch: exactly one store open,
// exactly one query embedding (or query-cache hit), document+chunk KNN
// merge, and - when `keywordEnabled` - the FTS keyword pass over the SAME
// store session (no second embed, no second open).
async function runBlendedSearch(
  prompt: string,
  memories: Memory[],
  memoryDir: string,
  k: number,
  keywordEnabled: boolean,
): Promise<BlendedSearchResult> {
  const empty: BlendedSearchResult = { semantic: [], keyword: [] };
  const cfg = resolveProviderConfig({ autoDetectOllama: true });
  if (!cfg) return empty;

  const idx = indexPath(memoryDir);
  if (!existsSync(idx)) {
    if (!missingIndexWarned) {
      missingIndexWarned = true;
      process.stderr.write(
        'memory-router: embedding index missing — run `memory-router index <dir>` to build it.\n',
      );
    }
    return empty;
  }

  const store = openIndex({
    path: idx,
    meta: { provider: cfg.provider, model: cfg.model },
    rebuildCommand: rebuildCommandFor(memoryDir),
    cache: { model: cfg.model, capacity: QUERY_CACHE_CAPACITY },
  });
  try {
    // Warn once per process when the index has rows from a different model
    // (or pre-v2 NULL rows). The cosine result for those rows is
    // meaningless, so search() filters them out below; the warning tells
    // the user to run `memory-router index` again to refresh.
    const stale = store.countEntriesWithStaleModel(cfg.model);
    if (stale > 0 && !staleModelWarned) {
      staleModelWarned = true;
      process.stderr.write(
        `[memory-router] embedding index has ${stale} entr(y/ies) under a different model than '${cfg.model}'; run \`memory-router index <dir>\` to rebuild.\n`,
      );
    }

    let queryVec = store.getCachedQuery(prompt);
    if (queryVec) {
      debug(`query cache hit (size=${store.cacheSize()})`);
    } else {
      debug(`query cache miss; embedding (size=${store.cacheSize()})`);
      try {
        [queryVec] = await embedBatch({
          apiKey: cfg.apiKey,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          inputs: [prompt],
          // Hook-specific budget: MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS, then
          // the shared MEMORY_ROUTER_EMBED_TIMEOUT_MS, then the tight 5s
          // hook default. Decoupled from the index-rebuild call above so a
          // persistent shared-var export for `index` headroom can't also
          // widen this call's prompt-blocking budget — see
          // resolveHookEmbedTimeoutMs in provider.ts.
          timeoutMs: resolveHookEmbedTimeoutMs(),
        });
      } catch (err) {
        throw describeEmbedError(err, cfg);
      }
      store.putCachedQuery(prompt, queryVec);
    }
    // Semantic score of a memory = max(document vector similarity, best
    // chunk similarity). `search` returns one hit per memory id;
    // `searchChunks` returns at most one hit per memory id as well (its
    // nearest chunk), so the merge below can never produce one hit per
    // chunk: maxHits, the blend's relevance floor and the router's dedup
    // all keep their meaning.
    const hits = store.search(queryVec, k, cfg.model);
    const chunkHits = store.searchChunks(queryVec, k, cfg.model);
    const bestById = new Map<
      string,
      { similarity: number; chunk?: { index: number; offset: number } }
    >();
    for (const h of hits) bestById.set(h.id, { similarity: h.similarity });
    for (const c of chunkHits) {
      const prev = bestById.get(c.id);
      const chunk = { index: c.chunkIndex, offset: c.charOffset };
      if (prev === undefined) {
        bestById.set(c.id, { similarity: c.similarity, chunk });
      } else if (c.similarity > prev.similarity) {
        prev.similarity = c.similarity;
        prev.chunk = chunk;
      }
    }
    // A union of the two top-k lists always contains the true top-k of the
    // max score (a memory in the true top-k must have its winning score
    // from either the document or a chunk vector), so sorting the merge and
    // cutting at k is exact. `Array.prototype.sort` is stable, so ties keep
    // the document-then-chunk insertion order.
    const ranked = [...bestById.entries()]
      .sort((a, b) => b[1].similarity - a[1].similarity)
      .slice(0, k);
    const byId = new Map(memories.map((m) => [m.id, m]));
    const semantic: SemanticHit[] = ranked
      .map(([id, best]) => ({
        memory: byId.get(id),
        score: best.similarity,
        // Best chunk's position in the body when the chunk vector is what
        // won this memory's score; undefined when the document vector won
        // (or the memory has no chunks). Callers that don't know this
        // field simply ignore it.
        chunk: best.chunk,
      }))
      .filter(
        (h: {
          memory: Memory | undefined;
        }): h is {
          memory: Memory;
          score: number;
          chunk: { index: number; offset: number } | undefined;
        } => h.memory !== undefined,
      );

    const keyword: KeywordHit[] = [];
    if (keywordEnabled) {
      // The keyword pass must never turn a working search into a failed
      // one: any throw below (a corrupt FTS index, an unexpected store
      // error) degrades to "no keyword matches" with one stderr warning.
      try {
        collectKeywordMatches(store, prompt, byId, keyword);
      } catch (err: unknown) {
        keyword.length = 0;
        if (!keywordWarned) {
          keywordWarned = true;
          process.stderr.write(
            `memory-router: keyword search failed, continuing without keyword matches: ${String(err)}\n`,
          );
        }
      }
    }

    return { semantic, keyword };
  } finally {
    store.close();
  }
}

// One FTS pass per id-token prompt term over the FTS index: a term whose
// ORIGINAL token is not an id token (see isIdToken in src/embed/keyword.ts)
// is never queried, never counted and never credits anything; an id term
// qualifies only when at most KEYWORD_MAX_DF distinct MEMORIES (not rows)
// contain it, and a qualifying term then credits every memory it matches.
// Per-prompt keyword work is therefore exactly two FTS reads (df count +
// rows) per id token - no embedding, no cosine batch.
function collectKeywordMatches(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any,
  prompt: string,
  byId: Map<string, Memory>,
  out: KeywordHit[],
): void {
  const terms = extractKeywordTerms(prompt);
  if (terms.length === 0) return;
  interface Match {
    idTerms: string[];
    bm25: number;
  }
  const perId = new Map<string, Match>();
  for (const t of terms) {
    if (!isIdToken(t.term)) continue;
    const query = quotePhrase(t.phrase);
    const df = store.ftsDocCount(query);
    if (df === 0 || df > KEYWORD_MAX_DF) continue;
    for (const row of store.ftsMatch(query, KEYWORD_ROW_CAP) as {
      id: string;
      chunkIndex: number;
      score: number;
    }[]) {
      let match = perId.get(row.id);
      if (!match) {
        match = { idTerms: [], bm25: row.score };
        perId.set(row.id, match);
      }
      if (!match.idTerms.includes(t.phrase)) match.idTerms.push(t.phrase);
      if (row.score < match.bm25) match.bm25 = row.score;
    }
  }
  if (perId.size === 0) return;
  for (const [id, match] of perId) {
    const memory = byId.get(id);
    if (!memory) continue; // index row for a memory not in this call's set
    out.push({ memory, idTerms: match.idTerms, bm25: match.bm25 });
  }
  out.sort((a, b) => a.bm25 - b.bm25);
}

async function semanticSearch(
  prompt: string,
  memories: Memory[],
  memoryDir: string,
  k: number,
): Promise<SemanticHit[]> {
  // Pure semantic caller (MCP memory_search, resolveConfidence): the
  // keyword pass never runs here, so this path costs exactly what it costed
  // before the keyword path existed.
  const { semantic } = await runBlendedSearch(prompt, memories, memoryDir, k, false);
  return semantic;
}

// resolveBlended's default search entry point: one store open and one query
// embedding (or query-cache hit) per prompt, shared by the semantic KNN and
// the keyword pass. `MEMORY_ROUTER_KEYWORD=off` skips the keyword pass
// entirely - the search then takes the byte-identical pre-keyword code path
// (nothing keyword-related even reads the FTS table).
async function blendedSearch(
  prompt: string,
  memories: Memory[],
  memoryDir: string,
  k: number,
): Promise<BlendedSearchResult> {
  const cfg = loadKeywordConfig();
  const { semantic, keyword } = await runBlendedSearch(
    prompt,
    memories,
    memoryDir,
    k,
    cfg.enabled,
  );
  return { semantic, keyword };
}

module.exports = {
  rebuildIndex,
  semanticSearch,
  blendedSearch,
  indexPath,
  EMBED_DIMENSIONS,
  // Re-exported so src/lint/conflicts.ts's `--semantic` missing-pair embed
  // call can wrap its errors with the same provider/model/baseUrl context
  // as rebuildIndex and semanticSearch above, instead of carrying its own
  // drifting copy.
  describeEmbedError,
};
