const { resolveProviderConfig } = require('../embed/provider');

const VAGUE_VERB_RE =
  /\b(check|schau|look|see|mal|irgendwie|kannst\s+du|can\s+you|überprüf)/i;
const IMPERATIVE_VERB_RE =
  /\b(fix|add|remove|rename|refactor|update|delete|implement|write|create|bump|upgrade|migrate|extract|inline|move)\b/i;
const SPECIFIC_NOUN_RE =
  /\b(function|class|method|file|test|spec|module|config|component|route|endpoint|schema|migration|commit|branch|PR|hook|gate)\b/i;
const PATH_RE = /(?:[\w.-]+\/[\w./-]+|\b[\w-]+\.[a-z]{1,5}\b)/;

// Returns a [0, 1] score where 0 means "prompt is clear and actionable" and
// 1 means "too vague to dispatch without pulling extra context". Only proxy
// signals — no LLM self-report, no model call. Keep this function free of
// side effects; the confidence gate's threshold derives directly from it.
function computeAmbiguity(prompt: string): number {
  const trimmed = prompt.trim();
  if (!trimmed) return 1;

  const words = trimmed.split(/\s+/).filter(Boolean).length;
  let score = 0.5;
  if (PATH_RE.test(trimmed)) score -= 0.2;
  if (SPECIFIC_NOUN_RE.test(trimmed)) score -= 0.2;
  if (IMPERATIVE_VERB_RE.test(trimmed)) score -= 0.1;
  if (VAGUE_VERB_RE.test(trimmed)) score += 0.3;
  if (words < 5) score += 0.2;
  return Math.max(0, Math.min(1, score));
}

function confidenceThreshold(ambiguity: number): number {
  return Math.max(0, 0.85 - ambiguity * 0.35);
}

