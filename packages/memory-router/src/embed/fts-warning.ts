// One once-per-process flag shared by BOTH keyword-degradation warning paths
// (the store-level FTS reads in src/embed/index-store.ts and the keyword pass
// wrapper in src/embed/indexer.ts), so one process writes AT MOST ONE such
// line: docs/scoring.md and docs/okf/semantic-search-silent-noop.md both
// promise "one stderr line per process" for a broken keyword index, which two
// independent flags could not deliver (one line per path).
//
// Lives in its own module because a shared flag has to live in exactly one
// module instance: each caller keeps its own message, the flag is shared.
// The other once-per-process warnings of the same shape (missing index, stale
// model) stay per-path flags in src/embed/indexer.ts; only the keyword/FTS
// pair shares this one, since both describe the same degradation.
let warned = false;

// What goes after a warning's fixed prefix: the error CLASS and the SQLite
// result code, never the message. An SQLite FTS error message can echo back
// part of the queried phrase, and that phrase comes from the user's prompt, so
// printing `String(err)` would copy prompt text into the log (and into whatever
// collects the hook's stderr). better-sqlite3 errors carry `name` (SqliteError)
// and `code` (e.g. SQLITE_ERROR); anything else degrades to just its class.
function errorSummary(err: unknown): string {
  if (err === null || typeof err !== 'object') return 'Error';
  const e = err as { name?: unknown; code?: unknown };
  const name = typeof e.name === 'string' && e.name !== '' ? e.name : 'Error';
  const code = typeof e.code === 'string' && e.code !== '' ? ` (${e.code})` : '';
  return `${name}${code}`;
}

// Writes `line` and returns true on the first call of this process; every later
// call from either path returns false and writes nothing. Callers build the
// line (prefix + errorSummary(err) + "\n"); the trailing newline is theirs.
function warnKeywordPathOnce(line: string): boolean {
  if (warned) return false;
  warned = true;
  process.stderr.write(line);
  return true;
}

module.exports = { errorSummary, warnKeywordPathOnce };
