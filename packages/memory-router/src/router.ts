const { statSync } = require('node:fs');
const { toolGate } = require('./gates/tool');
const { topicGate } = require('./gates/topic');
const {
  computeAmbiguity,
  confidenceThreshold,
  loadBlendWeights,
  typeModifier,
  recencyModifier,
} = require('./gates/confidence');
// semanticSearch: the pure-semantic entry point, still used by
// resolveConfidence below. blendedSearch: resolveBlended's default entry
// point (one store open + one query embedding shared by the semantic KNN
// and the schema v4 keyword pass, see src/embed/indexer.ts).
const { semanticSearch, blendedSearch } = require('./embed/indexer');
const {
  loadKeywordConfig,
  keywordReason,
  KEYWORD_MAX_HITS,
  KEYWORD_ADMISSION_OFFSET,
} = require('./embed/keyword');

// Only sync gates live in the default set. The Confidence Gate is an async
// resolver (semantic search hits the OpenAI API) so it's exposed separately
// as `resolveConfidence` — callers that can't await leave it out.
const DEFAULT_GATES: Gate[] = [topicGate, toolGate];

// Uncalibrated-floor drop hint (a review residual of PR #97): true once
// this process has emitted the stderr hint
// below. Module-level and never reset except by a fresh process — the
// real caller (the hook binary, see src/hooks/user-prompt-submit.ts) is a
// short-lived `node` process per prompt, so "once per process" already
// means "once per prompt" there; a long-lived caller (MCP server) still
// only gets it once for the life of that process, deliberately, so a
// noisy corpus can't spam stderr on every request.
let floorDropHintEmitted = false;

// Sanitizes an embedding model name (env-var provenance, so attacker- or
// misconfiguration-controlled — see the resolveDefaultMinSemanticScoreDetail
// hasOwnProperty guard in src/gates/confidence.ts for the same threat model)
// before it is interpolated into the stderr hint below: trims whitespace and
// strips C0/DEL control characters, so a stray control byte in the env var
// can't corrupt or inject into the terminal/log line. Deliberately keeps any
// `:tag` suffix (`all-minilm:latest` stays useful in the hint) — this is a
// display-safety sanitizer, not the floor lookup's own family-name
// normalization (normalizeOllamaModelName in src/gates/confidence.ts).
function sanitizeModelNameForLog(model: string | null): string {
  if (!model) return 'unknown';
  // eslint-disable-next-line no-control-regex
  const cleaned = model.trim().replace(/[\x00-\x1f\x7f]/g, '');
  return cleaned || 'unknown';
}

function resolve(
  ctx: RouterContext,
  memories: Memory[],
  opts: ResolveOptions = {},
): GateHit[] {
  const gates = opts.gates ?? DEFAULT_GATES;
  const maxHits = opts.maxHits ?? 5;

  const raw: GateHit[] = [];
  for (const gate of gates) raw.push(...gate.evaluate(ctx, memories));

  return dedupeAndRank(raw, maxHits);
}

async function resolveConfidence(
  ctx: RouterContext,
  memories: Memory[],
  memoryDir: string,
  opts: { maxHits?: number } = {},
): Promise<GateHit[]> {
  if (!ctx.prompt) return [];
  const ambiguity = computeAmbiguity(ctx.prompt);
  const threshold = confidenceThreshold(ambiguity);
  const maxHits = opts.maxHits ?? 3;

  const matches = await semanticSearch(ctx.prompt, memories, memoryDir, maxHits);
  const hits: GateHit[] = matches
    .filter((m: { score: number }) => m.score >= threshold)
    .map((m: { memory: Memory; score: number }) => ({
      memory: m.memory,
      gate: 'confidence' as const,
      score: m.score,
      reason: `semantic match (ambiguity=${ambiguity.toFixed(2)}, threshold=${threshold.toFixed(2)})`,
    }));
  return hits;
}

function dedupeAndRank(hits: GateHit[], maxHits: number): GateHit[] {
  const best = new Map<string, GateHit>();
  for (const hit of hits) {
    const prev = best.get(hit.memory.id);
    if (!prev || hit.score > prev.score) best.set(hit.memory.id, hit);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, maxHits);
}