// --- Score-blend weights (mm-v1-T004) --------------------------------------
//
// resolveBlended() (src/router.ts) combines a semantic score (the dominant
// signal, a raw cosine similarity typically in [0.3, 0.9] for a real match),
// a Topic Gate boost, and small recency/type modifiers into one score per
// memory. The weights below are the DEFAULTS for that blend. topicBoost and
// candidateK were CALIBRATED in mm-v1-T008 against the reference corpus
// (289 memories, 16-positive/4-negative golden set, Ollama bge-m3): a small
// topicBoost lets the semantic signal dominate the ranking (MRR 0.648 ->
// 0.710 vs the pre-calibration 0.15), and a candidate pool of 5 stops
// weak semantic candidates from flooding the final cap (P 0.238 -> 0.288,
// R 0.453 -> 0.547). See README "Calibration" for the full measurement
// table. minSemanticScore's un-overridden default is model/provider
// CONDITIONAL (see resolveDefaultMinSemanticScore below), not a single
// flat number: raw cosine ranges are provider- and model-specific (bge-m3
// relevance sits ~0.75-0.85 where OpenAI embeddings score far lower), and
// mm-v1-T008's flat 0.5 default left Ollama paths effectively unfiltered
// (measured 0/4 negative controls on the bge-m3 reference corpus with no
// override). MEMORY_ROUTER_BLEND_MIN_SEMANTIC still overrides the resolved
// default on every path when explicitly set (0.78 is bge-m3's measured
// value on the reference corpus, also the default now applied
// automatically — see resolveDefaultMinSemanticScore). Shape after
// calibration: topicBoost is a nudge, not a standalone signal (the old
// gates/topic.ts flat 1.0 score is exactly the bug this replaces) — but at
// 0.05 it is now ON PAR with the recency tie-breaker (0.05) and BELOW the
// combined max tie-breaker contribution (0.05 recency + 0.03 type), so at
// equal semantic score a topic match can be outranked by a fresh
// feedback-type memory. That relation is a measured outcome, not an
// accident: the golden set rewarded semantic dominance. recency/type kept
// their values; their golden-set insensitivity was re-confirmed AT the
// calibrated boost (recencyWeight swept 0.01-0.15 and typeWeight 0.09:
// metrics identical; typeWeight 0.001 moved MRR by +0.014 = a single tie
// flip on n=16, treated as noise). Every weight stays overridable via the
// MEMORY_ROUTER_BLEND_* env namespace.
interface BlendWeights {
  /** Additive score when the Topic Gate matches, on top of any semantic score. */
  topicBoost: number;
  /** Max additive contribution from recency (at age 0; decays toward 0). */
  recencyWeight: number;
  /** Days for the recency contribution to halve. */
  recencyHalfLifeDays: number;
  /** Max additive contribution from a memory's `type`, see TYPE_MODIFIER_UNITS. */
  typeWeight: number;
  /**
   * Relevance floor (mm-v1-T004 fix-round 2, HIGH): a semantic-search hit
   * scoring below this is dropped BEFORE it can enter the blend at all (see
   * resolveBlended in src/router.ts) — treated exactly like "the semantic
   * path found nothing for this memory", not like a weak-but-real signal.
   * The un-overridden default is now model/provider CONDITIONAL (see
   * resolveDefaultMinSemanticScore below): raw cosine ranges are
   * provider/model-specific, so a single flat number (the old 0.5,
   * inherited from confidenceThreshold(ambiguity=1) — the most ambiguous
   * prompt's old bar) left Ollama paths effectively unfiltered (measured
   * 0/4 negative controls on the bge-m3 reference corpus). An explicit
   * MEMORY_ROUTER_BLEND_MIN_SEMANTIC always wins over the conditional
   * default on every path, see README "Calibration".
   */
  minSemanticScore: number;
  /**
   * Where minSemanticScore's value came from (agent-tasks d33f968c, review
   * residual of mm-v1-T008/PR #97): 'env' when an explicit, valid
   * MEMORY_ROUTER_BLEND_MIN_SEMANTIC override was present, 'map' when it
   * resolved through a specifically-calibrated OLLAMA_MODEL_FLOOR_DEFAULTS
   * entry (today only bge-m3), 'fallback' otherwise — the un-calibrated
   * PROVIDER_FLOOR_DEFAULTS.ollama/openai value, which every OTHER Ollama
   * model (all-minilm, mxbai-embed-large, nomic-embed-text, ...) resolves
   * through today. Consumed by resolveBlended (src/router.ts) to decide
   * whether a "every semantic candidate fell below the floor" run is
   * something the operator already chose (map/env — stay silent) or a
   * gap they likely don't know about (fallback — warn once).
   */
  minSemanticScoreSource: 'env' | 'map' | 'fallback';
  /**
   * The resolved embedding model name (untrimmed/untagged, as returned by
   * resolveProviderConfig) minSemanticScoreSource was resolved against, or
   * null when no provider config was resolvable at all (misconfigured
   * explicit openai with no API key — the semantic path is dead on that
   * path regardless, see resolveDefaultMinSemanticScoreDetail below). Only
   * used to name the model in resolveBlended's stderr hint; never affects
   * scoring.
   */
  minSemanticScoreModel: string | null;
  /**
   * How many raw semantic-search candidates resolveBlended asks for before
   * capping the final result at maxHits (see semanticK in src/router.ts,
   * which takes Math.max(maxHits, this) — never narrower than the final
   * cap). The calibrated default (5, mm-v1-T008) deliberately sets the
   * candidate pool EQUAL to the default cap: on the golden set, a wider
   * pool only let weak semantic candidates flood the final cap (P 0.238 ->
   * 0.288, R 0.453 -> 0.547 going 10 -> 5 at floor 0.77). Consequence: a
   * memory outside the raw semantic top-maxHits can no longer be lifted
   * into the result by topic/recency/type at defaults — a pool wider than
   * the cap is now opt-in via MEMORY_ROUTER_BLEND_CANDIDATE_K.
   */
  candidateK: number;
}

