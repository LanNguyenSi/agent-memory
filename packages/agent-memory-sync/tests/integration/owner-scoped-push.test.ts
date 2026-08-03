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
const { mkdirSync } = require("node:fs");
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
const { StateStore } = require("../../src/memory-sync/state-store");

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
    // Negative control for the Fix-Runde HIGH finding's warning (05-review-
    // findings.md, agent-tasks 06d09cde): B's own file (machine-b.json) IS
    // present alongside A's stale copy, so no "own file not found" warning
    // should fire here — the warning is for the missing-own-file case only,
    // see the dedicated tests below.
    assert.ok(
      !(pushBPayload.notes || []).some((note: string) => note.includes("own file")),
      `negative control: B's own file is present, no own-file-missing warning expected: ${JSON.stringify(pushBPayload.notes)}`
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

// Fix-Runde HIGH finding (05-review-findings.md, agent-tasks 06d09cde): the
// original version of this test (title unchanged below, semantics extended)
// pinned tolerance — no exception — for a missing own file. It did NOT pin
// that this is a real, silent data-loss path whenever `config.profile`
// resolves to something other than this machine's actual owner filename
// (e.g. the CLI's [profile] positional defaulting to 'default' when a real
// machine invocation omits it — run.ts/loader.ts's override order). The
// tolerance (no exception) is preserved unchanged; a visible warning is now
// also asserted, per D-007 (03-decisions.md): fix the silence, not the CLI
// resolution semantics.
test("push tolerates an ownerScoped directory whose own <profile>.json does not exist locally yet, and now emits a visible warning when peer files are present", () => {
  const root = createSandbox("owner-scoped-missing-own-file");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const machineStateSource = path.join(root, "harness-state");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  // machineStateSource exists (so the directory-existence check passes) but
  // has no <profile>.json in it yet — only a peer's file.
  writeText(path.join(machineStateSource, "someone-elses.json"), '{"v":1}\n');
  writeProjectConfig(configPath, ownerScopedConfig(workspaceRoot, remoteDir, stateDir, "this-machine", machineStateSource));

  const result = runCli(["run", "this-machine", "--config", configPath, "--mode", "push", "--output", "json"]);
  const payload = JSON.parse(result.stdout).runs[0];

  assert.equal(payload.status, "applied", "tolerance preserved: no exception, still applies the rest of the push");
  assert.ok(payload.appliedFiles.some((f: string) => f.endsWith("MEMORY.md")));
  assert.ok(
    !payload.appliedFiles.some((f: string) => f.startsWith("machine-state/")),
    `no own file present yet — nothing under machine-state/ should be offered: ${JSON.stringify(payload.appliedFiles)}`
  );

  const inspection = cloneRemote(remoteDir, root, "inspect-no-own-file");
  assert.equal(fileExists(path.join(inspection, "shared", "machine-state", "someone-elses.json")), false);

  const notesText = (payload.notes || []).join(" ");
  assert.match(
    notesText,
    /own file 'this-machine\.json' not found among 1 file\(s\)/,
    `expected the own-file-missing warning naming the profile's owner filename and peer count: ${JSON.stringify(payload.notes)}`
  );
  assert.match(notesText, /this machine will publish no 'machine-state' state/);
  assert.match(notesText, /check the profile positional matches this machine/);
});

// Negative/tolerance companion: a directory that exists but has genuinely NO
// files at all (not even a peer's) must stay silent — there is nothing to
// warn about, this is the ordinary brand-new-machine first-run shape.
test("push stays silent (no warning) for an ownerScoped directory that exists but is completely empty", () => {
  const root = createSandbox("owner-scoped-empty-dir");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const machineStateSource = path.join(root, "harness-state");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  mkdirSync(machineStateSource, { recursive: true });
  writeProjectConfig(configPath, ownerScopedConfig(workspaceRoot, remoteDir, stateDir, "this-machine", machineStateSource));

  const result = runCli(["run", "this-machine", "--config", configPath, "--mode", "push", "--output", "json"]);
  const payload = JSON.parse(result.stdout).runs[0];

  assert.equal(payload.status, "applied");
  assert.ok(
    !payload.appliedFiles.some((f: string) => f.startsWith("machine-state/")),
    `empty directory — nothing under machine-state/ should be offered: ${JSON.stringify(payload.appliedFiles)}`
  );
  assert.ok(
    !(payload.notes || []).some((note: string) => note.includes("own file")),
    `an empty directory has nothing to warn about: ${JSON.stringify(payload.notes)}`
  );
});

// ─── Fix 3 (MEDIUM): queue replay must apply the same owner filter ─────────
//
// push.ts's currentLocalMap/currentBaseMap (the "current" snapshot) are
// filtered via collectLocalSyncFiles' ownerFilter + filterOwnerScopedBaseMap
// — but a snapshot enqueued BEFORE this machine's profile picked up
// ownerScoped:true (or before this fix shipped) is stored verbatim and, pre
// Fix 3, was replayed verbatim too: push.ts:71-85 mapped queuedSnapshots
// straight from entry.data.localFiles/baseFiles without going through
// filterOwnerScopedBaseMap. These two tests bypass a real push's collection
// step entirely and enqueue a stale snapshot directly via StateStore, which
// is the only way to reproduce a pre-fix/pre-deploy queue entry
// deterministically.
test("push replay strips a stale queued snapshot's peer ownerScoped file out of localFiles, so it is never re-offered", () => {
  const root = createSandbox("owner-scoped-queue-local-leak");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const machineStateSource = path.join(root, "harness-state");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "b's memory\n");
  writeText(path.join(machineStateSource, "machine-b.json"), '{"v":"b-own"}\n');
  writeProjectConfig(
    configPath,
    ownerScopedConfig(workspaceRoot, remoteDir, stateDir, "machine-b", machineStateSource)
  );

  // Directly enqueue a stale snapshot carrying a peer's ownerScoped file in
  // localFiles, simulating a pre-fix/pre-deploy capture.
  const stateStore = new StateStore(stateDir, "machine-b");
  stateStore.enqueueSnapshot({
    localFiles: { "machine-state/machine-a.json": '{"v":"stale-peer-local"}\n' },
    baseFiles: {}
  });

  const result = runCli(["run", "machine-b", "--config", configPath, "--mode", "push", "--output", "json"]);
  const payload = JSON.parse(result.stdout).runs[0];

  assert.equal(payload.status, "applied");
  assert.match((payload.notes || []).join(" "), /replayed 1 queued snapshot/);
  assert.ok(
    payload.appliedFiles.includes("machine-state/machine-b.json"),
    `own file must still be pushed: ${JSON.stringify(payload.appliedFiles)}`
  );
  assert.ok(
    !payload.appliedFiles.includes("machine-state/machine-a.json"),
    `stale queued peer file must NOT be replayed/offered: ${JSON.stringify(payload.appliedFiles)}`
  );

  const inspection = cloneRemote(remoteDir, root, "inspect-queue-local-leak");
  assert.equal(fileExists(path.join(inspection, "shared", "machine-state", "machine-a.json")), false);
});

