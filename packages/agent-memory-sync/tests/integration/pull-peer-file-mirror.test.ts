// AC-002 (task e104c9f2, pandora run
// .ai/runs/2026-09-11-sync-peer-file-conflict): pull's peer-file mirror rule
// for an ownerScoped directory destination.
//
// Live incident this closes: the mac mini's `machine-state/linux.json` (a
// peer's ownerScoped file, not this machine's own `<profile>.json`) carried
// inline conflict markers from the 2026-08-03 pre-fix cascade. base ==
// remote (the hub's content, unchanged since 2026-08-10), local != base
// (the markers). The old 3-way merge's `remote === base` fast path always
// resolved to "local wins" with the marker-carrying content, and push's
// ownerFilter (owner-scoped-push.test.ts) never publishes a peer file to fix
// it from the other end either, so the file could never converge, ticking
// `conflicts=1` (or, on the head build, silently skipping it entirely; see
// pull-stale-conflict-marker-note.test.ts for that half) forever.
//
// The fix: a peer file inside an ownerScoped directory destination is
// mirrored from the remote unconditionally on pull, never 3-way merged and
// never marker-written. The machine's own `<profile>.json` is exempt and
// keeps the existing 3-way rule (test (c) below).
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");
const {
  createSandbox,
  git,
  initBareRemote,
  readText,
  runCli,
  writeProjectConfig,
  writeText,
} = require("../helpers/cli.ts");

function ownerScopedPullConfig(
  workspaceRoot: string,
  remoteDir: string,
  stateDir: string,
  profile: string,
  machineStateSource: string,
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
      {
        source: machineStateSource,
        destination: "machine-state",
        kind: "directory",
        ownerScoped: true,
      },
    ],
  };
}

// Commits content directly to the bare remote's machine-state directory,
// simulating a peer machine's own push, without this workspace ever seeing
// it via a CLI call of its own.
function commitToRemote(
  root: string,
  remoteDir: string,
  name: string,
  relativePath: string,
  content: string,
): void {
  const peerCheckout = path.join(root, name);
  git(["clone", remoteDir, peerCheckout], root);
  git(["config", "user.name", "peer"], peerCheckout);
  git(["config", "user.email", "peer@example.invalid"], peerCheckout);
  writeText(path.join(peerCheckout, "shared", relativePath), content);
  git(["add", "."], peerCheckout);
  git(["commit", "-m", `peer update ${relativePath}`], peerCheckout);
  git(["push", "origin", "HEAD:main"], peerCheckout);
}

const NESTED_LIVE_MARKER_CONTENT = [
  "<<<<<<< local",
  "<<<<<<< local",
  "cascade one, local half",
  "=======",
  "cascade one, remote half",
  ">>>>>>> remote",
  "=======",
  "cascade two, remote half",
  ">>>>>>> remote",
].join("\n");

test("AC-002(a): a peer file with nested local conflict markers (base == remote) is mirrored, not merged", () => {
  const root = createSandbox("peer-mirror-a");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const machineStateSource = path.join(root, "harness-state");

  writeProjectConfig(
    configPath,
    ownerScopedPullConfig(
      workspaceRoot,
      remoteDir,
      stateDir,
      "mac-mini",
      machineStateSource,
    ),
  );

  const cleanContent = "linux state v1\n";
  commitToRemote(
    root,
    remoteDir,
    "peer-seed",
    "machine-state/linux.json",
    cleanContent,
  );

  // Establish base == remote == cleanContent for linux.json by pulling it
  // down with nothing local yet.
  const seed = runCli([
    "run",
    "mac-mini",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--output",
    "json",
  ]);
  const seedPayload = JSON.parse(seed.stdout).runs[0];
  assert.ok(
    seedPayload.appliedFiles.includes("machine-state/linux.json"),
    `sanity: seed pull must materialize the peer file: ${JSON.stringify(seedPayload.appliedFiles)}`,
  );
  assert.equal(
    readText(path.join(machineStateSource, "linux.json")),
    cleanContent,
  );

  // Simulate the pre-fix cascade: local diverges from base/remote by
  // acquiring nested inline conflict markers, with nothing else touching
  // the remote in between (base still == remote).
  writeText(
    path.join(machineStateSource, "linux.json"),
    NESTED_LIVE_MARKER_CONTENT,
  );

  const pull = runCli([
    "run",
    "mac-mini",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--output",
    "json",
  ]);
  const payload = JSON.parse(pull.stdout).runs[0];

  assert.equal(
    readText(path.join(machineStateSource, "linux.json")),
    cleanContent,
    "the mirror rule must overwrite the marker-carrying local content with the clean remote content",
  );
  assert.ok(
    payload.appliedFiles.includes("machine-state/linux.json"),
    `expected machine-state/linux.json in appliedFiles: ${JSON.stringify(payload.appliedFiles)}`,
  );
  assert.ok(
    !payload.conflictFiles.includes("machine-state/linux.json"),
    `mirrored peer file must never be reported as a conflict: ${JSON.stringify(payload.conflictFiles)}`,
  );
  assert.ok(
    !payload.mergedFiles.includes("machine-state/linux.json"),
    `mirrored peer file must never be reported as merged (no mergeText call at all): ${JSON.stringify(payload.mergedFiles)}`,
  );
});

