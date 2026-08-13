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
// memory. The weights below are the DEFAULTS for that blend and are
// DELIBERATELY UNCALIBRATED: no rollout measurement has tuned them yet (see
// mm-v1-T008, "measure against the golden set, then calibrate"). They only
// encode the intended *shape*: topicBoost is one order of magnitude below a
// typical semantic score (a nudge, not a standalone signal — the old
// gates/topic.ts flat 1.0 score is exactly the bug this replaces), and
// recency/type are a further order of magnitude below that (tie-breakers
// only). Every weight is overridable via the MEMORY_ROUTER_BLEND_* env
// namespace so a corpus can retune without a code change while T008 is
// pending.
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
   * Default 0.5 is the lower edge of the old confidenceThreshold() band
   * (confidenceThreshold(ambiguity=1) === 0.5, see above): the most
   * ambiguous prompt's old bar becomes the new blend's baseline bar.
   * UNCALIBRATED pending mm-v1-T008, same caveat as every other weight in
   * this table.
   */
  minSemanticScore: number;
  /**
   * How many raw semantic-search candidates resolveBlended asks for before
   * capping the final result at maxHits (see semanticK in src/router.ts,
   * which takes Math.max(maxHits, this) — never narrower than the final
   * cap). Wider than maxHits on purpose: a memory that ranks outside the
   * raw top-maxHits can still win a slot once topic/recency/type are folded
   * in. Default 10 preserves the pre-fix-round-2 hardcoded value.
   * UNCALIBRATED pending mm-v1-T008, same caveat as every other weight in
   * this table.
   */
  candidateK: number;
}

const BLEND_DEFAULTS: BlendWeights = {
  topicBoost: 0.15,
  recencyWeight: 0.05,
  recencyHalfLifeDays: 30,
  typeWeight: 0.03,
  minSemanticScore: 0.5,
  candidateK: 10,
};

// A negative override is invalid for every weight in this module (a
// "boost"/"weight"/"floor"/candidate count that goes negative would invert
// or break the blend's intended shape, not merely rescale it): fall back to
// the built-in default rather than accept it. This generalizes the
// non-positive guard recencyModifier already applies to
// weights.recencyHalfLifeDays specifically (division-by-zero/inverted-decay
// concern there) to every MEMORY_ROUTER_BLEND_* env override.
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Read fresh on every call (not memoized): a test-suite process that flips
// MEMORY_ROUTER_BLEND_* between assertions must see the change immediately,
// and this is cheap (four env reads) on the hot path.
function loadBlendWeights(): BlendWeights {
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
    minSemanticScore: envFloat(
      'MEMORY_ROUTER_BLEND_MIN_SEMANTIC',
      BLEND_DEFAULTS.minSemanticScore,
    ),
    candidateK: envFloat('MEMORY_ROUTER_BLEND_CANDIDATE_K', BLEND_DEFAULTS.candidateK),
  };
}

// Relative per-type units, unitless, scaled by weights.typeWeight below.
// UNCALIBRATED (T008), same caveat as BLEND_DEFAULTS above: `feedback`
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
};
