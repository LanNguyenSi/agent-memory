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

// GitClient.listStagedDeletions (agent-tasks cda5b12c, D-006): the
// mass-delete guard's real numerator. The push path stages its working copy
// and asks the INDEX which deletions the next commit would carry, because
// the merge plan and `git add -A` do not agree about a path the working copy
// was already missing.
//
// These tests use a real git repository rather than a stub: the behavior
// under test is git's own reporting, so a stub would only pin this file's
// idea of it.
const { execFileSync } = require("node:child_process");

function initRepoWithFiles(root: string, files: Record<string, string>): string {
  const repoDir = path.join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "test-runner"]);
  git(["config", "user.email", "test-runner@example.invalid"]);
  for (const [relativePath, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repoDir, relativePath)), { recursive: true });
    writeFileSync(path.join(repoDir, relativePath), content, "utf8");
  }
  git(["add", "-A"]);
  git(["commit", "-m", "seed"]);
  return repoDir;
}

test("GitClient.listStagedDeletions: reports every path the staged tree no longer has", () => {
  const root = sandbox("staged-deletions");
  const repoDir = initRepoWithFiles(root, {
    "shared/a.md": "a\n",
    "shared/b.md": "b\n",
    "shared/keep.md": "keep\n"
  });

  const client = new GitClient("git");
  // Nothing removed yet: staging a clean tree must report no deletions, or
  // the guard would refuse every push.
  client.stageAll(repoDir);
  assert.deepEqual(client.listStagedDeletions(repoDir), []);

  rmSync(path.join(repoDir, "shared", "a.md"));
  rmSync(path.join(repoDir, "shared", "b.md"));
  client.stageAll(repoDir);
  assert.deepEqual(client.listStagedDeletions(repoDir).sort(), ["shared/a.md", "shared/b.md"]);
});

test("GitClient.listStagedDeletions: a move of identical content still counts as a deletion", () => {
  // git's own rename detection is on by default for `git diff`, so a path
  // that disappears while an identical one appears is reported as a single
  // R entry and vanishes from a --diff-filter=D listing. For a deletion
  // guard the conservative reading is the right one: the old path IS gone
  // from the remote tree, and that is what peers mirror.
  const root = sandbox("staged-rename");
  const repoDir = initRepoWithFiles(root, { "shared/old.md": "same content\n" });

  rmSync(path.join(repoDir, "shared", "old.md"));
  writeFileSync(path.join(repoDir, "shared", "new.md"), "same content\n", "utf8");

  const client = new GitClient("git");
  client.stageAll(repoDir);
  assert.deepEqual(client.listStagedDeletions(repoDir), ["shared/old.md"]);
});

test("GitClient.listStagedDeletions: a path carrying a space or a non-ASCII byte is returned verbatim", () => {
  // -z, not the default quoting: core.quotePath would hand back
  // "shared/sp\\303\\251c ial.md" as a quoted C string, which no caller
  // un-escapes, so the guard would compare a mangled path against the
  // configured destinations and silently stop counting it.
  const root = sandbox("staged-quoting");
  const repoDir = initRepoWithFiles(root, { "shared/spéc ial.md": "content\n" });

  rmSync(path.join(repoDir, "shared", "spéc ial.md"));

  const client = new GitClient("git");
  client.stageAll(repoDir);
  assert.deepEqual(client.listStagedDeletions(repoDir), ["shared/spéc ial.md"]);
});

test("GitClient.listStagedDeletions: a working copy with no commit yet reports no deletions", () => {
  // prepareWorkingCopy's orphan-branch path (a remote that has never been
  // pushed to) has no HEAD to diff against. Reporting no deletions is the
  // truthful answer there; letting `git diff --cached` fail would turn a
  // first push into a crash.
  const root = sandbox("staged-no-head");
  const repoDir = path.join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir, encoding: "utf8" });

  const client = new GitClient("git");
  assert.deepEqual(client.listStagedDeletions(repoDir), []);
});

