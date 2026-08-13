// Curated topic-mapping file loader for `memory-router migrate --mapping <file>`.
//
// The migrate verb derives `topics:` mechanically in two steps (see
// transform.ts): (1) this curated mapping, (2) a vocabulary pattern match
// against name+description. Neither step guesses; a file that matches
// neither stays untagged and is surfaced in the migrate report.
//
// Format: a top-level YAML list of rules, each mapping either an exact
// memory id or a filename-prefix to a fixed topic list:
//
//   - prefix: "feedback_"
//     topics: [workflow]
//   - id: "reference_codebase_oracle"
//     topics: [testing, workflow]
//
// Deliberately mirrors `topics.yml`'s shape (bare top-level list, see
// src/vocab/loader.ts) rather than introducing a second file convention.
// `id` gives the curator (mm-v1-T008, the Pandora corpus operator) a way to
// pin a specific memory without needing full MEMORY.md section parsing,
// which this mechanical migrate verb deliberately does not implement.
//
// Matching is first-rule-wins in file order; an entry declaring both `id`
// and `prefix`, or neither, is rejected at load time rather than silently
// picking one.
const { readFileSync } = require('node:fs');
const { parse: parseYaml } = require('yaml');

interface MappingRule {
  id?: string;
  prefix?: string;
  topics: string[];
}

class MigrationMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationMappingError';
  }
}

function readTopics(raw: unknown, index: number): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new MigrationMappingError(
      `mapping file: entry ${index} field 'topics' must be a non-empty list of strings`,
    );
  }
  return raw.map((t: unknown, i: number) => {
    if (typeof t !== 'string' || t.trim() === '') {
      throw new MigrationMappingError(
        `mapping file: entry ${index} topics[${i}] must be a non-empty string`,
      );
    }
    return t.trim();
  });
}

// Throws MigrationMappingError on any invalid mapping file (missing,
// unreadable, YAML error, or wrong shape). Callers (cli.ts) are expected to
// surface this as a setup error, not to fail-open silently: a curated
// mapping file the operator explicitly pointed at via --mapping must not
// be quietly ignored on typo.
function loadMapping(path: string): MappingRule[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MigrationMappingError(
      `mapping file: could not read ${path}: ${detail}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MigrationMappingError(`mapping file: YAML parse error: ${detail}`);
  }

  if (!Array.isArray(parsed)) {
    throw new MigrationMappingError(
      'mapping file: expected a top-level list of {id|prefix, topics} entries',
    );
  }

  return parsed.map((entry: unknown, index: number): MappingRule => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new MigrationMappingError(
        `mapping file: entry ${index} is not a mapping ({id|prefix, topics})`,
      );
    }
    const raw = entry as Record<string, unknown>;
    const hasId = typeof raw.id === 'string' && raw.id.trim() !== '';
    const hasPrefix = typeof raw.prefix === 'string' && raw.prefix.trim() !== '';
    if (hasId === hasPrefix) {
      // Both set or neither set: reject rather than pick a silent default.
      throw new MigrationMappingError(
        `mapping file: entry ${index} must set exactly one of 'id' or 'prefix' (non-empty string)`,
      );
    }
    const topics = readTopics(raw.topics, index);
    return hasId
      ? { id: (raw.id as string).trim(), topics }
      : { prefix: (raw.prefix as string).trim(), topics };
  });
}

// First-match-wins against the memory id (filename without extension).
// Returns a fresh array (never the rule's own array) so a caller mutating
// the result never corrupts the loaded rule set on a repeat match.
function matchMapping(id: string, rules: MappingRule[]): string[] | null {
  for (const rule of rules) {
    if (rule.id !== undefined && rule.id === id) return [...rule.topics];
    if (rule.prefix !== undefined && id.startsWith(rule.prefix)) {
      return [...rule.topics];
    }
  }
  return null;
}

module.exports = { loadMapping, matchMapping, MigrationMappingError };
