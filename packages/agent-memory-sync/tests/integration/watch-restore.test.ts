// Watch-spawning tests in this file use the shared spawn/arming/deadline
// helpers in ../helpers/watch-process.ts (also used by
// watch-mirror-delete.test.ts): runWatchTick() waits for watch's own
// chokidar-'ready'-driven "watching N path(s) under ..." line before
// applying the trigger edit, instead of a fixed sleep() — a fixed delay is
// not a structural fix for watch's initial-scan race (most visible on
// inotify/Linux, worse under CI load), it only narrows the window; see that
// file's header comment for the full explanation. --verbose is required for
// the ready line to print at all (writeInfo, src/output.ts, is a no-op
// otherwise) — none of the assertions below match on exact/full stderr
// content, so the extra --verbose log lines this enables are harmless here.
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
  readText,
  runCli,
  writeProjectConfig,
  writeText
} = require("../helpers/cli.ts");
const { runWatchTick } = require("../helpers/watch-process.ts");

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("watch debounces N rapid changes into a single commit", async () => {
  const root = createSandbox("watch-debounce");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const inspectionBefore = cloneRemote(remoteDir, root, "before");
  const headBefore = git(["rev-parse", "HEAD"], inspectionBefore).trim();

  const { exitCode, stderr } = await runWatchTick(
    configPath,
    async () => {
      for (let i = 0; i < 7; i += 1) {
        writeText(path.join(workspaceRoot, "MEMORY.md"), `change ${i}\n`);
        await sleep(20);
      }
    },
    { debounceMs: 400 }
  );
  assert.equal(exitCode, 0, `watch exited non-zero. stderr: ${stderr}`);

  const inspectionAfter = cloneRemote(remoteDir, root, "after");
  const log = git(["log", "--oneline", `${headBefore}..HEAD`], inspectionAfter).trim();
  const commitCount = log.length === 0 ? 0 : log.split("\n").length;
  assert.equal(commitCount, 1, `expected exactly 1 new commit, got ${commitCount}:\n${log}`);
  assert.equal(readText(path.join(inspectionAfter, "shared", "MEMORY.md")), "change 6\n");
});

test("watch produces a single-file commit message when only one path changed", async () => {
  const root = createSandbox("watch-msg-single");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const { exitCode } = await runWatchTick(configPath, () => {
    writeText(path.join(workspaceRoot, "MEMORY.md"), "updated\n");
  });
  assert.equal(exitCode, 0);

  const inspection = cloneRemote(remoteDir, root, "msg-single");
  const subject = git(["log", "-1", "--format=%s"], inspection).trim();
  assert.equal(subject, "update MEMORY.md");
});

test("watch produces an aggregated commit message for multiple file changes", async () => {
  const root = createSandbox("watch-msg-multi");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeText(path.join(workspaceRoot, "logs", "2026-05-01.md"), "log 1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const { exitCode } = await runWatchTick(
    configPath,
    () => {
      writeText(path.join(workspaceRoot, "MEMORY.md"), "updated\n");
      writeText(path.join(workspaceRoot, "logs", "2026-05-01.md"), "log 1 v2\n");
      writeText(path.join(workspaceRoot, "logs", "2026-05-02.md"), "log 2\n");
    },
    { debounceMs: 400 }
  );
  assert.equal(exitCode, 0);

  const inspection = cloneRemote(remoteDir, root, "msg-multi");
  const subject = git(["log", "-1", "--format=%s"], inspection).trim();
  const body = git(["log", "-1", "--format=%b"], inspection).trim();
  assert.match(subject, /^update 3 memories$/);
  assert.match(body, /- update MEMORY\.md/);
  assert.match(body, /- update logs\/2026-05-01\.md/);
  assert.match(body, /- update logs\/2026-05-02\.md/);
});

test("watch records deletions as remove entries", async () => {
  const root = createSandbox("watch-delete");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeText(path.join(workspaceRoot, "logs", "2026-05-01.md"), "log 1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const { exitCode } = await runWatchTick(configPath, () => {
    fs.rmSync(path.join(workspaceRoot, "logs", "2026-05-01.md"));
  });
  assert.equal(exitCode, 0);

  const inspection = cloneRemote(remoteDir, root, "delete");
  const subject = git(["log", "-1", "--format=%s"], inspection).trim();
  assert.equal(subject, "remove logs/2026-05-01.md");
  assert.equal(fileExists(path.join(inspection, "shared", "logs", "2026-05-01.md")), false);
});

test("restore --path writes a single file byte-identical from a snapshot SHA", () => {
  const root = createSandbox("restore-single");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "snapshot 1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const snapshot1Sha = git(["rev-parse", "HEAD"], cloneRemote(remoteDir, root, "rev1")).trim();

  writeText(path.join(workspaceRoot, "MEMORY.md"), "snapshot 2\n");
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "snapshot 2\n");

  const result = runCli([
    "restore",
    snapshot1Sha,
    "--config",
    configPath,
    "--path",
    "MEMORY.md",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "restore");
  assert.equal(payload.sha, snapshot1Sha);
  assert.equal(payload.restored.length, 1);
  assert.equal(payload.restored[0].remoteRelativePath, "MEMORY.md");

  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "snapshot 1\n");
});