// --- Model-conditional relevance floor default ------------------------------
//
// minSemanticScore's un-overridden default depends on which embedding
// provider/model actually serves the corpus, not a single flat number
// (operator decision, see README "Calibration"). Resolution order, applied
// by resolveDefaultMinSemanticScore below and consumed as loadBlendWeights'
// envFloat fallback:
//   1. MEMORY_ROUTER_BLEND_MIN_SEMANTIC set to any valid, non-negative
//      value ALWAYS wins on every path — envFloat only reaches this
//      resolver as its fallback, once the env var is confirmed absent or
//      invalid.
//   2. provider === 'openai' (or no resolvable provider at all, e.g. an
//      explicit `MEMORY_ROUTER_EMBED_PROVIDER=openai` with no
//      OPENAI_API_KEY — a misconfiguration where the semantic path stays
//      dead regardless, see resolveProviderConfig): 0.5,
//      PROVIDER_FLOOR_DEFAULTS.openai, unchanged from the pre-existing
//      flat default.
//   3. provider === 'ollama': the model, normalized (see
//      normalizeOllamaModelName below), looked up in
//      OLLAMA_MODEL_FLOOR_DEFAULTS; a model with no specific entry
//      (including the Ollama default, nomic-embed-text) falls back to
//      PROVIDER_FLOOR_DEFAULTS.ollama.
//
// OLLAMA_MODEL_FLOOR_DEFAULTS and PROVIDER_FLOOR_DEFAULTS.ollama carry the
// same numeric value (0.78) today, but are deliberately kept as two
// separate slots rather than one flat "ollama default": bge-m3 is the only
// model mm-v1-T008 specifically calibrated (separates relevance from junk
// at ~0.77-0.79 on the reference corpus); every OTHER Ollama model,
// including nomic-embed-text, uses the provider-level fallback instead — a
// deliberately conservative choice, not a specific calibration.
// nomic-embed-text in particular was measured to NOT cleanly separate
// relevance from German junk prompts at ANY floor (cosine scores cluster
// 0.80-0.85 regardless of relevance; see calibration-results.md), so 0.78
// there is a floor that helps some but is known not to fully solve that
// model's problem. Keeping the two constants apart means a future
// model-specific calibration only touches OLLAMA_MODEL_FLOOR_DEFAULTS,
// without changing this resolution shape.
//
// Declared ABOVE BLEND_DEFAULTS (unlike the original mm-v1-T004 file order)
// so PROVIDER_FLOOR_DEFAULTS.openai below is already initialized where
// BLEND_DEFAULTS.minSemanticScore references it.
const OLLAMA_MODEL_FLOOR_DEFAULTS: Record<string, number> = {
  'bge-m3': 0.78,
};

const PROVIDER_FLOOR_DEFAULTS = {
  openai: 0.5,
  ollama: 0.78,
} as const;

const BLEND_DEFAULTS: BlendWeights = {
  topicBoost: 0.05,
  recencyWeight: 0.05,
  recencyHalfLifeDays: 30,
  typeWeight: 0.03,
  // A reference to PROVIDER_FLOOR_DEFAULTS.openai, not a duplicated literal
  // 0.5 — the two constants can no longer drift apart. This field is
  // itself unreachable as an actual default: loadBlendWeights' envFloat
  // fallback always calls resolveDefaultMinSemanticScore() instead of
  // reading this struct, and every branch of that resolver (openai,
  // ollama with or without a per-model entry) already returns its own
  // PROVIDER_FLOOR_/OLLAMA_MODEL_FLOOR_DEFAULTS value directly — see
  // resolveDefaultMinSemanticScore below. Kept here only because
  // BlendWeights requires every field to have a value.
  minSemanticScore: PROVIDER_FLOOR_DEFAULTS.openai,
  // Same "unreachable, only here because BlendWeights requires every field"
  // note applies to these two: loadBlendWeights always computes its own
  // source/model via resolveDefaultMinSemanticScoreDetail (agent-tasks
  // d33f968c), never reads this struct's placeholders.
  minSemanticScoreSource: 'fallback',
  minSemanticScoreModel: null,
  candidateK: 5,
};

