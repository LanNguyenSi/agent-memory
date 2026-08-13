// Golden-set eval runner: measures the router's current recall/precision
// against a labelled prompt set. This is a REPORT, not a gate — v1
// deliberately has no threshold/exit-code contract on the metrics
// themselves (see runEval in cli.ts: exit 0 on any error-free run).
//
// Purpose: capture a baseline of the resolver's recall/precision so a
// retrieval change is measurable against that baseline instead of vibes.
// mm-v1-T004 (score-blend resolver) is one such change: the pre-blend
// baseline was captured before promptToHits below was retargeted at
// resolveBlended.
const { existsSync } = require("node:fs");
const { loadMemoriesFromDir } = require("../memory/loader");
const { resolveBlended } = require("../router");
const { indexPath } = require("../embed/indexer");
const { resolveProviderConfig } = require("../embed/provider");
const { loadGoldenFile } = require("./golden");
const { loadVocabularyResult } = require("../vocab/loader");

/**
 * Test seam for promptToHits: lets tests substitute the router's single
 * exchange point and pin its exact call shape (see
 * tests/eval-runner.test.ts) without touching the real router/embedding
 * stack. Default is the real resolveBlended required above; production
 * callers (cli.ts's `eval` verb) never pass this.
 */
interface PromptToHitsDeps {
  resolveBlended: (
    ctx: RouterContext,
    memories: Memory[],
    dir: string,
  ) => Promise<GateHit[]>;
}

/**
 * Single source of truth for "which memories does this prompt select
 * today". mm-v1-T004: mirrors src/hooks/user-prompt-submit.ts EXACTLY —
 * one call to resolveBlended(ctx, memories, dir), no opts object (so the
 * router's own default maxHits, 5, applies exactly as the hook's call
 * does), wrapped in the same defensive try/catch the hook has around its
 * own resolveBlended call. resolveBlended already degrades internally on a
 * semantic-search failure (returns topic/recency/type-only scoring rather
 * than throwing — see src/router.ts); this catch is the same
 * defense-in-depth layer the hook keeps, not the only thing standing
 * between a flaky embeddings endpoint and a crashed eval run: an
 * unexpected failure here degrades to `[]` for that one prompt rather than
 * aborting the whole golden-set run.
 *
 * Keeping this selection logic in one small function (rather than
 * duplicating the hook's call inline per-prompt in the runner loop) is
 * deliberate: this one function is the sole "exchange point" a future
 * retrieval change swaps, and the rest of the eval runner is untouched.
 *
 * `ctx.memoryDir` is expected to already be populated by the caller (see
 * `runGoldenEval` below) — this function itself does not set it, only
 * passes `ctx` through to `deps.resolveBlended`. Mirrors the hook, which
 * now also threads `ctx.memoryDir` explicitly rather than relying on
 * `$MEMORY_ROUTER_DIR` (see src/hooks/user-prompt-submit.ts).
 */
async function promptToHits(
  ctx: RouterContext,
  memories: Memory[],
  dir: string,
  deps: PromptToHitsDeps = { resolveBlended },
): Promise<GateHit[]> {
  try {
    return await deps.resolveBlended(ctx, memories, dir);
  } catch {
    return [];
  }
}

/**
 * Whether the confidence gate CAN contribute a hit for this corpus today:
 * an embedding index file must exist on disk AND a provider must resolve
 * (OPENAI_API_KEY, an explicit MEMORY_ROUTER_EMBED_PROVIDER, or an
 * auto-detected local Ollama daemon, see src/embed/provider.ts). Computed
 * independently of any single prompt's outcome so the report states this
 * up front instead of letting "semantic gate silently returned []"
 * masquerade as "semantic path was measured and scored zero".
 *
 * `{ autoDetectOllama: true }` mirrors indexer.ts's rebuildIndex/
 * semanticSearch exactly (see provider.ts's ResolveProviderConfigOptions
 * doc): without it, a machine with no OPENAI_API_KEY but a usable local
 * Ollama daemon would report "semantic path: inactive" even though the
 * hook's own confidence gate resolves a provider and runs there today.
 *
 * This is a CONFIGURATION check, not a reachability probe: it proves an
 * index exists and a provider resolved, not that the provider actually
 * answers. A configured-but-unreachable Ollama daemon (or one missing the
 * configured model) still reports as available here; the failure only
 * surfaces at the first real embed call, same as an unreachable OpenAI
 * endpoint already does today.
 */
function semanticPathAvailable(dir: string): boolean {
  return (
    existsSync(indexPath(dir)) &&
    resolveProviderConfig({ autoDetectOllama: true }) !== null
  );
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