test("AC-002(b): a peer file where local, base and remote all differ is mirrored to the remote content, not 3-way merged", () => {
  const root = createSandbox("peer-mirror-b");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const machineStateSource = path.join(root, "harness-state");

  writeProjectConfig(
    configPath,
    ownerScopedPullConfig(
      workspaceRoot,
      remoteDir,
      stateDir,
      "mac-mini",
      machineStateSource,
    ),
  );

  commitToRemote(
    root,
    remoteDir,
    "peer-seed",
    "machine-state/linux.json",
    "v1\n",
  );
  const seed = runCli([
    "run",
    "mac-mini",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--output",
    "json",
  ]);
  assert.equal(JSON.parse(seed.stdout).runs[0].status, "applied");

  // Remote moves on (a genuine peer update) ...
  commitToRemote(
    root,
    remoteDir,
    "peer-update",
    "machine-state/linux.json",
    "v2 from peer\n",
  );
  // ... and, independently, local also diverges to unrelated content (not a
  // superset/append of v1, so an append-only merge could never quietly
  // reconcile the two even if this were routed through mergeText).
  writeText(
    path.join(machineStateSource, "linux.json"),
    "v3 stale local content\n",
  );

  const pull = runCli([
    "run",
    "mac-mini",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--output",
    "json",
  ]);
  const payload = JSON.parse(pull.stdout).runs[0];

  assert.equal(
    readText(path.join(machineStateSource, "linux.json")),
    "v2 from peer\n",
    "the mirror rule takes the remote content, discarding the stale local divergence entirely",
  );
  assert.ok(
    !/<<<<<<< local/.test(
      readText(path.join(machineStateSource, "linux.json")),
    ),
  );
  assert.ok(
    !payload.mergedFiles.includes("machine-state/linux.json"),
    `expected no mergedFiles entry for a mirrored peer file: ${JSON.stringify(payload.mergedFiles)}`,
  );
  assert.ok(
    !payload.conflictFiles.includes("machine-state/linux.json"),
    `expected no conflictFiles entry for a mirrored peer file: ${JSON.stringify(payload.conflictFiles)}`,
  );
  assert.ok(payload.appliedFiles.includes("machine-state/linux.json"));
});

test("AC-002(c): the machine's own ownerScoped file still 3-way merges/conflicts on a genuine divergence", () => {
  const root = createSandbox("peer-mirror-c");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const machineStateSource = path.join(root, "harness-state");

  writeProjectConfig(
    configPath,
    ownerScopedPullConfig(
      workspaceRoot,
      remoteDir,
      stateDir,
      "mac-mini",
      machineStateSource,
    ),
  );

  // Seed base == remote == v1 for the OWN file (mac-mini.json) via a real
  // push from this machine, so pull's base snapshot store agrees.
  writeText(path.join(machineStateSource, "mac-mini.json"), "v1\n");
  const seedPush = runCli([
    "run",
    "mac-mini",
    "--config",
    configPath,
    "--mode",
    "push",
    "--output",
    "json",
  ]);
  assert.equal(JSON.parse(seedPush.stdout).runs[0].status, "applied");

  // Remote and local now both diverge from v1 in unrelated, non-append-
  // compatible ways: a genuine 3-way conflict.
  commitToRemote(
    root,
    remoteDir,
    "peer-update-own",
    "machine-state/mac-mini.json",
    "remote v2\n",
  );
  writeText(path.join(machineStateSource, "mac-mini.json"), "local v2\n");

  const pull = runCli([
    "run",
    "mac-mini",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--output",
    "json",
  ]);
  const payload = JSON.parse(pull.stdout).runs[0];

  const afterPull = readText(path.join(machineStateSource, "mac-mini.json"));
  assert.match(
    afterPull,
    /<<<<<<< local/,
    "the own file must still go through the 3-way inline-markers strategy",
  );
  assert.match(afterPull, /local v2/);
  assert.match(afterPull, /remote v2/);
  assert.match(afterPull, />>>>>>> remote/);
  assert.ok(
    payload.conflictFiles.includes("machine-state/mac-mini.json"),
    `own file must still be reported as a conflict: ${JSON.stringify(payload.conflictFiles)}`,
  );
});

