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
const { loadVocabularyResult } = require("../vocab/loader");

// Matches the UserPromptSubmit hook's hardcoded cap (src/hooks/user-prompt-submit.ts).
const MAX_HITS = 5;

/**
 * Test seam for promptToHits: lets tests substitute the three router
 * entry points and pin the exact call shape (see tests/eval-runner.test.ts)
 * without touching the real router/embedding stack. Default is the real
 * functions required above; production and cli.ts callers never pass this.
 */
interface PromptToHitsDeps {
  resolve: (
    ctx: RouterContext,
    memories: Memory[],
    opts?: ResolveOptions,
  ) => GateHit[];
  resolveConfidence: (
    ctx: RouterContext,
    memories: Memory[],
    dir: string,
    opts?: { maxHits?: number },
  ) => Promise<GateHit[]>;
  dedupeAndRank: (hits: GateHit[], maxHits: number) => GateHit[];
}

/**
 * Single source of truth for "which memories does this prompt select
 * today". Mirrors src/hooks/user-prompt-submit.ts EXACTLY: sync gates
 * (topic, tool) run first; the async confidence gate only runs when the
 * sync gates were silent, and any confidence-gate failure falls back to
 * the sync hits alone. Keeping this selection logic in one small function
 * (rather than duplicating the hook's inline branching per-prompt in the
 * runner loop) is deliberate: the planned retrieval blend (T004) swaps
 * this one function and the rest of the eval runner is untouched.
 *
 * The resolveConfidence call below is intentionally called with NO opts
 * object (`resolveConfidence(ctx, memories, dir)`), exactly like the hook
 * (src/hooks/user-prompt-submit.ts) — that leaves the router's own default
 * maxHits (3, see src/router.ts) in effect instead of pinning it to this
 * module's MAX_HITS=5. Passing `{ maxHits: MAX_HITS }` here would silently
 * diverge from what the hook actually does and break the "mirrors the hook
 * exactly" claim below. `resolve()` and `dedupeAndRank()` DO get MAX_HITS
 * explicitly because that value (5) matches the hook's own behavior there
 * (resolve()'s default is also 5, and the hook's dedupeAndRank call is
 * hardcoded to 5).
 *
 * `ctx.memoryDir` is expected to already be populated by the caller (see
 * `runGoldenEval` below) — this function itself does not set it, only
 * passes `ctx` through to `deps.resolve`/`deps.resolveConfidence`. Mirrors
 * the hook: the hook's `$MEMORY_ROUTER_DIR` env var always points at THIS
 * corpus (env var *is* the dir, one process per corpus), so the Topic
 * Gate's vocabulary is scoped to it exactly the way `ctx.memoryDir` scopes
 * it here, without depending on that env var being set in the eval
 * process's own environment.
 */
async function promptToHits(
  ctx: RouterContext,
  memories: Memory[],
  dir: string,
  deps: PromptToHitsDeps = { resolve, resolveConfidence, dedupeAndRank },
): Promise<GateHit[]> {
  const syncHits: GateHit[] = deps.resolve(ctx, memories, {
    maxHits: MAX_HITS,
  });
  if (syncHits.length > 0) return syncHits;

  try {
    const semHits: GateHit[] = await deps.resolveConfidence(
      ctx,
      memories,
      dir,
    );
    return deps.dedupeAndRank([...syncHits, ...semHits], MAX_HITS);
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

/**
 * Human-readable statement of which topic vocabulary this eval run's Topic
 * Gate hits were scored against: the corpus's own `<dir>/topics.yml`, or
 * the built-in default (either because no `topics.yml` exists, or because
 * one exists but failed to load — in which case the rejection reason is
 * folded in too, same as lint/topics.ts's `vocabularyError` surface). A
 * mismatched-vocabulary run (e.g. `--dir` pointed at the wrong corpus, or a
 * broken `topics.yml`) would otherwise silently look identical to a normal
 * run in the report; this makes it visible instead. Additive to the report
 * schema — see EvalReport below and README.md "Golden-set eval".
 */
function vocabularySourceLabel(dir: string): string {
  const { vocabulary, error } = loadVocabularyResult(dir);
  if (vocabulary.source === "custom") {
    return `custom (${dir}/topics.yml)`;
  }
  return error
    ? `built-in default (topics.yml at ${dir} is invalid: ${error})`
    : "built-in default";
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
  /**
   * Which topic vocabulary the Topic Gate used for this run: `"built-in
   * default"` or `"custom (<dir>/topics.yml)"` (see `vocabularySourceLabel`
   * above). Additive field, see README.md "Golden-set eval".
   */
  vocabularySource: string;
  /**
   * Ids referenced in the golden file's `expect:` arrays that don't match
   * any memory id loaded from `dir`. A likely cause is a stale/renamed
   * memory id in the golden set; scoring is UNCHANGED by this list (see
   * scorePrompt/aggregateMetrics above) — it's a warning surface only, so
   * a phantom id silently deflating recall doesn't also silently escape
   * notice. Empty when every expect id resolves.
   */
  unknownExpectIds: string[];
  perPrompt: PromptMetric[];
  aggregate: AggregateMetrics;
}

/**
 * Ids referenced in any golden prompt's `expect:` array that aren't among
 * the loaded corpus's memory ids. Deduped (a phantom id repeated across
 * several prompts is reported once). Pure and independent of scoring.
 */
function findUnknownExpectIds(
  prompts: { expect: string[] }[],
  memories: Memory[],
): string[] {
  const corpusIds = new Set(memories.map((m) => m.id));
  const unknown = new Set<string>();
  for (const entry of prompts) {
    for (const id of entry.expect) {
      if (!corpusIds.has(id)) unknown.add(id);
    }
  }
  return [...unknown];
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
  const vocabularySource = vocabularySourceLabel(dir);
  const unknownExpectIds = findUnknownExpectIds(golden.prompts, memories);

  const perPrompt: PromptMetric[] = [];
  for (const entry of golden.prompts) {
    // cwd is deliberately omitted: no gate consulted by promptToHits (topic,
    // tool, confidence) reads ctx.cwd today, so there is nothing here to
    // populate it from — a golden.yml prompt has no associated cwd.
    // memoryDir IS populated (mirrors the hook, which points at THIS
    // corpus): the Topic Gate needs it to load the right topics.yml, and
    // leaving it unset would fall through to whatever $MEMORY_ROUTER_DIR
    // happens to be in the eval process's own environment instead of the
    // `dir` this eval run was actually pointed at (see gates/topic.ts).
    const ctx: RouterContext = { prompt: entry.prompt, memoryDir: dir };
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
    vocabularySource,
    unknownExpectIds,
    perPrompt,
    aggregate: aggregateMetrics(perPrompt),
  };
}

module.exports = {
  promptToHits,
  semanticPathAvailable,
  vocabularySourceLabel,
  scorePrompt,
  aggregateMetrics,
  findUnknownExpectIds,
  runGoldenEval,
};