// Test seam for resolveBlended: lets tests substitute the semantic-search
// entry point and pin its exact call shape / a controlled score set without
// touching the real embedding stack. Default is the real blendedSearch
// required above; every production caller (hook, MCP server, eval runner)
// never passes this.
//
// The seam accepts BOTH result shapes: a bare array of semantic hits (the
// pre-keyword shape every existing fake returns, treated as "no keyword
// matches") and the blendedSearch result { semantic, keyword } that carries
// the FTS keyword candidates (each an id-token match with its matched
// tokens and best bm25) alongside the semantic hits.
interface SemanticSearchHit {
  memory: Memory;
  score: number;
  // Winning chunk of the semantic score (see SemanticHit in
  // src/embed/indexer.ts); absent when the document vector won.
  chunk?: { index: number; offset: number };
}

interface KeywordSearchHit {
  memory: Memory;
  idTerms: string[];
  bm25: number;
  // Chunk holding the best-bm25 id-token match; absent from seam fakes that
  // predate chunk tracking.
  chunkIndex?: number;
}

type SearchOutcome =
  | SemanticSearchHit[]
  | { semantic: SemanticSearchHit[]; keyword: KeywordSearchHit[] };

interface ResolveBlendedDeps {
  semanticSearch: (
    prompt: string,
    memories: Memory[],
    memoryDir: string,
    k: number,
  ) => Promise<SearchOutcome>;
}

