// Unit tests for src/embed/keyword.ts: the keyword path's pure logic -
// prompt tokenizing/sanitizing, the shape rule (identifier vs word), the
// env-backed config, and the admission predicate. The FTS wiring (store +
// rebuild + router) is covered in tests/keyword-index.test.ts and
// tests/keyword-gate.test.ts.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KEYWORD_MAX_DF,
  KEYWORD_MAX_HITS,
  KEYWORD_CORROBORATION_DEFAULT,
  KEYWORD_BOOST_DEFAULT,
  loadKeywordConfig,
  extractKeywordTerms,
  isStrongTerm,
  quotePhrase,
  admitsKeywordCandidate,
  keywordReason,
} = require('../src/embed/keyword');

test('exported constants: df cap 12, max admissions 2, corroboration 0.70, boost 0.02', () => {
  assert.equal(KEYWORD_MAX_DF, 12);
  assert.equal(KEYWORD_MAX_HITS, 2);
  assert.equal(KEYWORD_CORROBORATION_DEFAULT, 0.7);
  assert.equal(KEYWORD_BOOST_DEFAULT, 0.02);
});

// --- The shape rule (AC4) -------------------------------------------------

test('shape rule: 4e7729ab, b11905, MTPLX, studio-tb, deliverableRepo, memory_router, v0.7.4 are strong', () => {
  assert.equal(isStrongTerm('4e7729ab'), true, 'contains a digit');
  assert.equal(isStrongTerm('b11905'), true, 'contains a digit');
  assert.equal(isStrongTerm('MTPLX'), true, 'ALL CAPS, 3+ letters');
  assert.equal(isStrongTerm('studio-tb'), true, 'inner -');
  assert.equal(isStrongTerm('deliverableRepo'), true, 'internal capital');
  assert.equal(isStrongTerm('memory_router'), true, 'inner _');
  assert.equal(isStrongTerm('v0.7.4'), true, 'digit + inner .');
});

test('shape rule: strata, bonsai and Strata are plain words, not identifiers', () => {
  assert.equal(isStrongTerm('strata'), false);
  assert.equal(isStrongTerm('bonsai'), false);
  assert.equal(
    isStrongTerm('Strata'),
    false,
    'a LEADING capital is not an internal lower→upper transition and not ALL CAPS',
  );
});

test('shape rule: Bonsai-Baum IS strong by the rule (inner -), documented, not fixed away', () => {
  // The rule keys on SHAPE; `Bonsai-Baum` has an inner `-`, so it reads as
  // an identifier. What keeps the "Wie pflege ich einen Bonsai-Baum"
  // negative control quiet is NOT the shape rule but the phrase query:
  // `Bonsai-Baum` becomes the FTS phrase "bonsai baum", which only matches
  // ADJACENT words - on a corpus where no memory spells the compound out,
  // it matches nothing (pinned end-to-end in tests/keyword-index.test.ts).
  assert.equal(isStrongTerm('Bonsai-Baum'), true);
});

test('shape rule: edge cases - two-letter caps plain, lowercase-with-inner-cap strong, trailing punctuation token trimmed by the tokenizer', () => {
  assert.equal(isStrongTerm('AB'), false, 'ALL CAPS needs 3+ letters');
  assert.equal(isStrongTerm('aBc'), true, 'lower→upper inside the word');
  assert.equal(isStrongTerm('strata'), false);
  assert.equal(isStrongTerm(''), false);
});

// --- Tokenizer / sanitizer (AC2 building blocks) ---------------------------

test('tokenizer: studio-tb becomes the phrase "studio tb", v0.7.4 becomes "v0 7 4"', () => {
  const terms = extractKeywordTerms('deploy studio-tb at v0.7.4');
  const phrases = terms.map((t: { phrase: string }) => t.phrase);
  assert.ok(phrases.includes('studio tb'));
  assert.ok(phrases.includes('v0 7 4'));
});

test('tokenizer: German and English stopwords are dropped, remaining terms kept in order, duplicates deduped', () => {
  const phrases = extractKeywordTerms('the und das bonsai der bonsai').map(
    (t: { phrase: string }) => t.phrase,
  );
  assert.deepEqual(phrases, ['bonsai']);
});

test('tokenizer: the bare FTS operators AND, OR and NOT vanish as stopwords, and every surviving phrase is quote-safe', () => {
  const terms = extractKeywordTerms('strata AND bonsai OR keller NOT schicht');
  const phrases = terms.map((t: { phrase: string }) => t.phrase);
  assert.ok(!phrases.includes('and'));
  assert.ok(!phrases.includes('or'));
  assert.ok(!phrases.includes('not'));
  for (const t of terms) {
    assert.match(
      t.phrase,
      /^[\p{L}\p{N}]+( [\p{L}\p{N}]+)*$/u,
      'a phrase may only contain letters, digits and single spaces',
    );
  }
});

test('tokenizer: empty prompt, whitespace-only prompt and pure punctuation/emoji prompts yield zero terms', () => {
  assert.deepEqual(extractKeywordTerms(''), []);
  assert.deepEqual(extractKeywordTerms('   '), []);
  assert.deepEqual(extractKeywordTerms('!!! ??? --- ... 🎉🎉'), []);
});

test('tokenizer: the shape-rule token keeps the original case and strips edge punctuation, the phrase is lowercased', () => {
  const terms = extractKeywordTerms('deploy MTPLX and "MTPLX" again (MTPLX)');
  const mtplx = terms.filter((t: { phrase: string }) => t.phrase === 'mtplx');
  assert.equal(mtplx.length, 1, 'deduped across the quoted/parenthesized spellings');
  assert.equal(mtplx[0].term, 'MTPLX', 'original token case kept for the shape rule');
});

