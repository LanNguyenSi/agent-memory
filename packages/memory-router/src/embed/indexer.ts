const { mkdirSync, statSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { loadMemoriesFromDir } = require('../memory/loader');
const { embedBatch, resolveProviderConfig } = require('./provider');
const { openIndex } = require('./index-store');
const { debug } = require('../debug');

// Legacy constant, kept ONLY because src/lint/conflicts.ts (out of scope
// for mm-v1-T003 — see task constraints) imports it and passes it as a
// `dimensions` hint to `openIndex()` for its own opportunistic embedding
// reuse. Dimensions are no longer hardcoded anywhere in THIS file — see
// "Dimensionality" below — index-store.ts derives the real dimension from
// the index's own recorded/physical state and silently ignores a
// disagreeing caller hint when it has no `opts.meta` (exactly
// conflicts.ts's call shape), so that caller keeps working correctly even
// against a non-1536-dim (e.g. Ollama) index without needing this constant
// to be accurate.
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
// once-per-process shape as the intent already documented (see
// semanticSearch below) for the stale-model warning.
let missingIndexWarned = false;

// Enriches an embedBatch() failure (a raw fetch/HTTP error) with the
// resolved provider + baseUrl the call was actually made against, so a
// user staring at "fetch failed" or a bare timeout knows WHICH endpoint
// misbehaved instead of guessing between OpenAI and a local Ollama daemon.
// For ollama specifically, folds in the two most common fixes verbatim
// from README "Embedding provider" (`ollama serve`, `ollama pull
// <model>`) since an unreachable/missing-model local daemon is the
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

interface IndexResult {
  total: number;
  embedded: number;
  removed: number;
  skipped: number;
  reason?: string;
}

async function rebuildIndex(memoryDir: string): Promise<IndexResult> {
  // autoDetectOllama: true — this is THE call that lets the semantic path
  // live on a machine with no OpenAI key (mm-v1-T003's whole point). See
  // provider.ts's ResolveProviderConfigOptions doc for why this opt-in
  // flag exists instead of being the unconditional default.
  const cfg = resolveProviderConfig({ autoDetectOllama: true });
  if (!cfg) {
    return {
      total: 0,
      embedded: 0,
      removed: 0,
      skipped: 0,
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
    const seen = new Set<string>();

    const toEmbed: { memory: Memory; mtime: number }[] = [];

    for (const memory of memories) {
      seen.add(memory.id);
      const mtime = Math.floor(statSync(memory.path).mtimeMs);
      const prev = existing.get(memory.id);
      if (prev === mtime) continue;
      toEmbed.push({ memory, mtime });
    }

    let removed = 0;
    for (const [id] of existing) {
      if (seen.has(id)) continue;
      store.remove(id);
      removed++;
    }

    // OpenAI accepts up to ~2048 inputs per call; for 20 memories we can
    // always do a single batch. For safety when the corpus grows, chunk at
    // 64 per request — still one HTTP round-trip per ~1000 memories.
    const BATCH = 64;
    let embedded = 0;
    for (let i = 0; i < toEmbed.length; i += BATCH) {
      const batch = toEmbed.slice(i, i + BATCH);
      let vectors: number[][];
      try {
        vectors = await embedBatch({
          apiKey: cfg.apiKey,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          inputs: batch.map((b) => buildEmbedInput(b.memory)),
        });
      } catch (err) {
        throw describeEmbedError(err, cfg);
      }
      for (let j = 0; j < batch.length; j++) {
        store.upsert(batch[j].memory.id, batch[j].mtime, cfg.model, vectors[j]);
        embedded++;
      }
    }

    return {
      total: memories.length,
      embedded,
      removed,
      skipped: memories.length - embedded,
    };
  } finally {
    store.close();
  }
}

async function semanticSearch(
  prompt: string,
  memories: Memory[],
  memoryDir: string,
  k: number,
): Promise<{ memory: Memory; score: number }[]> {
  const cfg = resolveProviderConfig({ autoDetectOllama: true });
  if (!cfg) return [];

  const idx = indexPath(memoryDir);
  if (!existsSync(idx)) {
    if (!missingIndexWarned) {
      missingIndexWarned = true;
      process.stderr.write(
        'memory-router: embedding index missing — run `memory-router index <dir>` to build it.\n',
      );
    }
    return [];
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
    if (stale > 0) {
      process.stderr.write(
        `[memory-router] embedding index has ${stale} entr(y/ies) under a different model than '${cfg.model}'; run \`memory-router index <dir>\` to rebuild.\n`,
      );
    }

    let queryVec = store.getCachedQuery(prompt);
    if (queryVec) {
      debug(`query cache hit (size=${store.cacheSize()})`);
    } else {
      debug(`query cache miss — embedding (size=${store.cacheSize()})`);
      try {
        [queryVec] = await embedBatch({
          apiKey: cfg.apiKey,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          inputs: [prompt],
        });
      } catch (err) {
        throw describeEmbedError(err, cfg);
      }
      store.putCachedQuery(prompt, queryVec);
    }
    const hits = store.search(queryVec, k, cfg.model);
    const byId = new Map(memories.map((m) => [m.id, m]));
    return hits
      .map((h: { id: string; similarity: number }) => ({
        memory: byId.get(h.id),
        score: h.similarity,
      }))
      .filter(
        (h: {
          memory: Memory | undefined;
        }): h is { memory: Memory; score: number } => h.memory !== undefined,
      );
  } finally {
    store.close();
  }
}

module.exports = { rebuildIndex, semanticSearch, indexPath, EMBED_DIMENSIONS };