test("AC-002(d): a base-less local peer file the remote lacks stays protected (unchanged)", () => {
  const root = createSandbox("peer-mirror-d");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const machineStateSource = path.join(root, "harness-state");

  writeProjectConfig(
    configPath,
    ownerScopedPullConfig(
      workspaceRoot,
      remoteDir,
      stateDir,
      "mac-mini",
      machineStateSource,
    ),
  );

  // A peer file this workspace already has locally (e.g. from a channel
  // outside this tool), never recorded in the base store, and the remote
  // has never had it either.
  mkdirSync(machineStateSource, { recursive: true });
  writeText(
    path.join(machineStateSource, "linux.json"),
    "locally-only content, never pulled or pushed\n",
  );

  const pull = runCli([
    "run",
    "mac-mini",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--output",
    "json",
  ]);
  const payload = JSON.parse(pull.stdout).runs[0];

  assert.ok(
    payload.protectedFiles.includes("machine-state/linux.json"),
    `expected machine-state/linux.json in protectedFiles: ${JSON.stringify(payload.protectedFiles)}`,
  );
  assert.equal(
    readText(path.join(machineStateSource, "linux.json")),
    "locally-only content, never pulled or pushed\n",
  );
  assert.ok(!payload.appliedFiles.includes("machine-state/linux.json"));
  assert.ok(!payload.conflictFiles.includes("machine-state/linux.json"));
});

test("AC-002(e): a peer file present in base and local is removed on the remote: pull deletes it locally and reports it in deletedFiles", () => {
  const root = createSandbox("peer-mirror-e");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const machineStateSource = path.join(root, "harness-state");

  writeProjectConfig(
    configPath,
    ownerScopedPullConfig(
      workspaceRoot,
      remoteDir,
      stateDir,
      "mac-mini",
      machineStateSource,
    ),
  );

  commitToRemote(
    root,
    remoteDir,
    "peer-seed",
    "machine-state/linux.json",
    "linux state v1\n",
  );

  // Establish base == remote == local == v1 for linux.json.
  const seed = runCli([
    "run",
    "mac-mini",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--output",
    "json",
  ]);
  assert.ok(
    JSON.parse(seed.stdout).runs[0].appliedFiles.includes(
      "machine-state/linux.json",
    ),
  );
  assert.equal(
    readText(path.join(machineStateSource, "linux.json")),
    "linux state v1\n",
  );

  // The peer removes its own file from the remote.
  const peerCheckout = path.join(root, "peer-delete");
  git(["clone", remoteDir, peerCheckout], root);
  git(["config", "user.name", "peer"], peerCheckout);
  git(["config", "user.email", "peer@example.invalid"], peerCheckout);
  rmSync(path.join(peerCheckout, "shared", "machine-state", "linux.json"));
  git(["add", "-A"], peerCheckout);
  git(["commit", "-m", "peer removes linux.json"], peerCheckout);
  git(["push", "origin", "HEAD:main"], peerCheckout);

  const pull = runCli([
    "run",
    "mac-mini",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--output",
    "json",
  ]);
  const payload = JSON.parse(pull.stdout).runs[0];

  assert.ok(
    payload.deletedFiles.includes("machine-state/linux.json"),
    `expected machine-state/linux.json in deletedFiles: ${JSON.stringify(payload.deletedFiles)}`,
  );
  assert.ok(
    !existsSync(path.join(machineStateSource, "linux.json")),
    "the local peer file must be removed once the remote drops it",
  );
});

test("AC-002/D-001: a peer file whose remote content itself carries conflict markers is mirrored and reported as a conflict", () => {
  const root = createSandbox("peer-mirror-f");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const machineStateSource = path.join(root, "harness-state");

  writeProjectConfig(
    configPath,
    ownerScopedPullConfig(
      workspaceRoot,
      remoteDir,
      stateDir,
      "mac-mini",
      machineStateSource,
    ),
  );

  commitToRemote(
    root,
    remoteDir,
    "peer-seed",
    "machine-state/linux.json",
    "v1\n",
  );
  const seed = runCli([
    "run",
    "mac-mini",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--output",
    "json",
  ]);
  assert.equal(JSON.parse(seed.stdout).runs[0].status, "applied");

  // The peer itself commits marker-carrying content straight to the remote
  // (e.g. an unresolved conflict on the peer's own machine, pushed by
  // mistake). The mirror rule still takes it verbatim, but must not claim
  // conflict:false for content that already carries markers.
  commitToRemote(
    root,
    remoteDir,
    "peer-corrupt",
    "machine-state/linux.json",
    NESTED_LIVE_MARKER_CONTENT,
  );

  const pull = runCli([
    "run",
    "mac-mini",
    "--config",
    configPath,
    "--mode",
    "pull",
    "--output",
    "json",
  ]);
  const payload = JSON.parse(pull.stdout).runs[0];

  assert.equal(
    readText(path.join(machineStateSource, "linux.json")),
    NESTED_LIVE_MARKER_CONTENT,
    "the mirror rule writes exactly what the remote has, markers included",
  );
  assert.ok(
    payload.appliedFiles.includes("machine-state/linux.json"),
    `expected machine-state/linux.json in appliedFiles: ${JSON.stringify(payload.appliedFiles)}`,
  );
  assert.ok(
    payload.conflictFiles.includes("machine-state/linux.json"),
    `a markered remote peer file must be reported as a conflict, not conflicts=0: ${JSON.stringify(payload.conflictFiles)}`,
  );
});
