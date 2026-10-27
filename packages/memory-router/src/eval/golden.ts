// Parser for the `memory-router eval <golden.yml>` input file.
//
// Format:
//   prompts:
//     - prompt: "user prompt text"
//       expect: ["memory_id_1", "memory_id_2"]
//     - prompt: "another prompt"
//       expect: []   # negative control: this prompt should match nothing
//     - prompt: "a prompt where a retired memory used to win"
//       expect: ["current_memory_id"]
//       forbid: ["retired_memory_id"]   # must NOT appear in the returned top-k
//
// `expect` is optional and defaults to `[]` (negative control) when omitted.
// `forbid` is optional and defaults to `[]`: ids that must not appear in the
// result at all (the stale-memory check). It is measured and reported next to
// the metrics, never folded into precision/recall/MRR.
// Every malformed shape throws a plain Error with a path-prefixed message;
// the CLI layer (src/cli.ts) catches it and exits 1 with a clear stderr
// line rather than a raw stack trace.
const { readFileSync } = require("node:fs");
const { parse: parseYaml } = require("yaml");

export interface GoldenPrompt {
  prompt: string;
  expect: string[];
  /** Ids that must not appear in the result for this prompt; `[]` when absent. */
  forbid: string[];
}

export interface GoldenFile {
  prompts: GoldenPrompt[];
}

function loadGoldenFile(path: string): GoldenFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    throw new Error(`cannot read golden file ${path}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`golden file ${path} is not valid YAML: ${detail}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `golden file ${path} must be a YAML object with a top-level 'prompts' key`,
    );
  }
  const rawPrompts = (parsed as Record<string, unknown>).prompts;
  if (!Array.isArray(rawPrompts)) {
    throw new Error(`golden file ${path}: 'prompts' must be an array`);
  }
  if (rawPrompts.length === 0) {
    throw new Error(`golden file ${path}: 'prompts' array is empty`);
  }

  const prompts: GoldenPrompt[] = rawPrompts.map(
    (entry: unknown, i: number) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`golden file ${path}: prompts[${i}] must be an object`);
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.prompt !== "string" || e.prompt.length === 0) {
        throw new Error(
          `golden file ${path}: prompts[${i}].prompt must be a non-empty string`,
        );
      }
      let expectIds: string[] = [];
      if (e.expect !== undefined) {
        if (
          !Array.isArray(e.expect) ||
          !e.expect.every((x) => typeof x === "string")
        ) {
          throw new Error(
            `golden file ${path}: prompts[${i}].expect must be an array of memory-id strings (empty array = negative control)`,
          );
        }
        // Dedupe here, at load time, so every downstream consumer (scoring,
        // reporting) sees the same expect list — a duplicated id in the
        // authored golden.yml must not silently deflate recall
        // (|expect ∩ got| / |expect|) by inflating the denominator.
        expectIds = [...new Set(e.expect as string[])];
      }
      let forbidIds: string[] = [];
      if (e.forbid !== undefined) {
        if (
          !Array.isArray(e.forbid) ||
          !e.forbid.every((x) => typeof x === "string")
        ) {
          throw new Error(
            `golden file ${path}: prompts[${i}].forbid must be an array of memory-id strings (empty array = nothing forbidden)`,
          );
        }
        forbidIds = [...new Set(e.forbid as string[])];
        // An id that is both wanted and forbidden can never be satisfied;
        // refuse it at load time instead of reporting a permanent violation.
        const overlap = forbidIds.filter((id) => expectIds.includes(id));
        if (overlap.length > 0) {
          throw new Error(
            `golden file ${path}: prompts[${i}] lists ${overlap.join(", ")} in both expect and forbid`,
          );
        }
      }
      return { prompt: e.prompt, expect: expectIds, forbid: forbidIds };
    },
  );

  return { prompts };
}

module.exports = { loadGoldenFile };