test("restore --yes restores the full snapshot tree", () => {
  const root = createSandbox("restore-full");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v1\n");
  writeText(path.join(workspaceRoot, "logs", "2026-05-01.md"), "log v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const snapshot1Sha = git(["rev-parse", "HEAD"], cloneRemote(remoteDir, root, "rev1")).trim();

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v2\n");
  writeText(path.join(workspaceRoot, "logs", "2026-05-01.md"), "log v2\n");
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const result = runCli([
    "restore",
    snapshot1Sha,
    "--config",
    configPath,
    "--yes",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.restored.length, 2);

  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "v1\n");
  assert.equal(readText(path.join(workspaceRoot, "logs", "2026-05-01.md")), "log v1\n");
});

test("restore without --yes/--path/--dry-run is rejected", () => {
  const root = createSandbox("restore-guard");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const snapshotSha = git(["rev-parse", "HEAD"], cloneRemote(remoteDir, root, "rev1")).trim();

  const result = runCli(
    ["restore", snapshotSha, "--config", configPath, "--output", "json"],
    { expectFailure: true }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --yes/);
});

test("restore --dry-run lists targets without writing", () => {
  const root = createSandbox("restore-dry");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const snapshotSha = git(["rev-parse", "HEAD"], cloneRemote(remoteDir, root, "rev1")).trim();

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v2\n");
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const result = runCli([
    "restore",
    snapshotSha,
    "--config",
    configPath,
    "--dry-run",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.restored.length, 1);

  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "v2\n");
});

test("restore --path rejects path-traversal payloads", () => {
  const root = createSandbox("restore-traversal");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "logs", "2026-05-01.md"), "v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const snapshotSha = git(["rev-parse", "HEAD"], cloneRemote(remoteDir, root, "rev1")).trim();

  for (const payload of ["logs/../../etc/passwd", "../escape.md", "logs//double"]) {
    const result = runCli(
      [
        "restore",
        snapshotSha,
        "--config",
        configPath,
        "--path",
        payload,
        "--output",
        "json"
      ],
      { expectFailure: true }
    );
    assert.notEqual(result.status, 0, `payload '${payload}' should be rejected`);
    assert.match(result.stderr, /invalid|cannot map/i);
  }
});

test("restore rejects an unknown sha with a loud non-zero exit", () => {
  const root = createSandbox("restore-bad-sha");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const result = runCli(
    ["restore", "deadbeef", "--config", configPath, "--yes", "--output", "json"],
    { expectFailure: true }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fetch|deadbeef|not.+exist/i);
  // Pins the AC-3 hint: `deadbeef` is short (8 hex chars), and unresolvable
  // both locally and via an explicit remote fetch (see the short-sha tests
  // below for the resolvable case), so the error should say outright that a
  // full 40-character sha is required instead of leaving the reader to
  // guess why a seemingly valid-looking hex string failed.
  assert.match(result.stderr, /40.character sha/i);
});

// Reproduces the documented restore-short-sha failure (README.md's restore
// section, docs/machine-setup.md): `git fetch origin <ref>` only accepts a
// ref name or a *full* object id from a remote — an abbreviated commit sha
// is never resolvable that way, so restore used to fail with a bare "could
// not fetch ref" even though the commit is right there in history.
//
// Fix: restore's working copy is prepared via prepareWorkingCopy(), which
// already runs a full `git fetch origin <branch>` and so already has every
// commit reachable from that branch tip as a local object — the short sha
// is resolvable locally (no network round-trip needed) via `git rev-parse
// --verify` before ever attempting the remote-only fetchRef path. This
// pins the common case (restoring from an older commit on the configured
// branch, the only realistic use of `restore`) actually working with a
// short sha, not just a friendlier error message.
test("restore <short-sha> resolves against the already-fetched branch history and restores successfully", () => {
  const root = createSandbox("restore-short-sha");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "snapshot 1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));

  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const inspection = cloneRemote(remoteDir, root, "rev1");
  const fullSha = git(["rev-parse", "HEAD"], inspection).trim();
  const shortSha = git(["rev-parse", "--short", "HEAD"], inspection).trim();
  assert.ok(shortSha.length < fullSha.length, "test fixture assumption: short sha must be abbreviated");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "snapshot 2\n");
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const result = runCli([
    "restore",
    shortSha,
    "--config",
    configPath,
    "--path",
    "MEMORY.md",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.restored.length, 1);
  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), "snapshot 1\n");
  // Pins that the reported sha is the resolved FULL commit actually restored
  // from, not an echo of the abbreviation the operator typed — restore.ts
  // captures GitClient.resolveLocalCommit's return value and threads it
  // through to the payload instead of discarding it after the truthiness
  // check.
  assert.equal(payload.sha, fullSha);
});

test("restore <short-sha> that is not reachable from the configured branch fails loudly with an explicit full-sha hint", () => {
  const root = createSandbox("restore-short-sha-unreachable");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "v1\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // A well-formed but short hex string that is not a prefix of any object
  // reachable from the branch (nor known to the remote at all) — neither
  // local resolution nor the fallback remote fetchRef can succeed.
  const result = runCli(
    ["restore", "0123abc", "--config", configPath, "--yes", "--output", "json"],
    { expectFailure: true }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /40.character sha/i);
});
