// AC-007 of the 2026-09-11 wipe (agent-tasks cda5b12c, pandora run
// .ai/runs/2026-09-11-memory-sync-wipe): the pull side.
//
// Two halves, driven here through the real binary against a local bare repo.
// (1) Before a pull applies a deletion or an overwrite, the affected
// destination's current tree is copied into the state directory, so the
// bytes that are about to be replaced survive the run that replaces them.
// (2) A remote change that would remove too much of a destination is not
// applied at all until an operator says the deletion is genuine, with
// --accept-mass-delete.
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

function logsOnlyConfig(workspaceRoot: string, remoteDir: string, extra: Record<string, unknown> = {}) {
  return {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    syncPaths: [{ source: "logs", destination: "logs", kind: "directory" }],
    ...extra
  };
}

function seedLogFiles(workspaceRoot: string, count: number): string[] {
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = `note-${String(index).padStart(3, "0")}.md`;
    writeText(path.join(workspaceRoot, "logs", name), `entry ${index}\n`);
    names.push(path.join("logs", name));
  }
  return names;
}

function stateDirOf(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent-memory-sync", "default");
}

function snapshotIds(workspaceRoot: string, destination: string): string[] {
  const dir = path.join(stateDirOf(workspaceRoot), "snapshots", destination);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry: { isDirectory: () => boolean }) => entry.isDirectory())
    .map((entry: { name: string }) => entry.name)
    .filter((name: string) => fs.existsSync(path.join(dir, name, "manifest.json")))
    .sort();
}

// Removes `names` (remote-relative, under shared/) from the remote, the way
// a peer machine's own sync would.
function peerDeletes(remoteDir: string, root: string, label: string, names: string[]): void {
  const checkout = cloneRemote(remoteDir, root, label);
  for (const name of names) {
    fs.rmSync(path.join(checkout, "shared", name));
  }
  git(["add", "-A"], checkout);
  git(["commit", "-m", `peer removes ${names.length} file(s)`], checkout);
  git(["push", "origin", "HEAD:main"], checkout);
}

test("pull: a deletion is preceded by a snapshot holding the pre-apply bytes (AC-007)", () => {
  const root = createSandbox("pre-apply-snapshot");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  seedLogFiles(workspaceRoot, 6);
  writeProjectConfig(configPath, logsOnlyConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // A single deletion, well inside both thresholds, plus an edit to a
  // second file so the plan also carries an overwrite.
  const peerCheckout = cloneRemote(remoteDir, root, "peer-one");
  fs.rmSync(path.join(peerCheckout, "shared", "logs", "note-000.md"));
  writeText(path.join(peerCheckout, "shared", "logs", "note-001.md"), "edited by peer\n");
  git(["add", "-A"], peerCheckout);
  git(["commit", "-m", "peer edits"], peerCheckout);
  git(["push", "origin", "HEAD:main"], peerCheckout);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.runs[0].status, "applied");
  assert.deepEqual(payload.runs[0].deletedFiles, ["logs/note-000.md"]);
  assert.equal(fileExists(path.join(workspaceRoot, "logs", "note-000.md")), false);
  assert.equal(readText(path.join(workspaceRoot, "logs", "note-001.md")), "edited by peer\n");

  const ids = snapshotIds(workspaceRoot, "logs");
  assert.equal(ids.length, 1, `expected exactly one snapshot, got ${ids.join(", ")}`);
  assert.deepEqual(payload.runs[0].snapshots, ids);

  // The snapshot holds the tree as it was BEFORE this pull: the deleted
  // file with its bytes, and the overwritten file with its old bytes.
  const snapshotFiles = path.join(stateDirOf(workspaceRoot), "snapshots", "logs", ids[0], "files", "logs");
  assert.equal(fs.readdirSync(snapshotFiles).length, 6);
  assert.equal(readText(path.join(snapshotFiles, "note-000.md")), "entry 0\n");
  assert.equal(readText(path.join(snapshotFiles, "note-001.md")), "entry 1\n");
});