// Replaces the old "shadowed gates" resolver (sync topic/tool
// gates first, confidence gate only when they were silent — see `resolve` +
// `resolveConfidence` above, both left unchanged for their existing callers,
// see the module-level comment). That shadowing meant the Topic Gate's flat
// 1.0 score pre-empted the semantic path on almost every real prompt (three
// different prompts sharing a topic word produced an identical top-5,
// regardless of what each prompt actually meant): see the pre-blend eval
// baseline.
//
// resolveBlended() instead combines every signal into one score per memory:
//   score = semanticScore + topicBoost + typeModifier + recencyModifier
// - semanticScore: the dominant signal, a raw cosine similarity from
//   semanticSearch. Runs UNCONDITIONALLY whenever an index + provider are
//   available for `memoryDir` — semanticSearch itself no-ops (returns [],
//   no HTTP call, no throw) when either is missing, so there is no separate
//   availability probe here, and this call happens exactly once per prompt
//   (one query embedding, or a query-cache hit — see src/embed/indexer.ts).
//   A hit scoring below MEMORY_ROUTER_BLEND_MIN_SEMANTIC (default 0.5) is
//   dropped before it ever reaches this formula — treated
//   as "no semantic score" below, not as a weak one.
// - topicBoost: the (deterministic) Topic Gate's match is no longer a
//   standalone full-score hit; it can only nudge a memory's score, never
//   flood it to 1.0 and shadow everything else.
// - typeModifier / recencyModifier: small tie-breaking modifiers (memory
//   `type`, file mtime decay). See src/gates/confidence.ts for the weight
//   defaults (env-overridable; topicBoost/candidateK calibrated against the
//   reference corpus, the relevance floor stays per-corpus — see
//   src/gates/confidence.ts and README "Calibration").
// A memory with neither a semantic score nor a topic match contributes
// nothing and is excluded — the modifiers alone can never surface an
// otherwise-silent memory, only shape the ranking of one some other signal
// already selected.
//
// Degraded mode (post-hoc fix): when the semantic path
// contributes NOTHING for this prompt, whether because no index/provider is
// available (semanticSearch no-ops, see src/embed/indexer.ts), because of a
// caught semantic-search error below, or because every candidate scored
// below the relevance floor above, resolveBlended returns EXACTLY what
// resolve(ctx, memories, {maxHits}) (the old sync-only topic/tool path)
// would: the same hits, the same flat 1.0 gate scores, the same load-order
// ties. No topic boost, no recency/type modifier is applied in this case.
// An initial version of this blend applied those modifiers even when
// semantic contributed nothing; on a real corpus with more than `maxHits`
// topic candidates for one prompt, that re-ranked the degraded top-N by
// mtime/type and silently evicted the correct picks, measured against the
// real golden set (P/R/MRR regressed against the documented "identical to
// today's topic-only degradation" acceptance criterion). See the pinned
// regression test in tests/blend.test.ts.
//
// A semantic-search failure (network/API error) is caught here, not left to
// the caller: the blend still returns topic-only scoring rather than
// throwing, so hook/MCP/eval callers each keep their own outer try/catch as
// a defensive-in-depth layer, not as the only thing standing between a
// flaky embeddings endpoint and a blocked prompt.
async function resolveBlended(
  ctx: RouterContext,
  memories: Memory[],
  memoryDir: string,
  opts: ResolveOptions = {},
  deps: ResolveBlendedDeps = { semanticSearch: blendedSearch },
): Promise<GateHit[]> {
  if (!ctx.prompt) return [];
  const maxHits = opts.maxHits ?? 5;
  const weights = loadBlendWeights();

  // Candidate pool width. At the calibrated default (5) the
  // pool EQUALS the default cap: a memory outside the raw semantic
  // top-maxHits is not lifted into the result by topic/recency/type unless
  // the operator widens the pool via MEMORY_ROUTER_BLEND_CANDIDATE_K (then
  // Math.max keeps it never narrower than the cap). The wider-pool rescue
  // was measured to hurt on the golden set (weak semantic candidates
  // flooding the cap, see BLEND_DEFAULTS.candidateK in
  // src/gates/confidence.ts). Rounded defensively since an env override is
  // free-form text and the value below flows straight into a search "how
  // many rows" argument.
  const semanticK = Math.max(maxHits, Math.round(weights.candidateK));
  let semanticHits: SemanticSearchHit[] = [];
  // Keyword candidates from the SAME search session as the semantic hits
  // (id-token FTS5 matches with their best bm25, see src/embed/indexer.ts
  // blendedSearch). Stays empty when the keyword path is off, the index
  // predates the FTS table / has no FTS rows, or nothing matched - every
  // branch below is then inert.
  let keywordMatches: KeywordSearchHit[] = [];
  try {
    const outcome = await deps.semanticSearch(ctx.prompt, memories, memoryDir, semanticK);
    if (Array.isArray(outcome)) {
      // Pre-keyword seam shape: bare array of semantic hits.
      semanticHits = outcome;
    } else {
      semanticHits = outcome.semantic;
      keywordMatches = outcome.keyword;
    }
  } catch (err: unknown) {
    process.stderr.write(
      `memory-router: semantic search failed, degrading to topic/recency/type only: ${String(err)}\n`,
    );
  }

  // Relevance floor: drop any semantic hit
  // scoring below MEMORY_ROUTER_BLEND_MIN_SEMANTIC (model/provider-
  // conditional default, see resolveDefaultMinSemanticScore in
  // src/gates/confidence.ts) BEFORE the degradation guard below. A
  // sub-floor cosine match is noise, not a real signal; filtering it out
  // here (rather than letting it into the blend at a near-zero weight)
  // means a corpus/provider that only ever returns weak matches for a
  // prompt degrades to the deterministic topic-only path instead of
  // quietly blending in scores that were never a real match. A memory that
  // also has an independent topic hit is unaffected by this filter — the
  // filter only removes the SEMANTIC contribution, topic candidacy is
  // evaluated separately below.
  const semanticCandidateCount = semanticHits.length;
  semanticHits = semanticHits.filter((h) => h.score >= weights.minSemanticScore);

  // Uncalibrated-floor drop hint (a review residual of PR #97): the
  // model/provider-conditional floor above
  // (src/gates/confidence.ts) has a specifically-calibrated entry for only
  // one model (bge-m3); every OTHER un-calibrated Ollama model (all-minilm,
  // mxbai-embed-large, nomic-embed-text, ...) falls through to the generic
  // provider default instead — a value measured against bge-m3's cosine
  // band, not that model's own. A model with a systematically lower band
  // can silently lose its ENTIRE semantic path this way: every real
  // candidate this run scored below the floor, so the run degrades to the
  // topic-only path below with no indication why. Surface that once per
  // process (see floorDropHintEmitted above), stderr only — never stdout,
  // so the hook's injected-context contract (tests/floor-drop-hint.test.ts)
  // stays byte-identical — and never behind a debug flag, since an operator
  // who doesn't know they have this problem won't think to enable one.
  // Deliberately excludes: a calibrated map entry (bge-m3,
  // minSemanticScoreSource === 'map'), an operator's own explicit
  // MEMORY_ROUTER_BLEND_MIN_SEMANTIC override (source === 'env'), or
  // OpenAI's own deliberate provider default (source === 'provider',
  // split out of 'fallback' because 0.5 is
  // OpenAI's documented default and an all-below-floor run there is the
  // normal junk-rejection outcome, not a sign the operator is missing a
  // calibration) — all three are a deliberate choice or provider-native
  // behavior, not a silent gap; a run where the semantic path found nothing
  // to filter at all (semanticCandidateCount === 0, e.g. no index/provider,
  // or the caught search error above); and a run where at least one
  // candidate still passed (there is a live semantic signal, not a total
  // loss).
  if (
    !floorDropHintEmitted &&
    weights.minSemanticScoreSource === 'fallback' &&
    semanticCandidateCount > 0 &&
    semanticHits.length === 0
  ) {
    floorDropHintEmitted = true;
    process.stderr.write(
      `memory-router: uncalibrated relevance floor ${weights.minSemanticScore} for model "${sanitizeModelNameForLog(weights.minSemanticScoreModel)}" dropped all ${semanticCandidateCount} semantic candidate(s) this run; set MEMORY_ROUTER_BLEND_MIN_SEMANTIC to override, or calibrate a floor for this model, see README "Calibration" (#calibration).\n`,
    );
  }

  // --- Keyword gate (index schema v4) -----------------------------------
  // The MEMORY_ROUTER_KEYWORD=off switch is honored HERE, not only in the
  // search layer: with the path off, any keyword candidates that somehow
  // arrived are dropped on the floor and the rest of this function is
  // byte-identical to the pre-keyword resolver (no admissions, no boost,
  // the original degraded short-circuit).
  const keywordConfig = loadKeywordConfig();
  if (!keywordConfig.enabled) keywordMatches = [];
  // Admissions: memories with NO semantic hit above the floor, at most
  // KEYWORD_MAX_HITS per prompt, best bm25 first (keywordMatches arrives
  // sorted that way from the search layer). Every candidate is an id-token
  // match - the search layer queries nothing else (see isIdToken in
  // src/embed/keyword.ts) - so every one of them admits. A memory that DOES
  // have an above-floor semantic hit is not keyword-only; it takes the
  // boost path below instead.
  const semanticHitIds = new Set(semanticHits.map((h) => h.memory.id));
  const admitted: KeywordSearchHit[] = [];
  for (const candidate of keywordMatches) {
    if (admitted.length >= KEYWORD_MAX_HITS) break;
    if (semanticHitIds.has(candidate.memory.id)) continue;
    admitted.push(candidate);
  }
  const admittedById = new Map<string, KeywordSearchHit>(
    admitted.map((a) => [a.memory.id, a]),
  );

  // Semantic path contributed nothing (no index/provider, the caught error
  // above, or every candidate falling below the relevance floor):
  // degrade to EXACTLY the pre-blend sync-only resolver rather than running
  // any topic-boost/recency/type scoring, see the module comment above this
  // function for why. The one schema v4 exception: when the keyword gate
  // admitted memories despite the silent semantic path, those take the
  // FIRST slots (scored like floor-edge semantic hits with the usual topic
  // boost and modifiers, best bm25 first) and the remaining slots get
  // exactly the resolve() output today's degradation returns, deduplicated.
  // With no admissions this branch is untouched pre-keyword behavior.
  if (semanticHits.length === 0) {
    const degraded = resolve(ctx, memories, { maxHits });
    if (admitted.length === 0) return degraded;
    const degradedTopicHits: GateHit[] = topicGate.evaluate(ctx, memories);
    const degradedTopicById = new Map<string, GateHit>(
      degradedTopicHits.map((h) => [h.memory.id, h]),
    );
    const now = Date.now();
    const keywordFirst: GateHit[] = admitted.map((a) =>
      blendCandidateHit(
        a.memory,
        weights,
        weights.minSemanticScore + KEYWORD_ADMISSION_OFFSET,
        degradedTopicById.get(a.memory.id),
        'keyword',
        [keywordReason(a)],
        now,
        a.chunkIndex,
      ),
    );
    const taken = new Set(keywordFirst.map((h) => h.memory.id));
    return [...keywordFirst, ...degraded.filter((h) => !taken.has(h.memory.id))].slice(
      0,
      maxHits,
    );
  }

  const topicHits: GateHit[] = topicGate.evaluate(ctx, memories);
  const topicById = new Map<string, GateHit>(topicHits.map((h) => [h.memory.id, h]));
  const semanticById = new Map<string, number>(
    semanticHits.map((h) => [h.memory.id, h.score]),
  );
  // Best chunk per semantic hit (only those whose winning vector was a
  // chunk). Threaded onto the GateHit so the hook renderer can inject the
  // matching excerpt instead of the whole body.
  const semanticChunkById = new Map<string, number>();
  for (const h of semanticHits) {
    if (h.chunk !== undefined) semanticChunkById.set(h.memory.id, h.chunk.index);
  }

  // Tool Gate: unrelated to the prompt-semantic blend above, only relevant
  // when the caller also passed a tool call (e.g. MCP's memory_resolve).
  // Deterministic full-score hit, unchanged, so a tool-triggered resolution
  // keeps working exactly as it did before this change.
  const toolHits: GateHit[] = ctx.tool ? toolGate.evaluate(ctx, memories) : [];

  // Semantic hits ABOVE the floor that also match an id token get
  // + keywordBoost (exact-token evidence breaking the tie between two
  // genuine semantic matches).
  const idMatchById = new Map<string, KeywordSearchHit>(
    keywordMatches.map((m) => [m.memory.id, m]),
  );

  const candidateIds = new Set<string>([
    ...semanticById.keys(),
    ...topicById.keys(),
    ...admittedById.keys(),
  ]);
  const byId = new Map(memories.map((m) => [m.id, m]));
  const now = Date.now();

  const blended: GateHit[] = [];
  for (const id of candidateIds) {
    const memory = byId.get(id);
    if (!memory) continue;

    // .has(), not "score > 0": MEMORY_ROUTER_BLEND_MIN_SEMANTIC can be
    // overridden down to 0 (see the relevance-floor comment above and
    // envFloat's non-negative guard in src/gates/confidence.ts), which lets
    // a genuine zero-score semantic hit survive the floor filter. Gating
    // gate/reason attribution on "score > 0" would then mislabel that
    // candidate as a phantom topic hit (gate: 'topic', reason: '') even
    // though it has no topic match at all — it's semantic-originated (a
    // real semanticById entry), just weighted zero.
    const hasSemanticHit = semanticById.has(id);
    const keywordOnly = admittedById.get(id);
    const semanticScore = hasSemanticHit
      ? (semanticById.get(id) as number)
      : keywordOnly
        ? weights.minSemanticScore + KEYWORD_ADMISSION_OFFSET
        : 0;
    const topicHit = topicById.get(id);

    const reasonParts: string[] = [];
    if (hasSemanticHit) reasonParts.push(`semantic match (score=${semanticScore.toFixed(2)})`);
    let gate: GateHit['gate'] = hasSemanticHit ? 'confidence' : 'topic';
    let keywordBoost = 0;
    // Chunk to excerpt: the semantic winner when there is one, else the
    // chunk the id token matched in (keyword-only admission, or a semantic
    // hit whose document vector won and so names no chunk).
    let chunkIndex: number | undefined = semanticChunkById.get(id);
    if (keywordOnly) {
      // Admitted keyword-only memory: distinguishable gate + reason so the
      // eval can count it, floor-edge semantic score (see the admission
      // comment above).
      reasonParts.push(keywordReason(keywordOnly));
      gate = 'keyword';
      chunkIndex = keywordOnly.chunkIndex;
    } else if (hasSemanticHit) {
      // Only an above-floor SEMANTIC hit that also matches an id token is
      // boosted (exact-token evidence breaking the tie between two genuine
      // semantic matches). A candidate with an id match but NO semantic hit
      // is never boosted here: it was either admitted above (keywordOnly) or
      // fell past the admission cap and stays a plain topic-only hit with no
      // keyword reason and no boost.
      const idMatch = idMatchById.get(id);
      if (idMatch) {
        keywordBoost = keywordConfig.keywordBoost;
        reasonParts.push(keywordReason(idMatch));
        if (chunkIndex === undefined) chunkIndex = idMatch.chunkIndex;
      }
    }

    blended.push(
      blendCandidateHit(
        memory,
        weights,
        semanticScore + keywordBoost,
        topicHit,
        gate,
        reasonParts,
        now,
        chunkIndex,
      ),
    );
  }

  return rankWithToolPrivilege(blended, toolHits, maxHits);
}

