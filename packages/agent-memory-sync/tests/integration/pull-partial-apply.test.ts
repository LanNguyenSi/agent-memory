// A pull whose apply loop throws part way (here: a removal in a read-only
// directory) has already changed some local files. It exits 13, names what was
// applied and the snapshot that holds the previous content, and leaves the base
// snapshot where it was so the same pull can be run again. Every run happens in
// a sandbox under the OS temp directory against a local bare repository.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { StateStore } = require("../../src/memory-sync/state-store");
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

test("pull: a removal that fails part way exits 13, names the applied paths and the snapshot, and keeps the base", (t: {
  skip: (reason: string) => void;
}) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("a read-only directory does not stop root");
    return;
  }
  const root = createSandbox("pull-partial-apply");
  const remoteDir = initBareRemote(root);
  const workspace = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(root, "state");
  for (let index = 0; index < 40; index += 1) {
    writeText(path.join(workspace, "notes", `n${String(index).padStart(2, "0")}.md`), `note ${index}\n`);
  }
  writeText(path.join(workspace, "notes", "sub", "b.md"), "sub b\n");
  writeProjectConfig(configPath, {
    profile: "default",
    rootDir: workspace,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: [{ source: path.join(workspace, "notes"), destination: "notes", kind: "directory" }]
  });
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const checkout = cloneRemote(remoteDir, root, "peer");
  fs.rmSync(path.join(checkout, "shared", "notes", "n00.md"));
  fs.rmSync(path.join(checkout, "shared", "notes", "sub", "b.md"));
  git(["add", "-A"], checkout);
  git(["commit", "-m", "peer removes two files"], checkout);
  git(["push", "origin", "HEAD:main"], checkout);

  const baseBefore = new StateStore(stateDir, "default").readBaseSnapshots();
  const readOnly = path.join(workspace, "notes", "sub");
  fs.chmodSync(readOnly, 0o555);
  let result;
  try {
    result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"], {
      expectFailure: true
    });
  } finally {
    fs.chmodSync(readOnly, 0o755);
  }

  assert.equal(result.status, 13, result.stderr);
  assert.match(result.stderr, /pull stopped part way: notes\/sub\/b\.md failed/);
  assert.match(result.stderr, /Already applied \(1 of 2\): notes\/n00\.md/);
  assert.match(result.stderr, /pre-apply snapshot 'notes' \S+/);
  assert.match(result.stderr, /base snapshot was not moved/);
  assert.match(result.stderr, /notes\/sub\/b\.md itself, which may be partially written/);
  assert.ok(result.stderr.includes(path.join(stateDir, "snapshots", "<destination>", "<id>")));
  assert.match(
    result.stderr,
    /every rerun takes a new snapshot and rotates older generations away, so copy the generation named above aside \(or pause the scheduled sync\) before retrying/
  );
  assert.equal(fs.existsSync(path.join(workspace, "notes", "n00.md")), false, "the earlier removal stays done");
  assert.equal(readText(path.join(workspace, "notes", "sub", "b.md")), "sub b\n");
  assert.deepEqual(new StateStore(stateDir, "default").readBaseSnapshots(), baseBefore, "the base did not move");

  const generations = fs
    .readdirSync(path.join(stateDir, "snapshots", "notes"))
    .filter((name: string) => name !== "sub");
  assert.equal(generations.length, 1);
  assert.equal(
    readText(path.join(stateDir, "snapshots", "notes", generations[0], "files", "notes", "n00.md")),
    "note 0\n"
  );

  // The cause is gone; the same pull finishes the job.
  const retry = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"]);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(fs.existsSync(path.join(workspace, "notes", "sub", "b.md")), false);
});

test("pull: a failure while creating only new files says no snapshot was needed instead of listing none", (t: {
  skip: (reason: string) => void;
}) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("a read-only directory does not stop root");
    return;
  }
  const root = createSandbox("pull-partial-apply-create-only");
  const remoteDir = initBareRemote(root);
  const workspace = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(root, "state");
  writeText(path.join(workspace, "notes", "sub", "a.md"), "sub a\n");
  writeProjectConfig(configPath, {
    profile: "default",
    rootDir: workspace,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: [{ source: path.join(workspace, "notes"), destination: "notes", kind: "directory" }]
  });
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  const checkout = cloneRemote(remoteDir, root, "peer");
  writeText(path.join(checkout, "shared", "notes", "sub", "new.md"), "new\n");
  git(["add", "-A"], checkout);
  git(["commit", "-m", "peer adds a file"], checkout);
  git(["push", "origin", "HEAD:main"], checkout);

  const readOnly = path.join(workspace, "notes", "sub");
  fs.chmodSync(readOnly, 0o555);
  let result;
  try {
    result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"], {
      expectFailure: true
    });
  } finally {
    fs.chmodSync(readOnly, 0o755);
  }

  assert.equal(result.status, 13, result.stderr);
  assert.match(result.stderr, /pull stopped part way: notes\/sub\/new\.md failed/);
  assert.match(result.stderr, /No snapshot was needed because only new files were created\./);
  assert.doesNotMatch(result.stderr, /pre-apply snapshot/);
  // No snapshot was written, so a rerun rotates nothing and there is no
  // generation to copy aside.
  assert.doesNotMatch(result.stderr, /copy the generation named above aside/);
  assert.doesNotMatch(result.stderr, /rotates older generations away, so copy/);
  assert.match(
    result.stderr,
    /Running the pull again applies the rest; a pull that only creates files writes no snapshot, so no generation is rotated away\./
  );
  assert.equal(fs.existsSync(path.join(stateDir, "snapshots")), false, "no snapshot directory was created");
});

