const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const {
  lintMemoryDirForConflicts,
  lintMemoryDirForConflictsWithSemantic,
  formatConflictReportText,
  __detectPolarity,
  __jaccard,
  __contentTokens,
  __cosineSimilarity,
  __SEMANTIC_SIMILARITY_THRESHOLD,
} = require('../src/lint/conflicts');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-conflict-'));
}

function writeMem(dir: string, name: string, frontmatter: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `---\n${frontmatter}\n---\n\n${body}\n`);
}

test('detectPolarity: positive imperatives', () => {
  assert.equal(__detectPolarity('ALWAYS amend commits'), 'positive');
  assert.equal(__detectPolarity('You must rebase before push'), 'positive');
  assert.equal(__detectPolarity('Prefer squash merges'), 'positive');
});

test('detectPolarity: negative imperatives', () => {
  assert.equal(__detectPolarity('NEVER amend commits'), 'negative');
  assert.equal(__detectPolarity("don't force-push to main"), 'negative');
  assert.equal(__detectPolarity('do not skip tests'), 'negative');
  assert.equal(__detectPolarity('avoid bypassing the gate'), 'negative');
});

test('detectPolarity: mixed and unmarked', () => {
  assert.equal(
    __detectPolarity('always run tests but never on prod'),
    'mixed',
  );
  assert.equal(__detectPolarity('this is just a description'), null);
});

test('jaccard: shared content tokens dominate', () => {
  const a = __contentTokens('always amend commits before pushing');
  const b = __contentTokens('never amend commits before pushing');
  assert.ok(__jaccard(a, b) > 0.5, 'overlapping content tokens beat the polarity word');
});

test('jaccard: no shared subject = 0 overlap', () => {
  const a = __contentTokens('always amend commits');
  const b = __contentTokens('never deploy on Friday');
  assert.equal(__jaccard(a, b), 0);
});

