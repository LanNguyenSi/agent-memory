// A destination restore after a local case-only rename (hub logs/foo.md, local
// logs/Foo.md) on a case-insensitive filesystem. The hub path and the local
// path are one file there: the write lands in Foo.md, and the removal of the
// "extra" local Foo.md then deleted the file the restore had just written, so
// the command exited 0 with the restored file gone. It now stops with exit 12
// before any snapshot or write, naming both paths.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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

// True when a name that differs only in case resolves to the same file here.
function directoryFoldsCase(dir: string): boolean {
  const probe = path.join(dir, "case-probe.txt");
  fs.writeFileSync(probe, "x");
  try {
    return fs.existsSync(path.join(dir, "CASE-PROBE.TXT"));
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

function setup(name: string) {
  const root = createSandbox(name);
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(root, "state");
  writeText(path.join(workspaceRoot, "logs", "foo.md"), "hub content\n");
  writeText(path.join(workspaceRoot, "logs", "other.md"), "other\n");
  writeProjectConfig(configPath, {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir,
    syncPaths: [{ source: "logs", destination: "logs", kind: "directory" }]
  });
  runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const sha = git(["rev-parse", "HEAD"], cloneRemote(remoteDir, root, "inspect")).trim();
  return { root, workspaceRoot, configPath, stateDir, sha };
}

test("restore --from-commit refuses a removable path that aliases a restored one by case", (t: {
  skip: (reason: string) => void;
}) => {
  const ctx = setup("restore-case-alias");
  const logsDir = path.join(ctx.workspaceRoot, "logs");
  if (!directoryFoldsCase(logsDir)) {
    t.skip("this filesystem is case-sensitive; foo.md and Foo.md are different files here");
    return;
  }

  // The local case-only rename.
  fs.renameSync(path.join(logsDir, "foo.md"), path.join(logsDir, "Foo.md"));
  writeText(path.join(logsDir, "Foo.md"), "local edit\n");

  const args = (extra: string[]) => [
    "restore",
    "default",
    "logs",
    "--config",
    ctx.configPath,
    "--from-commit",
    ctx.sha,
    ...extra,
    "--output",
    "json"
  ];

  for (const extra of [["--dry-run"], ["--yes"]]) {
    const result = runCli(args(extra), { expectFailure: true });
    assert.equal(result.status, 12, `${extra.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /logs\/foo\.md/);
    assert.match(result.stderr, /logs\/Foo\.md/);
    assert.match(result.stderr, /No file was written or removed and no pre-apply snapshot was taken/);
  }

  // Nothing was written, removed or snapshotted.
  assert.equal(readText(path.join(logsDir, "Foo.md")), "local edit\n");
  assert.deepEqual(fs.readdirSync(logsDir).sort(), ["Foo.md", "other.md"]);
  assert.equal(fs.existsSync(path.join(ctx.stateDir, "snapshots", "logs")), false);
});
