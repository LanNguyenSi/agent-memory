// A destination restore after a local rename that the filesystem does not see
// as one (hub logs/foo.md, local logs/Foo.md) on a case-insensitive filesystem.
// The hub path and the local path are one file there: the write lands in Foo.md,
// and the removal of the "extra" local Foo.md then deleted the file the restore
// had just written, so the command exited 0 with the restored file gone. It now
// stops with exit 12 before any snapshot or write, naming both paths. Which
// spellings a filesystem treats as one entry (ASCII case, a final sigma, the
// German sharp s, ligature names, precomposed against decomposed forms) is the
// filesystem's own folding table, so every scenario first asks this filesystem
// whether the two spellings are one entry and skips when they are not.
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

// True when the two relative spellings name one entry in this directory.
function spellingsAreOneEntry(dir: string, hubRelative: string, localRelative: string): boolean {
  const probeDir = fs.mkdtempSync(path.join(dir, "fold-probe-"));
  try {
    writeText(path.join(probeDir, hubRelative), "x");
    return fs.existsSync(path.join(probeDir, localRelative));
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

function listFiles(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...listFiles(path.join(dir, entry.name), relative));
    } else {
      found.push(relative);
    }
  }
  return found.sort();
}

function setup(name: string, hubFiles: string[]) {
  const root = createSandbox(name);
  const remoteDir = initBareRemote(root);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const stateDir = path.join(root, "state");
  for (const hubFile of hubFiles) {
    writeText(path.join(workspaceRoot, "logs", hubFile), "hub content\n");
  }
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

function restoreArgs(ctx: { configPath: string; sha: string }, extra: string[]): string[] {
  return [
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
}

// Each case: the file the hub has, and the spelling the local copy was renamed
// to. A path with a folder part covers the folder-level alias.
const aliasCases: Array<{ label: string; hubFile: string; localFile: string }> = [
  { label: "ASCII case", hubFile: "foo.md", localFile: "Foo.md" },
  { label: "German sharp s (Grüße against GRÜSSE)", hubFile: "Grüße.md", localFile: "GRÜSSE.md" },
  { label: "Greek final sigma (ΟΔΟΣ against οδος)", hubFile: "ΟΔΟΣ.md", localFile: "οδος.md" },
  { label: "Unicode normalization (NFC against NFD)", hubFile: "café.md", localFile: "café.md" },
  { label: "folder-level case alias", hubFile: "sub/x.md", localFile: "Sub/x.md" },
  { label: "folder-level ligature alias", hubFile: "office/x.md", localFile: "oﬃce/x.md" }
];

for (const aliasCase of aliasCases) {
  test(`restore --from-commit refuses a removable path that aliases a restored one: ${aliasCase.label}`, (t: {
    skip: (reason: string) => void;
  }) => {
    const ctx = setup("restore-case-alias", [aliasCase.hubFile]);
    const logsDir = path.join(ctx.workspaceRoot, "logs");
    if (!spellingsAreOneEntry(ctx.root, aliasCase.hubFile, aliasCase.localFile)) {
      t.skip("this filesystem treats these two spellings as different entries");
      return;
    }

    // The local rename: the folder for a folder-level case, the file otherwise.
    const hubParts = aliasCase.hubFile.split("/");
    const localParts = aliasCase.localFile.split("/");
    fs.renameSync(path.join(logsDir, hubParts[0]), path.join(logsDir, localParts[0]));
    writeText(path.join(logsDir, aliasCase.localFile), "local edit\n");
    const before = listFiles(logsDir);
    if (!before.includes(aliasCase.localFile)) {
      t.skip("this filesystem keeps the original spelling on rename, so there is no local alias to restore over");
      return;
    }

    for (const extra of [["--dry-run"], ["--yes"]]) {
      const result = runCli(restoreArgs(ctx, extra), { expectFailure: true });
      assert.equal(result.status, 12, `${extra.join(" ")}: ${result.stderr}`);
      assert.ok(
        result.stderr.includes(path.join(logsDir, aliasCase.hubFile)),
        `names the restored path (${aliasCase.hubFile}): ${result.stderr}`
      );
      assert.ok(
        result.stderr.includes(path.join(logsDir, aliasCase.localFile)),
        `names the local path (${aliasCase.localFile}): ${result.stderr}`
      );
      assert.match(result.stderr, /No file was written or removed and no pre-apply snapshot was taken/);
    }

    // Nothing was written, removed or snapshotted.
    assert.deepEqual(listFiles(logsDir), before);
    assert.equal(readText(path.join(logsDir, aliasCase.localFile)), "local edit\n");
    assert.equal(fs.existsSync(path.join(ctx.stateDir, "snapshots", "logs")), false);
  });
}

test("restore --from-commit still removes a local-only file that is not an alias of a restored one", () => {
  const ctx = setup("restore-no-alias", ["foo.md"]);
  const logsDir = path.join(ctx.workspaceRoot, "logs");
  writeText(path.join(logsDir, "foo.md"), "local edit\n");
  writeText(path.join(logsDir, "extra.md"), "local only\n");

  const result = runCli(restoreArgs(ctx, ["--yes"]));
  assert.equal(result.status, 0);
  assert.equal(readText(path.join(logsDir, "foo.md")), "hub content\n");
  assert.equal(fs.existsSync(path.join(logsDir, "extra.md")), false);
});
