// A pull whose pre-apply snapshot is not intact before the first write or
// removal stops with exit code 12, names the cause on stderr, writes and
// removes no local file and leaves the base snapshot alone. The damage is
// injected through tests/helpers/pull-snapshot-fault.cjs; every run happens in
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const preload = path.resolve(process.cwd(), "tests", "helpers", "pull-snapshot-fault.cjs");

interface Fault {
  kind: "drop-snapshot" | "omit-from-snapshot" | "hide-from-collection";
  destination?: string;
  path?: string;
}

function faultEnv(faults: Fault[]): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${preload}"`.trim(),
    AGENT_MEMORY_SYNC_TEST_PULL_FAULTS: JSON.stringify(faults)
  };
}

function setup(name: string, destinations: string[]) {
  const root = createSandbox(name);
  const remoteDir = initBareRemote(root);
  const workspace = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(root, "state");
  for (const destination of destinations) {
    for (let index = 0; index < 3; index += 1) {
      writeText(path.join(workspace, destination, `n${index}.md`), `${destination} ${index}\n`);
    }
  }
  writeProjectConfig(configPath, {
    profile: "default",
    rootDir: workspace,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    conflictStrategy: "inline-markers",
    syncPaths: destinations.map((destination) => ({
      source: path.join(workspace, destination),
      destination,
      kind: "directory"
    }))
  });
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);

  return {
    root,
    remoteDir,
    workspace,
    configPath,
    stateDir,
    snapshotIds: (destination: string): string[] => {
      const dir = path.join(stateDir, "snapshots", destination);
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    base: (): Record<string, string | null> => new StateStore(stateDir, "default").readBaseSnapshots(),
    // A peer deletes n0.md and edits n1.md in every destination, and adds a new n9.md.
    peerChanges: (peerName: string) => {
      const checkout = cloneRemote(remoteDir, root, peerName);
      for (const destination of destinations) {
        fs.rmSync(path.join(checkout, "shared", destination, "n0.md"));
        writeText(path.join(checkout, "shared", destination, "n1.md"), `${destination} edited by peer\n`);
        writeText(path.join(checkout, "shared", destination, "n9.md"), `${destination} new\n`);
      }
      git(["add", "-A"], checkout);
      git(["commit", "-m", "peer changes"], checkout);
      git(["push", "origin", "HEAD:main"], checkout);
    },
    pull: (faults: Fault[]) =>
      runCli(["run", "default", "--config", configPath, "--mode", "pull", "--output", "json"], {
        env: faultEnv(faults),
        expectFailure: true
      })
  };
}

function assertUntouched(ctx: ReturnType<typeof setup>, destinations: string[]) {
  for (const destination of destinations) {
    for (let index = 0; index < 3; index += 1) {
      assert.equal(
        readText(path.join(ctx.workspace, destination, `n${index}.md`)),
        `${destination} ${index}\n`,
        `${destination}/n${index}.md is unchanged`
      );
    }
    assert.equal(
      fs.existsSync(path.join(ctx.workspace, destination, "n9.md")),
      false,
      `${destination}/n9.md not written`
    );
  }
}

test("pull: a snapshot that does not hold a path the plan removes stops with exit 12 and changes nothing", () => {
  const ctx = setup("pull-fc-remove", ["notes"]);
  ctx.peerChanges("peer");
  const baseBefore = ctx.base();

  const result = ctx.pull([{ kind: "omit-from-snapshot", destination: "notes", path: "notes/n0.md" }]);

  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stderr, /pull stopped: the pre-apply snapshot for 'notes' is not intact/);
  assert.match(result.stderr, /does not list notes\/n0\.md/);
  assert.match(
    result.stderr,
    new RegExp(
      `run the pull again\\. If it stops again, check the snapshot store at ${escapeRegExp(path.join(ctx.stateDir, "snapshots", "notes"))}/ ` +
        "\\(free space, permissions, another process removing generations, or the machine's clock\\)"
    )
  );
  assert.doesNotMatch(result.stderr, /move it aside/, "the read-back hint no longer sends the operator to move a path");
  assert.match(result.stderr, /No local file was written or removed and the base snapshot was not moved/);
  assertUntouched(ctx, ["notes"]);
  assert.deepEqual(ctx.base(), baseBefore, "the base snapshot did not move");
});

