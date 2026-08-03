// Pins the exact cross-machine scenario an orchestrator-run live E2E test
// (real bare repo on the mac mini) caught broken: profiles/macbook.json and
// profiles/mac-mini.json each wrote to their OWN top-level tree in the
// remote repo (repositorySubdir defaulted/was set per machine), so neither
// machine ever saw the other's pushes — a mini `pull` after a MacBook
// `push` reported applied=0. Separately, the profiles' syncPaths were
// template leftovers (a single "MEMORY.md" file plus nonexistent daily/
// logs/ directories) that never covered the real memory directory's ~236
// flat .md files, so even a same-tree push would have missed most content.
//
// This test loads the ACTUAL committed profile files (profiles/macbook.json,
// profiles/mac-mini.json) via --config, overriding only what a hermetic test
// must override to avoid touching real machines or the network
// (--root-dir, --state-dir, --remote) — repositorySubdir and syncPaths come
// from the real files, unmodified, so a regression in either (e.g.
// reintroducing a per-machine repositorySubdir, or narrowing syncPaths back
// to named files/dirs) fails this test.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync } = require("node:fs");
const path = require("node:path");
const { cloneRemote, createSandbox, fileExists, initBareRemote, readText, runCli, writeText } = require("../helpers/cli.ts");

const PROFILES_DIR = path.resolve(process.cwd(), "profiles");

function machineArgs(
  profileName: string,
  configPath: string,
  rootDir: string,
  stateDir: string,
  remoteDir: string,
  extra: string[]
): string[] {
  return [
    "run",
    profileName,
    "--config",
    configPath,
    "--root-dir",
    rootDir,
    "--state-dir",
    stateDir,
    "--remote",
    remoteDir,
    "--output",
    "json",
    ...extra
  ];
}

test("macbook and mac-mini profiles share one remote tree and see each other's pushes on pull (hermetic, local bare repo)", () => {
  const root = createSandbox("cross-machine-profiles");
  const remoteDir = initBareRemote(root);

  // Two independent temp "machines" with a flat .md-file memory layout —
  // no daily/ or logs/ subdirectories, matching the real Claude Code memory
  // directory shape the orchestrator's live E2E test found.
  const macbookRoot = path.join(root, "macbook-workspace");
  const miniRoot = path.join(root, "mini-workspace");
  const macbookState = path.join(root, "macbook-state");
  const miniState = path.join(root, "mini-state");

  const macbookConfigPath = path.join(PROFILES_DIR, "macbook.json");
  const miniConfigPath = path.join(PROFILES_DIR, "mac-mini.json");

  writeText(path.join(macbookRoot, "MEMORY.md"), "macbook memory\n");
  writeText(path.join(miniRoot, "MEMORY.md"), "mini memory\n");

  const macbookArgs = (...extra: string[]) =>
    machineArgs("macbook", macbookConfigPath, macbookRoot, macbookState, remoteDir, extra);
  const miniArgs = (...extra: string[]) =>
    machineArgs("mac-mini", miniConfigPath, miniRoot, miniState, remoteDir, extra);

  // Seed: the mini (source of truth) pushes first, mirroring the real setup
  // order in docs/machine-setup.md.
  const miniSeed = runCli(miniArgs("--mode", "push"));
  const miniSeedPayload = JSON.parse(miniSeed.stdout);
  assert.equal(miniSeedPayload.runs[0].status, "applied");

  // A brand-new flat file appears on the MacBook — a plain edit, not a file
  // named in any hardcoded syncPaths list.
  writeText(path.join(macbookRoot, "e2e-sync-test.md"), "new file from macbook\n");

  const macbookPush = runCli(macbookArgs("--mode", "push"));
  const macbookPushPayload = JSON.parse(macbookPush.stdout);
  assert.equal(macbookPushPayload.runs[0].status, "applied");
  assert.ok(
    macbookPushPayload.runs[0].appliedFiles.some((f: string) => f.endsWith("e2e-sync-test.md")),
    `expected e2e-sync-test.md among pushed files, got: ${JSON.stringify(macbookPushPayload.runs[0].appliedFiles)}`
  );

  // The mini pulls: it MUST see the new file. This is exactly what the
  // orchestrator's live E2E test found broken (applied=0).
  const miniPull = runCli(miniArgs("--mode", "pull"));
  const miniPullPayload = JSON.parse(miniPull.stdout);
  assert.notEqual(
    miniPullPayload.runs[0].appliedFiles.length,
    0,
    "mini pull reported applied=0 — macbook and mac-mini are not sharing a remote tree"
  );
  assert.equal(fileExists(path.join(miniRoot, "e2e-sync-test.md")), true);
  assert.equal(readText(path.join(miniRoot, "e2e-sync-test.md")), "new file from macbook\n");

  // Reverse direction: the mini edits, the MacBook pulls.
  writeText(path.join(miniRoot, "mini-only-note.md"), "note from the mini\n");
  const miniPush2 = runCli(miniArgs("--mode", "push"));
  const miniPush2Payload = JSON.parse(miniPush2.stdout);
  assert.equal(miniPush2Payload.runs[0].status, "applied");

  const macbookPull = runCli(macbookArgs("--mode", "pull"));
  const macbookPullPayload = JSON.parse(macbookPull.stdout);
  assert.notEqual(macbookPullPayload.runs[0].appliedFiles.length, 0);
  assert.equal(fileExists(path.join(macbookRoot, "mini-only-note.md")), true);
  assert.equal(readText(path.join(macbookRoot, "mini-only-note.md")), "note from the mini\n");

  // Bare-repo-level assertion: exactly one shared top-level tree (the
  // profiles' shared repositorySubdir), not two divergent per-machine trees.
  const inspectionDir = cloneRemote(remoteDir, root, "inspect-shared-tree");
  const topLevelDirs = readdirSync(inspectionDir, { withFileTypes: true })
    .filter((entry: { isDirectory: () => boolean; name: string }) => entry.isDirectory() && entry.name !== ".git")
    .map((entry: { name: string }) => entry.name);
  assert.equal(
    topLevelDirs.length,
    1,
    `expected exactly one shared top-level tree in the remote, found: ${topLevelDirs.join(", ")}`
  );
});

