// A destination restore whose write or removal cannot succeed stops before it
// takes its pre-apply copy. The cause is persistent, so a restore that took
// the copy first would write one more generation per retry and rotate the
// older ones away, including the generation it was asked to restore from.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  cloneRemote,
  createSandbox,
  git,
  initBareRemote,
  readText,
  runCli,
  writeProjectConfig,
  writeText
} = require("../helpers/cli.ts");

function setup(name: string, options: { nested?: boolean } = {}) {
  const root = createSandbox(name);
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(root, "state");
  for (let index = 0; index < 6; index += 1) {
    writeText(path.join(workspaceRoot, "logs", `note-${index}.md`), `entry ${index}\n`);
  }
  if (options.nested) {
    writeText(path.join(workspaceRoot, "logs", "sub", "deep.md"), "deep\n");
  }
  // Two generations is the whole retention, so one more written generation
  // rotates the oldest away.
  writeProjectConfig(configPath, {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    snapshotGenerations: 2,
    syncPaths: [{ source: "logs", destination: "logs", kind: "directory" }]
  });
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // Two pulls that each remove one file, so each takes one generation; the
  // oldest one still holds all six files.
  for (const [label, name] of [
    ["peer-1", "note-0.md"],
    ["peer-2", "note-1.md"]
  ]) {
    const checkout = cloneRemote(remoteDir, root, label);
    fs.rmSync(path.join(checkout, "shared", "logs", name));
    git(["add", "-A"], checkout);
    git(["commit", "-m", `peer removes ${name}`], checkout);
    git(["push", "origin", "HEAD:main"], checkout);
    runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  }

  const snapshotDir = path.join(stateDir, "snapshots", "logs");
  const generations = fs.readdirSync(snapshotDir).sort();
  assert.equal(generations.length, 2, "two generations are seeded");

  return {
    workspaceRoot,
    snapshotDir,
    oldest: generations[0],
    generations,
    restore: (expectFailure: boolean) =>
      runCli(
        [
          "restore",
          "default",
          "logs",
          "--config",
          configPath,
          "--from-snapshot",
          generations[0],
          "--yes",
          "--output",
          "json"
        ],
        { expectFailure }
      )
  };
}

test("restore: a read-only destination stops with exit 12 before any snapshot and keeps the source generation", (t: {
  skip: (reason: string) => void;
}) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("a read-only directory does not stop root");
    return;
  }
  const ctx = setup("restore-eacces");
  const logsDir = path.join(ctx.workspaceRoot, "logs");
  const before = fs.readdirSync(logsDir).sort();
  fs.chmodSync(logsDir, 0o555);
  try {
    // snapshotGenerations is 2: a third run that took its copy first would
    // have rotated the oldest generation, the one named below, away.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = ctx.restore(true);
      assert.equal(result.status, 12, `attempt ${attempt}: ${result.stderr}`);
      assert.match(
        result.stderr,
        new RegExp(
          `restore stopped: ${logsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/note-0\\.md cannot be created: ` +
            `${logsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not writable`
        )
      );
      assert.match(result.stderr, /No file was written or removed and no pre-apply snapshot was taken/);
      assert.match(result.stderr, /every existing snapshot generation is still there/);
    }
  } finally {
    fs.chmodSync(logsDir, 0o755);
  }

  assert.deepEqual(fs.readdirSync(ctx.snapshotDir).sort(), ctx.generations, "no generation was written or dropped");
  assert.deepEqual(fs.readdirSync(logsDir).sort(), before, "the destination is unchanged");

  // The cause is gone; the generation the operator asked for is still there.
  const restored = ctx.restore(false);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).source.snapshot, ctx.oldest);
  assert.equal(readText(path.join(logsDir, "note-0.md")), "entry 0\n");
});

test("restore: a read-only file the restore must overwrite stops before any snapshot", (t: {
  skip: (reason: string) => void;
}) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("a read-only file does not stop root");
    return;
  }
  const ctx = setup("restore-readonly-file");
  const target = path.join(ctx.workspaceRoot, "logs", "note-3.md");
  writeText(target, "edited after the snapshot\n");
  fs.chmodSync(target, 0o444);
  try {
    const result = ctx.restore(true);
    assert.equal(result.status, 12, result.stderr);
    assert.match(result.stderr, /restore stopped: .*note-3\.md is not writable\./);
  } finally {
    fs.chmodSync(target, 0o644);
  }

  assert.deepEqual(fs.readdirSync(ctx.snapshotDir).sort(), ctx.generations, "no generation was written or dropped");
  assert.equal(readText(target), "edited after the snapshot\n");
});

