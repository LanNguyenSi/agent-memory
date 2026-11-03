// The error summary shared by every prompt-handling stderr line in this
// package: the error CLASS plus, when it carries one, a machine-readable result
// code - never the message.
//
// An error message on these paths can hold text derived from the user's prompt:
// an SQLite FTS message quotes back part of the phrase it was given, and that
// phrase is built from the prompt (the search path that degrades at
// src/router.ts is the same `blendedSearch()` call, so a store-level failure
// reaching it comes from that same session); and a JSON.parse failure quotes the
// stdin payload the prompt arrived in. All of these lines go to the stderr of a
// process a harness collects alongside the transcript
// (the UserPromptSubmit/PreToolUse hooks and the MCP server), so echoing the
// message copies prompt text into that log.
//
// The sites: src/embed/index-store.ts and src/embed/indexer.ts (keyword-path
// degradation, through the once-per-process flag in src/embed/fts-warning.ts),
// src/router.ts (semantic-search degradation), the two hooks, the MCP server's
// resolution fallback, and src/cli.ts's `--semantic` confidence-gate warning.
//
// better-sqlite3 errors carry `name` (SqliteError) and `code`
// (e.g. SQLITE_ERROR); anything else degrades to just its class.
function errorSummary(err: unknown): string {
  if (err === null || typeof err !== 'object') return 'Error';
  const e = err as { name?: unknown; code?: unknown };
  const name = typeof e.name === 'string' && e.name !== '' ? e.name : 'Error';
  const code = typeof e.code === 'string' && e.code !== '' ? ` (${e.code})` : '';
  return `${name}${code}`;
}

// The error class of an embedding index whose provenance disagrees with the
// active embedding config: built ONLY where those errors are created, in
// src/embed/index-store.ts (the provider-mismatch and legacy-provenance
// throws at open time, and the same-provider dimension-mismatch throws in
// upsert/putCachedQuery/search/searchChunks - a width change is a model
// switch seen from the index side). The class is what lets the prompt-handling
// degradation lines below recognize this one failure without echoing its
// message, which carries the index path and the provider/model tags.
class IndexProvenanceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexProvenanceMismatchError';
  }
}

// The FIXED hint appended to a degradation line when (and only when) the
// caught error is an IndexProvenanceMismatchError. The full rebuild command
// lives in that error's message, which these lines must not print, so without
// this hint a hook that silently degrades after an embedding model switch
// carries no pointer back to `memory-router index`. The hint text is fixed
// (never derived from the error); `memoryDir` is the caller's own memory dir,
// a value the code has, so no prompt- or error-derived text reaches stderr.
// Every other error keeps the short class-plus-code line.
function indexRebuildHint(err: unknown, memoryDir: string): string {
  if (!(err instanceof IndexProvenanceMismatchError)) return '';
  return `; if the embedding provider or model changed, run \`memory-router index ${memoryDir}\` to rebuild`;
}

module.exports = { errorSummary, IndexProvenanceMismatchError, indexRebuildHint };