// Structural shape of loadBlendWeights()'s return (the function itself is
// require()d, so its interface isn't name-importable from src/router.ts).
interface BlendWeightsLike {
  topicBoost: number;
  recencyWeight: number;
  recencyHalfLifeDays: number;
  typeWeight: number;
  minSemanticScore: number;
}

// One blended hit: semanticScore (already including any keyword boost) +
// topicBoost (when the Topic Gate matches) + type + recency modifiers, the
// Topic Gate reason appended last. Shared by the active-blend loop and the
// degraded-with-keyword-admissions branch so a keyword hit is blended
// EXACTLY like a semantic one, only with a substituted semantic score.
function blendCandidateHit(
  memory: Memory,
  weights: BlendWeightsLike,
  semanticScore: number,
  topicHit: GateHit | undefined,
  gate: GateHit['gate'],
  reasonParts: string[],
  now: number,
  chunkIndex?: number,
): GateHit {
  const topicBoost = topicHit ? weights.topicBoost : 0;

  // A stat failure (missing/unreadable file) must never cost a memory
  // its topic/semantic hit — treat it as "no recency signal" (age 0,
  // the modifier's max value) rather than throwing.
  let mtimeMs = now;
  try {
    mtimeMs = statSync(memory.path).mtimeMs;
  } catch {
    // fall through with mtimeMs = now
  }

  const score =
    semanticScore +
    topicBoost +
    typeModifier(memory.frontmatter.type, weights) +
    recencyModifier(mtimeMs, weights, now);

  const parts = [...reasonParts];
  if (topicHit) parts.push(topicHit.reason);

  const hit: GateHit = { memory, gate, score, reason: parts.join('; ') };
  // Only set when known, so hits without chunk information keep exactly
  // the four-field shape they always had.
  if (chunkIndex !== undefined) hit.chunkIndex = chunkIndex;
  return hit;
}