test('quotePhrase: wraps in FTS5 double quotes; phrase bodies can never contain a quote to break out of', () => {
  assert.equal(quotePhrase('studio tb'), '"studio tb"');
  for (const t of extractKeywordTerms('a "b" *NEAR(x) c:d (e) f^g')) {
    assert.ok(!t.phrase.includes('"'));
  }
});

// --- Admission predicate (AC1 core) ---------------------------------------

function candidate(overrides: Partial<{
  id: string;
  strongTerms: string[];
  matchedTerms: string[];
  bm25: number;
  cosine: number | null;
}> = {}) {
  return {
    id: 'c',
    strongTerms: [] as string[],
    matchedTerms: ['strata'] as string[],
    bm25: -1,
    cosine: null as number | null,
    ...overrides,
  };
}

test('admission: a strong qualifying match admits a memory regardless of cosine', () => {
  assert.equal(
    admitsKeywordCandidate(candidate({ strongTerms: ['4e7729ab'], cosine: 0.1 }), 0.7),
    true,
  );
  assert.equal(
    admitsKeywordCandidate(candidate({ strongTerms: ['4e7729ab'], cosine: null }), 0.7),
    true,
  );
});

test('admission: a plain word with cosine exactly at the 0.70 corroboration floor admits; just below does not', () => {
  assert.equal(admitsKeywordCandidate(candidate({ cosine: 0.7 }), 0.7), true);
  assert.equal(admitsKeywordCandidate(candidate({ cosine: 0.69 }), 0.7), false);
});

test('admission: a plain word below the corroboration floor still admits with 2 qualifying matched terms', () => {
  assert.equal(
    admitsKeywordCandidate(
      candidate({ matchedTerms: ['strata', 'schicht'], cosine: 0.2 }),
      0.7,
    ),
    true,
  );
});

test('admission: cosine null (no comparable vector at all) never corroborates a single plain word', () => {
  assert.equal(admitsKeywordCandidate(candidate({ cosine: null }), 0.7), false);
});

test('keywordReason: strong matches render the strong form, plain corroborated matches the corroborated form', () => {
  assert.equal(
    keywordReason({ strongTerms: ['4e7729ab'], matchedTerms: ['4e7729ab'] }),
    'keyword match (strong: 4e7729ab)',
  );
  assert.equal(
    keywordReason({ strongTerms: [], matchedTerms: ['strata'] }),
    'keyword match (corroborated: strata)',
  );
});

// --- Config / env overrides -----------------------------------------------

test('config: all three keyword env vars unset resolves the built-in defaults and enabled=true', () => {
  const prev = [
    process.env.MEMORY_ROUTER_KEYWORD,
    process.env.MEMORY_ROUTER_KEYWORD_CORROBORATION,
    process.env.MEMORY_ROUTER_KEYWORD_BOOST,
  ];
  delete process.env.MEMORY_ROUTER_KEYWORD;
  delete process.env.MEMORY_ROUTER_KEYWORD_CORROBORATION;
  delete process.env.MEMORY_ROUTER_KEYWORD_BOOST;
  try {
    const cfg = loadKeywordConfig();
    assert.deepEqual(cfg, {
      enabled: true,
      corroborationFloor: 0.7,
      keywordBoost: 0.02,
    });
  } finally {
    restore('MEMORY_ROUTER_KEYWORD', prev[0]);
    restore('MEMORY_ROUTER_KEYWORD_CORROBORATION', prev[1]);
    restore('MEMORY_ROUTER_KEYWORD_BOOST', prev[2]);
  }
});

test('config: MEMORY_ROUTER_KEYWORD=off disables (trimmed/case-insensitive); any other value keeps it enabled', () => {
  const prev = process.env.MEMORY_ROUTER_KEYWORD;
  try {
    for (const v of ['off', 'OFF', ' off ']) {
      process.env.MEMORY_ROUTER_KEYWORD = v;
      assert.equal(loadKeywordConfig().enabled, false, `"${v}" must disable`);
    }
    for (const v of ['on', '', 'nonsense']) {
      process.env.MEMORY_ROUTER_KEYWORD = v;
      assert.equal(loadKeywordConfig().enabled, true, `"${v}" must not disable`);
    }
  } finally {
    restore('MEMORY_ROUTER_KEYWORD', prev);
  }
});

test('config: corroboration/boost overrides set apply, invalid or negative ones fall back to the defaults (envFloat shape)', () => {
  const prevC = process.env.MEMORY_ROUTER_KEYWORD_CORROBORATION;
  const prevB = process.env.MEMORY_ROUTER_KEYWORD_BOOST;
  try {
    process.env.MEMORY_ROUTER_KEYWORD_CORROBORATION = '0.5';
    process.env.MEMORY_ROUTER_KEYWORD_BOOST = '0.1';
    assert.deepEqual(loadKeywordConfig().corroborationFloor, 0.5);
    assert.deepEqual(loadKeywordConfig().keywordBoost, 0.1);

    for (const bad of ['abc', '-1', '']) {
      process.env.MEMORY_ROUTER_KEYWORD_CORROBORATION = bad;
      process.env.MEMORY_ROUTER_KEYWORD_BOOST = bad;
      const cfg = loadKeywordConfig();
      assert.equal(
        cfg.corroborationFloor,
        KEYWORD_CORROBORATION_DEFAULT,
        `"${bad}" must fall back to the corroboration default`,
      );
      assert.equal(
        cfg.keywordBoost,
        KEYWORD_BOOST_DEFAULT,
        `"${bad}" must fall back to the boost default`,
      );
    }
  } finally {
    restore('MEMORY_ROUTER_KEYWORD_CORROBORATION', prevC);
    restore('MEMORY_ROUTER_KEYWORD_BOOST', prevB);
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