test("pull: a snapshot that does not hold a path the plan overwrites stops with exit 12 and changes nothing", () => {
  const ctx = setup("pull-fc-overwrite", ["notes"]);
  ctx.peerChanges("peer");
  const baseBefore = ctx.base();

  const result = ctx.pull([{ kind: "omit-from-snapshot", destination: "notes", path: "notes/n1.md" }]);

  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stderr, /does not list notes\/n1\.md/);
  assertUntouched(ctx, ["notes"]);
  assert.deepEqual(ctx.base(), baseBefore, "the base snapshot did not move");
});

// The peer adds n8.md; a local file of the same name appears on this machine
// after the pull collected its files, so the plan holds a plain "create" for a
// path that exists on disk by the time it is applied. With `alsoDelete` the
// destination also has a removal, so a snapshot is taken but cannot hold n8.md;
// without it the plan only adds files and no snapshot is taken at all.
function createdAfterCollection(name: string, alsoDelete: boolean) {
  const ctx = setup(name, ["notes"]);
  const checkout = cloneRemote(ctx.remoteDir, ctx.root, "peer-create");
  writeText(path.join(checkout, "shared", "notes", "n8.md"), "from the hub\n");
  if (alsoDelete) {
    fs.rmSync(path.join(checkout, "shared", "notes", "n0.md"));
  }
  git(["add", "-A"], checkout);
  git(["commit", "-m", "peer adds n8"], checkout);
  git(["push", "origin", "HEAD:main"], checkout);
  writeText(path.join(ctx.workspace, "notes", "n8.md"), "typed locally\n");
  const baseBefore = ctx.base();
  const result = ctx.pull([{ kind: "hide-from-collection", path: "notes/n8.md" }]);
  return { ctx, baseBefore, result };
}

test("pull: a path created after the local files were collected is never overwritten without a copy", () => {
  const { ctx, baseBefore, result } = createdAfterCollection("pull-fc-created", true);

  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stderr, /pull stopped: notes\/n8\.md exists on disk but is not a regular file the sync collects/);
  assert.match(
    result.stderr,
    /a file created after the run collected its files\), so no pre-apply snapshot can hold a copy of it\. No local file was written or removed, no snapshot was written and the base snapshot was not moved; run the pull again first\. Only if it stops again at the same path, move notes\/n8\.md aside and run the pull again$/m
  );
  assert.equal(readText(path.join(ctx.workspace, "notes", "n8.md")), "typed locally\n");
  assert.equal(readText(path.join(ctx.workspace, "notes", "n0.md")), "notes 0\n");
  assert.deepEqual(ctx.base(), baseBefore, "the base snapshot did not move");
  assert.deepEqual(ctx.snapshotIds("notes"), [], "no snapshot was written for a stop that happens before it");
});

test("pull: a path created after collection in a destination the plan only adds to is not overwritten either", () => {
  const { ctx, baseBefore, result } = createdAfterCollection("pull-fc-created-only", false);

  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stderr, /pull stopped: notes\/n8\.md exists on disk but is not a regular file the sync collects/);
  assert.equal(readText(path.join(ctx.workspace, "notes", "n8.md")), "typed locally\n");
  assert.deepEqual(ctx.base(), baseBefore, "the base snapshot did not move");
});

test("pull: a snapshot generation that is gone stops with exit 12 and changes nothing", () => {
  const ctx = setup("pull-fc-gone", ["notes"]);
  ctx.peerChanges("peer");
  const baseBefore = ctx.base();

  const result = ctx.pull([{ kind: "drop-snapshot", destination: "notes" }]);

  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stderr, /no longer exists/);
  assertUntouched(ctx, ["notes"]);
  assert.deepEqual(ctx.base(), baseBefore, "the base snapshot did not move");
});

