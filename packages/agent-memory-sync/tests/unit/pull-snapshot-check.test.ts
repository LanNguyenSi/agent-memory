// Unit coverage for the read-back a pull runs on its pre-apply snapshots
// before the first write or removal (findPullSnapshotProblem in
// src/memory-sync/pull.ts).
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { findPullSnapshotProblem } = require("../../src/memory-sync/pull");
const { writePreApplySnapshot } = require("../../src/memory-sync/pre-apply-snapshot");

interface Entry {
  remoteRelativePath: string;
  localAbsolutePath: string;
  content: string | null;
  overwrite: boolean;
}

function setup(name: string, destinations: string[] = ["notes"]) {
  const root = path.join(
    tmpdir(),
    `agent-memory-sync-pull-check-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const write = (remoteRelativePath: string, content: string) => {
    const absolutePath = path.join(workspace, remoteRelativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
    return { remoteRelativePath, absolutePath };
  };
  const entry = (remoteRelativePath: string, content: string | null, overwrite: boolean): Entry => ({
    remoteRelativePath,
    localAbsolutePath: path.join(workspace, remoteRelativePath),
    content,
    overwrite
  });
  const snapshot = (destination: string, files: Array<{ remoteRelativePath: string; absolutePath: string }>) => ({
    destination,
    id: writePreApplySnapshot({ stateDir, destination, files }).id
  });
  const check = (plan: Entry[], snapshots: Array<{ destination: string; id: string }>) =>
    findPullSnapshotProblem({
      stateDir,
      plan,
      snapshots,
      resolvedSyncPathEntries: destinations.map((destination) => ({ destination }))
    });
  return { stateDir, write, entry, snapshot, check };
}

test("a plan whose existing paths are all in the snapshot has no problem", () => {
  const ctx = setup("intact");
  const a = ctx.write("notes/a.md", "a\n");
  const b = ctx.write("notes/b.md", "b\n");
  const snapshots = [ctx.snapshot("notes", [a, b])];

  assert.equal(
    ctx.check([ctx.entry("notes/a.md", null, false), ctx.entry("notes/b.md", "new\n", true)], snapshots),
    null
  );
});

test("a removal of a path that is on disk but missing from the collected files is a problem", () => {
  const ctx = setup("remove");
  const a = ctx.write("notes/a.md", "a\n");
  ctx.write("notes/recreated.md", "typed after the collection\n");
  const snapshots = [ctx.snapshot("notes", [a])];

  const problem = ctx.check(
    [ctx.entry("notes/a.md", null, false), ctx.entry("notes/recreated.md", null, false)],
    snapshots
  );

  assert.ok(problem);
  assert.equal(problem.destination, "notes");
  assert.match(problem.problem, /does not list notes\/recreated\.md/);
});

test("an overwrite of a path that is on disk but missing from the collected files is a problem", () => {
  const ctx = setup("overwrite");
  const a = ctx.write("notes/a.md", "a\n");
  ctx.write("notes/recreated.md", "typed after the collection\n");
  const snapshots = [ctx.snapshot("notes", [a])];

  const problem = ctx.check(
    [ctx.entry("notes/a.md", "x\n", true), ctx.entry("notes/recreated.md", "hub copy\n", false)],
    snapshots
  );

  assert.ok(problem);
  assert.match(problem.problem, /does not list notes\/recreated\.md/);
});

test("a path that is not on disk needs no copy", () => {
  const ctx = setup("absent");
  const a = ctx.write("notes/a.md", "a\n");
  const snapshots = [ctx.snapshot("notes", [a])];

  assert.equal(
    ctx.check([ctx.entry("notes/a.md", null, false), ctx.entry("notes/gone.md", null, false)], snapshots),
    null
  );
  assert.equal(
    ctx.check([ctx.entry("notes/a.md", "x\n", true), ctx.entry("notes/new.md", "new\n", false)], snapshots),
    null
  );
});

test("a stored copy that has gone missing is a problem", () => {
  const ctx = setup("lost-copy");
  const a = ctx.write("notes/a.md", "a\n");
  const snapshots = [ctx.snapshot("notes", [a])];
  rmSync(path.join(ctx.stateDir, "snapshots", "notes", snapshots[0].id, "files", "notes", "a.md"));

  const problem = ctx.check([ctx.entry("notes/a.md", null, false)], snapshots);

  assert.ok(problem);
  assert.match(problem.problem, /missing its copy of notes\/a\.md/);
});

test("an existing path in a destination with no snapshot is a problem", () => {
  const ctx = setup("no-snapshot", ["alpha", "beta"]);
  const a = ctx.write("alpha/a.md", "a\n");
  ctx.write("beta/b.md", "b\n");
  const snapshots = [ctx.snapshot("alpha", [a])];

  const problem = ctx.check([ctx.entry("alpha/a.md", null, false), ctx.entry("beta/b.md", "x\n", false)], snapshots);

  assert.ok(problem);
  assert.equal(problem.destination, "beta");
  assert.match(problem.problem, /no pre-apply snapshot was taken that holds beta\/b\.md/);
});

test("the second destination's damaged snapshot is found although the first is intact", () => {
  const ctx = setup("second", ["alpha", "beta"]);
  const a = ctx.write("alpha/a.md", "a\n");
  const b = ctx.write("beta/b.md", "b\n");
  const snapshots = [ctx.snapshot("alpha", [a]), ctx.snapshot("beta", [b])];
  rmSync(path.join(ctx.stateDir, "snapshots", "beta", snapshots[1].id), { recursive: true, force: true });

  const problem = ctx.check([ctx.entry("alpha/a.md", null, false), ctx.entry("beta/b.md", null, false)], snapshots);

  assert.ok(problem);
  assert.equal(problem.destination, "beta");
});