test("pull: a run with nothing to apply writes no snapshot (AC-007)", () => {
  const root = createSandbox("pre-apply-noop");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  seedLogFiles(workspaceRoot, 3);
  writeProjectConfig(configPath, logsOnlyConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  assert.equal(JSON.parse(result.stdout).runs[0].status, "applied");
  assert.deepEqual(snapshotIds(workspaceRoot, "logs"), []);
});

test("pull: snapshot rotation keeps only the configured generations (AC-007)", () => {
  const root = createSandbox("pre-apply-rotation");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  seedLogFiles(workspaceRoot, 8);
  writeProjectConfig(configPath, logsOnlyConfig(workspaceRoot, remoteDir, { snapshotGenerations: 2 }));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const observed: string[] = [];
  for (let round = 0; round < 4; round += 1) {
    peerDeletes(remoteDir, root, `peer-rot-${round}`, [`logs/note-00${round}.md`]);
    runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
    observed.push(...snapshotIds(workspaceRoot, "logs"));
  }

  const kept = snapshotIds(workspaceRoot, "logs");
  assert.equal(kept.length, 2, `expected 2 generations, got ${kept.join(", ")}`);
  // The two that survive are the two most recent ones ever written.
  assert.deepEqual(kept, Array.from(new Set(observed)).sort().slice(-2));
});

// AC-007's own scenario: the incident's corpus size, removed in one remote
// commit. The run has to refuse it, say how much it is, and leave the local
// tree exactly as it found it.
test("pull: a remote commit deleting the whole corpus is refused and applies with the flag (AC-007)", () => {
  const root = createSandbox("pull-guard-406");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  const seeded = seedLogFiles(workspaceRoot, 406);
  writeProjectConfig(configPath, logsOnlyConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  peerDeletes(remoteDir, root, "peer-406", seeded.map((p) => p.replace(/\\/g, "/")));

  const refused = runCli(
    ["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"],
    { expectFailure: true }
  );

  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /406/);
  for (const relativePath of seeded) {
    assert.equal(fileExists(path.join(workspaceRoot, relativePath)), true, `${relativePath} was deleted`);
  }
  // A refusal is not an apply: nothing was snapshotted either, because
  // nothing was about to be overwritten.
  assert.deepEqual(snapshotIds(workspaceRoot, "logs"), []);

  const accepted = runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--accept-mass-delete",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(accepted.stdout);

  assert.equal(payload.runs[0].status, "applied");
  assert.equal(payload.runs[0].deletedFiles.length, 406);
  for (const relativePath of seeded) {
    assert.equal(fileExists(path.join(workspaceRoot, relativePath)), false, `${relativePath} survived`);
  }

  // Everything that was deleted is recoverable from the snapshot the
  // accepting run wrote first.
  const ids = snapshotIds(workspaceRoot, "logs");
  assert.equal(ids.length, 1);
  const snapshotFiles = path.join(stateDirOf(workspaceRoot), "snapshots", "logs", ids[0], "files", "logs");
  assert.equal(fs.readdirSync(snapshotFiles).length, 406);
  assert.equal(readText(path.join(snapshotFiles, "note-000.md")), "entry 0\n");
});

// The shape the checkout guard is structurally blind to: every destination
// loses a share small enough to pass on its own, and the run still applies
// far more deletions than the absolute limit allows in total.
test("pull: deletions spread across destinations trip the plan-wide total (AC-007)", () => {
  const root = createSandbox("pull-guard-total");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  const destinations = ["memory", "logs", "archive"];
  const seeded: string[] = [];
  for (const destination of destinations) {
    for (let index = 0; index < 8; index += 1) {
      const relativePath = `${destination}/note-${String(index).padStart(3, "0")}.md`;
      writeText(path.join(workspaceRoot, relativePath), `entry ${index}\n`);
      seeded.push(relativePath);
    }
  }
  // maxRatio 1 switches the proportional rule off, so this fixture is about
  // the absolute rules alone and needs 8 files per destination rather than
  // the 100 the default 10 percent would demand to keep 8 deletions under
  // it. The default ratio's own arithmetic is pinned in
  // tests/unit/guards.test.ts, which needs no files on disk at all.
  writeProjectConfig(configPath, {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    massDeleteGuard: { maxFiles: 20, maxRatio: 1 },
    syncPaths: destinations.map((destination) => ({
      source: destination,
      destination,
      kind: "directory"
    }))
  });
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // 8 per destination: under the absolute limit (20) everywhere and under
  // the proportional rule this fixture turned off, 24 in total.
  const removed = [...seeded];
  peerDeletes(remoteDir, root, "peer-total", removed);

  const refused = runCli(
    ["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(refused.status, 9, `expected the pull guard's exit code. stderr: ${refused.stderr}`);
  assert.match(refused.stderr, /24 file\(s\)/);
  assert.match(refused.stderr, /--accept-mass-delete/);
  assert.match(refused.stderr, /Nothing was deleted locally/);
  for (const relativePath of seeded) {
    assert.equal(fileExists(path.join(workspaceRoot, relativePath)), true, `${relativePath} was deleted`);
  }
  for (const destination of destinations) {
    assert.deepEqual(snapshotIds(workspaceRoot, destination), []);
  }

  const accepted = runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--accept-mass-delete",
    "--output",
    "json"
  ]);
  assert.equal(JSON.parse(accepted.stdout).runs[0].deletedFiles.length, 24);
  for (const relativePath of removed) {
    assert.equal(fileExists(path.join(workspaceRoot, relativePath)), false, `${relativePath} survived`);
  }
  // Every destination the plan touched was snapshotted first.
  for (const destination of destinations) {
    assert.equal(snapshotIds(workspaceRoot, destination).length, 1);
  }
});

// The R2 escape matrix (D-011): a legitimate remote deletion above the
// threshold wedges every mode at exit 7 until an operator says it is
// genuine. --accept-mass-delete is that one escape, and after it the same
// command that was wedged runs clean again.
test("sync: a genuine remote deletion is wedged at exit 7 until it is accepted (AC-007)", () => {
  const root = createSandbox("escape-matrix");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  const seeded = seedLogFiles(workspaceRoot, 50);
  writeProjectConfig(configPath, logsOnlyConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  peerDeletes(
    remoteDir,
    root,
    "peer-30",
    seeded.slice(0, 30).map((p) => p.replace(/\\/g, "/"))
  );

  const wedged = runCli(
    ["run", "default", "--config", configPath, "--mode", "sync", "--output", "json"],
    { expectFailure: true }
  );
  assert.equal(wedged.status, 7, `expected the checkout refusal's exit code. stderr: ${wedged.stderr}`);
  assert.match(wedged.stderr, /--accept-mass-delete/);
  assert.equal(fileExists(path.join(workspaceRoot, seeded[0])), true);

  const accepted = runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "sync",
    "--accept-mass-delete",
    "--output",
    "json"
  ]);
  assert.equal(accepted.status, 0, `stderr: ${accepted.stderr}`);
  assert.equal(fileExists(path.join(workspaceRoot, seeded[0])), false);
  assert.equal(fileExists(path.join(workspaceRoot, seeded[30])), true);

  const ids = snapshotIds(workspaceRoot, "logs");
  assert.equal(ids.length, 1);
  assert.equal(
    fs.readdirSync(path.join(stateDirOf(workspaceRoot), "snapshots", "logs", ids[0], "files", "logs")).length,
    50
  );

  // The base snapshot moved with the remote, so the next ordinary run is
  // clean rather than wedged again, and it republishes nothing.
  const afterwards = runCli(["run", "default", "--config", configPath, "--mode", "sync", "--output", "json"]);
  assert.equal(afterwards.status, 0, `stderr: ${afterwards.stderr}`);

  const inspection = cloneRemote(remoteDir, root, "inspect-escape");
  assert.equal(fs.readdirSync(path.join(inspection, "shared", "logs")).length, 20);
});

