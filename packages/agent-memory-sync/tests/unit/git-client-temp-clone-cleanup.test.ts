// A temp clone that GitClient.prepareWorkingCopy builds must be removable the
// moment the caller is done with it (agent-tasks 14d04351). git's own
// auto-maintenance is the writer that used to break that: `git fetch` ends by
// running `git maintenance run --auto --detach`, a daemonised process that
// outlives the fetch and, once it decides to run `gc`, repacks and prunes
// inside <clone>/.git/objects. A recursive rm that races it fails with
// `ENOTEMPTY: directory not empty, rmdir .../tmp/pull/.git/objects`.
//
// The default thresholds need thousands of loose objects, so the daemon almost
// never does real work in a small test corpus. These tests lower the threshold
// through a global git config (the same shape as a machine whose own git config
// is tuned that way, and the only way to make the race reproducible on
// demand), keep fetched objects loose so gc has a real amount of work, and
// craft blobs whose object ids start with `17`, the one object directory gc's
// loose-object estimate samples.

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { GitClient } = require("../../src/memory-sync/git-client");

const createdSandboxes: string[] = [];
test.after(() => {
  for (const dir of createdSandboxes) rmSync(dir, { recursive: true, force: true });
});

function sandbox(name: string): string {
  const root = path.join(
    tmpdir(),
    `agent-memory-sync-temp-clone-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  mkdirSync(root, { recursive: true });
  createdSandboxes.push(root);
  return root;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

// Blob contents whose object id starts with "17", so they land in
// .git/objects/17, the directory `git gc --auto` counts to estimate loose
// objects. Computed in-process (sha1 over "blob <len>\0<content>") rather than
// by spawning `git hash-object` per candidate.
function contentsInObjectDir17(count: number): string[] {
  const found: string[] = [];
  for (let candidate = 0; found.length < count; candidate += 1) {
    const content = `pad ${candidate}\n`;
    const id = createHash("sha1")
      .update(`blob ${Buffer.byteLength(content)}\0`)
      .update(content)
      .digest("hex");
    if (id.startsWith("17")) {
      found.push(content);
    }
  }
  return found;
}

function seedRemote(root: string): string {
  const remoteDir = path.join(root, "remote.git");
  mkdirSync(remoteDir, { recursive: true });
  git(["init", "--bare", "--initial-branch=main"], remoteDir);

  const seed = path.join(root, "seed");
  git(["clone", remoteDir, seed], root);
  git(["config", "user.name", "test-runner"], seed);
  git(["config", "user.email", "test-runner@example.invalid"], seed);
  for (let index = 0; index < 400; index += 1) {
    writeFileSync(path.join(seed, `note-${index}.md`), `entry ${index}\n`, "utf8");
  }
  contentsInObjectDir17(3).forEach((content, index) => {
    writeFileSync(path.join(seed, `pad-${index}.md`), content, "utf8");
  });
  git(["add", "-A"], seed);
  git(["commit", "-m", "seed"], seed);
  git(["push", "origin", "HEAD:main"], seed);
  return remoteDir;
}

// Runs `body` with a global git config that makes gc fire on a single loose
// object in objects/17 and keeps fetched objects loose (so gc has hundreds to
// repack and prune), then restores the process environment.
// Runs `body` with the eager gc config as the global git config. Returns false
// (after marking the test skipped) without running `body` when git does not
// honour GIT_CONFIG_GLOBAL (git < 2.32): the race would then not be exercised
// and the test would pass vacuously.
function withEagerAutoGc(t: { skip: (message?: string) => void }, root: string, body: () => void): boolean {
  const configPath = path.join(root, "eager-gc.gitconfig");
  writeFileSync(
    configPath,
    "[gc]\n\tauto = 1\n[fetch]\n\tunpackLimit = 100000\n[transfer]\n\tunpackLimit = 100000\n",
    "utf8"
  );
  const saved = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM
  };
  process.env.GIT_CONFIG_GLOBAL = configPath;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    let gcAuto = "";
    try {
      gcAuto = execFileSync("git", ["config", "--global", "--get", "gc.auto"], {
        encoding: "utf8"
      }).trim();
    } catch {
      gcAuto = "";
    }
    if (gcAuto !== "1") {
      t.skip(
        `eager gc config not in effect (global gc.auto=${gcAuto || "unset"}); this test needs git >= 2.32 for GIT_CONFIG_GLOBAL`
      );
      return false;
    }
    body();
    return true;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("GitClient.prepareWorkingCopy: the temp clone turns git's auto-maintenance off", () => {
  const root = sandbox("config");
  const remoteDir = seedRemote(root);
  const client = new GitClient("git");

  const { repoDir } = client.prepareWorkingCopy(remoteDir, "main", client.createTempRepoDir(root, "pull"));

  assert.equal(git(["config", "--local", "--get", "gc.auto"], repoDir).trim(), "0");
  assert.equal(git(["config", "--local", "--get", "maintenance.auto"], repoDir).trim(), "false");
});

test("GitClient.prepareWorkingCopy: a temp clone can be removed right away even when the machine's git config makes gc eager", (t: {
  skip: (message?: string) => void;
}) => {
  const root = sandbox("race");
  const remoteDir = seedRemote(root);
  const client = new GitClient("git");
  const iterations = 15;

  const failures: string[] = [];
  const ran = withEagerAutoGc(t, root, () => {
    for (let index = 0; index < iterations; index += 1) {
      const repoDir = client.createTempRepoDir(root, `pull-${index}`);
      client.prepareWorkingCopy(remoteDir, "main", repoDir);
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch (error: unknown) {
        failures.push(`${(error as { code?: string }).code}: ${(error as Error).message}`);
        rmSync(repoDir, { recursive: true, force: true });
      }
    }
  });
  if (!ran) return;

  assert.deepEqual(failures, [], `${failures.length} of ${iterations} removals raced a background git process`);
});