test('HIGH conflict: opposite imperatives + same subject + same topic', () => {
  const dir = tmpDir();
  writeMem(
    dir,
    'feedback_amend_yes.md',
    'name: amend yes\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'ALWAYS amend commits when fixing the previous one',
  );
  writeMem(
    dir,
    'feedback_amend_no.md',
    'name: amend no\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'NEVER amend commits — push a fixup instead',
  );

  try {
    const report = lintMemoryDirForConflicts(dir);
    const high = report.hits.filter((h: { severity: string }) => h.severity === 'high');
    assert.equal(high.length, 1, `expected 1 HIGH hit, got ${high.length}`);
    assert.equal(high[0].topic, 'workflow');
    assert.match(high[0].reason, /opposite imperatives/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('INFO only: same topic but no contradictory directive', () => {
  const dir = tmpDir();
  writeMem(
    dir,
    'feedback_branch.md',
    'name: branch\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'Cut a fresh branch off master before each task.',
  );
  writeMem(
    dir,
    'feedback_review.md',
    'name: review\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'Spawn a review subagent before merge.',
  );

  try {
    const report = lintMemoryDirForConflicts(dir);
    const high = report.hits.filter((h: { severity: string }) => h.severity === 'high');
    const info = report.hits.filter((h: { severity: string }) => h.severity === 'info');
    assert.equal(high.length, 0, 'no HIGH for complementary advice');
    assert.equal(info.length, 1, 'one INFO topic-overlap pair');
    assert.equal(info[0].topic, 'workflow');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opposite imperatives without subject overlap = INFO, not HIGH', () => {
  // Both share the `workflow` topic but the directives are about different
  // things ("amend commits" vs "deploy on Friday"). Shouldn't be HIGH.
  const dir = tmpDir();
  writeMem(
    dir,
    'feedback_amend.md',
    'name: amend\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'ALWAYS amend the previous commit when fixing a typo.',
  );
  writeMem(
    dir,
    'feedback_friday.md',
    'name: friday\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'NEVER deploy on Friday afternoons.',
  );

  try {
    const report = lintMemoryDirForConflicts(dir);
    const high = report.hits.filter((h: { severity: string }) => h.severity === 'high');
    assert.equal(high.length, 0, 'subject vocabulary disjoint, must not be HIGH');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('non-feedback memories are ignored even if they share topics', () => {
  const dir = tmpDir();
  writeMem(
    dir,
    'project_alpha.md',
    'name: alpha\ndescription: x\ntype: project\ntopics: [workflow]',
    'ALWAYS amend commits',
  );
  writeMem(
    dir,
    'reference_beta.md',
    'name: beta\ndescription: x\ntype: reference\ntopics: [workflow]',
    'NEVER amend commits',
  );

  try {
    const report = lintMemoryDirForConflicts(dir);
    assert.equal(report.hits.length, 0);
    assert.equal(report.feedbackCount, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memories without topics are excluded from conflict scan', () => {
  const dir = tmpDir();
  writeMem(
    dir,
    'feedback_topicless_a.md',
    'name: a\ndescription: x\ntype: feedback',
    'ALWAYS amend commits',
  );
  writeMem(
    dir,
    'feedback_topicless_b.md',
    'name: b\ndescription: x\ntype: feedback',
    'NEVER amend commits',
  );

  try {
    const report = lintMemoryDirForConflicts(dir);
    assert.equal(report.hits.length, 0, 'no topic, no pairing');
    assert.equal(report.feedbackCount, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-topic pair is reported once, not per shared topic', () => {
  const dir = tmpDir();
  writeMem(
    dir,
    'feedback_a.md',
    'name: a\ndescription: x\ntype: feedback\ntopics: [workflow, security]',
    'ALWAYS amend commits before push',
  );
  writeMem(
    dir,
    'feedback_b.md',
    'name: b\ndescription: x\ntype: feedback\ntopics: [workflow, security]',
    'NEVER amend commits before push',
  );

  try {
    const report = lintMemoryDirForConflicts(dir);
    assert.equal(report.hits.length, 1, 'pair de-duplicated across shared topics');
    assert.equal(report.hits[0].severity, 'high');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('empty / whitespace-only body: no crash, downgrades to INFO', () => {
  const dir = tmpDir();
  // Pair shares a topic but neither has a non-blank body line, so polarity
  // is null on both sides and the pair must not throw or be elevated to
  // HIGH. Pins the safe-default behaviour.
  fs.writeFileSync(
    path.join(dir, 'feedback_blank_a.md'),
    '---\nname: blank a\ndescription: x\ntype: feedback\ntopics: [workflow]\n---\n\n   \n',
  );
  fs.writeFileSync(
    path.join(dir, 'feedback_blank_b.md'),
    '---\nname: blank b\ndescription: x\ntype: feedback\ntopics: [workflow]\n---\n\n\n',
  );

  try {
    const report = lintMemoryDirForConflicts(dir);
    const high = report.hits.filter((h: { severity: string }) => h.severity === 'high');
    assert.equal(high.length, 0, 'empty bodies must never elevate to HIGH');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('descriptive polarity words (mid-sentence) match polarity but Jaccard floor blocks HIGH', () => {
  // Pin the v1 trade-off: lowercase `never` / `always` patterns also fire on
  // descriptive prose ("...never reaches production..."). The 25% Jaccard
  // floor is what keeps these pairs out of HIGH; without it they would be
  // false positives. Regression-pin the assumption so a future tightening
  // of the polarity regex doesn't silently break corpus quality.
  const dir = tmpDir();
  writeMem(
    dir,
    'feedback_descriptive_a.md',
    'name: descr a\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'Always check the audit log before merge to production.',
  );
  writeMem(
    dir,
    'feedback_descriptive_b.md',
    'name: descr b\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'Stale branches never reach production once the gate has fired.',
  );

  try {
    const report = lintMemoryDirForConflicts(dir);
    const high = report.hits.filter((h: { severity: string }) => h.severity === 'high');
    assert.equal(
      high.length,
      0,
      'unrelated descriptive prose with mismatched polarity must not be HIGH',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectPolarity: lowercase markers only fire in the leading window', () => {
  // Mid-sentence lowercase polarity must not classify the line as a
  // directive. Pre-PR this returned 'negative'; with leading-window
  // matching it must be null. Pin so a future regex tightening can't
  // silently regress.
  assert.equal(
    __detectPolarity('Stale branches never reach production once the gate has fired.'),
    null,
    'mid-sentence lowercase "never" must not classify as negative',
  );
  assert.equal(
    __detectPolarity('We always rebase before pushing to master.'),
    'positive',
    'lowercase "always" at the second token still classifies',
  );
  assert.equal(
    __detectPolarity('Stale branches always work fine actually.'),
    null,
    'mid-sentence lowercase "always" beyond the leading window must not classify',
  );
});

test('detectPolarity: ALL-CAPS markers fire even mid-sentence', () => {
  // ALL-CAPS variants are rare in descriptive prose, so they keep the
  // anywhere-on-line semantics from v1.
  assert.equal(
    __detectPolarity('Cut a fresh branch, ALWAYS rebase before push'),
    'positive',
  );
  assert.equal(
    __detectPolarity('After staging, NEVER force-push to master'),
    'negative',
  );
});

test('detectPolarity: leading directive contradicted later in the line is mixed', () => {
  // Leading "always" with a trailing "never" is the classic mixed case.
  assert.equal(
    __detectPolarity('always run tests but never on prod'),
    'mixed',
  );
  // Symmetric form: leading "never" with a trailing "always".
  assert.equal(
    __detectPolarity('never deploy on Friday, always rebase first'),
    'mixed',
  );
});

test('jaccard floor lowered to 0.15: marginal-overlap pairs now reach HIGH', () => {
  // With the 0.25 floor the canonical-shape pair in this fixture sat at
  // INFO. Tightened polarity (leading-only) means 0.15 is now safe; the
  // pair clears it and lands as HIGH. Pins the floor so a future raise
  // back to 0.25 doesn't silently re-suppress this class of conflict.
  const dir = tmpDir();
  writeMem(
    dir,
    'feedback_squash_a.md',
    'name: a\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'ALWAYS squash before merge to keep master tidy.',
  );
  writeMem(
    dir,
    'feedback_squash_b.md',
    'name: b\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'NEVER rewrite commits during merge to keep linear history.',
  );

  try {
    const report = lintMemoryDirForConflicts(dir);
    const high = report.hits.filter((h: { severity: string }) => h.severity === 'high');
    assert.equal(high.length, 1, 'lowered floor must catch the squash pair');
    assert.match(high[0].reason, /opposite imperatives/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formatConflictReportText: empty report', () => {
  const text = formatConflictReportText({
    hits: [],
    scannedCount: 12,
    feedbackCount: 5,
  });
  assert.match(text, /5 feedback memor.* scanned across 12 total file/);
  assert.match(text, /no topic-conflicts detected/);
});

test('cosineSimilarity: identical vectors = 1, orthogonal = 0, opposite = -1', () => {
  assert.equal(__cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(__cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(__cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.equal(__cosineSimilarity([], []), 0);
  assert.equal(__cosineSimilarity([0, 0], [0, 0]), 0);
});

test('--semantic upgrades INFO → HIGH when paraphrased pair clears similarity threshold', async () => {
  const dir = tmpDir();
  // Two memories with opposite polarity but DISJOINT content vocabulary
  // — the regex pass keeps them at INFO because Jaccard is 0. The stub
  // embedder returns identical vectors so cosine sim = 1 ≥ threshold,
  // which forces the upgrade.
  writeMem(
    dir,
    'feedback_squash_yes.md',
    'name: squash always\ndescription: one tidy commit\ntype: feedback\ntopics: [workflow]',
    'ALWAYS squash before merge to keep master tidy.',
  );
  writeMem(
    dir,
    'feedback_ff_only.md',
    'name: fast-forward only\ndescription: keep linear history without squash\ntype: feedback\ntopics: [workflow]',
    'NEVER rewrite history during merge; use fast-forward only.',
  );

  const stubEmbed = async (texts: string[]): Promise<number[][]> =>
    texts.map(() => [1, 0, 0]);

  try {
    const baseReport = lintMemoryDirForConflicts(dir);
    const baseHigh = baseReport.hits.filter(
      (h: { severity: string }) => h.severity === 'high',
    );
    assert.equal(
      baseHigh.length,
      0,
      'regex-only pass cannot reach HIGH on disjoint subjects',
    );

    const report = await lintMemoryDirForConflictsWithSemantic(dir, {
      semantic: true,
      embedFn: stubEmbed,
    });
    const high = report.hits.filter(
      (h: { severity: string }) => h.severity === 'high',
    );
    assert.equal(high.length, 1, '--semantic must upgrade the paraphrased pair');
    assert.match(high[0].reason, /semantic similarity/);
    assert.match(high[0].reason, /--semantic/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--semantic does NOT upgrade pairs without opposite polarity', async () => {
  const dir = tmpDir();
  // Both memories use positive polarity. Even with a stub embedder
  // returning sim=1, the pair must stay INFO because polarity isn't
  // opposite — the embedding alone is too weak a signal.
  writeMem(
    dir,
    'feedback_a.md',
    'name: a\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'ALWAYS run the audit before push.',
  );
  writeMem(
    dir,
    'feedback_b.md',
    'name: b\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'ALWAYS document the change in the PR body.',
  );

  const stubEmbed = async (texts: string[]): Promise<number[][]> =>
    texts.map(() => [1, 0, 0]);

  try {
    const report = await lintMemoryDirForConflictsWithSemantic(dir, {
      semantic: true,
      embedFn: stubEmbed,
    });
    const high = report.hits.filter(
      (h: { severity: string }) => h.severity === 'high',
    );
    assert.equal(high.length, 0, 'same-polarity pairs must not upgrade');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--semantic skips with stderr warning when OPENAI_API_KEY is unset', async () => {
  const dir = tmpDir();
  writeMem(
    dir,
    'feedback_a.md',
    'name: a\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'ALWAYS squash before merge.',
  );
  writeMem(
    dir,
    'feedback_b.md',
    'name: b\ndescription: x\ntype: feedback\ntopics: [workflow]',
    'NEVER rewrite history, use fast-forward only.',
  );

  // Capture stderr writes triggered by the fail-open path.
  const captured: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any) => {
    captured.push(String(chunk));
    return true;
  };
  const prevKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const report = await lintMemoryDirForConflictsWithSemantic(dir, {
      semantic: true,
      // No embedFn override — forces the resolveProviderConfig path.
    });
    const high = report.hits.filter(
      (h: { severity: string }) => h.severity === 'high',
    );
    assert.equal(high.length, 0, 'fail-open: regex-only signal returned, no upgrade');
    assert.ok(
      captured.some((line) =>
        line.includes('--semantic skipped: OPENAI_API_KEY not set'),
      ),
      'must emit the documented stderr line for the skip path',
    );
  } finally {
    process.stderr.write = origWrite;
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--semantic threshold constant is 0.85 (regression-pin)', () => {
  assert.equal(__SEMANTIC_SIMILARITY_THRESHOLD, 0.85);
});

test('formatConflictReportText: shows both file paths and first-line snippets for HIGH', () => {
  const text = formatConflictReportText({
    hits: [
      {
        severity: 'high',
        topic: 'workflow',
        reason: 'opposite imperatives (positive/negative) and subject vocabulary overlap 70%',
        a: { path: '/m/a.md', memoryId: 'a', firstLine: 'ALWAYS amend commits' },
        b: { path: '/m/b.md', memoryId: 'b', firstLine: 'NEVER amend commits' },
      },
    ],
    scannedCount: 2,
    feedbackCount: 2,
  });
  assert.match(text, /HIGH \(1\)/);
  assert.match(text, /\/m\/a\.md/);
  assert.match(text, /\/m\/b\.md/);
  assert.match(text, /ALWAYS amend commits/);
  assert.match(text, /NEVER amend commits/);
});
