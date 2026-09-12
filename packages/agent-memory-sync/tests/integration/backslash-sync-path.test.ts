// A local file name that carries a literal backslash character is legal on
// darwin/linux, but path.sep is "/" there, so path.relative never puts a
// "\" in its output as a separator: any "\" collectLocalSyncFiles sees in a
// relative path is part of an actual file name. Blindly converting it to
// "/" (the pre-fix behavior) silently published the file's content under a
// different, mangled remote path that pull and restore --from-commit could
// never map back to the original file (review R5 of the 2026-09-11 wipe fix,
// pandora run .ai/runs/2026-09-11-memory-sync-wipe, agent-tasks 73ea60bf).
// This platform never exercises the win32 branch (converting every
// backslash to "/" there is exact, since NTFS disallows one in a real file
// name); these tests run on darwin/linux only and pin the refusal.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  cloneRemote,
  createSandbox,
  fileExists,
  git,
  initBareRemote,
  runCli,
  writeProjectConfig,
  writeText
} = require("../helpers/cli.ts");
const { StateStore } = require("../../src/memory-sync/state-store");

function createConfig(workspaceRoot: string, remoteDir: string) {
  return {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    syncPaths: [
      { source: "MEMORY.md", destination: "MEMORY.md", kind: "file" },
      { source: "logs", destination: "logs", kind: "directory" }
    ]
  };
}

