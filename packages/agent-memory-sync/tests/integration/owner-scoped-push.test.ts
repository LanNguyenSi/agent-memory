// Repro B (agent-tasks 06d09cde / .ai/runs/2026-08-03-sync-conflict-markers-echo).
//
// Defect: a directory-kind syncPaths entry (e.g. machine-state, frictions)
// has no ownership concept — collectLocalSyncFiles (src/memory-sync/config.ts)
// offers every file under the directory, including a peer's file this
// machine merely materialized via a prior `pull`. A subsequent `push` then
// re-offers that peer's file as if it were this machine's own local change
// (an echo) and can win a last-writer-wins race against the peer's own,
// newer push.
//
// Fix (Teil 2, D-002/D-003/D-004 in
// .ai/runs/2026-08-03-sync-conflict-markers-echo/03-decisions.md): an
// optional `ownerScoped: true` on a directory syncPaths entry restricts what
// PUSH offers from that directory to exactly `<profile>.json` — this
// machine's own file, named after its own `profile` config field. Pull is
// untouched (D-004) — a peer's file is still pulled/materialized locally,
// exactly like today.
//
// This test proves the echo is eliminated even in the adversarial case where
// it would otherwise matter most: machine B's locally-materialized copy of
// machine A's file is STALE (A pushed again after B's last pull) — without
// the fix, B's push could overwrite A's newer remote content with B's stale
// local copy. With the fix, B never offers A's file at all, regardless of
// staleness.
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

function ownerScopedConfig(
  workspaceRoot: string,
  remoteDir: string,
  stateDir: string,
  profile: string,
  machineStateSource: string
) {
  return {
    profile,
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: [
      { source: "MEMORY.md", destination: "MEMORY.md", kind: "file" },
      { source: machineStateSource, destination: "machine-state", kind: "directory", ownerScoped: true }
    ]
  };
}

