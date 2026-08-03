// Repro A (agent-tasks 06d09cde / .ai/runs/2026-08-03-sync-conflict-markers-echo).
//
// Live incident this pins: `run --mode sync` runs performPull then
// performPush back-to-back (src/commands/run.ts executeMode). A genuine
// conflict on pull writes inline conflict markers to the local file
// (src/memory-sync/pull.ts) and — correctly — sets the state store's base
// snapshot to the CLEAN remote content it just fetched
// (stateStore.replaceBaseSnapshots(remoteMap)). The very next push in that
// same sync then reads that marker-corrupted file back off local disk
// (collectLocalSyncFiles) as its "local" snapshot; since nothing else
// changed the remote in between, push's own 3-way merge sees
// `remote === base` and takes the "local wins" fast path
// (src/memory-sync/merge.ts) — which, before this fix, returned
// `conflict: false` unconditionally, so the marker-carrying content was
// pushed to the remote AND committed to the local base snapshot while the
// run reported a clean 0-conflict outcome. Two rapid remote pushes plus a
// concurrent local edit produced exactly this on the mac mini on
// 2026-08-03 (see 00-goal.md's "Reproduktion" section).
//
// This test drives pull and push as two separate CLI invocations against the
// SAME stateDir/rootDir/remote (the task brief explicitly allows "im selben
// Prozess/StateStore" — every relevant artifact pull leaves behind, the
// marker-corrupted local file and the state store's base snapshot, is on
// disk, so two sequential CLI calls reproduce the identical on-disk state
// transition a single in-process `--mode sync` would). Splitting the calls
// also lets this test inspect the PUSH step's own JSON report in isolation —
// asserting only on a combined `--mode sync` result would not distinguish
// the bug from the fix, because pull's OWN conflict detection for the
// initial marker-producing conflict was never broken (only the SUBSEQUENT
// push's re-labeling of that already-marker-carrying content was).
const test = require("node:test");
const assert = require("node:assert/strict");
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

function createConfig(workspaceRoot: string, remoteDir: string, stateDir: string) {
  return {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: [{ source: "MEMORY.md", destination: "MEMORY.md", kind: "file" }]
  };
}

test(
  "a push immediately following a pull that produced local conflict markers reports the file as a " +
    "conflict, not silently as a clean local win",
  () => {
    const root = createSandbox("push-conflict-marker-honesty");
    const remoteDir = initBareRemote(root);
    const workspaceRoot = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "config.json");

    writeText(path.join(workspaceRoot, "MEMORY.md"), "base\n");
    writeProjectConfig(configPath, createConfig(workspaceRoot, remoteDir, stateDir));

    // Establish "base\n" as both the remote content and this workspace's
    // known base snapshot.
    const seed = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
    assert.equal(JSON.parse(seed.stdout).runs[0].status, "applied");

    // A peer fully replaces the remote file (not an append — the base/local/
    // remote three-way append merge must not silently absorb this), without
    // this workspace ever pulling it.
    const peerCheckout = cloneRemote(remoteDir, root, "peer");
    writeText(path.join(peerCheckout, "shared", "MEMORY.md"), "remote v2\n");
    git(["add", "."], peerCheckout);
    git(["commit", "-m", "remote replaced"], peerCheckout);
    git(["push", "origin", "HEAD:main"], peerCheckout);

    // Meanwhile this workspace also fully replaces its local copy, with
    // content unrelated to the remote's replacement — base, local, and
    // remote now all three differ and are not append-compatible, so pull
    // must hit the genuine single-pass conflict fallback.
    writeText(path.join(workspaceRoot, "MEMORY.md"), "local v2\n");

    const pullResult = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
    const pullPayload = JSON.parse(pullResult.stdout).runs[0];
    assert.ok(
      pullPayload.conflictFiles.includes("MEMORY.md"),
      `sanity: pull's own genuine conflict must be reported, got: ${JSON.stringify(pullPayload.conflictFiles)}`
    );

    const afterPull = readText(path.join(workspaceRoot, "MEMORY.md"));
    assert.match(afterPull, /<<<<<<< local/, "sanity: pull must have written inline conflict markers locally");
    assert.match(afterPull, /local v2/);
    assert.match(afterPull, /remote v2/);
    assert.match(afterPull, />>>>>>> remote/);

    // Nothing else touches the remote between the pull and this push, so
    // push's own 3-way merge sees remote === base and takes the "local
    // wins" fast path with the marker-carrying local content as the winner
    // — the exact blind spot this task closes.
    const pushResult = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
    const pushPayload = JSON.parse(pushResult.stdout).runs[0];

    assert.ok(
      pushPayload.appliedFiles.includes("MEMORY.md"),
      `expected MEMORY.md among push's appliedFiles: ${JSON.stringify(pushPayload.appliedFiles)}`
    );
    assert.ok(
      pushPayload.conflictFiles.includes("MEMORY.md"),
      "push must report the marker-carrying file as a conflict, not silently as a clean local win " +
        `(conflicts=0 hides that a real conflict landed on the remote); got conflictFiles: ${JSON.stringify(
          pushPayload.conflictFiles
        )}`
    );

    // The payload itself is intentionally not rewritten by this fix — only
    // the conflict flag becomes honest. The marker content still reaches
    // the remote (identical to what a genuine single-pass conflict already
    // does, and already covered by watch-mirror-delete.test.ts's pinned
    // negative control) — but now correctly flagged as a conflict instead
    // of hidden behind conflicts=0.
    const inspection = cloneRemote(remoteDir, root, "inspect-after-push");
    const remoteContent = readText(path.join(inspection, "shared", "MEMORY.md"));
    assert.match(remoteContent, /<<<<<<< local/);
    assert.match(remoteContent, /local v2/);
    assert.match(remoteContent, /remote v2/);
    assert.match(remoteContent, />>>>>>> remote/);
  }
);
