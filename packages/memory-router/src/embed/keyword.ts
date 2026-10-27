// Keyword path for memory-router (index schema v4, src/embed/index-store.ts).
//
// Why: the dense embedding ranks rare EXACT identifiers poorly - task ids
// like `4e7729ab` or build tags like `b11905` carry almost no mass in a
// 1024-dim cosine space, so a prompt that literally names the memory's id
// misses it. An FTS5 keyword index over the same chunks recovers exactly
// those hits, but a raw keyword match is far too weak a signal on its own
// (the reference corpus measured negative controls like IPv6, UTF-8,
// JavaScript or WLAN carrying tokens as rare as the positives' ids, and
// unrelated memories scoring 0.69 to 0.78 cosine on bge-m3, so neither
// rarity nor cosine can separate an ordinary rare word from an id), so
// ONLY identifier-shaped tokens enter the keyword path at all: a prompt
// token is queried, counted and allowed to admit or boost only when it
// reads as an id (`isIdToken` below), never as a bare word match.
//
// This module is pure (no I/O): tokenizing/sanitizing, the id rule, the
// env-backed config, and the reason text. The FTS queries themselves live
// in the store (src/embed/index-store.ts) and are wired into retrieval by
// src/embed/indexer.ts (blendedSearch) + src/router.ts (resolveBlended).

const { envFloat } = require('../gates/confidence');

// An id term qualifies only when at most this many MEMORIES (distinct ids,
// not chunk rows) contain it. Rarity alone never ADMITS anything (see the
// header comment); it only bounds which id tokens are even asked about,
// and keeps an id that got copy-pasted through a dozen memories (an RFC,
// a tutorial corpus) from acting like a locator.
const KEYWORD_MAX_DF = 12;

// At most this many keyword-only admissions per prompt (best bm25 first),
// so the keyword path can nudge recall but never reshape the whole result.
const KEYWORD_MAX_HITS = 2;

// An id token is at least this many characters (see `isIdToken`): short
// alphanumerics (`IPv6`, `arm64`, `S12`) are vocabulary, not identifiers.
const KEYWORD_MIN_ID_LENGTH = 6;

// Additive boost for a semantic hit ABOVE the floor that also matches an
// id token (env MEMORY_ROUTER_KEYWORD_BOOST): the exact-token evidence
// breaks ties between two genuine semantic matches.
const KEYWORD_BOOST_DEFAULT = 0.02;

// A keyword-only admission enters the blend at the floor edge:
// minSemanticScore + KEYWORD_ADMISSION_OFFSET. The usual topic, type and
// recency modifiers then apply on top exactly as for any other candidate, so
// this offset is where an admission STARTS, not a rank guarantee (a topic- or
// type-boosted candidate can still land under it). What it never does is
// touch the embedding signal: an admitted memory has no above-floor semantic
// score, and its below-floor cosine (if it has one at all) is never lifted or
// blended.
const KEYWORD_ADMISSION_OFFSET = 0.01;

// Small fixed German + English stopword list: the grammatical glue that
// would otherwise form phrases of no locating value (FTS operator words
// like AND/OR/NOT vanish through it too). With the id-only gate no stopword
// can ever become a queryable term anyway (`isIdToken` rejects every
// letters-only token), so this list is tokenizer hygiene, not a gate.
// Deliberately small and closed.
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
    keywordBoost: envFloat('MEMORY_ROUTER_KEYWORD_BOOST', KEYWORD_BOOST_DEFAULT),
  };
}

// One prompt term: `term` is the ORIGINAL prompt token (edge punctuation
// trimmed, never lowercased - the id rule inspects it as typed), `phrase`
// is its sanitized FTS phrase body (lowercased alphanumeric pieces joined
// by single spaces, stopwords dropped).
interface KeywordTerm {
  term: string;
  phrase: string;
}