test("restore: a directory where the restore must write a file stops before any snapshot", () => {
  const ctx = setup("restore-eisdir");
  const blocker = path.join(ctx.workspaceRoot, "logs", "note-0.md");
  writeText(path.join(blocker, "inside.md"), "kept\n");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = ctx.restore(true);
    assert.equal(result.status, 12, `attempt ${attempt}: ${result.stderr}`);
    assert.match(result.stderr, /restore stopped: .*note-0\.md is a directory, not a file the restore can write\./);
  }

  assert.deepEqual(fs.readdirSync(ctx.snapshotDir).sort(), ctx.generations, "no generation was written or dropped");
  assert.equal(readText(path.join(blocker, "inside.md")), "kept\n");
});

test("restore --dry-run reports the same stop instead of previewing a write that cannot happen", () => {
  const ctx = setup("restore-dry-run");
  writeText(path.join(ctx.workspaceRoot, "logs", "note-0.md", "inside.md"), "kept\n");

  const result = runCli(
    [
      "restore",
      "default",
      "logs",
      "--config",
      path.join(path.dirname(ctx.workspaceRoot), "config.json"),
      "--from-snapshot",
      ctx.oldest,
      "--dry-run",
      "--output",
      "json"
    ],
    { expectFailure: true }
  );

  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stderr, /restore stopped: .*note-0\.md is a directory/);
});

test("restore: an extra file in a read-only subfolder stops N+1 runs before any snapshot", (t: {
  skip: (reason: string) => void;
}) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("a read-only directory does not stop root");
    return;
  }
  const ctx = setup("restore-unremovable");
  const folder = path.join(ctx.workspaceRoot, "logs", "extras");
  writeText(path.join(folder, "extra.md"), "not in the snapshot\n");
  fs.chmodSync(folder, 0o555);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = ctx.restore(true);
      assert.equal(result.status, 12, `attempt ${attempt}: ${result.stderr}`);
      assert.match(
        result.stderr,
        new RegExp(
          `restore stopped: .*extra\\.md cannot be removed: ${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not writable`
        )
      );
    }
  } finally {
    fs.chmodSync(folder, 0o755);
  }

  assert.deepEqual(fs.readdirSync(ctx.snapshotDir).sort(), ctx.generations, "no generation was written or dropped");
  assert.equal(readText(path.join(folder, "extra.md")), "not in the snapshot\n");
});

test("restore: a dangling symlink at a path the restore must write stops before any snapshot", (t: {
  skip: (reason: string) => void;
}) => {
  const ctx = setup("restore-dangling-link");
  const link = path.join(ctx.workspaceRoot, "logs", "note-0.md");
  try {
    fs.symlinkSync(path.join(ctx.workspaceRoot, "nowhere.md"), link);
  } catch {
    t.skip("symlinks are not available on this platform");
    return;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = ctx.restore(true);
    assert.equal(result.status, 12, `attempt ${attempt}: ${result.stderr}`);
    assert.match(result.stderr, /restore stopped: .*note-0\.md is a symlink whose target does not exist/);
  }

  assert.deepEqual(fs.readdirSync(ctx.snapshotDir).sort(), ctx.generations, "no generation was written or dropped");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, "the symlink is still there");
});

test("restore: a regular file where the restore needs a parent directory stops before any snapshot", () => {
  const ctx = setup("restore-parent-file", { nested: true });
  const parent = path.join(ctx.workspaceRoot, "logs", "sub");
  fs.rmSync(parent, { recursive: true });
  writeText(parent, "a file, not a folder\n");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = ctx.restore(true);
    assert.equal(result.status, 12, `attempt ${attempt}: ${result.stderr}`);
    assert.match(result.stderr, /restore stopped: .*deep\.md cannot be created: .*sub is not a directory/);
  }

  assert.deepEqual(fs.readdirSync(ctx.snapshotDir).sort(), ctx.generations, "no generation was written or dropped");
  assert.equal(readText(parent), "a file, not a folder\n");
});
