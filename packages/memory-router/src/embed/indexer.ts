const { mkdirSync, statSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { loadMemoriesFromDir } = require('../memory/loader');
const { embedBatch, resolveProviderConfig } = require('./provider');
const { openIndex } = require('./index-store');
const { debug } = require('../debug');

// text-embedding-3-small emits 1536-dim vectors. If the model is ever
// swapped, the index is versioned by directory (re-run `memory-router index`
// wipes + rebuilds); no automatic migration — simpler, and this is a local
// cache, not a source of truth.
const EMBED_DIMENSIONS = 1536;

const INDEX_SUBDIR = '.memory-router';
const INDEX_FILENAME = 'index.sqlite';

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
  const parts = [memory.frontmatter.name, memory.frontmatter.description, memory.body];
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
  const cfg = resolveProviderConfig();
  if (!cfg) {
    return {
      total: 0,
      embedded: 0,
      removed: 0,
      skipped: 0,
      reason: 'OPENAI_API_KEY not set — confidence gate will remain silent',
    };
  }

  const memories = loadMemoriesFromDir(memoryDir);
  mkdirSync(join(memoryDir, INDEX_SUBDIR), { recursive: true });
  const store = openIndex({ path: indexPath(memoryDir), dimensions: EMBED_DIMENSIONS });

  try {
    const existing = new Map<string, number>(
      store.listEntries().map((e: { id: string; mtime: number }) => [e.id, e.mtime]),
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
      const vectors = await embedBatch({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        inputs: batch.map((b) => buildEmbedInput(b.memory)),
      });
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
  const cfg = resolveProviderConfig();
  if (!cfg) return [];

  const idx = indexPath(memoryDir);
  if (!existsSync(idx)) {
    process.stderr.write(
      'memory-router: embedding index missing — run `memory-router index <dir>` to build it.\n',
    );
    return [];
  }

  const store = openIndex({
    path: idx,
    dimensions: EMBED_DIMENSIONS,
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
      [queryVec] = await embedBatch({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        inputs: [prompt],
      });
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
        (h: { memory: Memory | undefined }): h is { memory: Memory; score: number } =>
          h.memory !== undefined,
      );
  } finally {
    store.close();
  }
}

module.exports = { rebuildIndex, semanticSearch, indexPath, EMBED_DIMENSIONS };
