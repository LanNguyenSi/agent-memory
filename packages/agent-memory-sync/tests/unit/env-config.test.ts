// Unit tests for the AGENT_MEMORY_SYNC_* environment overrides in
// src/config/loader.ts's readEnvConfig(). AGENT_MEMORY_SYNC_REACHABILITY_
// CHECK_COMMAND has its own dedicated test file (reachability-check-command-
// env.test.ts); every other env var listed there — ROOT_DIR, BRANCH,
// REPOSITORY_SUBDIR, STATE_DIR, SCHEDULE, SYNC_PATHS, GIT_BINARY — had no
// test anywhere in the suite before this file.
//
// Hermetic: exercises loadConfig()/resolveRunConfig() directly against a
// nonexistent config path (mirroring reachability-check-command-env.test.ts
// and tests/unit/reachability.test.ts's "test the module directly" style),
// so only the env var under test — not a real config file — drives the
// result.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, resolveRunConfig } = require("../../src/config/loader");

async function resolveWithEnv(env: Record<string, string>): Promise<ReturnType<typeof resolveRunConfig>> {
  // Hermetic baseline: clear every ambient AGENT_MEMORY_SYNC_* variable first,
  // so the negative control ({}) and the positive cases measure against a
  // clean env even on a machine where the operator exports overrides.
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AGENT_MEMORY_SYNC_")) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
  }
  for (const key of Object.keys(env)) {
    if (!(key in previous)) previous[key] = process.env[key];
    process.env[key] = env[key];
  }

  try {
    const loaded = await loadConfig("/nonexistent/agent-memory-sync-config.json");
    return resolveRunConfig(loaded, { remoteUrl: "/tmp/does-not-matter.git" });
  } finally {
    for (const key of Object.keys(env)) {
      if (typeof previous[key] === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = previous[key] as string;
      }
    }
  }
}

test("AGENT_MEMORY_SYNC_ROOT_DIR sets rootDir", async () => {
  const runConfig = await resolveWithEnv({ AGENT_MEMORY_SYNC_ROOT_DIR: "/tmp/env-root" });
  assert.equal(runConfig.rootDir, "/tmp/env-root");
});

test("AGENT_MEMORY_SYNC_BRANCH sets branch", async () => {
  const runConfig = await resolveWithEnv({ AGENT_MEMORY_SYNC_BRANCH: "env-branch" });
  assert.equal(runConfig.branch, "env-branch");
});

test("AGENT_MEMORY_SYNC_REPOSITORY_SUBDIR sets repositorySubdir", async () => {
  const runConfig = await resolveWithEnv({ AGENT_MEMORY_SYNC_REPOSITORY_SUBDIR: "env-subdir" });
  assert.equal(runConfig.repositorySubdir, "env-subdir");
});

test("AGENT_MEMORY_SYNC_STATE_DIR sets stateDir (resolved against rootDir)", async () => {
  const runConfig = await resolveWithEnv({
    AGENT_MEMORY_SYNC_ROOT_DIR: "/tmp/env-root",
    AGENT_MEMORY_SYNC_STATE_DIR: "env-state"
  });
  assert.equal(runConfig.stateDir, "/tmp/env-root/env-state");
});

test("AGENT_MEMORY_SYNC_SCHEDULE sets schedule", async () => {
  const runConfig = await resolveWithEnv({ AGENT_MEMORY_SYNC_SCHEDULE: "*/15 * * * *" });
  assert.equal(runConfig.schedule, "*/15 * * * *");
});

test("AGENT_MEMORY_SYNC_GIT_BINARY sets gitBinary", async () => {
  const runConfig = await resolveWithEnv({ AGENT_MEMORY_SYNC_GIT_BINARY: "/usr/local/bin/git-env" });
  assert.equal(runConfig.gitBinary, "/usr/local/bin/git-env");
});

test("AGENT_MEMORY_SYNC_SYNC_PATHS parses a JSON array and normalizes it into syncPaths", async () => {
  const runConfig = await resolveWithEnv({
    AGENT_MEMORY_SYNC_SYNC_PATHS: JSON.stringify([{ source: "notes.md", destination: "notes.md", kind: "file" }])
  });
  assert.deepEqual(runConfig.syncPaths, [
    { source: "notes.md", destination: "notes.md", kind: "file", required: false, ownerScoped: false }
  ]);
});

// Not set at all: every one of the above must fall through to the built-in
// default, not to some parsed-undefined artifact — a negative control for
// the seven tests above.
test("none of the AGENT_MEMORY_SYNC_* overrides above apply when the env vars are unset", async () => {
  const runConfig = await resolveWithEnv({});
  assert.equal(runConfig.branch, "main");
  assert.equal(runConfig.schedule, null);
  assert.equal(runConfig.gitBinary, "git");
});
