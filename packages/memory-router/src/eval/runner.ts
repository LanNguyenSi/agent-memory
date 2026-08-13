// Golden-set eval runner: measures the router's current recall/precision
// against a labelled prompt set. This is a REPORT, not a gate — v1
// deliberately has no threshold/exit-code contract on the metrics
// themselves (see runEval in cli.ts: exit 0 on any error-free run).
//
// Purpose: capture a baseline of the status-quo resolver BEFORE the
// retrieval rework (blend of sync + semantic gates), so every later change
// to that path is measurable against this baseline instead of vibes.
const { existsSync } = require("node:fs");
const { loadMemoriesFromDir } = require("../memory/loader");
const { resolve, resolveConfidence, dedupeAndRank } = require("../router");
const { indexPath } = require("../embed/indexer");
const { resolveProviderConfig } = require("../embed/provider");
const { loadGoldenFile } = require("./golden");

// Matches the UserPromptSubmit hook's hardcoded cap (src/hooks/user-prompt-submit.ts).
const MAX_HITS = 5;

/**
 * Single source of truth for "which memories does this prompt select
 * today". Mirrors src/hooks/user-prompt-submit.ts EXACTLY: sync gates
 * (topic, tool) run first; the async confidence gate only runs when the
 * sync gates were silent, and any confidence-gate failure falls back to
 * the sync hits alone. Keeping this selection logic in one small function
 * (rather than duplicating the hook's inline branching per-prompt in the
 * runner loop) is deliberate: the planned retrieval blend (T004) swaps
 * this one function and the rest of the eval runner is untouched.
 */
async function promptToHits(
  ctx: RouterContext,
  memories: Memory[],
  dir: string,
): Promise<GateHit[]> {
  const syncHits: GateHit[] = resolve(ctx, memories, { maxHits: MAX_HITS });
  if (syncHits.length > 0) return syncHits;

  try {
    const semHits: GateHit[] = await resolveConfidence(ctx, memories, dir, {
      maxHits: MAX_HITS,
    });
    return dedupeAndRank([...syncHits, ...semHits], MAX_HITS);
  } catch {
    // Same fail-open contract as the hook: a semantic-search failure never
    // costs the sync hits that already fired (here: none, since we only
    // reach this branch when syncHits was empty).
    return syncHits;
  }
}

/**
 * Whether the confidence gate can contribute a hit for this corpus today:
 * an embedding index file must exist on disk AND a provider must be
 * configured (OPENAI_API_KEY). Computed independently of any single
 * prompt's outcome so the report states this up front instead of letting
 * "semantic gate silently returned []" masquerade as "semantic path was
 * measured and scored zero".
 */
function semanticPathAvailable(dir: string): boolean {
  return existsSync(indexPath(dir)) && resolveProviderConfig() !== null;
}

export interface PromptMetric {
  prompt: string;
  expect: string[];
  got: string[];
  isNegativeControl: boolean;
  precision: number;
  recall: number;
  /** null for negative-control prompts; MRR is undefined for them by design. */
  reciprocalRank: number | null;
}

/**
 * Metric definitions (documented in full in README.md "Golden-set eval"):
 *
 * Positive prompt (expect.length > 0):
 *   precision = |expect ∩ got| / |got|   (0 when got is empty)
 *   recall    = |expect ∩ got| / |expect|
 *   reciprocalRank = 1 / (1-indexed rank of the first got id that is in
 *     expect), or 0 when none of expect appears in got.
 *
 * Negative control (expect.length === 0): the only correct result is an
 * empty got. precision = recall = 1.0 when got is empty, else 0.0.
 * reciprocalRank is not defined (null) and negative controls are excluded
 * from the MRR aggregate.
 */
function scorePrompt(
  expect: string[],
  got: string[],
): Pick<
  PromptMetric,
  "isNegativeControl" | "precision" | "recall" | "reciprocalRank"
> {
  const isNegativeControl = expect.length === 0;
  if (isNegativeControl) {
    const score = got.length === 0 ? 1 : 0;
    return {
      isNegativeControl,
      precision: score,
      recall: score,
      reciprocalRank: null,
    };
  }

  const expectSet = new Set(expect);
  const intersectionSize = got.filter((id) => expectSet.has(id)).length;
  const precision = got.length === 0 ? 0 : intersectionSize / got.length;
  const recall = intersectionSize / expect.length;

  let reciprocalRank = 0;
  for (let i = 0; i < got.length; i++) {
    if (expectSet.has(got[i])) {
      reciprocalRank = 1 / (i + 1);
      break;
    }
  }
  return { isNegativeControl, precision, recall, reciprocalRank };
}

export interface NegativeControlSummary {
  total: number;
  passed: number;
  failed: number;
  /** null when there are no negative controls in the golden set. */
  rate: number | null;
}

export interface AggregateMetrics {
  /** Mean precision across positive (non-negative-control) prompts. */
  precision: number;
  /** Mean recall across positive prompts. */
  recall: number;
  /** Mean reciprocal rank across positive prompts. */
  mrr: number;
  /** Number of positive prompts the above three means are computed over. */
  positiveCount: number;
  /** Negative-control prompts are reported separately, never blended into P/R/MRR. */
  negativeControls: NegativeControlSummary;
}

function aggregateMetrics(perPrompt: PromptMetric[]): AggregateMetrics {
  const positive = perPrompt.filter((p) => !p.isNegativeControl);
  const negative = perPrompt.filter((p) => p.isNegativeControl);
  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

  const passed = negative.filter((p) => p.precision === 1).length;

  return {
    precision: mean(positive.map((p) => p.precision)),
    recall: mean(positive.map((p) => p.recall)),
    mrr: mean(positive.map((p) => p.reciprocalRank ?? 0)),
    positiveCount: positive.length,
    negativeControls: {
      total: negative.length,
      passed,
      failed: negative.length - passed,
      rate: negative.length === 0 ? null : passed / negative.length,
    },
  };
}

export interface EvalReport {
  goldenPath: string;
  dir: string;
  corpusSize: number;
  semanticPathActive: boolean;
  perPrompt: PromptMetric[];
  aggregate: AggregateMetrics;
}

/**
 * Runs every prompt in `goldenPath` against the corpus at `dir` through
 * `promptToHits` and returns the full per-prompt + aggregate report.
 * Throws on a missing/unparsable golden file (loadGoldenFile); the caller
 * (cli.ts) is responsible for validating `dir` exists before calling this
 * — loadMemoriesFromDir fails open (returns []) on a missing/unreadable
 * dir, which would otherwise silently report a 0-memory corpus instead of
 * a clear error.
 */
async function runGoldenEval(
  goldenPath: string,
  dir: string,
): Promise<EvalReport> {
  const golden = loadGoldenFile(goldenPath);
  const memories = loadMemoriesFromDir(dir);
  const semanticPathActive = semanticPathAvailable(dir);

  const perPrompt: PromptMetric[] = [];
  for (const entry of golden.prompts) {
    const ctx: RouterContext = { prompt: entry.prompt };
    const hits = await promptToHits(ctx, memories, dir);
    const got = hits.map((h) => h.memory.id);
    const scored = scorePrompt(entry.expect, got);
    perPrompt.push({
      prompt: entry.prompt,
      expect: entry.expect,
      got,
      ...scored,
    });
  }

  return {
    goldenPath,
    dir,
    corpusSize: memories.length,
    semanticPathActive,
    perPrompt,
    aggregate: aggregateMetrics(perPrompt),
  };
}

module.exports = {
  promptToHits,
  semanticPathAvailable,
  scorePrompt,
  aggregateMetrics,
  runGoldenEval,
};