test("all committed profiles (macbook, mac-mini, linux, linux.example) declare the same repositorySubdir", () => {
  // A narrower, faster companion to the end-to-end test above: pins the
  // specific config field that caused the divergence directly against the
  // committed files, independent of any CLI/git plumbing. Includes
  // linux.example.json — the copy-paste source for any new machine — so a
  // future template edit that reintroduces a per-machine placeholder (as
  // this template originally had, mirroring the pre-fix macbook/mac-mini
  // profiles) is caught here too, not just on the profiles already in
  // active use.
  const profileFiles = ["macbook.json", "mac-mini.json", "linux.json", "linux.example.json"];
  const settingsByFile = Object.fromEntries(
    profileFiles.map((file) => [file, JSON.parse(readText(path.join(PROFILES_DIR, file)))])
  );

  for (const file of profileFiles) {
    assert.ok(settingsByFile[file].repositorySubdir, `profiles/${file} must set repositorySubdir explicitly`);
  }

  const [firstFile, ...restFiles] = profileFiles;
  const expected = settingsByFile[firstFile].repositorySubdir;
  for (const file of restFiles) {
    assert.equal(
      settingsByFile[file].repositorySubdir,
      expected,
      `profiles/${file} must share the same repositorySubdir as profiles/${firstFile} ` +
        "(it is the only thing that determines the remote tree path — see toRepositoryRelativePath " +
        "in src/memory-sync/config.ts); the 'profile' field is local-only and may differ"
    );
  }

  // Pin the frictions syncPaths entry (agent-tasks 343d5a8f) directly
  // against each committed profile file — deliberately placed in THIS test,
  // not the live push/pull E2E test above, because this one parses the
  // profile JSON via settingsByFile and never touches a real machine's home
  // directory, so it stays green even where the E2E test's EACCES failure
  // (mac-mini.json's hardcoded /Users/lannguyensi paths on a machine that
  // isn't the mini) applies. Without this block, reverting the three
  // profiles' new syncPaths entry left the suite fully green — nothing else
  // reads the committed profile files for this entry.
  function findEntriesByDestination(
    syncPaths: Array<Record<string, unknown>> | undefined,
    destination: string
  ): Array<Record<string, unknown>> {
    return (syncPaths || []).filter((entry) => entry.destination === destination);
  }

  for (const file of profileFiles) {
    const frictionsEntries = findEntriesByDestination(settingsByFile[file].syncPaths, "frictions");
    assert.equal(
      frictionsEntries.length,
      1,
      `profiles/${file} must declare exactly one syncPaths entry with destination 'frictions', found ${frictionsEntries.length}`
    );
    const [frictionsEntry] = frictionsEntries;
    assert.equal(frictionsEntry.kind, "directory", `profiles/${file} frictions entry must be kind 'directory'`);
    assert.ok(
      typeof frictionsEntry.source === "string" && path.isAbsolute(frictionsEntry.source as string),
      `profiles/${file} frictions entry source must be an absolute path, got: ${JSON.stringify(frictionsEntry.source)}`
    );
    assert.ok(
      (frictionsEntry.source as string).endsWith("/.harness/frictions"),
      `profiles/${file} frictions entry source must end with '/.harness/frictions', got: ${frictionsEntry.source}`
    );
    assert.ok(
      !frictionsEntry.required,
      `profiles/${file} frictions entry must not be required (missing-source tolerance is the point)`
    );
  }

  // Same pin for the pre-existing machine-state entry, closing the identical
  // #64 coverage gap — every committed machine profile, but not
  // linux.example.json, since the template has never carried a machine-state
  // entry (linux.json adds it deliberately; see machine-setup.md section f).
  for (const file of ["macbook.json", "mac-mini.json", "linux.json"]) {
    const machineStateEntries = findEntriesByDestination(settingsByFile[file].syncPaths, "machine-state");
    assert.equal(
      machineStateEntries.length,
      1,
      `profiles/${file} must declare exactly one syncPaths entry with destination 'machine-state', found ${machineStateEntries.length}`
    );
    const [machineStateEntry] = machineStateEntries;
    assert.equal(machineStateEntry.kind, "directory", `profiles/${file} machine-state entry must be kind 'directory'`);
    assert.ok(
      typeof machineStateEntry.source === "string" && path.isAbsolute(machineStateEntry.source as string),
      `profiles/${file} machine-state entry source must be an absolute path, got: ${JSON.stringify(machineStateEntry.source)}`
    );
    assert.ok(
      (machineStateEntry.source as string).endsWith("/.harness/machine-state"),
      `profiles/${file} machine-state entry source must end with '/.harness/machine-state', got: ${machineStateEntry.source}`
    );
  }
});

