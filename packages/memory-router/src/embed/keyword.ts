// Keyword path for memory-router (index schema v4, src/embed/index-store.ts).
//
// Why: the dense embedding ranks rare EXACT tokens poorly - task ids like
// `4e7729ab`, build tags like `b11905`, identifiers like `MTPLX` or
// `studio-tb` carry almost no mass in a 1024-dim cosine space, so a prompt
// that literally names the memory's id misses it. An FTS5 keyword index over
// the same chunks recovers exactly those hits, but a raw keyword match is
// far too weak a signal on its own (the reference corpus measured negative
// controls like "Erkläre geologische Strata" carrying tokens as rare as the
// positives' ids), so admission is gated on token SHAPE plus either
// rarity-plus-corroboration, never on a bare match.
//
// This module is pure (no I/O): tokenizing/sanitizing, the shape rule, the
// env-backed config, and the admission predicate. The FTS queries themselves
// live in the store (src/embed/index-store.ts) and are wired into retrieval
// by src/embed/indexer.ts (blendedSearch) + src/router.ts (resolveBlended).

const { envFloat } = require('../gates/confidence');

// A term qualifies only when at most this many MEMORIES (distinct ids, not
// chunk rows) contain it. Rarity alone never ADMITS anything (see the
// header comment); it only bounds which terms the shape/corroboration
// questions are even asked about, and keeps a corpus-common word like
// "memory" from turning the keyword path into a second topic gate.
const KEYWORD_MAX_DF = 12;

// At most this many keyword-only admissions per prompt (best bm25 first),
// so the keyword path can nudge recall but never reshape the whole result.
const KEYWORD_MAX_HITS = 2;

// A plain-word admission requires the memory's actual query cosine to reach
// this (env MEMORY_ROUTER_KEYWORD_CORROBORATION). Deliberately BELOW the
// calibrated semantic floor (0.78 for bge-m3): it corroborates "this memory
// is at least in the right neighborhood" for memories the floor dropped or
// that never entered the semantic top-k at all.
const KEYWORD_CORROBORATION_DEFAULT = 0.7;

// Additive boost for a semantic hit ABOVE the floor that also matches a
// strong qualifying term (env MEMORY_ROUTER_KEYWORD_BOOST): the exact-token
// evidence breaks ties between two genuine semantic matches.
const KEYWORD_BOOST_DEFAULT = 0.02;

// A keyword-only admission scores as if it had cleared the relevance floor
// by this hair: minSemanticScore + KEYWORD_ADMISSION_OFFSET, so it ranks
// just under any real semantic match and above the degraded topic path.
const KEYWORD_ADMISSION_OFFSET = 0.01;

// Small fixed German + English stopword list: the grammatical glue that
// would otherwise qualify with df 0 (nothing matches it) or, worse, match a
// dozen memories as a "rare" plain word. Deliberately small and closed -
// the gate's precision does not depend on this list being complete.
const STOPWORDS = new Set<string>([
  // German
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem',
  'einen', 'und', 'oder', 'aber', 'denn', 'sondern', 'als', 'wenn', 'weil',
  'dass', 'ist', 'sind', 'war', 'waren', 'sei', 'sein', 'seine', 'ihr',
  'ihre', 'mit', 'für', 'fur', 'auf', 'von', 'an', 'aus', 'bei', 'zu',
  'zum', 'zur', 'über', 'uber', 'unter', 'vor', 'nach', 'im', 'ins', 'am',
  'um', 'nicht', 'nichts', 'man', 'ich', 'du', 'er', 'es', 'sie', 'wir',
  'mir', 'dir', 'mich', 'dich', 'sich', 'kann', 'können', 'koennen', 'muss',
  'wie', 'was', 'wer', 'wo', 'wann', 'warum', 'alle', 'bitte', 'mal',
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'this',
  'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'with', 'for', 'on', 'of', 'to', 'in', 'it', 'its', 'at', 'by',
  'from', 'as', 'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could',
  'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'not', 'no',
  'yes', 'please', 'just', 'like', 'get', 'got', 'make', 'made', 'use',
  'used', 'using', 'all', 'any', 'some', 'there', 'here', 'they', 'them',
  'their', 'we', 'you', 'your', 'our', 'he', 'she', 'his', 'her', 'i',
]);

interface KeywordConfig {
  /** MEMORY_ROUTER_KEYWORD=off disables the whole path. */
  enabled: boolean;
  corroborationFloor: number;
  keywordBoost: number;
}

// Read fresh on every call (not memoized), mirroring loadBlendWeights: env
// flips must show up immediately, and the reads are trivial. `off` (exact,
// trimmed, case-insensitive) disables everything; any other value - valid
// or not - leaves the path enabled (an unparseable switch value must never
// silently kill retrieval).
function loadKeywordConfig(): KeywordConfig {
  const raw = process.env.MEMORY_ROUTER_KEYWORD;
  const off = raw !== undefined && raw.trim().toLowerCase() === 'off';
  return {
    enabled: !off,
    corroborationFloor: envFloat(
      'MEMORY_ROUTER_KEYWORD_CORROBORATION',
      KEYWORD_CORROBORATION_DEFAULT,
    ),
    keywordBoost: envFloat('MEMORY_ROUTER_KEYWORD_BOOST', KEYWORD_BOOST_DEFAULT),
  };
}