// watch pushes, it never pulls, so its escape has to make the local tree
// match the remote itself before the push it was refusing can go through.
test("push: --accept-mass-delete adopts the remote's deletion instead of republishing it (AC-007)", () => {
  const root = createSandbox("push-accept");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  const seeded = seedLogFiles(workspaceRoot, 50);
  writeProjectConfig(configPath, logsOnlyConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  peerDeletes(
    remoteDir,
    root,
    "peer-push-30",
    seeded.slice(0, 30).map((p) => p.replace(/\\/g, "/"))
  );

  const wedged = runCli(
    ["run", "default", "--config", configPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );
  assert.equal(wedged.status, 7, `stderr: ${wedged.stderr}`);

  const accepted = runCli([
    "run",
    "default",
    "--config",
    configPath,
    "--mode",
    "push",
    "--accept-mass-delete",
    "--output",
    "json"
  ]);
  assert.equal(accepted.status, 0, `stderr: ${accepted.stderr}`);

  // The local copies of the 30 files the remote dropped are gone, with a
  // snapshot of the tree they were in, and the remote still holds 20: the
  // run adopted the deletion instead of pushing the files back.
  assert.equal(fileExists(path.join(workspaceRoot, seeded[0])), false);
  assert.equal(fileExists(path.join(workspaceRoot, seeded[30])), true);
  assert.equal(snapshotIds(workspaceRoot, "logs").length, 1);

  const inspection = cloneRemote(remoteDir, root, "inspect-push-accept");
  assert.equal(fs.readdirSync(path.join(inspection, "shared", "logs")).length, 20);

  const afterwards = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(afterwards.status, 0, `stderr: ${afterwards.stderr}`);
  const secondInspection = cloneRemote(remoteDir, root, "inspect-push-accept-2");
  assert.equal(fs.readdirSync(path.join(secondInspection, "shared", "logs")).length, 20);
});

// git behaves normally except that the push itself is rejected, which
// performPush treats as an unreachable remote and queues.
function writeStubGitRejectingPush(root: string): string {
  const stubPath = path.join(root, "stub-git-rejects-push.sh");
  writeText(
    stubPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "push" ]; then',
      '  echo "fatal: simulated push rejection" >&2',
      "  exit 1",
      "fi",
      'exec git "$@"',
      ""
    ].join("\n")
  );
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

function baseTrackedCount(workspaceRoot: string, destination: string): number {
  const dir = path.join(stateDirOf(workspaceRoot), "base", destination);
  if (!fs.existsSync(dir)) {
    return 0;
  }
  return fs.readdirSync(dir).filter((name: string) => !name.endsWith(".meta.json")).length;
}

// An accepted deletion changes the local tree immediately, so the base
// snapshot has to move with it immediately too. Leaving that to the end of a
// successful push means a push that fails afterwards leaves a base snapshot
// claiming files that are no longer on disk, and the next run reads that as a
// checkout that lost them: refused at exit 7, with the adoption the operator
// already agreed to still not recorded anywhere.
test("push: an accepted deletion survives a push that fails afterwards (AC-007)", () => {
  const root = createSandbox("accept-then-failed-push");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stubConfigPath = path.join(root, "config-stub-git.json");

  const seeded = seedLogFiles(workspaceRoot, 50);
  writeProjectConfig(configPath, logsOnlyConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(baseTrackedCount(workspaceRoot, "logs"), 50);

  peerDeletes(
    remoteDir,
    root,
    "peer-failed-push",
    seeded.slice(0, 30).map((p) => p.replace(/\\/g, "/"))
  );

  writeProjectConfig(stubConfigPath, {
    ...logsOnlyConfig(workspaceRoot, remoteDir),
    gitBinary: writeStubGitRejectingPush(root)
  });

  const queued = runCli([
    "run",
    "default",
    "--config",
    stubConfigPath,
    "--mode",
    "push",
    "--accept-mass-delete",
    "--output",
    "json"
  ]);
  assert.equal(JSON.parse(queued.stdout).runs[0].status, "queued");

  // The adoption stands on its own: local and base agree with the remote,
  // even though this run never got to rewrite the base after a push.
  assert.equal(fileExists(path.join(workspaceRoot, seeded[0])), false);
  assert.equal(baseTrackedCount(workspaceRoot, "logs"), 20);

  // So the next ordinary run is clean rather than refusing a checkout it
  // would otherwise read as having lost 30 files.
  const afterwards = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(afterwards.status, 0, `stderr: ${afterwards.stderr}`);
});

// R3 medium (D-018): the two flags answer opposite questions, and together
// they re-enacted the incident (measured: local 50 to 0, remote 50 to 0,
// rc 0). After --accept-mass-delete has adopted the remote's state there is
// nothing left for --allow-mass-delete to publish, so the pair is refused as
// a usage error before anything is read or written.
test("run: --accept-mass-delete together with --allow-mass-delete is a usage error (AC-003, AC-007)", () => {
  const root = createSandbox("flag-pair");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  const seeded = seedLogFiles(workspaceRoot, 50);
  writeProjectConfig(configPath, logsOnlyConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  peerDeletes(
    remoteDir,
    root,
    "peer-pair-30",
    seeded.slice(0, 30).map((p) => p.replace(/\\/g, "/"))
  );

  for (const mode of ["push", "sync", "pull"]) {
    const result = runCli(
      [
        "run",
        "default",
        "--config",
        configPath,
        "--mode",
        mode,
        "--accept-mass-delete",
        "--allow-mass-delete",
        "--output",
        "json"
      ],
      { expectFailure: true }
    );

    assert.equal(result.status, 2, `mode ${mode}: expected a usage error. stderr: ${result.stderr}`);
    assert.match(result.stderr, /--accept-mass-delete/);
    assert.match(result.stderr, /--allow-mass-delete/);
    assert.equal(result.stdout, "");
  }

  // Nothing happened: every local file is still there, no snapshot was
  // taken, and the remote still holds the 20 the peer left.
  for (const relativePath of seeded) {
    assert.equal(fileExists(path.join(workspaceRoot, relativePath)), true, `${relativePath} was deleted`);
  }
  assert.deepEqual(snapshotIds(workspaceRoot, "logs"), []);
  const inspection = cloneRemote(remoteDir, root, "inspect-pair");
  assert.equal(fs.readdirSync(path.join(inspection, "shared", "logs")).length, 20);
});

// R3 medium (D-020): `--dry-run --accept-mass-delete` exited 7 on push and
// sync while the real run applied, so the one command machine-setup tells an
// operator to run first could not preview the acceptance. The preview now
// reports the paths the real run would adopt, and changes nothing.
for (const mode of ["push", "sync"]) {
  test(`${mode} --dry-run --accept-mass-delete reports the adoption without applying it (AC-007)`, () => {
    const root = createSandbox(`dry-run-accept-${mode}`);
    const remoteDir = initBareRemote(root);
    const workspaceRoot = path.join(root, "workspace");
    const configPath = path.join(root, "config.json");

    const seeded = seedLogFiles(workspaceRoot, 50);
    writeProjectConfig(configPath, logsOnlyConfig(workspaceRoot, remoteDir));
    runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

    const dropped = seeded.slice(0, 30).map((p) => p.replace(/\\/g, "/"));
    peerDeletes(remoteDir, root, `peer-dry-${mode}`, dropped);

    // Without the flag the preview refuses the checkout, same as the real run.
    const refused = runCli(
      ["run", "default", "--config", configPath, "--mode", mode, "--dry-run", "--output", "json"],
      { expectFailure: true }
    );
    assert.equal(refused.status, 7, `stderr: ${refused.stderr}`);

    const previewed = runCli([
      "run",
      "default",
      "--config",
      configPath,
      "--mode",
      mode,
      "--dry-run",
      "--accept-mass-delete",
      "--output",
      "json"
    ]);
    assert.equal(previewed.status, 0, `stderr: ${previewed.stderr}`);
    const run = JSON.parse(previewed.stdout).runs[0];

    assert.equal(run.kind, mode);
    assert.equal(run.status, "dry-run");
    // The adoption is named: every path the real run would remove locally.
    assert.deepEqual(run.deletedFiles, [...dropped].sort());
    assert.match((run.notes || []).join(" "), /would adopt 30 remote deletion\(s\)/);
    assert.deepEqual(run.snapshots, []);

    // And nothing changed: local tree, snapshots, base snapshot and remote
    // are exactly as the preview found them.
    for (const relativePath of seeded) {
      assert.equal(fileExists(path.join(workspaceRoot, relativePath)), true, `${relativePath} was deleted`);
    }
    assert.equal(fs.existsSync(path.join(stateDirOf(workspaceRoot), "snapshots")), false);
    assert.equal(baseTrackedCount(workspaceRoot, "logs"), 50);
    const inspection = cloneRemote(remoteDir, root, `inspect-dry-${mode}`);
    assert.equal(fs.readdirSync(path.join(inspection, "shared", "logs")).length, 20);

    // The real run still wedges afterwards, since the preview adopted nothing.
    const stillWedged = runCli(
      ["run", "default", "--config", configPath, "--mode", mode, "--output", "json"],
      { expectFailure: true }
    );
    assert.equal(stillWedged.status, 7, `stderr: ${stillWedged.stderr}`);
  });
}

// R3 low: the add-only rule (a destination the plan only ADDS files to is not
// copied) was untested; removing it left the suite green. A pull that only
// creates files takes nothing away, so there is nothing a copy could keep.
test("pull: an add-only plan writes no snapshot (AC-007)", () => {
  const root = createSandbox("pre-apply-add-only");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  seedLogFiles(workspaceRoot, 3);
  writeProjectConfig(configPath, logsOnlyConfig(workspaceRoot, remoteDir));
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const peerCheckout = cloneRemote(remoteDir, root, "peer-adds");
  for (const name of ["added-a.md", "added-b.md", "added-c.md"]) {
    writeText(path.join(peerCheckout, "shared", "logs", name), `${name}\n`);
  }
  git(["add", "-A"], peerCheckout);
  git(["commit", "-m", "peer adds three files"], peerCheckout);
  git(["push", "origin", "HEAD:main"], peerCheckout);

  const result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const run = JSON.parse(result.stdout).runs[0];

  assert.equal(run.status, "applied");
  assert.deepEqual(run.appliedFiles, ["logs/added-a.md", "logs/added-b.md", "logs/added-c.md"]);
  assert.deepEqual(run.deletedFiles, []);
  assert.deepEqual(run.snapshots, []);
  assert.equal(readText(path.join(workspaceRoot, "logs", "added-a.md")), "added-a.md\n");
  // Not "no generation for logs" but "no snapshots directory at all": the
  // add-only rule decides before anything is created.
  assert.equal(fs.existsSync(path.join(stateDirOf(workspaceRoot), "snapshots")), false);
});
