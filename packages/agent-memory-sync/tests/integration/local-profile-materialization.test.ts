// Covers the workflow docs/machine-setup.md's "Real per-machine profiles
// are local-only" section now documents: a machine's real profile is a
// *.example.json template, copied somewhere local and git-ignored, with its
// placeholders filled in. Nothing about that workflow changes how
// agent-memory-sync resolves a profile. This test proves it end to end
// against a materialized copy of the mac-mini template, at a path OUTSIDE
// this repo's tracked profiles/ directory entirely (a stand-in for an
// operator's own local, git-ignored location), so a regression that makes
// the CLI implicitly depend on the profile living under packages/
// agent-memory-sync/profiles/ specifically would fail here.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  createSandbox,
  fileExists,
  initBareRemote,
  readText,
  runCli,
  writeText
} = require("../helpers/cli.ts");

const PROFILES_DIR = path.resolve(process.cwd(), "profiles");

// Fills in the template's placeholders the way docs/machine-setup.md
// instructs an operator to for a brand-new machine, with a fictitious user
// and slug, chosen precisely so nothing under this fake "/Users/<fakeUser>"
// path can exist on the machine actually running this test, keeping the
// unmapped machine-state/frictions syncPaths entries (see below) inert
// rather than merely sandboxed.
function materializeTemplate(templateFile: string, fakeUser: string, fakeSlug: string): Record<string, unknown> {
  const templateText = readText(path.join(PROFILES_DIR, templateFile));
  const filledInText = templateText
    .split("<claude-code-slug-for-this-machine>").join(fakeSlug)
    .split("<user>").join(fakeUser);
  return JSON.parse(filledInText);
}

test("a real, filled-in mac-mini profile parses into the documented settings after materialization", () => {
  const fakeUser = "<fixture-user>";
  const fakeSlug = "-Users-<fixture-user>-git-pandora";
  const settings = materializeTemplate("mac-mini.example.json", fakeUser, fakeSlug);

  // No placeholder survives filling in; a leftover '<...>' token would mean
  // this test (or a future template edit) missed one.
  const serialized = JSON.stringify(settings);
  assert.ok(!serialized.includes("<user>"), "materialized profile still contains an unresolved '<user>' placeholder");
  assert.ok(
    !serialized.includes("<claude-code-slug-for-this-machine>"),
    "materialized profile still contains an unresolved slug placeholder"
  );

  assert.equal(settings.profile, "mac-mini");
  assert.equal(settings.repositorySubdir, "pandora");
  assert.equal(settings.rootDir, `/Users/${fakeUser}/.claude/projects/${fakeSlug}/memory`);
  assert.equal(settings.remoteUrl, `/Users/${fakeUser}/memory-sync/pandora-memory.git`);
  assert.equal(settings.stateDir, `/Users/${fakeUser}/.agent-memory-sync/mac-mini`);

  // Materialize it at a path OUTSIDE packages/agent-memory-sync/profiles/
  // entirely (this test's own OS-tmpdir sandbox), then ask the CLI to parse
  // it via `config show --config <path>`, the same code path `run`/`watch`/
  // `restore` all go through (loadConfig in src/config/loader.ts), proving
  // resolution does not care where the real, local file lives.
  const root = createSandbox("local-profile-materialization-parse");
  const materializedPath = path.join(root, "not-under-repo-profiles-dir", "mac-mini.json");
  writeText(materializedPath, `${JSON.stringify(settings, null, 2)}\n`);

  const result = runCli(["config", "show", "--config", materializedPath, "--output", "json"]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.path, materializedPath);
  assert.equal(payload.settings.profile, "mac-mini");
  assert.equal(payload.settings.repositorySubdir, "pandora");
  assert.equal(payload.settings.rootDir, `/Users/${fakeUser}/.claude/projects/${fakeSlug}/memory`);
});

test("a real, filled-in mac-mini profile actually syncs from that local, non-repo path", () => {
  const fakeUser = "<fixture-user-2>";
  const fakeSlug = "-Users-<fixture-user-2>-git-pandora";
  const settings = materializeTemplate("mac-mini.example.json", fakeUser, fakeSlug);

  const root = createSandbox("local-profile-materialization-sync");
  const remoteDir = initBareRemote(root);

  // The two machine-absolute syncPaths entries (machine-state, frictions)
  // are left pointing at the fictitious /Users/<fixture-user-2>/.harness/...
  // paths the materialized file itself carries, deliberately NOT remapped
  // into the sandbox. Since that user does not exist on any real machine,
  // those paths cannot exist locally either, so collectLocalSyncFiles (see
  // src/memory-sync/config.ts) treats both as an absent, non-required
  // source and skips them without ever touching the filesystem, the same
  // missing-source tolerance every fresh real machine relies on before its
  // first machine-state/frictions write. Asserted explicitly below so a
  // change to that tolerance (or to this fixture's fake path no longer
  // being safely absent) fails loudly instead of this test silently writing
  // outside its own sandbox.
  const machineStateEntry = (settings.syncPaths as Array<Record<string, unknown>>).find(
    (entry) => entry.destination === "machine-state"
  );
  const frictionsEntry = (settings.syncPaths as Array<Record<string, unknown>>).find(
    (entry) => entry.destination === "frictions"
  );
  assert.ok(machineStateEntry && typeof machineStateEntry.source === "string");
  assert.ok(frictionsEntry && typeof frictionsEntry.source === "string");
  assert.equal(fileExists(machineStateEntry!.source as string), false);
  assert.equal(fileExists(frictionsEntry!.source as string), false);

  const materializedPath = path.join(root, "not-under-repo-profiles-dir", "mac-mini.json");
  writeText(materializedPath, `${JSON.stringify(settings, null, 2)}\n`);

  const sandboxedRootDir = path.join(root, "mini-workspace");
  const sandboxedStateDir = path.join(root, "mini-state");
  writeText(path.join(sandboxedRootDir, "MEMORY.md"), "materialized-profile fixture memory\n");

  // --root-dir/--state-dir/--remote win over the file's own (fictitious)
  // values per resolveRunConfig's merge order (src/config/loader.ts), so
  // this push runs entirely against the sandbox even though the file on
  // disk still carries /Users/<fixture-user-2>/... verbatim.
  const push = runCli([
    "run",
    "mac-mini",
    "--config",
    materializedPath,
    "--root-dir",
    sandboxedRootDir,
    "--state-dir",
    sandboxedStateDir,
    "--remote",
    remoteDir,
    "--mode",
    "push",
    "--output",
    "json"
  ]);
  const payload = JSON.parse(push.stdout).runs[0];
  assert.equal(payload.status, "applied");
  assert.ok(
    payload.appliedFiles.some((f: string) => f.endsWith("MEMORY.md")),
    `expected MEMORY.md among pushed files, got: ${JSON.stringify(payload.appliedFiles)}`
  );
});
