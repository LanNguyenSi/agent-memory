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

module.exports = { errorSummary };