test(
  "push never re-offers a peer's ownerScoped file that was only materialized locally by a prior pull, " +
    "even when that local copy is stale",
  () => {
    const root = createSandbox("owner-scoped-echo");
    const remoteDir = initBareRemote(root);

    // Machine A: profile "machine-a", writes its own machine-state file and
    // pushes it.
    const workspaceA = path.join(root, "workspace-a");
    const stateDirA = path.join(root, "state-a");
    const configPathA = path.join(root, "config-a.json");
    const machineStateSourceA = path.join(root, "machine-a-harness-state");

    writeText(path.join(workspaceA, "MEMORY.md"), "machine a memory\n");
    writeText(path.join(machineStateSourceA, "machine-a.json"), '{"v":1}\n');
    writeProjectConfig(
      configPathA,
      ownerScopedConfig(workspaceA, remoteDir, stateDirA, "machine-a", machineStateSourceA)
    );

    // The profile name is passed positionally (not "default") because the
    // CLI's [profile] positional argument overrides the config file's
    // "profile" field in resolveRunConfig's merge order (overrides applied
    // last) — the same "pass BOTH --config and the profile name" pattern
    // profiles/mac-mini.json etc. document, and now load-bearing: the
    // ownerScoped filter's `<profile>.json` filename comes from this field.
    const pushA1 = runCli(["run", "machine-a", "--config", configPathA, "--mode", "push", "--output", "json"]);
    const pushA1Payload = JSON.parse(pushA1.stdout).runs[0];
    assert.equal(pushA1Payload.status, "applied");
    assert.ok(
      pushA1Payload.appliedFiles.includes("machine-state/machine-a.json"),
      `expected machine-state/machine-a.json in appliedFiles: ${JSON.stringify(pushA1Payload.appliedFiles)}`
    );

    // Machine B: profile "machine-b", pulls — this materializes A's file
    // locally under B's own machine-state source directory (pull is
    // unaffected by ownerScoped, D-004).
    const workspaceB = path.join(root, "workspace-b");
    const stateDirB = path.join(root, "state-b");
    const configPathB = path.join(root, "config-b.json");
    const machineStateSourceB = path.join(root, "machine-b-harness-state");

    writeProjectConfig(
      configPathB,
      ownerScopedConfig(workspaceB, remoteDir, stateDirB, "machine-b", machineStateSourceB)
    );

    const pullB = runCli(["run", "machine-b", "--config", configPathB, "--mode", "pull", "--output", "json"]);
    const pullBPayload = JSON.parse(pullB.stdout).runs[0];
    assert.ok(
      pullBPayload.appliedFiles.includes("machine-state/machine-a.json"),
      `expected pull to materialize the peer file locally: ${JSON.stringify(pullBPayload.appliedFiles)}`
    );
    assert.equal(readText(path.join(machineStateSourceB, "machine-a.json")), '{"v":1}\n');

    // A advances again, so B's locally-materialized copy of A's file is now
    // stale relative to the remote — the case where an echo could actually
    // clobber A's newer content via a last-writer-wins race.
    writeText(path.join(machineStateSourceA, "machine-a.json"), '{"v":2}\n');
    const pushA2 = runCli(["run", "machine-a", "--config", configPathA, "--mode", "push", "--output", "json"]);
    assert.equal(JSON.parse(pushA2.stdout).runs[0].status, "applied");

    // B now writes its OWN machine-state file (the legitimate case that must
    // keep working) and pushes. B's stale local copy of A's file is still
    // sitting under machineStateSourceB, untouched.
    writeText(path.join(machineStateSourceB, "machine-b.json"), '{"v":1}\n');
    const pushB = runCli(["run", "machine-b", "--config", configPathB, "--mode", "push", "--output", "json"]);
    const pushBPayload = JSON.parse(pushB.stdout).runs[0];

    assert.equal(pushBPayload.status, "applied");
    assert.ok(
      pushBPayload.appliedFiles.includes("machine-state/machine-b.json"),
      `negative control: B's own file must still be pushed: ${JSON.stringify(pushBPayload.appliedFiles)}`
    );
    assert.ok(
      !pushBPayload.appliedFiles.includes("machine-state/machine-a.json"),
      `B must not echo-push A's file: ${JSON.stringify(pushBPayload.appliedFiles)}`
    );
    assert.ok(
      !pushBPayload.conflictFiles.includes("machine-state/machine-a.json"),
      `B must not even attempt a merge over A's file: ${JSON.stringify(pushBPayload.conflictFiles)}`
    );

    // The remote must still hold A's latest content — not overwritten by
    // B's stale echo — and must now also carry B's own file.
    const inspection = cloneRemote(remoteDir, root, "inspect-after-b-push");
    assert.equal(
      readText(path.join(inspection, "shared", "machine-state", "machine-a.json")),
      '{"v":2}\n',
      "A's newer remote content must survive untouched by B's push"
    );
    assert.equal(readText(path.join(inspection, "shared", "machine-state", "machine-b.json")), '{"v":1}\n');
  }
);

test("push tolerates an ownerScoped directory whose own <profile>.json does not exist locally yet", () => {
  const root = createSandbox("owner-scoped-missing-own-file");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const machineStateSource = path.join(root, "harness-state");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  // machineStateSource exists (so the directory-existence check passes) but
  // has no <profile>.json in it yet.
  writeText(path.join(machineStateSource, "someone-elses.json"), '{"v":1}\n');
  writeProjectConfig(configPath, ownerScopedConfig(workspaceRoot, remoteDir, stateDir, "this-machine", machineStateSource));

  const result = runCli(["run", "this-machine", "--config", configPath, "--mode", "push", "--output", "json"]);
  const payload = JSON.parse(result.stdout).runs[0];

  assert.equal(payload.status, "applied");
  assert.ok(payload.appliedFiles.some((f: string) => f.endsWith("MEMORY.md")));
  assert.ok(
    !payload.appliedFiles.some((f: string) => f.startsWith("machine-state/")),
    `no own file present yet — nothing under machine-state/ should be offered: ${JSON.stringify(payload.appliedFiles)}`
  );

  const inspection = cloneRemote(remoteDir, root, "inspect-no-own-file");
  assert.equal(fileExists(path.join(inspection, "shared", "machine-state", "someone-elses.json")), false);
});
