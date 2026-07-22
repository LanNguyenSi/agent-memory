// Pins that agent-memory-sync's recursive directory sync (syncPaths with
// kind "directory", e.g. the shared repositorySubdir/source:"." pattern
// every committed profile under profiles/ uses) never sweeps up hidden
// files or dot-directories — .DS_Store, AppleDouble shadow files (._*, also
// dot-prefixed so the same check covers them), .git, editor dotfiles, etc.
// On macOS these are machine-local cruft that differs byte-for-byte between
// machines; syncing them produces spurious recurring inline-conflict-marker
// diffs on every run. Symmetric: a hidden path already sitting in the
// remote (legacy junk from before this fix, or committed by hand) must not
// be materialized locally by pull either.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { cloneRemote, createSandbox, fileExists, git, initBareRemote, readText, runCli, writeProjectConfig, writeText } = require("../helpers/cli.ts");

function directoryRootConfig(workspaceRoot: string, remoteDir: string, stateDir: string) {
  return {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    conflictStrategy: "inline-markers",
    // Matches the real profiles/*.json pattern (a single directory-root
    // entry), which is exactly what surfaced this bug in production.
    syncPaths: [{ source: ".", destination: "memory", kind: "directory" }]
  };
}

test("push skips hidden files and dot-directories under rootDir (.DS_Store, nested .DS_Store, dotfile, .git)", () => {
  const root = createSandbox("hidden-push");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  // stateDir lives outside workspaceRoot (matches the committed profiles'
  // pattern) so this test is only exercising the hidden-file filter, not
  // the separate state-containment concern.
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "visible content\n");
  writeText(path.join(workspaceRoot, ".DS_Store"), "top-level DS_Store\n");
  writeText(path.join(workspaceRoot, ".hidden-secret"), "should never sync\n");
  writeText(path.join(workspaceRoot, "sub", ".DS_Store"), "nested DS_Store\n");
  writeText(path.join(workspaceRoot, "sub", "visible-nested.md"), "nested visible\n");
  writeText(path.join(workspaceRoot, ".git", "config"), "pretend .git internals\n");
  writeProjectConfig(configPath, directoryRootConfig(workspaceRoot, remoteDir, stateDir));

  const result = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "applied");
  const applied: string[] = payload.runs[0].appliedFiles;

  assert.ok(applied.some((f) => f.endsWith("MEMORY.md")), `expected MEMORY.md in appliedFiles: ${JSON.stringify(applied)}`);
  assert.ok(
    applied.some((f) => f.endsWith("visible-nested.md")),
    `expected sub/visible-nested.md in appliedFiles: ${JSON.stringify(applied)}`
  );
  assert.ok(!applied.some((f) => f.includes(".DS_Store")), `hidden file leaked into appliedFiles: ${JSON.stringify(applied)}`);
  assert.ok(!applied.some((f) => f.includes(".hidden-secret")), `hidden file leaked into appliedFiles: ${JSON.stringify(applied)}`);
  assert.ok(!applied.some((f) => f.includes(".git")), `.git directory contents leaked into appliedFiles: ${JSON.stringify(applied)}`);

  const inspectionDir = cloneRemote(remoteDir, root, "inspect-hidden");
  assert.equal(fileExists(path.join(inspectionDir, "shared", "memory", ".DS_Store")), false);
  assert.equal(fileExists(path.join(inspectionDir, "shared", "memory", ".hidden-secret")), false);
  assert.equal(fileExists(path.join(inspectionDir, "shared", "memory", "sub", ".DS_Store")), false);
  assert.equal(fileExists(path.join(inspectionDir, "shared", "memory", ".git")), false);
  assert.equal(fileExists(path.join(inspectionDir, "shared", "memory", "MEMORY.md")), true);
});

test("pull does not materialize a hidden file that already exists in the remote (legacy junk)", () => {
  const root = createSandbox("hidden-pull");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");

  // Seed the bare repo directly with raw git, bypassing agent-memory-sync's
  // own push entirely — simulates hidden junk that predates this fix (or
  // was committed by hand), independent of whether push itself is fixed.
  const seedCheckout = cloneRemote(remoteDir, root, "seed");
  writeText(path.join(seedCheckout, "shared", "memory", "MEMORY.md"), "seed content\n");
  writeText(path.join(seedCheckout, "shared", "memory", ".DS_Store"), "legacy junk\n");
  git(["add", "-A"], seedCheckout);
  git(["commit", "-m", "seed with legacy hidden junk"], seedCheckout);
  git(["push", "origin", "HEAD:main"], seedCheckout);

  // No local MEMORY.md yet — this is a fresh machine's first pull, so
  // there's nothing to merge/conflict with; the assertion below is purely
  // about the hidden file, not merge behavior.
  writeProjectConfig(configPath, directoryRootConfig(workspaceRoot, remoteDir, stateDir));

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "applied");
  assert.ok(
    !payload.runs[0].appliedFiles.some((f: string) => f.includes(".DS_Store")),
    `hidden remote file leaked into pull's appliedFiles: ${JSON.stringify(payload.runs[0].appliedFiles)}`
  );
  assert.equal(fileExists(path.join(workspaceRoot, ".DS_Store")), false);
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "seed content\n");
});