test("pull: with two destinations, damage to only the second destination's snapshot applies nothing in either", () => {
  const destinations = ["alpha", "beta"];
  const ctx = setup("pull-fc-two", destinations);
  ctx.peerChanges("peer");
  const baseBefore = ctx.base();

  const result = ctx.pull([{ kind: "drop-snapshot", destination: "beta" }]);

  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stderr, /snapshot for 'beta' is not intact/);
  assert.doesNotMatch(result.stderr, /snapshot for 'alpha'/);
  assertUntouched(ctx, destinations);
  assert.deepEqual(ctx.base(), baseBefore, "the base snapshot did not move");
});

test("pull: the same changes apply when no snapshot is damaged", () => {
  const destinations = ["alpha", "beta"];
  const ctx = setup("pull-fc-control", destinations);
  ctx.peerChanges("peer");

  const result = ctx.pull([]);

  assert.equal(result.status, 0, result.stderr);
  for (const destination of destinations) {
    assert.equal(fs.existsSync(path.join(ctx.workspace, destination, "n0.md")), false);
    assert.equal(readText(path.join(ctx.workspace, destination, "n1.md")), `${destination} edited by peer\n`);
    assert.equal(readText(path.join(ctx.workspace, destination, "n9.md")), `${destination} new\n`);
  }
});

// A local entry the sync never collects (a symlink, a directory, a case or
// Unicode-normalization alias) at a path the hub creates is a persistent
// stop: it repeats on every run. It must stop before any snapshot is written,
// or each retry would write one more generation and rotate an older one away.
function symlinkOrSkip(t: { skip: (reason: string) => void }, target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch {
    t.skip("symlinks are not available on this platform");
    return false;
  }
}

function peerAddsAndEdits(ctx: ReturnType<typeof setup>, peerName: string) {
  const checkout = cloneRemote(ctx.remoteDir, ctx.root, peerName);
  writeText(path.join(checkout, "shared", "notes", "n7.md"), "from the hub\n");
  writeText(path.join(checkout, "shared", "notes", "n1.md"), `edited by ${peerName}\n`);
  git(["add", "-A"], checkout);
  git(["commit", "-m", `${peerName} changes`], checkout);
  git(["push", "origin", "HEAD:main"], checkout);
}

test("pull: a symlink at a hub-created path stops with exit 12 and leaves the link and its target alone", (t: {
  skip: (reason: string) => void;
}) => {
  const ctx = setup("pull-fc-symlink", ["notes"]);
  peerAddsAndEdits(ctx, "peer");
  const targetPath = path.join(ctx.root, "outside-target.md");
  writeText(targetPath, "precious\n");
  const linkPath = path.join(ctx.workspace, "notes", "n7.md");
  if (!symlinkOrSkip(t, targetPath, linkPath)) {
    return;
  }
  const baseBefore = ctx.base();

  const result = ctx.pull([]);

  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stderr, /pull stopped: notes\/n7\.md exists on disk but is not a regular file the sync collects/);
  assert.match(result.stderr, /move notes\/n7\.md aside and run the pull again/);
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, "the symlink is still a symlink");
  assert.equal(readText(targetPath), "precious\n", "the symlink target is unchanged");
  assert.equal(readText(path.join(ctx.workspace, "notes", "n1.md")), "notes 1\n", "no other path was applied");
  assert.deepEqual(ctx.snapshotIds("notes"), [], "no snapshot was written");
  assert.deepEqual(ctx.base(), baseBefore, "the base snapshot did not move");
});

