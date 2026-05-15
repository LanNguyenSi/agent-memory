// Smoke test for the `--version` CLI short-circuit on the
// memory-router-user-prompt-submit hook. Tooling that probes installed
// memory routers with `<bin> --version` (e.g. harness doctor's
// memory.router.min_version check) otherwise hangs on stdin until the 5s
// probe budget expires.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const BIN = path.join(
  __dirname,
  '..',
  'dist',
  'hooks',
  'user-prompt-submit.js',
);
const PACKAGE_JSON = path.join(__dirname, '..', 'package.json');

function expectedVersion(): string {
  const raw = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    version: string;
  };
  return raw.version;
}

function runFlag(flag: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(process.execPath, [BIN, flag], {
    encoding: 'utf8',
    timeout: 4_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

test('user-prompt-submit --version prints package.json#version and exits 0', () => {
  const { status, stdout } = runFlag('--version');
  assert.equal(status, 0);
  // Drift guard: PACKAGE_VERSION in src must stay in sync with
  // package.json on every release bump.
  assert.equal(stdout.trim(), expectedVersion());
});

test('user-prompt-submit -v shorthand also prints the version', () => {
  const { status, stdout } = runFlag('-v');
  assert.equal(status, 0);
  assert.equal(stdout.trim(), expectedVersion());
});
