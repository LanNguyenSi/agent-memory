// Unit tests for src/embed/keyword.ts: the keyword path's pure logic -
// prompt tokenizing/sanitizing, the id rule (identifier vs word), the
// env-backed config, and the reason text. The FTS wiring (store +
// rebuild + router) is covered in tests/keyword-index.test.ts and
// tests/keyword-gate.test.ts.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KEYWORD_MAX_DF,
  KEYWORD_MAX_HITS,
  KEYWORD_MIN_ID_LENGTH,
  KEYWORD_BOOST_DEFAULT,
  loadKeywordConfig,
  extractKeywordTerms,
  isIdToken,
  quotePhrase,
  keywordReason,
} = require('../src/embed/keyword');

test('exported constants: df cap 12, max admissions 2, min id length 6, boost 0.02', () => {
  assert.equal(KEYWORD_MAX_DF, 12);
  assert.equal(KEYWORD_MAX_HITS, 2);
  assert.equal(KEYWORD_MIN_ID_LENGTH, 6);
  assert.equal(KEYWORD_BOOST_DEFAULT, 0.02);
});

// --- The id rule (identifier token vs. ordinary word) ----------------------
//
// A token qualifies only as a single ASCII letter/digit run, at least
// KEYWORD_MIN_ID_LENGTH characters, with at least one letter AND at least
// one digit. One named case per example from the rule's specification.

test('id rule: 4e7729ab qualifies (alnum run, 8 chars, letters and digits)', () => {
  assert.equal(isIdToken('4e7729ab'), true);
});

test('id rule: b11905 qualifies (6 chars, one letter, five digits)', () => {
  assert.equal(isIdToken('b11905'), true);
});

test('id rule: a1b2c3 qualifies (6 chars, alternating letters and digits)', () => {
  assert.equal(isIdToken('a1b2c3'), true);
});

test('id rule: base64 qualifies (6 chars, letters then digits)', () => {
  assert.equal(isIdToken('base64'), true);
});

test('id rule: IPv6 does not qualify (only 4 characters)', () => {
  assert.equal(isIdToken('IPv6'), false);
});

test('id rule: arm64 does not qualify (only 5 characters)', () => {
  assert.equal(isIdToken('arm64'), false);
});

test('id rule: UTF-8 does not qualify (separator character)', () => {
  assert.equal(isIdToken('UTF-8'), false);
});

test('id rule: v0.7.4 does not qualify (separator characters)', () => {
  assert.equal(isIdToken('v0.7.4'), false);
});

test('id rule: studio-tb does not qualify (inner hyphen)', () => {
  assert.equal(isIdToken('studio-tb'), false);
});

test('id rule: finish_reason does not qualify (inner underscore)', () => {
  assert.equal(isIdToken('finish_reason'), false);
});

test('id rule: JavaScript does not qualify (letters only, no digit)', () => {
  assert.equal(isIdToken('JavaScript'), false);
});

test('id rule: WLAN does not qualify (letters only, and short)', () => {
  assert.equal(isIdToken('WLAN'), false);
});

test('id rule: MTPLX does not qualify (letters only)', () => {
  assert.equal(isIdToken('MTPLX'), false);
});

test('id rule: deliverableRepo does not qualify (letters only)', () => {
  assert.equal(isIdToken('deliverableRepo'), false);
});

test('id rule: S12 does not qualify (only 3 characters)', () => {
  assert.equal(isIdToken('S12'), false);
});

test('id rule: 123456 does not qualify (digits only, no letter)', () => {
  assert.equal(isIdToken('123456'), false);
});

test('id rule: abcdef does not qualify (letters only, no digit)', () => {
  assert.equal(isIdToken('abcdef'), false);
});

test('id rule: Bonsai-Baum does not qualify, and neither do its parts Bonsai and Baum', () => {
  assert.equal(isIdToken('Bonsai-Baum'), false, 'inner hyphen');
  assert.equal(isIdToken('Bonsai'), false, 'the parts are no id tokens either');
  assert.equal(isIdToken('Baum'), false);
});

test('id rule: strata-builds does not qualify, and neither do its parts strata and builds', () => {
  assert.equal(isIdToken('strata-builds'), false, 'inner hyphen');
  assert.equal(isIdToken('strata'), false, 'the parts are no id tokens either');
  assert.equal(isIdToken('builds'), false);
});