// GitClient.commitStaged (agent-tasks cda5b12c, D-017): the push measures
// the index and then commits exactly that index. A commit that re-staged on
// its way in would carry whatever the working copy looked like at commit
// time, which is how a wipe landing after the measurement was published.
test("GitClient.commitStaged: commits the index as measured, not the working copy at commit time", () => {
  const root = sandbox("commit-staged");
  const repoDir = initRepoWithFiles(root, {
    "shared/a.md": "a\n",
    "shared/b.md": "b\n",
    "shared/c.md": "c\n"
  });
  const client = new GitClient("git");

  // One measured deletion.
  rmSync(path.join(repoDir, "shared", "a.md"));
  client.stageAll(repoDir);
  assert.deepEqual(client.listStagedDeletions(repoDir), ["shared/a.md"]);

  // The working copy is wiped AFTER the measurement.
  rmSync(path.join(repoDir, "shared", "b.md"));
  rmSync(path.join(repoDir, "shared", "c.md"));

  const sha = client.commitStaged(repoDir, "measured");
  assert.ok(sha, "expected a commit sha");

  // The commit carries the one measured deletion and nothing the wipe did.
  const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repoDir, encoding: "utf8" })
    .trim()
    .split("\n")
    .sort();
  assert.deepEqual(tree, ["shared/b.md", "shared/c.md"]);
});

test("GitClient.commitStaged: an index that matches HEAD produces no commit", () => {
  const root = sandbox("commit-staged-noop");
  const repoDir = initRepoWithFiles(root, { "shared/a.md": "a\n" });
  const client = new GitClient("git");
  const headBefore = client.revParseHead(repoDir);

  // An unstaged working-copy change is not the index: it must neither be
  // picked up nor produce a commit.
  writeFileSync(path.join(repoDir, "shared", "a.md"), "edited but unstaged\n", "utf8");
  assert.equal(client.commitStaged(repoDir, "nothing"), null);
  assert.equal(client.revParseHead(repoDir), headBefore);
});

test("GitClient.commitStaged: creates the first commit on an unborn branch", () => {
  // prepareWorkingCopy's orphan-branch path (a remote never pushed to): the
  // index is diffed against the empty tree there, so the first push still
  // commits.
  const root = sandbox("commit-staged-unborn");
  const repoDir = path.join(root, "repo");
  mkdirSync(path.join(repoDir, "shared"), { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "test-runner"], { cwd: repoDir, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "test-runner@example.invalid"], { cwd: repoDir, encoding: "utf8" });
  const client = new GitClient("git");

  assert.equal(client.commitStaged(repoDir, "empty"), null);

  writeFileSync(path.join(repoDir, "shared", "first.md"), "first\n", "utf8");
  client.stageAll(repoDir);
  const sha = client.commitStaged(repoDir, "first");
  assert.ok(sha);
  assert.equal(client.revParseHead(repoDir), sha);
});

// GitClient.listTreePaths (agent-tasks cda5b12c, D-022): the restore paths'
// idea of "what the commit holds". Without -z, git C-quotes a path carrying
// a byte above 0x7F, a double quote, a backslash or a control character, and
// the quoted form fails every caller's `startsWith(subdir/)` filter, so the
// file reads as absent from the commit: the destination restore then removes
// the local copy and the whole-snapshot restore skips it.
test("GitClient.listTreePaths: a path git would C-quote is returned verbatim", () => {
  const root = sandbox("tree-quoting");
  const repoDir = initRepoWithFiles(root, {
    "shared/logs/spéc \"quoted\".md": "content\n",
    "shared/plain.md": "plain\n",
    "outside/other.md": "other\n"
  });

  const client = new GitClient("git");
  assert.deepEqual(client.listTreePaths(repoDir, "HEAD", "shared").sort(), [
    "shared/logs/spéc \"quoted\".md",
    "shared/plain.md"
  ]);
  // No subdir: the whole tree, still verbatim.
  assert.deepEqual(client.listTreePaths(repoDir, "HEAD", "").sort(), [
    "outside/other.md",
    "shared/logs/spéc \"quoted\".md",
    "shared/plain.md"
  ]);
});
