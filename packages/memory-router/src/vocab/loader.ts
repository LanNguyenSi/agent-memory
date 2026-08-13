// Corpus-controlled topic vocabulary loader.
//
// The Topic Gate and `lint --unknown-topics` used to work against a single
// hardcoded 5-topic set in `../topic-patterns` (`deployment`,
// `destructive_ops`, `workflow`, `security`, `testing`). That set is now
// only the *built-in default*. A corpus overrides it corpus-wide by placing
// `topics.yml` at the root of its memory dir — the same directory
// `MEMORY_ROUTER_DIR` points at / `lint <dir>` is invoked against — as a
// top-level YAML list of `{ name, description?, patterns? }` entries.
//
// Two entry points, deliberately different failure behavior:
//
//   - `loadVocabularyOrThrow(memoryDir)`: throws `VocabularyError` with a
//     human-readable message on any invalid `topics.yml` (YAML error,
//     missing `name`, duplicate `name`, wrong field shape). For callers
//     that want to surface the problem instead of swallowing it.
//   - `loadVocabulary(memoryDir)` / `loadVocabularyResult(memoryDir)`: never
//     throws. Falls back to the built-in default and logs via `debug()` on
//     any failure. The Topic Gate uses this — the UserPromptSubmit hook
//     must never crash (and so never block) the prompt over a broken
//     corpus file.
//
// A single non-compiling regex inside an otherwise-valid `patterns:` list
// does not reject the whole file either: that one pattern degrades to a
// keyword match on its topic's own `name` (see `compilePatterns`). Same for
// a topic entry declared with no `patterns:` at all — it would otherwise
// never match anything, so it also gets the keyword-on-name fallback.
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { parse: parseYaml } = require('yaml');
const { debug: debugWarn } = require('../debug');
const { TOPIC_PATTERNS } = require('../topic-patterns');
// Reused rather than duplicated: a `topics.yml` pattern is author-trusted
// content just like a memory's `triggers.command_pattern` (see gates/tool.ts
// and README.md "Trust Model"), so it gets the same ReDoS screen. Already
// exported from gates/tool.ts for this purpose.
const { isSafePattern } = require('../gates/tool');

const VOCAB_FILENAME = 'topics.yml';

class VocabularyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VocabularyError';
  }
}

interface CompiledVocabulary {
  source: 'default' | 'custom';
  topicNames: string[];
  patterns: Record<string, RegExp[]>;
}

interface VocabularyResult {
  vocabulary: CompiledVocabulary;
  error: string | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `\b` is a transition between a \w char and a non-\w char. For a name
// whose first or last character is itself non-\w (e.g. the topic name
// `.env` or `c++`), a `\b…\b`-wrapped pattern can never match the name at
// all: the boundary immediately touching a non-\w literal char requires the
// OTHER neighbor to be \w, which is never guaranteed (e.g. ".env" at the
// very start of a string, or "c++" immediately followed by whitespace, both
// fail `\b\.env\b` / `\bc\+\+\b`). Lookarounds against the same \w charset
// `\b` uses give the identical boundary semantics for ordinary
// (all-word-char) names while also matching names that start/end on
// punctuation.
function keywordFallback(name: string): RegExp {
  const escaped = escapeRegExp(name);
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i');
}

// Defensive copy: callers (see tests/vocab-loader.test.ts) must not be able
// to mutate the module-level TOPIC_PATTERNS by mutating a vocabulary object
// they were handed. topicNames is already a fresh array (Object.keys), but
// `patterns`'s per-topic RegExp[] arrays need their own copy too — a
// `.push()` on a returned array would otherwise corrupt TOPIC_PATTERNS for
// every subsequent defaultVocabulary() call in the same process.
function defaultVocabulary(): CompiledVocabulary {
  const patterns: Record<string, RegExp[]> = {};
  for (const [topic, pats] of Object.entries(TOPIC_PATTERNS)) {
    patterns[topic] = [...(pats as RegExp[])];
  }
  return {
    source: 'default',
    topicNames: Object.keys(TOPIC_PATTERNS),
    patterns,
  };
}

function compilePatterns(name: string, rawPatterns: string[]): RegExp[] {
  const compiled = rawPatterns.map((p) => {
    // ReDoS screen first, same guard gates/tool.ts applies to a memory's
    // `triggers.command_pattern`: a `topics.yml` pattern is equally
    // author-trusted content, so an unsafe shape degrades exactly like a
    // non-compiling pattern rather than being compiled and run.
    if (!isSafePattern(p)) {
      debugWarn(
        `topics.yml: topic '${name}' pattern ${JSON.stringify(p)} rejected by the ReDoS safety screen (too long or a nested-quantifier shape); degrading to keyword match on the topic name`,
      );
      return keywordFallback(name);
    }
    try {
      return new RegExp(p, 'i');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      debugWarn(
        `topics.yml: topic '${name}' pattern ${JSON.stringify(p)} failed to compile (${detail}); degrading to keyword match on the topic name`,
      );
      return keywordFallback(name);
    }
  });
  if (compiled.length === 0) compiled.push(keywordFallback(name));
  return compiled;
}

interface RawEntry {
  [key: string]: unknown;
}

function readEntryFields(
  entry: unknown,
  index: number,
): { name: string; patterns: string[] } {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new VocabularyError(
      `topics.yml: entry ${index} is not a mapping ({name, description, patterns})`,
    );
  }
  const raw = entry as RawEntry;
  const rawName = raw.name;
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    throw new VocabularyError(
      `topics.yml: entry ${index} is missing required field 'name'`,
    );
  }
  // Trimmed before it becomes the topic key: an author's stray leading/
  // trailing whitespace in `name:` must not produce a topic that never
  // matches its own keyword fallback (keywordFallback would otherwise embed
  // the untrimmed whitespace into the regex) or a duplicate-name miss
  // against an otherwise-identical trimmed entry elsewhere in the file.
  const name = rawName.trim();
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    throw new VocabularyError(
      `topics.yml: topic '${name}' field 'description' must be a string`,
    );
  }

  let patterns: string[] = [];
  if (raw.patterns !== undefined && raw.patterns !== null) {
    if (!Array.isArray(raw.patterns)) {
      throw new VocabularyError(
        `topics.yml: topic '${name}' field 'patterns' must be a list of strings`,
      );
    }
    patterns = raw.patterns.map((p: unknown, i: number) => {
      if (typeof p !== 'string') {
        throw new VocabularyError(
          `topics.yml: topic '${name}' patterns[${i}] must be a string`,
        );
      }
      return p;
    });
  }

  return { name, patterns };
}

