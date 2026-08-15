const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { planMigration, applyMigration, listMigratableFiles } = require('../src/migrate/transform');

const STATIC_CORPUS = path.join(__dirname, 'fixtures', 'migrate', 'corpus');

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-migrate-'));
}

// Copies the static, checked-in fixture corpus into a fresh temp dir so
// every test mutates only a throwaway copy, never the real fixtures — the
// task's own constraint ("migrate schreibt in Tests nur in temp-Kopien").
function copyStaticCorpus(): string {
  const dir = mkTmpDir();
  fs.cpSync(STATIC_CORPUS, dir, { recursive: true });
  return dir;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
function extractBody(source: string): string {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) throw new Error('fixture must have frontmatter');
  return (match[2] ?? '').replace(/^\r?\n/, '');
}
function bodyHash(source: string): string {
  return crypto.createHash('sha256').update(extractBody(source)).digest('hex');
}

function planFor(id: string, dir: string) {
  const plan = planMigration(dir);
  const found = plan.files.find((f: { id: string }) => f.id === id);
  assert.ok(found, `fixture ${id} should be in the plan`);
  return found;
}

// --- format matrix: hoist / kept / conflict / untagged ---------------------

test('migrate: metadata.type hoists to top-level type when no top-level type exists', () => {
  const dir = copyStaticCorpus();
  try {
    const f = planFor('feedback_needs_hoist', dir);
    assert.equal(f.skipped, false);
    assert.deepEqual(f.type, { action: 'set', value: 'feedback', source: 'metadata.type' });
    assert.equal(f.changed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: topics derive from a vocabulary pattern match against name+description when no mapping is given', () => {
  const dir = copyStaticCorpus();
  try {
    const f = planFor('feedback_needs_hoist', dir);
    assert.equal(f.topics.action, 'set');
    assert.equal(f.topics.source, 'vocabulary-pattern');
    assert.deepEqual(f.topics.value, ['deployment']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: created derives from mtime and is marked approx', () => {
  const dir = copyStaticCorpus();
  const target = path.join(dir, 'feedback_needs_hoist.md');
  const fixedMtime = new Date('2026-03-15T00:00:00Z');
  fs.utimesSync(target, fixedMtime, fixedMtime);
  try {
    const f = planFor('feedback_needs_hoist', dir);
    assert.equal(f.created.action, 'set');
    assert.equal(f.created.value, '2026-03-15');
    assert.equal(f.created.source, 'mtime (approx)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: a fully canonical file is left untouched (all fields kept, changed=false)', () => {
  const dir = copyStaticCorpus();
  try {
    const f = planFor('reference_already_canonical', dir);
    assert.equal(f.changed, false);
    assert.equal(f.type.action, 'kept');
    assert.equal(f.type.value, 'reference');
    assert.equal(f.topics.action, 'kept');
    assert.deepEqual(f.topics.value, ['workflow']);
    assert.equal(f.created.action, 'kept');
    assert.equal(f.created.value, '2026-01-01');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: an existing top-level type is NEVER overwritten, even when metadata.type disagrees', () => {
  const dir = copyStaticCorpus();
  try {
    const f = planFor('project_conflict', dir);
    assert.equal(f.type.action, 'kept');
    assert.equal(f.type.value, 'project', 'top-level type must win over metadata.type=user');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: no mapping match and no vocabulary pattern hit leaves topics untagged, reported', () => {
  const dir = copyStaticCorpus();
  try {
    const plan = planMigration(dir);
    const untagged = plan.files
      .filter((f: { topics: { action: string } }) => f.topics.action === 'missing')
      .map((f: { id: string }) => f.id)
      .sort();
    assert.deepEqual(untagged, ['project_conflict', 'user_untagged']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: a file with no type anywhere reports type as missing, not guessed', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'no_type_at_all.md'),
    '---\nname: no type\ndescription: nothing to hoist\n---\n\nbody\n',
  );
  try {
    const f = planFor('no_type_at_all', dir);
    assert.equal(f.type.action, 'missing');
    assert.equal(f.type.value, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- metadata.topics hoist ---------------------------------------------------

test('migrate: metadata.topics hoists to top-level topics when no top-level topics exists', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'meta_topics_hoist.md'),
    '---\nname: meta topics\ndescription: nothing vocabulary would match\nmetadata:\n  type: feedback\n  topics: [curated_one, curated_two]\n---\n\nbody\n',
  );
  try {
    const f = planFor('meta_topics_hoist', dir);
    assert.deepEqual(f.topics, {
      action: 'set',
      value: ['curated_one', 'curated_two'],
      source: 'metadata.topics',
    });
    assert.equal(f.changed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: metadata.topics values are hoisted byte-identical (no trim/dedupe/reorder)', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'meta_topics_verbatim.md'),
    '---\nname: verbatim\ndescription: nothing vocabulary would match\nmetadata:\n  type: feedback\n  topics: ["  spaced  ", "dup", "dup"]\n---\n\nbody\n',
  );
  try {
    const f = planFor('meta_topics_verbatim', dir);
    assert.equal(f.topics.action, 'set');
    assert.equal(f.topics.source, 'metadata.topics');
    assert.deepEqual(f.topics.value, ['  spaced  ', 'dup', 'dup']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: existing top-level topics wins over metadata.topics (top-level > metadata)', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'toplevel_wins.md'),
    '---\nname: toplevel wins\ndescription: nothing vocabulary would match\ntopics: [already_canonical]\nmetadata:\n  type: feedback\n  topics: [would_be_overwritten]\n---\n\nbody\n',
  );
  try {
    const f = planFor('toplevel_wins', dir);
    assert.deepEqual(f.topics, { action: 'kept', value: ['already_canonical'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: metadata.topics wins over a matching --mapping rule (metadata > mapping)', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'meta_wins_over_mapping.md'),
    '---\nname: meta wins\ndescription: nothing vocabulary would match\nmetadata:\n  type: feedback\n  topics: [from_metadata]\n---\n\nbody\n',
  );
  try {
    const rules = [{ prefix: 'meta_wins_', topics: ['from_mapping'] }];
    const plan = planMigration(dir, { mappingRules: rules, mappingPath: 'fixture.yml' });
    const f = plan.files.find((x: { id: string }) => x.id === 'meta_wins_over_mapping');
    assert.deepEqual(f.topics, {
      action: 'set',
      value: ['from_metadata'],
      source: 'metadata.topics',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: an invalid metadata.topics shape (not an array) is not hoisted, falls through to the next source', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'meta_topics_not_array.md'),
    '---\nname: not array\ndescription: deploy release rollback\nmetadata:\n  type: feedback\n  topics: "not-a-list"\n---\n\nbody\n',
  );
  try {
    const f = planFor('meta_topics_not_array', dir);
    assert.equal(f.topics.action, 'set');
    assert.equal(f.topics.source, 'vocabulary-pattern', 'falls through past the invalid shape, no crash');
    assert.deepEqual(f.topics.value, ['deployment']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: an invalid metadata.topics shape (array with a non-string entry) is not hoisted, reported untagged when nothing else matches', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'meta_topics_bad_entry.md'),
    '---\nname: bad entry\ndescription: nothing vocabulary would match at all\nmetadata:\n  type: feedback\n  topics: [ok_one, 42]\n---\n\nbody\n',
  );
  try {
    const f = planFor('meta_topics_bad_entry', dir);
    assert.equal(f.topics.action, 'missing', 'invalid shape never crashes and never gets guessed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: an empty metadata.topics array is not hoisted (falls through, same as an empty top-level topics)', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'meta_topics_empty.md'),
    '---\nname: empty\ndescription: deploy release rollback\nmetadata:\n  type: feedback\n  topics: []\n---\n\nbody\n',
  );
  try {
    const f = planFor('meta_topics_empty', dir);
    assert.equal(f.topics.action, 'set');
    assert.equal(f.topics.source, 'vocabulary-pattern');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --apply: metadata.topics hoist is idempotent (second run is a no-op)', () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'hoist_idempotent.md');
  fs.writeFileSync(
    file,
    '---\nname: idempotent hoist\ndescription: nothing vocabulary would match\nmetadata:\n  type: feedback\n  topics: [curated]\n---\n\nbody text\n',
  );
  try {
    const firstPlan = planMigration(dir);
    const firstResult = applyMigration(firstPlan);
    assert.equal(firstResult.applied, 1, 'first run hoists topics (and type)');

    const afterFirst = fs.readFileSync(file, 'utf8');
    assert.match(afterFirst, /^topics:\n\s*- curated$/m);

    const secondPlan = planMigration(dir);
    const f = secondPlan.files.find((x: { id: string }) => x.id === 'hoist_idempotent');
    assert.deepEqual(f.topics, { action: 'kept', value: ['curated'] });

    const secondResult = applyMigration(secondPlan);
    assert.equal(secondResult.applied, 0, 'second run must not write anything');
    assert.equal(fs.readFileSync(file, 'utf8'), afterFirst, 'byte-identical after the second run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --apply: metadata.topics hoist leaves the body byte-identical', () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'hoist_body_hash.md');
  const original =
    '---\nname: hoist body\ndescription: nothing vocabulary would match\nmetadata:\n  type: feedback\n  topics: [curated]\n---\n\n<!-- keep me -->\nSome body text.\n\n- item one\n- item two\n';
  fs.writeFileSync(file, original);
  try {
    const before = bodyHash(original);
    const plan = planMigration(dir);
    const result = applyMigration(plan);
    assert.equal(result.applied, 1);
    const afterSource = fs.readFileSync(file, 'utf8');
    assert.equal(bodyHash(afterSource), before, 'body bytes must be unchanged by the metadata.topics hoist');
    assert.match(afterSource, /<!-- keep me -->/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- mapping vs. pattern precedence -----------------------------------------

test('migrate: a mapping match wins over a vocabulary pattern hit, even when the text would also match the pattern', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'special_deploy_note.md'),
    '---\nname: special\ndescription: deploy release rollback, vocabulary would tag this "deployment"\nmetadata:\n  type: feedback\n---\n\nbody\n',
  );
  try {
    const rules = [{ prefix: 'special_', topics: ['curated_topic'] }];
    const plan = planMigration(dir, { mappingRules: rules, mappingPath: 'fixture.yml' });
    const f = plan.files.find((x: { id: string }) => x.id === 'special_deploy_note');
    assert.equal(f.topics.action, 'set');
    assert.equal(f.topics.source, 'mapping');
    assert.deepEqual(
      f.topics.value,
      ['curated_topic'],
      'mapping must win even though the text also matches the deployment vocabulary pattern',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: an id-mode mapping rule matches exactly, prefix rules do not leak into it', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'exact_id_case.md'),
    '---\nname: exact\ndescription: no vocabulary keywords here at all\nmetadata:\n  type: reference\n---\n\nbody\n',
  );
  try {
    const rules = [{ id: 'exact_id_case', topics: ['pinned'] }];
    const plan = planMigration(dir, { mappingRules: rules });
    const f = plan.files.find((x: { id: string }) => x.id === 'exact_id_case');
    assert.deepEqual(f.topics, { action: 'set', value: ['pinned'], source: 'mapping' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- MEMORY.md / non-.md exclusion ------------------------------------------

test('migrate: MEMORY.md and non-.md files (topics.yml, golden.yml) are never scanned or touched', () => {
  const dir = mkTmpDir();
  const memoryMd = '# index\n\n- [x](x.md)\n';
  const topicsYml = '- name: workflow\n  patterns: ["\\\\btask\\\\b"]\n';
  const goldenYml = 'prompts: []\n';
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), memoryMd);
  fs.writeFileSync(path.join(dir, 'topics.yml'), topicsYml);
  fs.writeFileSync(path.join(dir, 'golden.yml'), goldenYml);
  fs.writeFileSync(
    path.join(dir, 'real_memory.md'),
    '---\nname: real\ndescription: deploy release\nmetadata:\n  type: feedback\n---\n\nbody\n',
  );
  try {
    const files = listMigratableFiles(dir);
    assert.deepEqual(
      files.map((f: string) => path.basename(f)).sort(),
      ['real_memory.md'],
    );

    const plan = planMigration(dir);
    applyMigration(plan);

    assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), memoryMd);
    assert.equal(fs.readFileSync(path.join(dir, 'topics.yml'), 'utf8'), topicsYml);
    assert.equal(fs.readFileSync(path.join(dir, 'golden.yml'), 'utf8'), goldenYml);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- dry-run vs --apply ------------------------------------------------------

test('migrate: planMigration alone never writes (dry-run is inert)', () => {
  const dir = copyStaticCorpus();
  const before = fs.readFileSync(path.join(dir, 'feedback_needs_hoist.md'), 'utf8');
  try {
    planMigration(dir);
    const after = fs.readFileSync(path.join(dir, 'feedback_needs_hoist.md'), 'utf8');
    assert.equal(after, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --apply: writes the planned fields and reports counts', () => {
  const dir = copyStaticCorpus();
  try {
    const plan = planMigration(dir);
    const result = applyMigration(plan);
    // 2 files change (feedback_needs_hoist, user_untagged both hoist type
    // and/or created), 1 already canonical, 1 (project_conflict) also
    // changes (created gets stamped even though type/topics don't).
    assert.equal(result.errored.length, 0);
    assert.equal(result.applied + result.unchanged + result.skipped, plan.files.length);

    const after = fs.readFileSync(path.join(dir, 'feedback_needs_hoist.md'), 'utf8');
    assert.match(after, /^type: feedback$/m);
    assert.match(after, /^topics:\n\s*- deployment$/m);
    assert.match(after, /^created: \d{4}-\d{2}-\d{2} # approx \(mtime\)$/m);
    // Original metadata block is preserved, not stripped.
    assert.match(after, /originSessionId: xyz789/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- idempotency -------------------------------------------------------------

test('migrate: applying twice is a no-op the second time (migrate ∘ migrate)', () => {
  const dir = copyStaticCorpus();
  try {
    const firstPlan = planMigration(dir);
    const firstResult = applyMigration(firstPlan);
    assert.ok(firstResult.applied > 0, 'first run should actually change something');

    const snapshot = new Map<string, string>();
    for (const name of fs.readdirSync(dir)) {
      snapshot.set(name, fs.readFileSync(path.join(dir, name), 'utf8'));
    }

    const secondPlan = planMigration(dir);
    const secondResult = applyMigration(secondPlan);
    assert.equal(secondResult.applied, 0, 'second run must not write anything');
    assert.ok(secondPlan.files.every((f: { changed: boolean }) => f.changed === false));

    for (const name of fs.readdirSync(dir)) {
      assert.equal(
        fs.readFileSync(path.join(dir, name), 'utf8'),
        snapshot.get(name),
        `${name} must be byte-identical after the second run`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- body-hash invariance -----------------------------------------------------

test('migrate --apply: body content is byte-identical before and after (comments included)', () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'has_a_body_comment.md');
  const original = `---\nname: comment keeper\ndescription: deploy release\nmetadata:\n  type: feedback\n---\n\n<!-- keep me -->\nSome body text with a trailing comment.\n\n- list item one\n- list item two\n`;
  fs.writeFileSync(file, original);
  try {
    const before = bodyHash(fs.readFileSync(file, 'utf8'));
    const plan = planMigration(dir);
    const result = applyMigration(plan);
    assert.equal(result.applied, 1);
    const afterSource = fs.readFileSync(file, 'utf8');
    const after = bodyHash(afterSource);
    assert.equal(after, before, 'body bytes must be unchanged by migrate');
    assert.match(afterSource, /<!-- keep me -->/, 'body comment must survive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --apply: preserves CRLF line endings', () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'crlf_case.md');
  const lines = [
    '---',
    'name: crlf',
    'description: deploy release',
    'metadata:',
    '  type: feedback',
    '---',
    '',
    'crlf body',
    '',
  ];
  fs.writeFileSync(file, lines.join('\r\n'));
  try {
    const plan = planMigration(dir);
    applyMigration(plan);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes('\r\n'), 'should still contain CRLF');
    assert.ok(!/[^\r]\n/.test(after), 'should not introduce lone LFs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- skip conditions -----------------------------------------------------------

test('migrate: a file with no frontmatter delimiter is skipped, not crashed on', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'plain.md'), '# just a heading\n');
  try {
    const plan = planMigration(dir);
    const f = plan.files.find((x: { id: string }) => x.id === 'plain');
    assert.equal(f.skipped, true);
    assert.match(f.reason, /no YAML frontmatter delimiter/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: a file missing the required name field is skipped', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'no_name.md'),
    '---\ntype: reference\ndescription: x\n---\nbody\n',
  );
  try {
    const plan = planMigration(dir);
    const f = plan.files.find((x: { id: string }) => x.id === 'no_name');
    assert.equal(f.skipped, true);
    assert.match(f.reason, /missing required field 'name'/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- null/invalid frontmatter guard (fix-round 2, #3) -----------------------

test('migrate: an empty frontmatter block (--- \\n\\n ---) is skipped as "not a YAML object", not crashed on; a healthy neighbor is still planned', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'empty_frontmatter.md'), '---\n\n---\n\nbody\n');
  fs.writeFileSync(
    path.join(dir, 'healthy_neighbor.md'),
    '---\nname: healthy neighbor\ndescription: deploy release\nmetadata:\n  type: feedback\n---\n\nbody\n',
  );
  try {
    const plan = planMigration(dir);

    const broken = plan.files.find((x: { id: string }) => x.id === 'empty_frontmatter');
    assert.ok(broken, 'the empty-frontmatter file must still appear in the plan');
    assert.equal(broken.skipped, true);
    assert.match(broken.reason, /frontmatter is not a YAML object/);

    const healthy = plan.files.find((x: { id: string }) => x.id === 'healthy_neighbor');
    assert.ok(healthy, 'a healthy neighbor must still be planned, run must not abort');
    assert.equal(healthy.skipped, false);
    assert.equal(healthy.type.action, 'set');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: a top-level YAML list between the frontmatter delimiters is skipped as "not a YAML object", not crashed on', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'list_frontmatter.md'), '---\n- one\n- two\n---\n\nbody\n');
  try {
    const plan = planMigration(dir);
    const f = plan.files.find((x: { id: string }) => x.id === 'list_frontmatter');
    assert.ok(f);
    assert.equal(f.skipped, true);
    assert.match(f.reason, /frontmatter is not a YAML object/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: an unexpected planFile failure (file becomes unreadable after listing) is turned into a skipped entry, not a run abort', () => {
  const dir = mkTmpDir();
  const badFile = path.join(dir, 'goes_unreadable.md');
  fs.writeFileSync(
    badFile,
    '---\nname: goes unreadable\ndescription: deploy release\nmetadata:\n  type: feedback\n---\n\nbody\n',
  );
  fs.writeFileSync(
    path.join(dir, 'healthy_neighbor2.md'),
    '---\nname: healthy neighbor 2\ndescription: deploy release\nmetadata:\n  type: feedback\n---\n\nbody\n',
  );
  fs.chmodSync(badFile, 0o000);
  try {
    let plan;
    try {
      plan = planMigration(dir);
    } finally {
      fs.chmodSync(badFile, 0o644); // restore so cleanup (rmSync) can remove it
    }

    const broken = plan.files.find((x: { id: string }) => x.id === 'goes_unreadable');
    assert.ok(broken, 'the unreadable file must still appear in the plan, not abort the run');
    assert.equal(broken.skipped, true);
    assert.match(broken.reason, /unexpected error/);

    const healthy = plan.files.find((x: { id: string }) => x.id === 'healthy_neighbor2');
    assert.ok(healthy, 'a healthy neighbor must still be planned');
    assert.equal(healthy.skipped, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- non-array topics protection (fix-round 2, #4) ---------------------------

test('migrate: an existing non-empty top-level topics of an invalid shape (scalar string) is kept, never overwritten, and flagged for manual review', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'topics_scalar_string.md'),
    '---\nname: scalar topics\ndescription: deploy release rollback\ntopics: "not-a-list-but-present"\nmetadata:\n  type: feedback\n  topics: [would_be_overwritten]\n---\n\nbody\n',
  );
  try {
    const f = planFor('topics_scalar_string', dir);
    assert.deepEqual(f.topics, {
      action: 'kept',
      value: 'not-a-list-but-present',
      source: 'invalid-shape',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: an empty-string top-level topics is treated as absent, falls through to the normal precedence (not flagged invalid-shape)', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'topics_empty_string.md'),
    '---\nname: empty topics\ndescription: deploy release rollback\ntopics: ""\nmetadata:\n  type: feedback\n---\n\nbody\n',
  );
  try {
    const f = planFor('topics_empty_string', dir);
    assert.equal(f.topics.action, 'set');
    assert.equal(f.topics.source, 'vocabulary-pattern');
    assert.deepEqual(f.topics.value, ['deployment']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- vocabulary disclosure (fix-round 2, #5) ---------------------------------

test('migrate: planMigration reports vocabularySource "default" and vocabularyError null when no topics.yml exists', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(
    path.join(dir, 'plain_case.md'),
    '---\nname: plain\ndescription: deploy release\nmetadata:\n  type: feedback\n---\n\nbody\n',
  );
  try {
    const plan = planMigration(dir);
    assert.equal(plan.vocabularySource, 'default');
    assert.equal(plan.vocabularyError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: planMigration reports vocabularySource "custom" for a valid topics.yml', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'topics.yml'), '- name: incident\n  patterns: ["\\\\bincident\\\\b"]\n');
  fs.writeFileSync(
    path.join(dir, 'plain_case.md'),
    '---\nname: plain\ndescription: deploy release\nmetadata:\n  type: feedback\n---\n\nbody\n',
  );
  try {
    const plan = planMigration(dir);
    assert.equal(plan.vocabularySource, 'custom');
    assert.equal(plan.vocabularyError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: planMigration falls back to "default" and reports vocabularyError for a broken topics.yml', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'topics.yml'), 'not_a_list: true\n');
  fs.writeFileSync(
    path.join(dir, 'plain_case.md'),
    '---\nname: plain\ndescription: deploy release\nmetadata:\n  type: feedback\n---\n\nbody\n',
  );
  try {
    const plan = planMigration(dir);
    assert.equal(plan.vocabularySource, 'default');
    assert.match(plan.vocabularyError, /topics\.yml/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- separator preservation (fix-round 2, #8) --------------------------------

test('migrate --apply: a file with NO blank line after frontmatter keeps that exact separator (no blank line is forced in)', () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'no_blank_separator.md');
  const original =
    '---\nname: no blank sep\ndescription: deploy release rollback\nmetadata:\n  type: feedback\n---\nbody text directly after the delimiter, no blank line\n';
  fs.writeFileSync(file, original);
  try {
    const plan = planMigration(dir);
    const f = plan.files.find((x: { id: string }) => x.id === 'no_blank_separator');
    assert.equal(f.changed, true);

    const result = applyMigration(plan);
    assert.equal(result.applied, 1);
    const after = fs.readFileSync(file, 'utf8');

    assert.match(
      after,
      /---\nbody text directly after the delimiter, no blank line\n$/,
      'no blank line must be introduced between the closing delimiter and the body',
    );
    assert.ok(
      !after.includes('---\n\nbody text directly after the delimiter'),
      'must not force a blank line where the original had none',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate --apply: a file WITH a blank line after frontmatter keeps exactly that blank line (regression guard)', () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'one_blank_separator.md');
  const original =
    '---\nname: one blank sep\ndescription: deploy release rollback\nmetadata:\n  type: feedback\n---\n\nbody text after exactly one blank line\n';
  fs.writeFileSync(file, original);
  try {
    const plan = planMigration(dir);
    applyMigration(plan);
    const after = fs.readFileSync(file, 'utf8');
    assert.match(after, /---\n\nbody text after exactly one blank line\n$/);
    assert.ok(!after.includes('---\n\n\nbody text after exactly one blank line'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- serialization fidelity: lineWidth (fix-round 2, #1) ---------------------

test('migrate --apply: lineWidth:0 avoids yaml\'s default 80-col reflow; pre-existing frontmatter lines survive byte-identical when only `created` is appended', () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'fidelity_case.md');
  const longDescriptionLine =
    "description: this description line is deliberately written past eighty characters to trigger yaml's default line-wrapping reflow at the default lineWidth of 80";
  const original =
    '---\n' +
    'name: fidelity check\n' +
    '# a frontmatter comment about this memory\n' +
    `${longDescriptionLine}\n` +
    'type: reference\n' +
    'topics:\n' +
    '  - workflow\n' +
    'folded: >-\n' +
    '  This is a folded scalar\n' +
    '  that spans multiple physical lines\n' +
    '  and should not crash migrate.\n' +
    'literal: |\n' +
    '  line one of a literal block\n' +
    '  line two of a literal block\n' +
    'severity: medium\n' +
    'verify:\n' +
    '  - kind: path\n' +
    '    value: some/path/here.ts\n' +
    'metadata: \n' + // deliberate trailing space after the colon
    '  originSessionId: xyz789\n' +
    '---\n' +
    '\n' +
    'Body text untouched by migrate.\n';
  fs.writeFileSync(file, original);
  try {
    const plan = planMigration(dir);
    const f = plan.files.find((x: { id: string }) => x.id === 'fidelity_case');
    assert.ok(f);
    assert.equal(f.type.action, 'kept', 'type is already valid top-level, kept as-is');
    assert.equal(f.topics.action, 'kept', 'topics is already valid top-level, kept as-is');
    assert.equal(f.created.action, 'set', 'created is the only field missing');
    assert.equal(f.changed, true);

    const result = applyMigration(plan);
    assert.equal(result.applied, 1);
    const after = fs.readFileSync(file, 'utf8');

    // The actual regression: yaml's default 80-column reflow used to split
    // this line across two physical lines. lineWidth: 0 disables that; the
    // line must survive whole, byte-identical to the original.
    assert.ok(
      after.includes(`${longDescriptionLine}\n`),
      'the >80-char description line must not be reflowed across multiple lines',
    );

    // Pre-existing lines untouched by the field append: byte-identical,
    // not reordered, not reformatted.
    for (const line of [
      'name: fidelity check',
      '# a frontmatter comment about this memory',
      'type: reference',
      'topics:',
      '  - workflow',
      'literal: |',
      '  line one of a literal block',
      '  line two of a literal block',
      'severity: medium',
      'verify:',
      '  - kind: path',
      '    value: some/path/here.ts',
      '  originSessionId: xyz789',
    ]) {
      assert.ok(
        after.includes(`${line}\n`),
        `pre-existing line must survive byte-identical: ${JSON.stringify(line)}`,
      );
    }

    // Known, documented yaml round-trip normalization, NOT something
    // lineWidth controls or migrate can preserve: a trailing space right
    // after a key's colon is stripped on re-serialize.
    assert.ok(
      after.includes('metadata:\n'),
      'trailing whitespace after "metadata:" is normalized away on round-trip',
    );
    assert.ok(
      !after.includes('metadata: \n'),
      'the trailing-space form must not survive (documents the known normalization, not a preservation claim)',
    );

    // New field appended, not reordered, body untouched.
    assert.match(after, /created: \d{4}-\d{2}-\d{2} # approx \(mtime\)/);
    assert.match(after, /Body text untouched by migrate\.\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listMigratableFiles order is lexicographic code-unit order, independent of readdir order', () => {
  const tmp = mkTmpDir();
  for (const name of ['alpha.md', 'bravo.md', 'delta.md', 'Zulu.md']) {
    // Content is irrelevant here: listMigratableFiles only stats the
    // entries, it never reads them.
    fs.writeFileSync(path.join(tmp, name), 'body\n');
  }
  // Simulate a hash-ordered filesystem (e.g. ext4 dir_index) with a fixed
  // scrambled readdir result, so this test pins the walker's own sort on
  // every platform instead of the host filesystem's incidental ordering.
  // transform.ts destructures readdirSync at module load, so patch fs first
  // and require a fresh module instance. The stub is scoped to the fixture
  // dir (everything else passes through) so the cache-miss require below
  // and any other dynamic fs use in the patched window stays unaffected.
  const transformPath = require.resolve('../src/migrate/transform');
  const realReaddirSync = fs.readdirSync;
  (fs as unknown as { readdirSync: (dir: string) => string[] }).readdirSync = (
    dir: string,
  ) =>
    dir === tmp
      ? ['bravo.md', 'Zulu.md', 'delta.md', 'alpha.md']
      : (realReaddirSync as unknown as (dir: string) => string[])(dir);
  try {
    delete require.cache[transformPath];
    const { listMigratableFiles: freshList } = require(transformPath);
    // 'Zulu' before 'alpha': uppercase code units sort first. This pins the
    // comparator choice (code-unit order, not locale-aware collation).
    assert.deepEqual(freshList(tmp), [
      path.join(tmp, 'Zulu.md'),
      path.join(tmp, 'alpha.md'),
      path.join(tmp, 'bravo.md'),
      path.join(tmp, 'delta.md'),
    ]);
  } finally {
    (fs as unknown as { readdirSync: typeof realReaddirSync }).readdirSync =
      realReaddirSync;
    delete require.cache[transformPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
