// AC-003 (task e104c9f2, pandora run
// .ai/runs/2026-09-11-sync-peer-file-conflict): a local file that already
// carries inline conflict markers and that this run leaves untouched must
// be named in the run's notes, once per file, in both the JSON payload and
// the text summary's `notes=` field.
//
// Live blind spot this closes: at head build 8d0893c, pull.ts's
// `mergeResult.content === localValue` continue runs BEFORE the merged/
// conflict classification. A file where the merge result equals the
// already-marker-carrying local content (e.g. remote === base, so the
// "local wins" fast path just hands back the same content) is skipped
// silently: it lands in neither appliedFiles nor conflictFiles, so the run
// reports a clean 0-conflict outcome while the markers still sit in the
// file. This is the mac mini's actual manual-sync experience after
// installing the AC-002 mirror fix in isolation: the diagnosis in
// .ai/runs/2026-09-11-sync-peer-file-conflict/01-plan.md is exactly this.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  createSandbox,
  git,
  initBareRemote,
  readText,
  runCli,
  writeProjectConfig,
  writeText
} = require("../helpers/cli.ts");

function plainFileConfig(workspaceRoot: string, remoteDir: string, stateDir: string) {
  return {
    profile: "default",
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: [{ source: "MEMORY.md", destination: "MEMORY.md", kind: "file" }]
  };
}

function ownerScopedPullConfig(workspaceRoot: string, remoteDir: string, stateDir: string, profile: string, machineStateSource: string) {
  return {
    profile,
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: [{ source: machineStateSource, destination: "machine-state", kind: "directory", ownerScoped: true }]
  };
}

const STALE_MARKER_CONTENT = ["<<<<<<< local", "an earlier local half", "=======", "an earlier remote half", ">>>>>>> remote"].join(
  "\n"
);

test("run --mode pull reports a note for a local memory file that still carries conflict markers and is left untouched", () => {
  const root = createSandbox("stale-marker-note-pull");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "clean\n");
  writeProjectConfig(configPath, plainFileConfig(workspaceRoot, remoteDir, stateDir));

  // Establish base == remote == "clean\n" via a seeding push.
  const seed = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(JSON.parse(seed.stdout).runs[0].status, "applied");

  // Local acquires stale conflict markers with nothing else touching the
  // remote in between, so remote === base and the "local wins" fast path
  // hands back the exact same (marker-carrying) content: the file is left
  // untouched by the plan.
  writeText(path.join(workspaceRoot, "MEMORY.md"), STALE_MARKER_CONTENT);

  const jsonResult = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const jsonPayload = JSON.parse(jsonResult.stdout).runs[0];

  assert.equal(readText(path.join(workspaceRoot, "MEMORY.md")), STALE_MARKER_CONTENT, "sanity: pull must leave the file untouched");
  assert.ok(!jsonPayload.appliedFiles.includes("MEMORY.md"), "sanity: the file must not be in appliedFiles");
  assert.ok(
    (jsonPayload.notes || []).some(
      (note: string) => note === "stale conflict markers in MEMORY.md; resolve by editing the file"
    ),
    `expected a stale-marker note naming MEMORY.md: ${JSON.stringify(jsonPayload.notes)}`
  );

  const textResult = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "text"]);
  assert.match(textResult.stdout, /notes=stale conflict markers in MEMORY\.md; resolve by editing the file/);
});

test("run --mode sync also reports the stale-marker note (pull's notes carry through the combined payload)", () => {
  const root = createSandbox("stale-marker-note-sync");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "clean\n");
  writeProjectConfig(configPath, plainFileConfig(workspaceRoot, remoteDir, stateDir));

  const seed = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(JSON.parse(seed.stdout).runs[0].status, "applied");

  writeText(path.join(workspaceRoot, "MEMORY.md"), STALE_MARKER_CONTENT);

  const syncResult = runCli(["run", "default", "--config", configPath, "--mode", "sync", "--output", "json"]);
  const syncPayload = JSON.parse(syncResult.stdout).runs[0];

  assert.ok(
    (syncPayload.notes || []).some(
      (note: string) => note === "stale conflict markers in MEMORY.md; resolve by editing the file"
    ),
    `expected the stale-marker note in the combined sync payload: ${JSON.stringify(syncPayload.notes)}`
  );
});

test("negative control: no stale-marker note fires for a peer file whose local markers the AC-002 mirror rule overwrites", () => {
  const root = createSandbox("stale-marker-note-overwritten");
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const machineStateSource = path.join(root, "harness-state");

  writeProjectConfig(configPath, ownerScopedPullConfig(workspaceRoot, remoteDir, stateDir, "mac-mini", machineStateSource));

  const peerCheckout = path.join(root, "peer-seed");
  git(["clone", remoteDir, peerCheckout], root);
  git(["config", "user.name", "peer"], peerCheckout);
  git(["config", "user.email", "peer@example.invalid"], peerCheckout);
  writeText(path.join(peerCheckout, "shared", "machine-state", "linux.json"), "linux state v1\n");
  git(["add", "."], peerCheckout);
  git(["commit", "-m", "seed linux.json"], peerCheckout);
  git(["push", "origin", "HEAD:main"], peerCheckout);

  const seed = runCli(["run", "mac-mini", "--config", configPath, "--mode", "pull", "--output", "json"]);
  assert.ok(JSON.parse(seed.stdout).runs[0].appliedFiles.includes("machine-state/linux.json"));

  // Local acquires markers on the peer file, base == remote unchanged: the
  // AC-002 mirror rule overwrites this on the very next pull, so it must
  // never be reported as a "left untouched" stale-marker note.
  writeText(path.join(machineStateSource, "linux.json"), STALE_MARKER_CONTENT);

  const pull = runCli(["run", "mac-mini", "--config", configPath, "--mode", "pull", "--output", "json"]);
  const payload = JSON.parse(pull.stdout).runs[0];

  assert.ok(
    payload.appliedFiles.includes("machine-state/linux.json"),
    `sanity: the mirror rule must overwrite this file: ${JSON.stringify(payload.appliedFiles)}`
  );
  assert.ok(
    !(payload.notes || []).some((note: string) => note.includes("machine-state/linux.json")),
    `expected no stale-marker note for a file the plan overwrites: ${JSON.stringify(payload.notes)}`
  );
});