test("push refuses a local file name that contains a backslash, naming the path (exit 3)", () => {
  const root = createSandbox("backslash-push-refuse");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  writeText(path.join(workspaceRoot, "logs", "plain.md"), "plain entry\n");
  // A real, single file whose OWN name contains a literal backslash, not a
  // directory separator. path.join on darwin/linux treats "\" as an
  // ordinary character in the last segment.
  writeText(path.join(workspaceRoot, "logs", "back\\slash.md"), "backslash entry\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  const result = runCli(
    ["run", "default", "--config", configPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(result.status, 3, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /back\\slash\.md/);
  assert.match(result.stderr, /backslash/i);

  // Refused before anything was published: the remote never received a
  // mangled sibling path either.
  const checkout = cloneRemote(remoteDir, root, "verify-empty");
  assert.equal(fs.existsSync(path.join(checkout, "shared")), false);
});

test("a workspace with no backslash name pushes unchanged", () => {
  const root = createSandbox("backslash-push-sibling-ok");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  writeText(path.join(workspaceRoot, "logs", "plain.md"), "plain entry\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  const result = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const checkout = cloneRemote(remoteDir, root, "verify");
  assert.ok(fileExists(path.join(checkout, "shared", "logs", "plain.md")));
});

// The restore-side half: a backslash-named path that reached the hub some
// other way (crafted directly with git here, bypassing this tool's own push
// refusal above; simulating pre-existing hub content or a foreign writer)
// must not be silently mapped to a mangled local path by
// `restore --from-commit`; it is refused loudly (exit 3, naming the path)
// instead, the same way an unmapped remote path already is.
test("restore --from-commit refuses a backslash-named path from the commit instead of mis-restoring it", () => {
  const root = createSandbox("backslash-restore-refuse");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  writeText(path.join(workspaceRoot, "logs", "plain.md"), "plain entry\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // Craft the backslash-named path directly on the hub, bypassing this
  // tool's own push (which now refuses it): the restore fixture's new
  // backslash case.
  const checkout = cloneRemote(remoteDir, root, "foreign-writer");
  writeText(path.join(checkout, "shared", "logs", "back\\slash.md"), "hub-only backslash entry\n");
  git(["add", "-A"], checkout);
  git(["commit", "-m", "foreign writer adds a backslash-named file"], checkout);
  git(["push", "origin", "HEAD:main"], checkout);
  const sha = git(["rev-parse", "HEAD"], checkout).trim();

  const result = runCli(
    ["restore", "default", "logs", "--config", configPath, "--from-commit", sha, "--yes", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(result.status, 3, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /back\\slash\.md/);

  // Refused before writing: no mangled sibling ("back/slash.md") appeared
  // locally, and the plain file already there is untouched.
  assert.equal(fs.existsSync(path.join(workspaceRoot, "logs", "back")), false);
  assert.equal(
    fs.readFileSync(path.join(workspaceRoot, "logs", "plain.md"), "utf8"),
    "plain entry\n"
  );
});

// The pull-side half (review round 1, MEDIUM #1): a hub-side backslash-named
// path this machine cannot rename must not abort the whole pull the way a
// local backslash-named path aborts the whole push above. It is skipped,
// named in a note, and every other file in the same run still applies.
test("pull skips a hub-side backslash-named path with a note, applying the rest of the run", () => {
  const root = createSandbox("backslash-pull-skip");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  // Craft both paths directly on the hub, bypassing this tool's own push
  // (which now refuses the backslash one): a foreign writer, or pre-existing
  // hub content.
  const checkout = cloneRemote(remoteDir, root, "foreign-writer");
  writeText(path.join(checkout, "shared", "logs", "back\\slash.md"), "hub-only backslash entry\n");
  writeText(path.join(checkout, "shared", "logs", "other.md"), "hub-only plain entry\n");
  git(["add", "-A"], checkout);
  git(["commit", "-m", "foreign writer adds a backslash-named file and a plain one"], checkout);
  git(["push", "origin", "HEAD:main"], checkout);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const payload = JSON.parse(result.stdout);
  const run = payload.runs[0];

  assert.equal(run.status, "applied");
  assert.ok(run.appliedFiles.includes("logs/other.md"), JSON.stringify(run.appliedFiles));
  assert.ok(
    run.notes.some((note: string) => note.includes("logs/back\\slash.md")),
    JSON.stringify(run.notes)
  );

  // The other file applied; the backslash-named one was neither mangled nor
  // otherwise written.
  assert.equal(
    fs.readFileSync(path.join(workspaceRoot, "logs", "other.md"), "utf8"),
    "hub-only plain entry\n"
  );
  assert.equal(fs.existsSync(path.join(workspaceRoot, "logs", "back")), false);
  assert.equal(fs.existsSync(path.join(workspaceRoot, "logs", "back\\slash.md")), false);
});

// moveBaseToCurrentRemote's own hub-side skip (restore.ts, review round 2
// finding #2): a backslash-named path a foreign writer added to the hub
// AFTER the commit this restore targets must not become a base-snapshot
// key. `restore --from-commit <seed sha>` restores the destination back to
// the pre-backslash state, but moveBaseToCurrentRemote still walks the
// CURRENT remote tree (which by then holds the backslash file) to rebuild
// the base map; it must skip that entry rather than record it raw or
// mangled.
test("restore --from-commit skips a hub-side backslash path when rebuilding the base snapshot", () => {
  const root = createSandbox("backslash-restore-base-skip");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(workspaceRoot, ".agent-memory-sync", "default");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  writeText(path.join(workspaceRoot, "logs", "plain.md"), "plain entry\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  // The clean seed: this is the commit `restore --from-commit` targets.
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const seedCheckout = cloneRemote(remoteDir, root, "seed");
  const seedSha = git(["rev-parse", "HEAD"], seedCheckout).trim();

  // A foreign writer adds a backslash-named file on top of the seed. The
  // remote tip now carries it; the seed commit does not.
  writeText(path.join(seedCheckout, "shared", "logs", "back\\slash.md"), "hub-only backslash entry\n");
  git(["add", "-A"], seedCheckout);
  git(["commit", "-m", "foreign writer adds a backslash-named file after the seed"], seedCheckout);
  git(["push", "origin", "HEAD:main"], seedCheckout);

  const result = runCli(
    ["restore", "default", "logs", "--config", configPath, "--from-commit", seedSha, "--yes", "--output", "json"]
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  // The seed's plain file is restored.
  assert.equal(
    fs.readFileSync(path.join(workspaceRoot, "logs", "plain.md"), "utf8"),
    "plain entry\n"
  );

  const stateStore = new StateStore(stateDir, "default");
  const baseSnapshots = stateStore.readBaseSnapshots();
  assert.equal(Object.prototype.hasOwnProperty.call(baseSnapshots, "logs/back\\slash.md"), false, JSON.stringify(Object.keys(baseSnapshots)));
  assert.equal(Object.prototype.hasOwnProperty.call(baseSnapshots, "logs/back/slash.md"), false, JSON.stringify(Object.keys(baseSnapshots)));
});

// The legacy single-commit form's --path guard (normalizeRequestedPath,
// restore.ts, review round 2 finding #3): an operator-typed --path value
// carrying a literal backslash is refused outright on non-win32, the same
// way a local sync path is, before this command even looks at the commit.
test("restore <sha> --path with a backslash is refused (exit 3)", () => {
  const root = createSandbox("backslash-restore-path-flag-refuse");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory root\n");
  writeText(path.join(workspaceRoot, "logs", "plain.md"), "plain entry\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const checkout = cloneRemote(remoteDir, root, "verify");
  const sha = git(["rev-parse", "HEAD"], checkout).trim();

  const result = runCli(
    ["restore", sha, "--path", "logs/back\\slash.md", "--config", configPath, "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(result.status, 3, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /back\\slash\.md/);
  assert.match(result.stderr, /backslash/i);
});

// The legacy whole-commit form (no --path, restore.ts's file-mode write
// loop, review round 2 finding #5): every target path is now mapped and
// validated before the first write. Before that fix, a commit containing a
// backslash-named path aborted mid-loop after already overwriting an
// earlier-sorted local file with the loop still holding a local-only edit.
// "MEMORY.md" sorts before "logs/back\slash.md" in git's own tree order, so
// this reproduces the exact ordering the bug depended on.
test("legacy restore <sha> --yes with a backslash path in the commit aborts before writing anything (exit 3)", () => {
  const root = createSandbox("backslash-restore-legacy-atomic");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "memory v1\n");
  writeText(path.join(workspaceRoot, "logs", "plain.md"), "plain v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // A local-only edit that must survive an aborted restore untouched.
  writeText(path.join(workspaceRoot, "MEMORY.md"), "local edit only\n");

  // A foreign writer adds a backslash-named file to the hub, on top of the
  // files already pushed above.
  const checkout = cloneRemote(remoteDir, root, "foreign-writer");
  writeText(path.join(checkout, "shared", "logs", "back\\slash.md"), "hub-only backslash entry\n");
  git(["add", "-A"], checkout);
  git(["commit", "-m", "foreign writer adds a backslash-named file"], checkout);
  git(["push", "origin", "HEAD:main"], checkout);
  const sha = git(["rev-parse", "HEAD"], checkout).trim();

  const result = runCli(
    ["restore", sha, "--yes", "--config", configPath, "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(result.status, 3, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /back\\slash\.md/);
  assert.match(result.stderr, /backslash/i);

  // Nothing was written: the local-only edit to the earlier-sorted MEMORY.md
  // survives exactly as it was before this restore ran.
  assert.equal(
    fs.readFileSync(path.join(workspaceRoot, "MEMORY.md"), "utf8"),
    "local edit only\n"
  );
  assert.equal(
    fs.readFileSync(path.join(workspaceRoot, "logs", "plain.md"), "utf8"),
    "plain v1\n"
  );
});