// Privileges deterministic Tool-Gate hits ahead of the maxHits cap: a
// memory ctx.tool directly matched
// (score 1.0, see gates/tool.ts) must never be evicted from the result by
// blend-scored memories whose semantic+topicBoost+modifiers sum happens to
// exceed 1.0 — plain dedupeAndRank (highest score wins the slot) would let
// that happen on any prompt with more than maxHits strong blend candidates.
// Attribution (which gate/score/reason wins for a memory present in BOTH
// `blended` and `toolHits`) is unchanged from plain dedupeAndRank: whichever
// has the higher score, same as dedupeAndRank always did. Only SLOT
// ALLOCATION changes: every deduped tool hit fills a slot first, remaining
// slots go to the highest-ranked blend hits, then the combined list is
// capped at maxHits.
function rankWithToolPrivilege(
  blended: GateHit[],
  toolHits: GateHit[],
  maxHits: number,
): GateHit[] {
  const merged = new Map<string, GateHit>();
  for (const hit of [...blended, ...toolHits]) {
    const prev = merged.get(hit.memory.id);
    if (!prev || hit.score > prev.score) merged.set(hit.memory.id, hit);
  }

  const toolIds = new Set(toolHits.map((h) => h.memory.id));
  const privileged: GateHit[] = [];
  const rest: GateHit[] = [];
  for (const hit of merged.values()) {
    (toolIds.has(hit.memory.id) ? privileged : rest).push(hit);
  }
  privileged.sort((a, b) => b.score - a.score);
  rest.sort((a, b) => b.score - a.score);

  return [...privileged, ...rest].slice(0, maxHits);
}

module.exports = {
  resolve,
  resolveConfidence,
  resolveBlended,
  dedupeAndRank,
  DEFAULT_GATES,
};