// One prompt term: `term` is the ORIGINAL prompt token (edge punctuation
// trimmed, never lowercased - the shape rule inspects it as typed), `phrase`
// is its sanitized FTS phrase body (lowercased alphanumeric pieces joined by
// single spaces, stopwords dropped).
interface KeywordTerm {
  term: string;
  phrase: string;
}

// Tokenizes a prompt into gated terms, dropping stopwords and terms with no
// alphanumeric content (pure punctuation, emoji). Splitting each word into
// unicode alphanumeric pieces and rejoining with spaces is what makes
// `studio-tb` become the phrase `studio tb` and `v0.7.4` become `v0 7 4`:
// the same boundaries the FTS5 unicode61 tokenizer applies to the indexed
// text, so phrases match whole tokens and nothing else. No FTS operator can
// survive: the only characters a phrase may contain are letters, digits and
// spaces; quotePhrase() wraps it in FTS5 double quotes, where even `AND`
// and `NEAR(` are ordinary string content.
function extractKeywordTerms(prompt: string): KeywordTerm[] {
  if (!prompt) return [];
  const seen = new Set<string>();
  const terms: KeywordTerm[] = [];
  for (const word of prompt.split(/\s+/)) {
    const pieces = word.match(/[\p{L}\p{N}]+/gu);
    if (!pieces || pieces.length === 0) continue;
    const kept: string[] = [];
    for (const piece of pieces) {
      const lower = piece.toLowerCase();
      if (STOPWORDS.has(lower)) continue;
      kept.push(lower);
    }
    if (kept.length === 0) continue;
    const phrase = kept.join(' ');
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    // The shape rule's token: the original word with edge punctuation
    // stripped (`"MTPLX"` and `(4e7729ab)` still read as the tokens they
    // are), never lowercased.
    const original = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    terms.push({ term: original, phrase });
  }
  return terms;
}

// The shape rule (checked on the ORIGINAL token, before lowercasing):
// an identifier, not a word of any language. `Bonsai-Baum` HAS an inner
// `-` and is therefore strong by this rule - documented and pinned by test;
// what keeps the "Bonsai-Baum" negative control quiet is that the phrase
// query `"bonsai baum"` only matches ADJACENT words, so on a corpus where
// no memory spells the compound out it matches nothing at all.
function isStrongTerm(term: string): boolean {
  if (!term) return false;
  if (/[\p{N}]/u.test(term)) return true; // contains a digit
  if (/[a-z][A-Z]/.test(term)) return true; // lower→upper inside the word
  if (/(?<=[\p{L}\p{N}])[-_.](?=[\p{L}\p{N}])/u.test(term)) return true; // inner - _ .
  if (/^[A-Z]{3,}$/.test(term)) return true; // ALL CAPS, 3+ letters
  return false;
}

// One gated term phrase as an FTS5 MATCH string: a double-quoted string
// literal, which FTS5 parses as a single phrase of exact tokens. Phrase
// bodies never contain a double quote (extractKeywordTerms only emits
// letters, digits and spaces), so the literal cannot be broken out of.
function quotePhrase(phrase: string): string {
  return `"${phrase}"`;
}

// One keyword candidate for a prompt: everything a matched memory collected
// across ALL qualifying terms, plus its best query cosine (null when the
// memory has no comparable vector at all, e.g. a stale-model index - treat
// it as "fails corroboration").
interface KeywordCandidate {
  id: string;
  strongTerms: string[];
  matchedTerms: string[]; // strong + plain qualifying terms, deduped
  bm25: number; // best (lowest) bm25 across the matched rows
  cosine: number | null;
}

// The admission predicate for a memory with NO semantic hit above the
// floor: a strong qualifying match admits it outright; a plain-word match
// needs corroboration - a query cosine at/above the floor, or at least TWO
// qualifying terms of this prompt matching the same memory.
function admitsKeywordCandidate(
  candidate: KeywordCandidate,
  corroborationFloor: number,
): boolean {
  if (candidate.strongTerms.length > 0) return true;
  if (candidate.matchedTerms.length >= 2) return true;
  return (
    candidate.cosine !== null && candidate.cosine >= corroborationFloor
  );
}

// The distinguishable reason an admitted/boosted hit carries, e.g.
// `keyword match (strong: 4e7729ab)` - what makes keyword-attributed hits
// countable in the eval report (gate 'keyword' + this reason prefix).
function keywordReason(candidate: {
  strongTerms: string[];
  matchedTerms: string[];
}): string {
  return candidate.strongTerms.length > 0
    ? `keyword match (strong: ${candidate.strongTerms.join(', ')})`
    : `keyword match (corroborated: ${candidate.matchedTerms.join(', ')})`;
}

module.exports = {
  KEYWORD_MAX_DF,
  KEYWORD_MAX_HITS,
  KEYWORD_CORROBORATION_DEFAULT,
  KEYWORD_BOOST_DEFAULT,
  KEYWORD_ADMISSION_OFFSET,
  STOPWORDS,
  loadKeywordConfig,
  extractKeywordTerms,
  isStrongTerm,
  quotePhrase,
  admitsKeywordCandidate,
  keywordReason,
};