test("pull: a dangling symlink at a hub-created path is not written through", (t: {
  skip: (reason: string) => void;
}) => {
  const ctx = setup("pull-fc-dangling", ["notes"]);
  peerAddsAndEdits(ctx, "peer");
  const targetPath = path.join(ctx.root, "not-there-yet.md");
  const linkPath = path.join(ctx.workspace, "notes", "n7.md");
  if (!symlinkOrSkip(t, targetPath, linkPath)) {
    return;
  }

  const result = ctx.pull([]);

  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stderr, /notes\/n7\.md exists on disk but is not a regular file the sync collects/);
  assert.equal(fs.existsSync(targetPath), false, "nothing was written through the dangling link");
});

test("pull: a persistent stop does not rotate the earlier snapshot generations away", (t: {
  skip: (reason: string) => void;
}) => {
  const ctx = setup("pull-fc-rotation", ["notes"]);
  ctx.peerChanges("peer-first");
  const seeded = ctx.pull([]);
  assert.equal(seeded.status, 0, seeded.stderr);
  const seededIds = ctx.snapshotIds("notes");
  assert.equal(seededIds.length, 1, "the first pull wrote one generation");
  const seededFile = path.join(ctx.stateDir, "snapshots", "notes", seededIds[0]);

  peerAddsAndEdits(ctx, "peer-second");
  const targetPath = path.join(ctx.root, "outside-target.md");
  writeText(targetPath, "precious\n");
  if (!symlinkOrSkip(t, targetPath, path.join(ctx.workspace, "notes", "n7.md"))) {
    return;
  }
  const baseBefore = ctx.base();

  // snapshotGenerations defaults to 3: one more stuck run than that would
  // have rotated the seeded generation away.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = ctx.pull([]);
    assert.equal(result.status, 12, `attempt ${attempt}: ${result.stderr}`);
  }

  assert.equal(fs.existsSync(seededFile), true, "the seeded generation still exists");
  assert.deepEqual(ctx.snapshotIds("notes"), seededIds, "no generation was written or rotated away");
  assert.deepEqual(ctx.base(), baseBefore, "the base snapshot did not move");
});

// --dry-run is how an operator inspects a plan before running it, so it must
// not preview one the real run refuses at exit 12 for an uncollected path.
test("pull --dry-run stops with the same exit 12 as the real run for an uncollected path", () => {
  const { ctx, baseBefore } = createdAfterCollection("pull-fc-dry-run", true);
  const dryRun = runCli(
    ["run", "default", "--config", ctx.configPath, "--mode", "pull", "--dry-run", "--output", "json"],
    { env: faultEnv([{ kind: "hide-from-collection", path: "notes/n8.md" }]), expectFailure: true }
  );
  const real = ctx.pull([{ kind: "hide-from-collection", path: "notes/n8.md" }]);

  assert.equal(dryRun.status, 12, dryRun.stderr);
  assert.equal(real.status, 12, real.stderr);
  const errorLine = (stderr: string): string => stderr.split("\n").find((line) => line.startsWith("error:")) || "";
  assert.notEqual(errorLine(real.stderr), "");
  assert.equal(
    errorLine(dryRun.stderr),
    errorLine(real.stderr),
    "the dry run reports the same message as the real run"
  );
  assert.match(dryRun.stderr, /pull stopped: notes\/n8\.md exists on disk but is not a regular file the sync collects/);
  assert.equal(readText(path.join(ctx.workspace, "notes", "n8.md")), "typed locally\n");
  assert.deepEqual(ctx.snapshotIds("notes"), [], "no snapshot was written");
  assert.deepEqual(ctx.base(), baseBefore, "the base snapshot did not move");
});

test("pull --dry-run still previews a plan the real run accepts", () => {
  const ctx = setup("pull-fc-dry-run-control", ["notes"]);
  ctx.peerChanges("peer");

  const dryRun = runCli(
    ["run", "default", "--config", ctx.configPath, "--mode", "pull", "--dry-run", "--output", "json"],
    { env: faultEnv([]) }
  );

  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).runs[0].status, "dry-run");
  assertUntouched(ctx, ["notes"]);
  assert.deepEqual(ctx.snapshotIds("notes"), []);
});
