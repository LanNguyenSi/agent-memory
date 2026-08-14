// Orchestrator for `memory-router consolidate`: a REPORT-ONLY verb, no LLM,
// no automatic merges, never writes to the corpus (not even a temp file
// inside it). It combines four independent, read-only passes over a memory
// dir so an operator can decide what to consolidate by hand:
//   - exact duplicates (normalized body-hash groups)
//   - near duplicates  (cosine over EXISTING embedding-index vectors)
//   - stale references (delegates entirely to src/lint/stale.ts, unchanged)
//   - schema metrics   (untagged, legacy-format, loader-reject reasons)

const { loadMemoriesFromDir } = require('../memory/loader');
const { lintMemoryDirForStale } = require('../lint/stale');
const { findExactDupes, NORMALIZATION_DESCRIPTION } = require('./exact-dupes');
const { findNearDupes, DEFAULT_NEAR_THRESHOLD } = require('./near-dupes');
const { buildSchemaMetrics } = require('./schema-metrics');

interface ConsolidateOptions {
  /** Cosine threshold for the near-dupe pass. Default 0.95. */
  nearThreshold?: number;
  /**
   * Repo roots passed through verbatim to lintMemoryDirForStale. Defaults
   * to [process.cwd()], matching the `stale` CLI verb's own default.
   */
  repoRoots?: string[];
}

function runConsolidate(dir: string, options: ConsolidateOptions = {}) {
  const threshold = options.nearThreshold ?? DEFAULT_NEAR_THRESHOLD;
  const repoRoots =
    options.repoRoots && options.repoRoots.length > 0 ? options.repoRoots : [process.cwd()];

  const memories: Memory[] = loadMemoriesFromDir(dir);

  const exactGroups = findExactDupes(memories);
  const nearDupes = findNearDupes(dir, memories, threshold);
  // stale.ts's own public API, called exactly as the `stale` CLI verb calls
  // it (default options: verify:-only refs, no --scan-body/--check-urls;
  // neither is part of this task's scope).
  const stale = lintMemoryDirForStale(dir, repoRoots);
  const schema = buildSchemaMetrics(dir);

  return {
    dir,
    scannedCount: memories.length,
    exactDupes: {
      normalization: NORMALIZATION_DESCRIPTION,
      groups: exactGroups,
    },
    nearDupes,
    stale,
    schema,
  };
}

module.exports = { runConsolidate, DEFAULT_NEAR_THRESHOLD };
