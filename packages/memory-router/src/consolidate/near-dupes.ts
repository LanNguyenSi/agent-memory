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
//
// Read-only (mm-v1-T007 fix round HIGH #1): openIndex is asked for a
// readonly connection (`readonly: true`, see src/embed/index-store.ts).
// This pass only ever reads embeddings; opening the index writable had no
// functional purpose and, more importantly, meant a future bug here (a
// stray upsert/remove call) would silently write into a shared index file
// concurrently used by `memory-router index`/the hook rather than being
// rejected outright. Whatever store handle openIndex DOES return (success
// or not) is closed in a single top-level `finally` below; when openIndex
// itself throws before returning one, there is nothing to close.
// Reading the vectors back (the loop below) is also wrapped in its own
// try/catch: a corrupted or partially-written index file can throw mid-
// read (e.g. a truncated vec blob), which now degrades this pass to
// `status: "skipped"` with a reason instead of crashing the whole
// `consolidate` run.

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
  // Always present (a stable JSON key set across both statuses): null on
  // an 'ok' result, the skip explanation on a 'skipped' one.
  reason: string | null;
  threshold: number;
  // How many of `totalCount` loaded memories actually had a usable, same-
  // model embedding row in the index. A gap here (indexedCount < totalCount)
  // means the index is stale relative to the corpus (new/changed memories
  // since the last `memory-router index` run), surfaced, not hidden.
  indexedCount: number;
  totalCount: number;
  pairs: NearDupePair[];
  // Set only on an 'ok' result when indexedCount < totalCount: how many
  // entries the index DOES have for the missing memories, just tagged for
  // a DIFFERENT embedding model than the one currently active
  // (cfg.model). Disambiguates "these memories were never indexed at
  // all" (run `memory-router index`) from "these memories were indexed
  // under a stale/different model" (REBUILD the index), which otherwise
  // look identical from indexedCount/totalCount alone. Omitted (not 0)
  // when there is nothing stale to report, so a consumer can branch on
  // `staleModelRows !== undefined` without a magic-zero check.
  staleModelRows?: number;
  staleModelReason?: string;
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
    reason: null as string | null,
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

  // A single top-level `finally` closes whatever store handle was actually
  // bound, however this function returns (a computed result below, or a
  // throw caught inside). When openIndex itself throws (the inner
  // try/catch right below), `store` is never assigned, so there is
  // nothing to close: `store?.close()` reflects exactly that "as far as
  // it is bound" scope.
  let store;
  try {
    try {
      store = openIndex({
        path: idxPath,
        meta: { provider: cfg.provider, model: cfg.model },
        rebuildCommand,
        // Read-only: this pass never writes, see the file-level comment.
        readonly: true,
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
      // Code-unit (UTF-16) order via `<`/`>`, not localeCompare: localeCompare
// depends on the host locale and would make report order machine-dependent
// (same rationale as schema-metrics.ts's byId/byPath and the readdir-walk
// sorts in loader/drift/transform/applier).
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Highest similarity first; ties broken by id pair (code-unit order) for
// determinism. The id tiebreaks go through the three-way cmp above (not a
// boolean) so the OR-chain composes a total order.
      pairs.sort(
        (a, b) => b.similarity - a.similarity || cmp(a.aId, b.aId) || cmp(a.bId, b.bId),
      );

      // Coverage gap disclosure, part 2: indexedCount < totalCount alone
      // only says SOME memories had no usable row; it can't say whether
      // that's because they were never indexed, or because they WERE
      // indexed but under a model that isn't the one currently active.
      // Probe the index for the latter so the operator gets an actionable
      // "rebuild" hint instead of an ambiguous "index is stale" one.
      let staleModelRows: number | undefined;
      let staleModelReason: string | undefined;
      if (withEmbeddings.length < memories.length) {
        const stale = store.countEntriesWithStaleModel(cfg.model);
        if (stale > 0) {
          staleModelRows = stale;
          staleModelReason =
            `${stale} indexed entr${stale === 1 ? 'y is' : 'ies are'} stored under a different embedding ` +
            `model than the currently active model=${cfg.model}; this is NOT the same as "the index isn't ` +
            `up to date" (new/changed memories never indexed at all). Run \`memory-router index ${dir}\` ` +
            `to re-embed the stale-model entries.`;
        }
      }

      return {
        ...base,
        status: 'ok',
        indexedCount: withEmbeddings.length,
        pairs,
        ...(staleModelRows !== undefined ? { staleModelRows, staleModelReason } : {}),
      };
    } catch (err: unknown) {
      // A corrupted or partially-written index file can throw mid-read
      // (e.g. store.getEmbedding hitting a truncated/malformed vec blob).
      // Degrade to skipped with a reason rather than crashing the whole
      // `consolidate` run over one unreadable index.
      return {
        ...base,
        status: 'skipped',
        reason: `error reading embeddings from the index at ${idxPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } finally {
    store?.close();
  }
}

module.exports = { findNearDupes, cosineSimilarity, DEFAULT_NEAR_THRESHOLD };
