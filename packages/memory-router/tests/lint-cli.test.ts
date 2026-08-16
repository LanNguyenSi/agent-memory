// CLI-level exit-code contract for `memory-router lint <dir>` (unknown-topics
// path, the default check when no flag narrows it). mm-v1-T002 added
// report.vocabularyError for a rejected topics.yml but never wired it into
// the exit code, so a CI step that only checks the exit code missed a broken
// vocabulary whenever the fallback scan itself found no unknown-topic hits.
// This file pins the fix: vocabularyError alone must fail the run, and the
// pre-existing hits-only exit behavior must stay unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'dist', 'cli.js');

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const baseEnv = { ...process.env };
  delete baseEnv.MEMORY_ROUTER_DIR;
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 8_000,
    env: baseEnv,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-router-lint-cli-'));
}

function writeMemory(dir: string, filename: string, frontmatter: string): void {
  fs.writeFileSync(path.join(dir, filename), `---\n${frontmatter}\n---\n\nbody\n`);
}

test('lint: no topics.yml, no unknown topics -> exit 0 (unchanged)', () => {
  const dir = makeTmpDir();
  try {
    writeMemory(dir, 'a.md', 'name: a\ndescription: x\ntype: feedback\ntopics:\n  - workflow');
    const { status, stdout } = run(['lint', dir, '--unknown-topics']);
    assert.equal(status, 0, stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint: no topics.yml, an unknown topic hit -> exit 1 (unchanged)', () => {
  const dir = makeTmpDir();
  try {
    writeMemory(dir, 'a.md', 'name: a\ndescription: x\ntype: feedback\ntopics:\n  - not-a-real-topic');
    const { status, stdout } = run(['lint', dir, '--unknown-topics']);
    assert.equal(status, 1, stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint: valid custom topics.yml, no hits -> exit 0 (unchanged)', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'topics.yml'),
      "- name: incident_response\n  patterns:\n    - '\\boutage\\b'\n",
    );
    writeMemory(dir, 'a.md', 'name: a\ndescription: x\ntype: feedback\ntopics:\n  - incident_response');
    const { status, stdout } = run(['lint', dir, '--unknown-topics']);
    assert.equal(status, 0, stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint: broken topics.yml, zero unknown-topic hits -> exit 1 (the fix)', () => {
  const dir = makeTmpDir();
  try {
    // Invalid YAML, so `loadVocabularyResult` rejects it and the scan below
    // falls back to the built-in default. 'workflow' is a built-in default
    // topic, so this memory produces zero hits against the fallback: the
    // report's only signal is `vocabularyError`, not a hit.
    fs.writeFileSync(path.join(dir, 'topics.yml'), '- name: [unterminated\n');
    writeMemory(dir, 'a.md', 'name: a\ndescription: x\ntype: feedback\ntopics:\n  - workflow');
    const { status, stdout } = run(['lint', dir, '--unknown-topics']);
    assert.match(stdout, /invalid topics\.yml/);
    assert.equal(status, 1, stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint: broken topics.yml, default check set (no flag) -> exit 1', () => {
  const dir = makeTmpDir();
  try {
    // The realistic CI shape: `lint <dir>` with no check flag runs
    // --drift + --unknown-topics by default. A drift-clean corpus (MEMORY.md
    // pointer present) isolates the vocabulary rejection as the only signal.
    fs.writeFileSync(path.join(dir, 'topics.yml'), '- name: [unterminated\n');
    writeMemory(dir, 'a.md', 'name: a\ndescription: x\ntype: feedback\ntopics:\n  - workflow');
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [a](a.md)\n');
    const { status, stdout } = run(['lint', dir]);
    assert.match(stdout, /invalid topics\.yml/);
    assert.equal(status, 1, stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint: broken topics.yml plus an unknown-topic hit -> exit 1 with both signals', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'topics.yml'), '- name: [unterminated\n');
    writeMemory(dir, 'a.md', 'name: a\ndescription: x\ntype: feedback\ntopics:\n  - not-a-real-topic');
    const { status, stdout } = run(['lint', dir, '--unknown-topics']);
    assert.match(stdout, /invalid topics\.yml/);
    assert.match(stdout, /not-a-real-topic/);
    assert.equal(status, 1, stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