// Tokenizes a prompt into candidate terms, dropping stopwords and terms
// with no alphanumeric content (pure punctuation, emoji). Splitting each
// word into unicode alphanumeric pieces and rejoining with spaces is what
// makes `studio-tb` become the phrase `studio tb` and `v0.7.4` become
// `v0 7 4`: the same boundaries the FTS5 unicode61 tokenizer applies to the
// indexed text, so phrases match whole tokens and nothing else. No FTS
// operator can survive: the only characters a phrase may contain are
// letters, digits and spaces; quotePhrase() wraps it in FTS5 double quotes,
// where even `AND` and `NEAR(` are ordinary string content. Only terms that
// pass isIdToken() are ever QUERIED (see collectKeywordMatches in
// src/embed/indexer.ts); tokenizing stays general so the FTS-safety
// properties of the phrase body hold for every token shape a prompt can
// contain.
//
// Besides the whole-token term, each whitespace token is ALSO split at the
// id separators (ID_SEPARATORS below) and every part that passes isIdToken
// is emitted as its own term whose term AND phrase are that part - this is
// what lets `task:4e7729ab`, `4e7729ab's`, `https://x/t/4e7729ab` and
// `src/a1b2c3.ts` reach the keyword path without any non-id part (or a
// snake_case name, whose underscore is not a separator) becoming queryable.
// Whole-token emission is unchanged, and a token that is already an id
// yields exactly one term (never a dup). The two passes dedupe through two
// phrase-keyed sets, NOT one: `seenWhole` dedupes the whole-token emission
// (a repeated non-id token never emits twice), `seenId` holds the phrases
// already covered by a QUERYABLE term - a whole-token phrase registers there
// only when the whole token itself passes isIdToken, a part phrase always.
// One shared set would be the bug this split fixes: dropping a stopword
// prefix gives `the:a1b2c3` the phrase `a1b2c3` even though the whole token
// `the:a1b2c3` is never queried (it is no id), and registering that inert
// phrase would then dedupe away the very `a1b2c3` part that IS the id.
function extractKeywordTerms(prompt: string): KeywordTerm[] {
  if (!prompt) return [];
  const seenWhole = new Set<string>();
  const seenId = new Set<string>();
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
    if (!seenWhole.has(phrase)) {
      seenWhole.add(phrase);
      // The id rule's token for the whole word: the original word with edge
      // punctuation stripped (`"4e7729ab"` and `(4e7729ab)` still read as
      // the token they are), never lowercased. An id whole token whose phrase
      // a part already covered is skipped (one term per id, never a dup);
      // only a whole token that IS an id registers in `seenId`.
      const original = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      const wholeIsId = isIdToken(original);
      if (wholeIsId) {
        if (seenId.has(phrase)) continue;
        seenId.add(phrase);
      }
      terms.push({ term: original, phrase });
    }
    // An id hidden inside a larger token: split at the id separators and let
    // every qualifying part become its own term (part as both term and
    // phrase). A qualifying part is a single ASCII alnum run, so its phrase
    // stays letters/digits only and FTS-safe. Empty parts (`::a1b2c3::`) and
    // non-id parts never pass isIdToken, so no empty or bogus term is emitted.
    for (const part of word.split(ID_SEPARATORS)) {
      if (!isIdToken(part)) continue;
      const partPhrase = part.toLowerCase();
      if (seenId.has(partPhrase)) continue;
      seenId.add(partPhrase);
      terms.push({ term: part, phrase: partPhrase });
    }
  }
  return terms;
}

// Id separators: the characters an id can hide between when it is wrapped in
// a larger prompt token (a `task:4e7729ab` or `x=a1b2c3` reference, a URL
// path segment, a dotted path `src/a1b2c3.ts`, a possessive `4e7729ab's` or
// its typographic form `4e7729ab’s` - U+2019, the “smart quote” spellings
// produce). A whitespace token is checked part by part at these boundaries
// (consecutive separators collapse, so empty edge parts vanish). The
// underscore is deliberately absent: snake_case names (`b11905_x`,
// `finish_reason`) stay whole and stay non-ids. Each part is re-checked with
// the UNCHANGED isIdToken, so only real id parts become queryable.
const ID_SEPARATORS = /[:\/.#?='\u2019-]+/;

// The id rule (checked on the ORIGINAL token, before lowercasing): a single
// run of ASCII letters and digits only, at least KEYWORD_MIN_ID_LENGTH
// characters, containing at least one letter AND at least one digit. This
// qualifies `4e7729ab`, `b11905`, `a1b2c3`, `base64`; it rejects every
// ordinary word of any language (no digit), every pure number (no letter),
// every SHORT alnum word (`IPv6`, `arm64`), and anything carrying a
// separator (`UTF-8`, `v0.7.4`, `studio-tb`, `finish_reason`) or a non-ASCII
// character - including hyphenated compounds like `Bonsai-Baum` or
// `strata-builds`. `extractKeywordTerms` also asks this rule about each
// part of a token split at the id separators, but none of these examples
// has an id part, so they stay non-ids either way.
function isIdToken(token: string): boolean {
  if (!token) return false;
  if (token.length < KEYWORD_MIN_ID_LENGTH) return false;
  if (!/^[A-Za-z0-9]+$/.test(token)) return false; // single ASCII alnum run
  if (!/[A-Za-z]/.test(token)) return false; // at least one letter
  if (!/[0-9]/.test(token)) return false; // at least one digit
  return true;
}

// One gated term phrase as an FTS5 MATCH string: a double-quoted string
// literal, which FTS5 parses as a single phrase of exact tokens. Phrase
// bodies never contain a double quote (extractKeywordTerms only emits
// letters, digits and spaces), so the literal cannot be broken out of.
function quotePhrase(phrase: string): string {
  return `"${phrase}"`;
}

// The distinguishable reason an admitted/boosted hit carries, e.g.
// `keyword match (id: 4e7729ab)` - what makes keyword-attributed hits
// countable in the eval report (gate 'keyword' + this reason prefix). Since
// id tokens are the only kind of match, there is only one reason form.
function keywordReason(candidate: { idTerms: string[] }): string {
  return `keyword match (id: ${candidate.idTerms.join(', ')})`;
}

module.exports = {
  KEYWORD_MAX_DF,
  KEYWORD_MAX_HITS,
  KEYWORD_MIN_ID_LENGTH,
  KEYWORD_BOOST_DEFAULT,
  KEYWORD_ADMISSION_OFFSET,
  STOPWORDS,
  loadKeywordConfig,
  extractKeywordTerms,
  isIdToken,
  quotePhrase,
  keywordReason,
};