// Ollama model identifiers can carry a `:tag` suffix (`bge-m3:latest`,
// `bge-m3:567m`, an explicit quantization tag, etc — see `ollama list`)
// that all name the same model family for calibration purposes; the floor
// map above is keyed on the bare family name (everything before the first
// `:`). README's own reproduction command
// (`MEMORY_ROUTER_OLLAMA_EMBED_MODEL=bge-m3`) sets the untagged form,
// which is also what the reference corpus's index provenance stores
// (`meta.embed_model = 'bge-m3'`, verified against the live index) — but
// an operator who instead pins an explicit tag must still match the same
// calibrated floor, not silently fall through to the generic provider
// fallback (today numerically identical, but see the comment above). This
// normalization is exact-string on the family name only, not a fuzzy or
// semantic match: a pinned tag whose normalized family matches an entry
// here still has to satisfy the index's own provenance check first
// (mm-v1-T003, unmodified: `meta.embed_model` compared to the resolved
// model string exactly). Pin a tag that does not match the index's
// provenance and the provenance check rejects the query BEFORE this floor
// ever gets a chance to apply — 0 hits plus a mismatch warning, not a
// floor-filtered result.
// Case-insensitive and trimmed defensively (env-var provenance).
function normalizeOllamaModelName(model: string): string {
  return model.trim().toLowerCase().split(':')[0];
}

// Pure, synchronous, side-effect-free, mirroring loadBlendWeights' own
// contract below: only reads process.env via resolveProviderConfig, never
// performs I/O or a reachability probe. autoDetectOllama: true mirrors
// src/embed/indexer.ts's own resolveProviderConfig call (the real
// semanticSearch path), so the floor default tracks the SAME provider/
// model resolution the actual embedding call would use for this prompt,
// not a stricter or looser one.
//
// Returns provenance (source/model) alongside the numeric value (agent-tasks
// d33f968c): resolveBlended (src/router.ts) needs to tell "this floor is a
// specifically-calibrated map entry (bge-m3)" apart from "this floor is the
// generic, un-calibrated provider fallback every OTHER model falls through
// to" to decide whether an all-candidates-dropped run is worth a stderr
// hint. resolveDefaultMinSemanticScore below stays the pre-existing
// number-only shape for its own (many) pinned callers.
function resolveDefaultMinSemanticScoreDetail(): {
  value: number;
  source: 'map' | 'fallback';
  model: string | null;
} {
  const cfg = resolveProviderConfig({ autoDetectOllama: true });
  if (!cfg || cfg.provider === 'openai') {
    return { value: PROVIDER_FLOOR_DEFAULTS.openai, source: 'fallback', model: cfg?.model ?? null };
  }
  const normalized = normalizeOllamaModelName(cfg.model);
  // hasOwnProperty guard, not a plain OLLAMA_MODEL_FLOOR_DEFAULTS[normalized]
  // bracket lookup + ?? fallback: a bracket lookup walks the prototype
  // chain, so a model name of '__proto__' or 'constructor' (env-var
  // provenance, so attacker- or misconfiguration-controlled) would resolve
  // through Object.prototype's own properties instead of correctly falling
  // through to PROVIDER_FLOOR_DEFAULTS.ollama.
  return Object.prototype.hasOwnProperty.call(OLLAMA_MODEL_FLOOR_DEFAULTS, normalized)
    ? { value: OLLAMA_MODEL_FLOOR_DEFAULTS[normalized], source: 'map', model: cfg.model }
    : { value: PROVIDER_FLOOR_DEFAULTS.ollama, source: 'fallback', model: cfg.model };
}

function resolveDefaultMinSemanticScore(): number {
  return resolveDefaultMinSemanticScoreDetail().value;
}

// A negative override is invalid for every weight in this module (a
// "boost"/"weight"/"floor"/candidate count that goes negative would invert
// or break the blend's intended shape, not merely rescale it): fall back to
// the built-in default rather than accept it. This generalizes the
// non-positive guard recencyModifier already applies to
// weights.recencyHalfLifeDays specifically (division-by-zero/inverted-decay
// concern there) to every MEMORY_ROUTER_BLEND_* env override.
//
// envFloat delegates to envFloatResolved (agent-tasks d33f968c) so
// loadBlendWeights' minSemanticScoreSource can tell "the raw override
// string was present AND valid" apart from "absent/invalid, fell back"
// without re-deriving that validity check a second time (single source of
// truth — a callsite duplicating envFloat's own validation logic could
// silently drift from it).
function envFloatResolved(
  name: string,
  fallback: number,
): { value: number; usedOverride: boolean } {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return { value: fallback, usedOverride: false };
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return { value: parsed, usedOverride: true };
  return { value: fallback, usedOverride: false };
}