test("pull: a failing create next to a removal does not claim snapshot content for the created path", (t: {
  skip: (reason: string) => void;
}) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("a read-only directory does not stop root");
    return;
  }
  const root = createSandbox("pull-partial-apply-create-with-removal");
  const remoteDir = initBareRemote(root);
  const workspace = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(root, "state");
  writeText(path.join(workspace, "notes", "a.md"), "a\n");
  writeText(path.join(workspace, "notes", "sub", "keep.md"), "keep\n");
  writeProjectConfig(configPath, {
    profile: "default",
    rootDir: workspace,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: [{ source: path.join(workspace, "notes"), destination: "notes", kind: "directory" }]
  });
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // The hub removes a.md (so a snapshot is written) and adds sub/new.md
  // (which cannot be created in the read-only directory).
  const checkout = cloneRemote(remoteDir, root, "peer");
  fs.rmSync(path.join(checkout, "shared", "notes", "a.md"));
  writeText(path.join(checkout, "shared", "notes", "sub", "new.md"), "new\n");
  git(["add", "-A"], checkout);
  git(["commit", "-m", "peer removes one file and adds one"], checkout);
  git(["push", "origin", "HEAD:main"], checkout);

  const readOnly = path.join(workspace, "notes", "sub");
  fs.chmodSync(readOnly, 0o555);
  let result;
  try {
    result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"], {
      expectFailure: true
    });
  } finally {
    fs.chmodSync(readOnly, 0o755);
  }

  assert.equal(result.status, 13, result.stderr);
  assert.match(result.stderr, /pull stopped part way: notes\/sub\/new\.md failed/);
  assert.match(result.stderr, /Already applied \(1 of 2\): notes\/a\.md/);
  assert.match(result.stderr, /The previous content of notes\/a\.md is in the pre-apply snapshot 'notes' \S+ /);
  assert.match(
    result.stderr,
    /notes\/sub\/new\.md was being created, so no snapshot holds a previous copy of it, and it may be partially written\./
  );
  assert.doesNotMatch(result.stderr, /notes\/sub\/new\.md itself, which may be partially written, is in the pre-apply/);
  // A snapshot was written, so the copy-aside advice still applies.
  assert.match(result.stderr, /rotates older generations away, so copy the generation named above aside/);
});

test("pull: a failing create after only applied creates points at no snapshot content", (t: {
  skip: (reason: string) => void;
}) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("a read-only directory does not stop root");
    return;
  }
  const root = createSandbox("pull-partial-apply-creates-only-applied");
  const remoteDir = initBareRemote(root);
  const workspace = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(root, "state");
  writeText(path.join(workspace, "notes", "z.md"), "z\n");
  writeText(path.join(workspace, "notes", "sub", "keep.md"), "keep\n");
  writeProjectConfig(configPath, {
    profile: "default",
    rootDir: workspace,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: [{ source: path.join(workspace, "notes"), destination: "notes", kind: "directory" }]
  });
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  // The hub adds a.md (created first) and sub/new.md (cannot be created in the
  // read-only directory) and removes z.md, which is what writes a snapshot.
  const checkout = cloneRemote(remoteDir, root, "peer");
  fs.rmSync(path.join(checkout, "shared", "notes", "z.md"));
  writeText(path.join(checkout, "shared", "notes", "a.md"), "a\n");
  writeText(path.join(checkout, "shared", "notes", "sub", "new.md"), "new\n");
  git(["add", "-A"], checkout);
  git(["commit", "-m", "peer adds two files and removes one"], checkout);
  git(["push", "origin", "HEAD:main"], checkout);

  const readOnly = path.join(workspace, "notes", "sub");
  fs.chmodSync(readOnly, 0o555);
  let result;
  try {
    result = runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"], {
      expectFailure: true
    });
  } finally {
    fs.chmodSync(readOnly, 0o755);
  }

  assert.equal(result.status, 13, result.stderr);
  assert.match(result.stderr, /Already applied \(1 of 3\): notes\/a\.md\./);
  assert.match(
    result.stderr,
    /Already applied \(1 of 3\): notes\/a\.md\. notes\/sub\/new\.md was being created, so no snapshot holds a previous copy of it, and it may be partially written\. The base snapshot was not moved\./
  );
  assert.doesNotMatch(result.stderr, /The previous content of/);
  assert.doesNotMatch(result.stderr, /copy the generation named above aside/);
});