// Throws VocabularyError on any invalid topics.yml. Returns the built-in
// default unchanged when the file is simply absent.
function loadVocabularyOrThrow(memoryDir: string): CompiledVocabulary {
  const filePath = join(memoryDir, VOCAB_FILENAME);
  if (!existsSync(filePath)) return defaultVocabulary();

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new VocabularyError(
      `topics.yml: could not read ${filePath}: ${detail}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new VocabularyError(`topics.yml: YAML parse error: ${detail}`);
  }

  if (!Array.isArray(parsed)) {
    throw new VocabularyError(
      'topics.yml: expected a top-level list of {name, description, patterns} entries',
    );
  }
  if (parsed.length === 0) {
    throw new VocabularyError(
      'topics.yml: vocabulary is empty (no topic entries)',
    );
  }

  const patterns: Record<string, RegExp[]> = {};
  const topicNames: string[] = [];
  const seen = new Set<string>();

  parsed.forEach((entry, index) => {
    const { name, patterns: rawPatterns } = readEntryFields(entry, index);
    if (seen.has(name)) {
      throw new VocabularyError(`topics.yml: duplicate topic name '${name}'`);
    }
    seen.add(name);
    topicNames.push(name);
    patterns[name] = compilePatterns(name, rawPatterns);
  });

  return { source: 'custom', topicNames, patterns };
}

// Never throws. `memoryDir` unset => built-in default, silently (matches
// every other MEMORY_ROUTER_DIR-unset code path in this package). Any
// invalid `topics.yml` falls back to the built-in default too, with the
// rejection reason returned in `.error` for callers that want to surface it
// (see lint/topics.ts) and always logged via `debug()`.
function loadVocabularyResult(memoryDir: string | undefined): VocabularyResult {
  if (!memoryDir) return { vocabulary: defaultVocabulary(), error: null };
  try {
    return { vocabulary: loadVocabularyOrThrow(memoryDir), error: null };
  } catch (err) {
    const message =
      err instanceof VocabularyError
        ? err.message
        : `topics.yml: ${err instanceof Error ? err.message : String(err)}`;
    debugWarn(`falling back to default topic vocabulary: ${message}`);
    return { vocabulary: defaultVocabulary(), error: message };
  }
}

function loadVocabulary(memoryDir: string | undefined): CompiledVocabulary {
  return loadVocabularyResult(memoryDir).vocabulary;
}

// Runtime matcher against a loaded vocabulary (default or custom): any
// single regex hit on a topic is enough — permissive on purpose, mirrors
// the old built-in-only matcher's contract before topics.yml existed.
function matchedTopicsForVocabulary(
  text: string,
  vocabulary: CompiledVocabulary,
): string[] {
  const hits: string[] = [];
  for (const name of vocabulary.topicNames) {
    const pats = vocabulary.patterns[name] ?? [];
    if (pats.some((p) => p.test(text))) hits.push(name);
  }
  return hits;
}

module.exports = {
  // Production surface: every non-test caller (gates/topic.ts,
  // lint/topics.ts, src/eval/runner.ts) uses loadVocabularyResult /
  // loadVocabulary / defaultVocabulary / matchedTopicsForVocabulary.
  defaultVocabulary,
  loadVocabularyResult,
  loadVocabulary,
  matchedTopicsForVocabulary,
  // Test-only from here down: VOCAB_FILENAME, VocabularyError, and
  // loadVocabularyOrThrow exist so tests/vocab-loader.test.ts can assert
  // the throwing contract and the on-disk filename directly. No production
  // code in this package imports loadVocabularyOrThrow (production always
  // wants the never-throws loadVocabularyResult/loadVocabulary). Not
  // lint-enforced yet — a `lint --strict "no production import of
  // loadVocabularyOrThrow"` rule is filed as a follow-up (task 0a32c3ad),
  // out of scope for this fix round.
  VOCAB_FILENAME,
  VocabularyError,
  loadVocabularyOrThrow,
};