function envFloat(name: string, fallback: number): number {
  return envFloatResolved(name, fallback).value;
}

// Read fresh on every call (not memoized): a test-suite process that flips
// MEMORY_ROUTER_BLEND_* between assertions must see the change immediately,
// and this is cheap (four env reads plus one sync, no-I/O provider
// resolution) on the hot path.
function loadBlendWeights(): BlendWeights {
  const minSemanticDefault = resolveDefaultMinSemanticScoreDetail();
  // Fallback (used only when MEMORY_ROUTER_BLEND_MIN_SEMANTIC is unset or
  // invalid) is now the model/provider-conditional default, not a flat
  // constant — see resolveDefaultMinSemanticScoreDetail above.
  const minSemantic = envFloatResolved(
    'MEMORY_ROUTER_BLEND_MIN_SEMANTIC',
    minSemanticDefault.value,
  );
  return {
    topicBoost: envFloat('MEMORY_ROUTER_BLEND_TOPIC_BOOST', BLEND_DEFAULTS.topicBoost),
    recencyWeight: envFloat(
      'MEMORY_ROUTER_BLEND_RECENCY_WEIGHT',
      BLEND_DEFAULTS.recencyWeight,
    ),
    recencyHalfLifeDays: envFloat(
      'MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS',
      BLEND_DEFAULTS.recencyHalfLifeDays,
    ),
    typeWeight: envFloat('MEMORY_ROUTER_BLEND_TYPE_WEIGHT', BLEND_DEFAULTS.typeWeight),
    minSemanticScore: minSemantic.value,
    minSemanticScoreSource: minSemantic.usedOverride ? 'env' : minSemanticDefault.source,
    minSemanticScoreModel: minSemanticDefault.model,
    candidateK: envFloat('MEMORY_ROUTER_BLEND_CANDIDATE_K', BLEND_DEFAULTS.candidateK),
  };
}

// Relative per-type units, unitless, scaled by weights.typeWeight below.
// Left as shaped after mm-v1-T008 (typeWeight sweeps showed no golden-set
// effect beyond single-tie noise, see BLEND_DEFAULTS above): `feedback`
// memories (corrective "always/never" rules) are the most consistently
// actionable type in the corpus today, so they get the largest nudge;
// `project`/`reference` trail behind; `user` gets none. A type missing from
// this table (should not happen — MemoryType is a closed union) falls back
// to 0 rather than throwing.
const TYPE_MODIFIER_UNITS: Record<MemoryType, number> = {
  feedback: 1,
  project: 0.5,
  reference: 0.25,
  user: 0,
};

function typeModifier(type: MemoryType, weights: BlendWeights): number {
  return (TYPE_MODIFIER_UNITS[type] ?? 0) * weights.typeWeight;
}

// Exponential decay on file mtime: 1.0x weights.recencyWeight at age 0,
// halving every `recencyHalfLifeDays`. A non-positive/invalid half-life
// (e.g. a bad env override) falls back to the built-in default rather than
// dividing by zero or inverting the decay direction.
function recencyModifier(
  mtimeMs: number,
  weights: BlendWeights,
  now: number = Date.now(),
): number {
  const ageDays = Math.max(0, (now - mtimeMs) / 86_400_000);
  const halfLifeDays =
    weights.recencyHalfLifeDays > 0
      ? weights.recencyHalfLifeDays
      : BLEND_DEFAULTS.recencyHalfLifeDays;
  const decay = Math.pow(0.5, ageDays / halfLifeDays);
  return decay * weights.recencyWeight;
}

module.exports = {
  computeAmbiguity,
  confidenceThreshold,
  loadBlendWeights,
  typeModifier,
  recencyModifier,
  resolveDefaultMinSemanticScore,
  resolveDefaultMinSemanticScoreDetail,
  normalizeOllamaModelName,
  OLLAMA_MODEL_FLOOR_DEFAULTS,
};
