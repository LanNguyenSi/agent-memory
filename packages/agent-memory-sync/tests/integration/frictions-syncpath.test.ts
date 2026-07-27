// Pins the frictions syncPaths convention (agent-tasks 343d5a8f: "agent-memory-sync:
// frictions syncPaths-Eintrag in allen Maschinen-Profilen"): a third,
// independent directory-kind syncPaths entry whose `source` is an ABSOLUTE
// path OUTSIDE rootDir — mirroring profiles/mac-mini.json, profiles/macbook.json,
// and profiles/linux.example.json's real frictions entry, which points at
// ~/.harness/frictions rather than anywhere under the Claude Code memory
// rootDir. This is the exact PR-#64 machine-state-syncpath pattern (see
// tests/integration/machine-state-syncpath.test.ts) applied to the frictions
// payload — same two guarantees, both already true of
// collectLocalSyncFiles/mapRemotePathToLocalAbsolute in
// src/memory-sync/config.ts and src/memory-sync/pull.ts WITHOUT any code
// change:
//   1. A directory-kind entry with an absolute `source` syncs correctly
//      end-to-end through push+pull alongside sibling entries —
//      resolveWorkspacePath (src/memory-sync/config.ts) treats an absolute
//      candidate as-is instead of resolving it against rootDir.
//   2. Neither `push` nor `pull` breaks when that absolute source directory
//      does not exist locally yet: config.ts's collectLocalSyncFiles skips a
//      non-required syncPaths entry whose source is missing (existsSync
//      check, `continue`), and pull's writer
//      (mkdirSync(path.dirname(...), { recursive: true }) in
//      src/memory-sync/pull.ts) creates that absolute directory the first
//      time a peer's snapshot is pulled — so a fresh machine's frictions
//      directory need not pre-exist before its first pull.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  cloneRemote,
  createSandbox,
  fileExists,
  initBareRemote,
  readText,
  runCli,
  writeProjectConfig,
  writeText
} = require("../helpers/cli.ts");

function twoEntryConfig(
  workspaceRoot: string,
  remoteDir: string,
  stateDir: string,
  frictionsSource: string
) {
  return {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: [
      { source: "MEMORY.md", destination: "MEMORY.md", kind: "file" },
      { source: frictionsSource, destination: "frictions", kind: "directory" }
    ]
  };
}

test("push tolerates a second syncPaths directory entry whose absolute source does not exist locally yet", () => {
  const root = createSandbox("frictions-missing-source");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  // Absolute path outside rootDir/workspaceRoot, deliberately never
  // created — mirrors a fresh machine that has not written a friction-log
  // export to ~/.harness/frictions yet.
  const frictionsSource = path.join(root, "harness-frictions");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeProjectConfig(configPath, twoEntryConfig(workspaceRoot, remoteDir, stateDir, frictionsSource));
  assert.equal(fileExists(frictionsSource), false);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "applied");
  assert.ok(
    payload.runs[0].appliedFiles.some((f: string) => f.endsWith("MEMORY.md")),
    `expected MEMORY.md in appliedFiles: ${JSON.stringify(payload.runs[0].appliedFiles)}`
  );
  assert.ok(
    !payload.runs[0].appliedFiles.some((f: string) => f.startsWith("frictions/")),
    `missing source should not have synced anything: ${JSON.stringify(payload.runs[0].appliedFiles)}`
  );

  const inspection = cloneRemote(remoteDir, root, "inspect-missing-source");
  assert.equal(fileExists(path.join(inspection, "shared", "frictions")), false);
});

test(
  "push and pull round-trip a directory syncPaths entry whose source is absolute and outside rootDir, " +
    "and pull creates that directory locally if missing (mkdir -p semantics)",
  () => {
    const root = createSandbox("frictions-roundtrip");
    const remoteDir = initBareRemote(root);

    // Machine A already has a friction-log export on disk and pushes it.
    const workspaceA = path.join(root, "workspace-a");
    const stateDirA = path.join(root, "state-a");
    const configPathA = path.join(root, "config-a.json");
    const frictionsSourceA = path.join(root, "machine-a-harness-frictions");

    writeText(path.join(workspaceA, "MEMORY.md"), "machine a memory\n");
    writeText(path.join(frictionsSourceA, "mac-mini.json"), '{"frictions":[]}\n');
    writeProjectConfig(configPathA, twoEntryConfig(workspaceA, remoteDir, stateDirA, frictionsSourceA));

    const pushResult = runCli(["run", "default", "--config", configPathA, "--mode", "push", "--output", "json"]);
    const pushPayload = JSON.parse(pushResult.stdout);
    assert.equal(pushPayload.runs[0].status, "applied");
    assert.ok(
      pushPayload.runs[0].appliedFiles.includes("frictions/mac-mini.json"),
      `expected frictions/mac-mini.json in appliedFiles: ${JSON.stringify(pushPayload.runs[0].appliedFiles)}`
    );

    // Machine B has never written to its frictions source directory — it
    // (and its rootDir) do not exist on disk at all before the pull below,
    // matching a brand-new machine's first `run --mode pull`.
    const workspaceB = path.join(root, "workspace-b");
    const stateDirB = path.join(root, "state-b");
    const configPathB = path.join(root, "config-b.json");
    const frictionsSourceB = path.join(root, "machine-b-harness-frictions");

    writeProjectConfig(configPathB, twoEntryConfig(workspaceB, remoteDir, stateDirB, frictionsSourceB));
    assert.equal(fileExists(frictionsSourceB), false);
    assert.equal(fileExists(workspaceB), false);

    const pullResult = runCli(["run", "default", "--config", configPathB, "--mode", "pull", "--output", "json"]);
    const pullPayload = JSON.parse(pullResult.stdout);
    assert.equal(pullPayload.runs[0].status, "applied");
    assert.ok(
      pullPayload.runs[0].appliedFiles.includes("frictions/mac-mini.json"),
      `expected frictions/mac-mini.json in pull appliedFiles: ${JSON.stringify(pullPayload.runs[0].appliedFiles)}`
    );

    assert.equal(fileExists(frictionsSourceB), true);
    assert.equal(readText(path.join(frictionsSourceB, "mac-mini.json")), '{"frictions":[]}\n');
    assert.equal(readText(path.join(workspaceB, "MEMORY.md")), "machine a memory\n");
  }
);
