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
  assert.match(result.stderr, /does not list notes\/n8\.md/);
  assert.equal(readText(path.join(ctx.workspace, "notes", "n8.md")), "typed locally\n");
  assert.equal(readText(path.join(ctx.workspace, "notes", "n0.md")), "notes 0\n");
  assert.deepEqual(ctx.base(), baseBefore, "the base snapshot did not move");
});

test("pull: a path created after collection in a destination the plan only adds to is not overwritten either", () => {
  const { ctx, baseBefore, result } = createdAfterCollection("pull-fc-created-only", false);

  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stderr, /no pre-apply snapshot was taken that holds notes\/n8\.md/);
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