test(
  "push replay strips a stale queued snapshot's peer ownerScoped file out of baseFiles too, preventing a " +
    "spurious conflict-marker corruption of a file this machine never touched",
  () => {
    const root = createSandbox("owner-scoped-queue-base-leak");
    const remoteDir = initBareRemote(root);

    // Seed the remote with A's real, current machine-state file via an
    // ordinary push from A's own profile first.
    const workspaceA = path.join(root, "workspace-a");
    const stateDirA = path.join(root, "state-a");
    const configPathA = path.join(root, "config-a.json");
    const machineStateSourceA = path.join(root, "machine-a-harness-state");
    writeText(path.join(workspaceA, "MEMORY.md"), "a's memory\n");
    writeText(path.join(machineStateSourceA, "machine-a.json"), '{"v":"a-real-content"}\n');
    writeProjectConfig(
      configPathA,
      ownerScopedConfig(workspaceA, remoteDir, stateDirA, "machine-a", machineStateSourceA)
    );
    const pushA = runCli(["run", "machine-a", "--config", configPathA, "--mode", "push", "--output", "json"]);
    assert.equal(JSON.parse(pushA.stdout).runs[0].status, "applied");

    // Machine B never pulled/touched A's file. A stale queued snapshot
    // carries A's file ONLY in baseFiles (not localFiles) — the shape that,
    // pre-fix, drove mergeText's genuine-conflict fallback (base non-null,
    // local null, remote A's real content) and would have written a marker
    // block combining an empty local half with A's real remote content,
    // corrupting a file B never touched (see config.ts's
    // filterOwnerScopedBaseMap comment for the mechanics).
    const workspaceB = path.join(root, "workspace-b");
    const stateDirB = path.join(root, "state-b");
    const configPathB = path.join(root, "config-b.json");
    const machineStateSourceB = path.join(root, "machine-b-harness-state");
    writeText(path.join(workspaceB, "MEMORY.md"), "b's memory\n");
    writeText(path.join(machineStateSourceB, "machine-b.json"), '{"v":"b-own"}\n');
    writeProjectConfig(
      configPathB,
      ownerScopedConfig(workspaceB, remoteDir, stateDirB, "machine-b", machineStateSourceB)
    );

    const stateStoreB = new StateStore(stateDirB, "machine-b");
    stateStoreB.enqueueSnapshot({
      localFiles: {},
      baseFiles: { "machine-state/machine-a.json": '{"v":"stale-base-snapshot"}\n' }
    });

    const pushB = runCli(["run", "machine-b", "--config", configPathB, "--mode", "push", "--output", "json"]);
    const pushBPayload = JSON.parse(pushB.stdout).runs[0];

    assert.equal(pushBPayload.status, "applied");
    assert.ok(
      !pushBPayload.appliedFiles.includes("machine-state/machine-a.json"),
      `B must not touch A's file at all: ${JSON.stringify(pushBPayload.appliedFiles)}`
    );
    assert.ok(
      !pushBPayload.conflictFiles.includes("machine-state/machine-a.json"),
      `B must not spuriously conflict over A's file: ${JSON.stringify(pushBPayload.conflictFiles)}`
    );

    const inspection = cloneRemote(remoteDir, root, "inspect-queue-base-leak");
    assert.equal(
      readText(path.join(inspection, "shared", "machine-state", "machine-a.json")),
      '{"v":"a-real-content"}\n',
      "A's remote content must survive completely untouched — no marker corruption from B's stale queued base entry"
    );
  }
);