// Pins Defect B's fix (agent-tasks 06d09cde / .ai/runs/2026-08-03-sync-conflict-markers-echo,
// D-002/D-003): machine-state and frictions are one-owner-file-per-machine
// destinations, so push must never re-offer a peer's file it only pulled —
// ownerScoped: true on both entries in every real machine profile is what
// makes collectLocalSyncFiles' ownerFilter (src/memory-sync/config.ts)
// actually engage. Deliberately scoped to the same 3 real profiles as the
// machine-state pin above, not linux.example.json — the template documents
// the convention but was never a live sync target, so it carries no
// machine-state entry at all and this task's brief only requires the flag on
// "die 3 committeten Profilen".
test("macbook, mac-mini, and linux profiles set ownerScoped: true on both their machine-state and frictions entries", () => {
  const profileFiles = ["macbook.json", "mac-mini.json", "linux.json"];
  const settingsByFile = Object.fromEntries(
    profileFiles.map((file) => [file, JSON.parse(readText(path.join(PROFILES_DIR, file)))])
  );

  function findEntriesByDestination(
    syncPaths: Array<Record<string, unknown>> | undefined,
    destination: string
  ): Array<Record<string, unknown>> {
    return (syncPaths || []).filter((entry) => entry.destination === destination);
  }

  for (const file of profileFiles) {
    for (const destination of ["machine-state", "frictions"]) {
      const [entry] = findEntriesByDestination(settingsByFile[file].syncPaths, destination);
      assert.ok(entry, `profiles/${file} must declare a syncPaths entry with destination '${destination}'`);
      assert.equal(
        entry.ownerScoped,
        true,
        `profiles/${file}'s '${destination}' entry must set ownerScoped: true, got: ${JSON.stringify(entry.ownerScoped)}`
      );
    }
  }
});
