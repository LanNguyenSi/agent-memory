// Runtime entry point for programmatic use. Types are global ambient
// (src/types.d.ts) so direct consumers need their own declarations — this
// module is primarily consumed via the `memory-router*` bin entries.

const { loadMemoriesFromDir, parseMemoryFile } = require('./memory/loader');
const { topicGate } = require('./gates/topic');
const { toolGate } = require('./gates/tool');
const {
  computeAmbiguity,
  confidenceThreshold,
} = require('./gates/confidence');
const {
  resolve,
  resolveConfidence,
  dedupeAndRank,
  DEFAULT_GATES,
} = require('./router');
const { rebuildIndex, semanticSearch } = require('./embed/indexer');
const { renderHitsAsContext } = require('./render');

module.exports = {
  loadMemoriesFromDir,
  parseMemoryFile,
  topicGate,
  toolGate,
  computeAmbiguity,
  confidenceThreshold,
  resolve,
  resolveConfidence,
  dedupeAndRank,
  DEFAULT_GATES,
  rebuildIndex,
  semanticSearch,
  renderHitsAsContext,
};
