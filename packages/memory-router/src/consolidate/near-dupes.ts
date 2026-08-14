// Near-duplicate detection for `memory-router consolidate`: pairwise cosine
// similarity over EXISTING embedding-index vectors only. This never makes a
// live embedding API call: it opens the sqlite-vec index already built by
// `memory-router index <dir>` (src/embed/index-store.ts, src/embed/indexer.ts)
// and reads back the vectors already stored there. When the index is
// missing, or was built under a different embedding provider/model than the
// one currently configured (see index-store.ts's provenance-mismatch
// contract, mm-v1-T003), the pass is skipped with an explicit reason instead
// of either crashing or silently reporting nothing.
//
// Compatibility with the current provider config is checked the same way
// src/embed/indexer.ts's rebuildIndex/semanticSearch do: resolve the active
// provider/model via resolveProviderConfig({ autoDetectOllama: true }) and
// pass it as `opts.meta` to openIndex, which throws when the on-disk index
// disagrees. That throw is caught here and turned into a skip, not a crash.

const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { indexPath } = require('../embed/indexer');
const { openIndex } = require('../embed/index-store');
const { resolveProviderConfig } = require('../embed/provider');

const DEFAULT_NEAR_THRESHOLD = 0.95;

interface NearDupePair {
  aId: string;
  aPath: string;
  bId: string;
  bPath: string;
  similarity: number;
}

interface NearDupeResult {
  status: 'ok' | 'skipped';
  reason?: string;
  threshold: number;
  // How many of `totalCount` loaded memories actually had a usable, same-
  // model embedding row in the index. A gap here (indexedCount < totalCount)
  // means the index is stale relative to the corpus (new/changed memories
  // since the last `memory-router index` run), surfaced, not hidden.
  indexedCount: number;
  totalCount: number;
  pairs: NearDupePair[];
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function findNearDupes(
  dir: string,
  memories: Memory[],
  threshold: number = DEFAULT_NEAR_THRESHOLD,
): NearDupeResult {
  const base = {
    threshold,
    indexedCount: 0,
    totalCount: memories.length,
    pairs: [] as NearDupePair[],
  };

  const idxPath = indexPath(dir);
  if (!existsSync(idxPath)) {
    return {
      ...base,
      status: 'skipped',
      reason: `no embedding index found at ${idxPath}; run \`memory-router index ${dir}\` first`,
    };
  }

  // Mirrors src/embed/indexer.ts's own resolution exactly (same
  // autoDetectOllama:true opt-in) so "the active provider config" means the
  // same thing here as it does when the index was (re)built.
  const cfg = resolveProviderConfig({ autoDetectOllama: true });
  if (!cfg) {
    return {
      ...base,
      status: 'skipped',
      reason:
        'no embedding provider configured (set OPENAI_API_KEY, or MEMORY_ROUTER_EMBED_PROVIDER=ollama with a reachable local daemon); near-dupe search compares vectors under the active provider, so it needs one resolved',
    };
  }

  const rebuildCommand = `rm -rf ${join(dir, '.memory-router')} && memory-router index ${dir}`;

  let store;
  try {
    store = openIndex({
      path: idxPath,
      meta: { provider: cfg.provider, model: cfg.model },
      rebuildCommand,
    });
  } catch (err: unknown) {
    // openIndex throws on a provider/model mismatch against the on-disk
    // index (see index-store.ts's provenance contract); that is exactly
    // the "provider mismatch" case this pass must degrade on, not crash.
    return {
      ...base,
      status: 'skipped',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const withEmbeddings: { memory: Memory; embedding: number[] }[] = [];
    for (const memory of memories) {
      const embedding = store.getEmbedding(memory.id, cfg.model);
      if (embedding) withEmbeddings.push({ memory, embedding });
    }

    const pairs: NearDupePair[] = [];
    for (let i = 0; i < withEmbeddings.length; i++) {
      for (let j = i + 1; j < withEmbeddings.length; j++) {
        const similarity = cosineSimilarity(
          withEmbeddings[i].embedding,
          withEmbeddings[j].embedding,
        );
        if (similarity >= threshold) {
          pairs.push({
            aId: withEmbeddings[i].memory.id,
            aPath: withEmbeddings[i].memory.path,
            bId: withEmbeddings[j].memory.id,
            bPath: withEmbeddings[j].memory.path,
            similarity,
          });
        }
      }
    }
    // Highest similarity first; ties broken by id pair for determinism.
    pairs.sort(
      (a, b) => b.similarity - a.similarity || a.aId.localeCompare(b.aId) || a.bId.localeCompare(b.bId),
    );

    return {
      ...base,
      status: 'ok',
      indexedCount: withEmbeddings.length,
      pairs,
    };
  } finally {
    store.close();
  }
}

module.exports = { findNearDupes, cosineSimilarity, DEFAULT_NEAR_THRESHOLD };