test('id rule: separator runs that carry letters AND digits do not qualify (task-4e77, b11905_x, a1.2b3c4, a1/b2c3)', () => {
  assert.equal(isIdToken('task-4e77'), false, 'hyphen inside an otherwise id-shaped run');
  assert.equal(isIdToken('b11905_x'), false, 'underscore');
  assert.equal(isIdToken('a1.2b3c4'), false, 'dot');
  assert.equal(isIdToken('a1/b2c3d4'), false, 'slash');
});

test('id rule: empty and non-ASCII inputs do not qualify', () => {
  assert.equal(isIdToken(''), false);
  assert.equal(isIdToken('baum12'), true, 'sanity: the minimal 6-char alnum id');
  assert.equal(isIdToken('bäum12'), false, 'non-ASCII letter is not [A-Za-z]');
  assert.equal(isIdToken('baum١٢'), false, 'non-ASCII digit is not [0-9]');
});

// --- Tokenizer / sanitizer (prompt to query-safe phrase bodies) ------------

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

test('tokenizer: the id-rule token keeps the original case and strips edge punctuation, the phrase is lowercased', () => {
  const terms = extractKeywordTerms('task "4e7729ab" again (4e7729ab)');
  const id = terms.filter((t: { phrase: string }) => t.phrase === '4e7729ab');
  assert.equal(id.length, 1, 'deduped across the quoted/parenthesized spellings');
  assert.equal(id[0].term, '4e7729ab', 'original token case kept for the id rule');
  assert.equal(isIdToken(id[0].term), true, 'the kept token is the queryable one');
});

test('tokenizer: multi-piece words never yield id tokens (the rule is asked about the whole token)', () => {
  for (const t of extractKeywordTerms('fix UTF-8 in studio-tb v0.7.4 Bonsai-Baum')) {
    assert.equal(isIdToken(t.term), false, `"${t.term}" must never enter the keyword path`);
  }
});

test('quotePhrase: wraps in FTS5 double quotes; phrase bodies can never contain a quote to break out of', () => {
  assert.equal(quotePhrase('studio tb'), '"studio tb"');
  for (const t of extractKeywordTerms('a "b" *NEAR(x) c:d (e) f^g')) {
    assert.ok(!t.phrase.includes('"'));
  }
});

// --- Reason text -------------------------------------------------------------

test('keywordReason: the single reason form names the matched id tokens', () => {
  assert.equal(
    keywordReason({ idTerms: ['4e7729ab'] }),
    'keyword match (id: 4e7729ab)',
  );
  assert.equal(
    keywordReason({ idTerms: ['4e7729ab', 'b11905'] }),
    'keyword match (id: 4e7729ab, b11905)',
  );
});

// --- Config / env overrides -----------------------------------------------

test('config: the keyword env vars unset resolve the built-in defaults and enabled=true', () => {
  const prev = [
    process.env.MEMORY_ROUTER_KEYWORD,
    process.env.MEMORY_ROUTER_KEYWORD_BOOST,
  ];
  delete process.env.MEMORY_ROUTER_KEYWORD;
  delete process.env.MEMORY_ROUTER_KEYWORD_BOOST;
  try {
    const cfg = loadKeywordConfig();
    assert.deepEqual(cfg, {
      enabled: true,
      keywordBoost: 0.02,
    });
  } finally {
    restore('MEMORY_ROUTER_KEYWORD', prev[0]);
    restore('MEMORY_ROUTER_KEYWORD_BOOST', prev[1]);
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

test('config: boost override set applies, invalid or negative ones fall back to 0.02 (envFloat shape)', () => {
  const prevB = process.env.MEMORY_ROUTER_KEYWORD_BOOST;
  try {
    process.env.MEMORY_ROUTER_KEYWORD_BOOST = '0.1';
    assert.deepEqual(loadKeywordConfig().keywordBoost, 0.1);

    for (const bad of ['abc', '-1', '']) {
      process.env.MEMORY_ROUTER_KEYWORD_BOOST = bad;
      assert.equal(
        loadKeywordConfig().keywordBoost,
        KEYWORD_BOOST_DEFAULT,
        `"${bad}" must fall back to the boost default`,
      );
    }
  } finally {
    restore('MEMORY_ROUTER_KEYWORD_BOOST', prevB);
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
