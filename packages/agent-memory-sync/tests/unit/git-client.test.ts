// Unit tests for GitClient.push()'s two failure branches
// (src/memory-sync/git-client.ts). Both throw RemoteUnavailableError so
// performPush's catch (src/memory-sync/push.ts) queues instead of crashing
// — see that file's own comment for why the distinction matters — but
// neither branch was exercised anywhere in the existing suite: every
// integration test's "push fails" scenario fails earlier, either at the
// reachability precheck (never reaching `git push` at all) or at
// prepareWorkingCopy's `git ls-remote` (GitClient.lookupRemoteHead). A real
// `git push` rejection (e.g. a peer pushed to the same branch concurrently)
// was untested.
//
// Hermetic, mirroring tests/integration/watch-mirror-delete.test.ts's
// writeStubGitFailingOnCommit pattern: a tiny shell stub intercepts the
// `push` subcommand and returns a canned failure, so no real remote or
// network access is needed. repoDir does not need to be a real git
// checkout — the stub never delegates to the real `git` binary for `push`.

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, chmodSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { GitClient } = require("../../src/memory-sync/git-client");
const { RemoteUnavailableError } = require("../../src/errors");

const createdSandboxes: string[] = [];
test.after(() => {
  for (const dir of createdSandboxes) rmSync(dir, { recursive: true, force: true });
});

function sandbox(name: string): string {
  const root = path.join(
    tmpdir(),
    `agent-memory-sync-git-client-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  mkdirSync(root, { recursive: true });
  createdSandboxes.push(root);
  return root;
}

function writeStubGit(root: string, pushStderr: string, pushExitCode: number): string {
  // The stderr text is written to a sidecar file and cat'ed, never
  // interpolated into the shell script, so a future message containing
  // shell metacharacters cannot execute during the test run.
  const stubPath = path.join(root, "stub-git.sh");
  const stderrPath = path.join(root, "stub-git-stderr.txt");
  writeFileSync(stderrPath, `${pushStderr}\n`, "utf8");
  writeFileSync(
    stubPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "push" ]; then',
      `  cat "${stderrPath}" >&2`,
      `  exit ${pushExitCode}`,
      "fi",
      'exec git "$@"',
      ""
    ].join("\n"),
    "utf8"
  );
  chmodSync(stubPath, 0o755);
  return stubPath;
}

test("GitClient.push: a '[rejected] ... (non-fast-forward)' failure throws a RemoteUnavailableError naming the re-run remedy", () => {
  const root = sandbox("rejected");
  const repoDir = path.join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const stubGitBinary = writeStubGit(root, "! [rejected] main -> main (non-fast-forward)", 1);

  const gitClient = new GitClient(stubGitBinary);

  assert.throws(
    () => gitClient.push(repoDir, "main"),
    (error: unknown) => {
      assert.ok(error instanceof RemoteUnavailableError, "expected a RemoteUnavailableError");
      assert.match((error as Error).message, /remote branch changed during push/);
      assert.match((error as Error).message, /Re-run the sync to merge/);
      return true;
    }
  );
});

test("GitClient.push: a 'fetch first' failure is classified the same as an explicit '[rejected]' message", () => {
  const root = sandbox("fetch-first");
  const repoDir = path.join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const stubGitBinary = writeStubGit(root, "! [rejected] main -> main (fetch first)", 1);

  const gitClient = new GitClient(stubGitBinary);

  assert.throws(
    () => gitClient.push(repoDir, "main"),
    (error: unknown) => {
      assert.ok(error instanceof RemoteUnavailableError);
      assert.match((error as Error).message, /remote branch changed during push/);
      return true;
    }
  );
});

test("GitClient.push: a git failure unrelated to rejection surfaces the generic 'git push failed' RemoteUnavailableError", () => {
  const root = sandbox("generic-failure");
  const repoDir = path.join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const stubGitBinary = writeStubGit(root, "fatal: unable to access remote: permission denied", 1);

  const gitClient = new GitClient(stubGitBinary);

  assert.throws(
    () => gitClient.push(repoDir, "main"),
    (error: unknown) => {
      assert.ok(error instanceof RemoteUnavailableError);
      assert.match((error as Error).message, /git push failed\. Check repository access and branch permissions\./);
      return true;
    }
  );
});
