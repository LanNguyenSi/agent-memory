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
