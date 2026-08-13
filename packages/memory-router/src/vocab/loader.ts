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

function keywordFallback(name: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
}

function defaultVocabulary(): CompiledVocabulary {
  return {
    source: 'default',
    topicNames: Object.keys(TOPIC_PATTERNS),
    patterns: TOPIC_PATTERNS,
  };
}

function compilePatterns(name: string, rawPatterns: string[]): RegExp[] {
  const compiled = rawPatterns.map((p) => {
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
  const name = raw.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new VocabularyError(
      `topics.yml: entry ${index} is missing required field 'name'`,
    );
  }
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

// Runtime matcher generalizing topic-patterns.ts's `matchedTopics` over a
// loaded vocabulary (default or custom): any single regex hit on a topic is
// enough — permissive on purpose, same contract as the original.
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
  VOCAB_FILENAME,
  VocabularyError,
  defaultVocabulary,
  loadVocabularyOrThrow,
  loadVocabularyResult,
  loadVocabulary,
  matchedTopicsForVocabulary,
};
