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
// profiles/mac-mini.json), so a regression in repositorySubdir (e.g.
// reintroducing a per-machine value) or in syncPaths shape (e.g. narrowing
// back to named files/dirs, dropping an entry, changing 'kind'/'ownerScoped')
// fails this test — everything about every syncPaths entry is taken from the
// real files verbatim EXCEPT one field on the two entries whose 'source' is a
// hardcoded machine-absolute path (machine-state, frictions; e.g.
// mac-mini.json's "/Users/lannguyensi/.harness/machine-state").
//
// Those two sources get remapped (remapAbsoluteSyncPathsIntoSandbox below)
// into per-machine fake-$HOME directories under this test's own sandbox
// before the CLI ever runs, and assertSyncPathSourcesWithinSandbox asserts
// every syncPaths source — absolute sources directly, the "." memory
// entry's relative source resolved against the sandboxed rootDir — actually
// lands under the sandbox root before any sync executes. Without this, the
// test is not hermetic: it silently reads/writes whatever
// machine-state/frictions.json content happens to exist under the REAL
// path baked into the committed profile (agent-tasks 112a0864) — on a
// machine whose home genuinely is /Users/lannguyensi (e.g. the mini
// itself), that is live operational content (measured: an unmodified run
// of this file copies the real ~/.harness/machine-state/mac-mini.json and
// ~/.harness/frictions/mac-mini.json verbatim into an uncleaned bare git
// repo under the OS tmpdir). On a machine whose home is something else
// (e.g. the MacBook, /Users/lan), the mini profile's hardcoded
// /Users/lannguyensi/... source instead makes a pull step try to mkdir a
// path outside any real home the current user can write to — the EACCES
// this whole task starts from. Remapping removes both failure modes.
//
// rootDir/stateDir/remoteUrl get the same treatment for a related but
// distinct reason: nothing in the CLI reads them from the derived config
// today — resolveRunConfig's merge order (src/config/loader.ts) puts
// CLI-flag overrides last, so the --root-dir/--state-dir/--remote flags
// machineArgs below always passes win over whatever the config file says.
// Hermeticity for these three used to rest entirely on machineArgs always
// passing all three flags, with nothing asserting it — silently dropping
// one would have pushed straight into the REAL values the committed
// profile still carries verbatim in its config (rootDir: the operator's
// real memory directory, currently ~270 live files; remoteUrl: the real
// production bare repo; stateDir: the real state dir). Two things close
// that, for defense in depth: (1) remapAbsoluteSyncPathsIntoSandbox also
// rewrites rootDir/stateDir/remoteUrl in the derived config to the same
// sandboxed values passed as CLI flags (an observable no-op today given
// the merge order above, but it removes the live paths from the config
// file this test hands to --config entirely), and (2) machineArgs itself
// now asserts each of --root-dir/--state-dir/--remote resolves under the
// sandbox root before returning the CLI argv, so a future call site that
// drops or mistypes one of them fails this test immediately, before any
// CLI invocation, instead of silently reaching a real path.
//
// Between the CLI-flag-level guard in machineArgs and the config-level
// guard in assertSyncPathSourcesWithinSandbox, every path the CLI can act
// on in this test — --root-dir/--state-dir/--remote, the "." memory
// entry's source (relative to rootDir), and the machine-state/frictions
// entries' rewritten absolute sources — resolves under the sandbox root,
// so nothing this test does can touch a real machine's filesystem,
// regardless of what machine it runs on. The flags, the config rewrite,
// and the guard together sandbox rootDir/stateDir/remoteUrl; no single one
// of them is load-bearing alone.
//
// repositorySubdir and every other syncPaths field (kind, destination,
// ownerScoped) still come from the real files, unmodified — only the
// machine-state/frictions sources and rootDir/stateDir/remoteUrl are
// rewritten; the remap happens one layer up, in the config file this test
// hands to --config, with the CLI-flag values (machineArgs) as the
// actually-enforced defense.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync } = require("node:fs");
const path = require("node:path");
const { cloneRemote, createSandbox, fileExists, initBareRemote, readText, runCli, writeText } = require("../helpers/cli.ts");

const PROFILES_DIR = path.resolve(process.cwd(), "profiles");

// Derives the committed profile file list structurally (readdirSync over
// profiles/*.json) instead of a hand-maintained array, so a future profile
// (including a new machine or a template edit) is picked up by every test
// below that iterates "all committed profiles" without a matching edit
// here. Deliberately includes linux.example.json: the template is a
// committed *.json file under profiles/ like any other.
//
// A purely structural derivation loses deletion/rename detection though:
// an empty or partially-emptied profiles/ directory would silently make
// every test below iterate over fewer (or zero) files and report green
// instead of catching the loss. The non-vacuity guard below restores that
// detection while still auto-picking-up any future profile: it requires
// at least the 4 known files to be present, by name, on every call.
function listProfileFiles(): string[] {
  const files = readdirSync(PROFILES_DIR)
    .filter((name: string) => name.endsWith(".json"))
    .sort();

  const knownProfiles = ["macbook.json", "mac-mini.json", "linux.json", "linux.example.json"];
  assert.ok(
    files.length >= 4,
    `profiles/ must contain at least the ${knownProfiles.length} known machine profiles, found ${files.length}: ${JSON.stringify(files)} (PROFILES_DIR: ${PROFILES_DIR})`
  );
  const missing = knownProfiles.filter((name) => !files.includes(name));
  assert.equal(
    missing.length,
    0,
    `profiles/ is missing known machine profile(s): ${JSON.stringify(missing)}, found: ${JSON.stringify(files)} (PROFILES_DIR: ${PROFILES_DIR})`
  );

  return files;
}

// Resolves `candidate` and asserts it lands under `sandboxRoot` (exactly
// equal, or as a descendant path). The one choke point every
// sandbox-containment check in this file goes through, so
// assertSyncPathSourcesWithinSandbox (config-file syncPaths sources) and
// machineArgs (--root-dir/--state-dir/--remote CLI flags) apply the exact
// same resolve+startsWith logic instead of two implementations that could
// drift apart.
function assertPathWithinSandbox(candidate: string, sandboxRoot: string, label: string): void {
  const resolvedSandboxRoot = path.resolve(sandboxRoot);
  const resolvedCandidate = path.resolve(candidate);
  const withinSandbox =
    resolvedCandidate === resolvedSandboxRoot || resolvedCandidate.startsWith(`${resolvedSandboxRoot}${path.sep}`);
  assert.ok(
    withinSandbox,
    `${label}: '${candidate}' resolves to '${resolvedCandidate}', OUTSIDE the test sandbox root ` +
      `'${resolvedSandboxRoot}' — refusing to let this test touch a path that could be a real machine's.`
  );
}

// Asserts rootDir/stateDir/remoteDir resolve under `sandboxRoot` BEFORE
// building the CLI argv, so a call site that drops or mistypes one of
// --root-dir/--state-dir/--remote (the flags that make the CLI ignore
// whatever the derived config's own rootDir/stateDir/remoteUrl say, per
// resolveRunConfig's merge order in src/config/loader.ts) fails this test
// immediately, before any CLI invocation, instead of silently reaching a
// real machine path — see the file-level comment above for why this
// mattered enough to add as a second, independent guard alongside the
// config-file rewrite in remapAbsoluteSyncPathsIntoSandbox.
function machineArgs(
  profileName: string,
  configPath: string,
  rootDir: string,
  stateDir: string,
  remoteDir: string,
  sandboxRoot: string,
  extra: string[]
): string[] {
  assertPathWithinSandbox(rootDir, sandboxRoot, `machineArgs('${profileName}') --root-dir`);
  assertPathWithinSandbox(stateDir, sandboxRoot, `machineArgs('${profileName}') --state-dir`);
  assertPathWithinSandbox(remoteDir, sandboxRoot, `machineArgs('${profileName}') --remote`);

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

// The only two syncPaths destinations any committed profile gives a
// hardcoded machine-absolute 'source' (see profiles/mac-mini.json /
// macbook.json / linux.json's "/Users/<user>/.harness/{machine-state,
// frictions}" entries, pinned unmodified by the second test below). Every
// other entry (the "." memory entry) is already relative to --root-dir, which
// this test already sandboxes.
const HOME_ABSOLUTE_SYNC_DESTINATIONS = ["machine-state", "frictions"];

// Fails loudly (rather than silently reading/writing a real machine's files)
// if any syncPaths source in `settings` resolves outside `sandboxRoot` — an
// absolute source is checked directly; a relative source (e.g. the "."
// memory entry, or an escape attempt like "../../elsewhere") is resolved
// against `sandboxedRootDir` first, the same base directory the CLI itself
// would resolve it against once --root-dir is applied, so a relative source
// can't slip past this guard just by not being absolute. Called right after
// remapAbsoluteSyncPathsIntoSandbox below, before any CLI invocation, so a
// remap that silently no-ops (e.g. a future destination rename this test's
// remap logic doesn't know about) fails the test immediately instead of
// quietly falling through to a real path.
function assertSyncPathSourcesWithinSandbox(
  settings: { syncPaths?: Array<Record<string, unknown>> },
  sandboxRoot: string,
  sandboxedRootDir: string,
  label: string
): void {
  for (const entry of settings.syncPaths || []) {
    const source = entry.source;
    if (typeof source !== "string") {
      continue;
    }
    const candidate = path.isAbsolute(source) ? source : path.resolve(sandboxedRootDir, source);
    assertPathWithinSandbox(
      candidate,
      sandboxRoot,
      `${label}: syncPaths entry with destination '${String(entry.destination)}' has source '${source}'`
    );
  }
}

// Loads the real committed profile at `realConfigPath`, rewrites the
// 'source' of its machine-state/frictions syncPaths entries (the only
// hardcoded machine-absolute paths any profile carries) to point inside a
// per-machine fake-$HOME under `sandboxRoot`, ALSO rewrites the profile's
// top-level rootDir/stateDir/remoteUrl to the sandboxed values the caller
// passes in (`sandboxedRootDir`/`sandboxedStateDir`/`sandboxedRemoteUrl` —
// the same values machineArgs will pass as --root-dir/--state-dir/--remote;
// see the file-level comment above for why this exists in addition to the
// CLI flags), asserts the result is fully sandboxed, and writes it to a new
// config file this test hands to --config in place of the real one. Every
// other field of every entry (kind, destination, ownerScoped, and the "."
// memory entry's source), plus repositorySubdir and everything else in the
// profile, is copied through unmodified.
function remapAbsoluteSyncPathsIntoSandbox(
  realConfigPath: string,
  sandboxRoot: string,
  machineLabel: string,
  sandboxedRootDir: string,
  sandboxedStateDir: string,
  sandboxedRemoteUrl: string
): { configPath: string; sandboxSourceByDestination: Record<string, string> } {
  const settings = JSON.parse(readText(realConfigPath));
  const fakeHome = path.join(sandboxRoot, `${machineLabel}-fake-home`);
  const sandboxSourceByDestination: Record<string, string> = {};

  settings.syncPaths = (settings.syncPaths || []).map((entry: Record<string, unknown>) => {
    const destination = entry.destination as string;
    if (
      !HOME_ABSOLUTE_SYNC_DESTINATIONS.includes(destination) ||
      typeof entry.source !== "string" ||
      !path.isAbsolute(entry.source as string)
    ) {
      return entry;
    }

    const sandboxSource = path.join(fakeHome, ".harness", destination);
    sandboxSourceByDestination[destination] = sandboxSource;
    return { ...entry, source: sandboxSource };
  });

  // Opaque-failure guard: a syncPaths entry the remap above never matched
  // (e.g. a committed profile that dropped or renamed a machine-state/
  // frictions entry) would silently leave sandboxSourceByDestination missing
  // that key, and every downstream test assertion keyed off it would either
  // throw a confusing "undefined is not a directory" or — worse — read
  // `undefined` and skip a check outright. Name the missing destination
  // explicitly instead.
  for (const destination of HOME_ABSOLUTE_SYNC_DESTINATIONS) {
    assert.ok(
      sandboxSourceByDestination[destination],
      `remapped profile for '${machineLabel}' (source: ${realConfigPath}) has no syncPaths entry for ` +
        `destination '${destination}' — remapAbsoluteSyncPathsIntoSandbox found nothing to rewrite, so this ` +
        "destination's sandboxed source directory was never created."
    );
  }

  // Rewrite rootDir/stateDir/remoteUrl into the config file itself. The CLI
  // never reads these from the config here (the --root-dir/--state-dir/
  // --remote flags machineArgs passes always win — see the file-level
  // comment), so this is an observable no-op today; it exists so the
  // derived config this test hands to --config never carries the real
  // operator paths verbatim, as defense in depth alongside the CLI-flag
  // guard in machineArgs.
  settings.rootDir = sandboxedRootDir;
  settings.stateDir = sandboxedStateDir;
  settings.remoteUrl = sandboxedRemoteUrl;

  assertSyncPathSourcesWithinSandbox(
    settings,
    sandboxRoot,
    sandboxedRootDir,
    `remapped profile for '${machineLabel}' (source: ${realConfigPath})`
  );

  const configPath = path.join(sandboxRoot, "configs", `${machineLabel}.json`);
  writeText(configPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { configPath, sandboxSourceByDestination };
}

// Seeds a representative owner file (the "<profile>.json" convention
// collectLocalSyncFiles' ownerScoped filter looks for — see
// src/memory-sync/config.ts) inside a remapped sandbox source directory, so
// push actually has something to offer for that destination: an empty
// sandbox directory would make the machine-state/frictions sync paths a
// silent no-op, which is exactly the kind of silent skip this task's spec
// rules out.
function seedOwnerFile(sandboxSourceDir: string, ownerFileName: string, payload: Record<string, unknown>): void {
  writeText(path.join(sandboxSourceDir, ownerFileName), `${JSON.stringify(payload, null, 2)}\n`);
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

  // Remap the machine-absolute machine-state/frictions syncPaths sources
  // (real committed values: mac-mini.json's
  // "/Users/lannguyensi/.harness/{machine-state,frictions}",
  // macbook.json's "/Users/lan/..." equivalents) into this sandbox before
  // any CLI invocation. remapAbsoluteSyncPathsIntoSandbox asserts the result
  // is fully sandboxed; nothing below this point can read or write a real
  // machine's ~/.harness — see the file-level comment above for the leak
  // this closes (agent-tasks 112a0864).
  const macbookRemap = remapAbsoluteSyncPathsIntoSandbox(
    path.join(PROFILES_DIR, "macbook.json"),
    root,
    "macbook",
    macbookRoot,
    macbookState,
    remoteDir
  );
  const miniRemap = remapAbsoluteSyncPathsIntoSandbox(
    path.join(PROFILES_DIR, "mac-mini.json"),
    root,
    "mac-mini",
    miniRoot,
    miniState,
    remoteDir
  );
  const macbookConfigPath = macbookRemap.configPath;
  const miniConfigPath = miniRemap.configPath;

  // Seed each machine's own owner file for the remapped machine-state/
  // frictions destinations so push has real, sandbox-owned content to offer
  // — an empty remapped directory would make this coverage a silent no-op,
  // which the task spec rules out.
  seedOwnerFile(macbookRemap.sandboxSourceByDestination["machine-state"], "macbook.json", {
    machine: "macbook",
    note: "sandbox machine-state fixture (agent-tasks 112a0864)"
  });
  seedOwnerFile(macbookRemap.sandboxSourceByDestination["frictions"], "macbook.json", {
    machine: "macbook",
    note: "sandbox frictions fixture (agent-tasks 112a0864)"
  });
  seedOwnerFile(miniRemap.sandboxSourceByDestination["machine-state"], "mac-mini.json", {
    machine: "mac-mini",
    note: "sandbox machine-state fixture (agent-tasks 112a0864)"
  });
  seedOwnerFile(miniRemap.sandboxSourceByDestination["frictions"], "mac-mini.json", {
    machine: "mac-mini",
    note: "sandbox frictions fixture (agent-tasks 112a0864)"
  });

  writeText(path.join(macbookRoot, "MEMORY.md"), "macbook memory\n");
  writeText(path.join(miniRoot, "MEMORY.md"), "mini memory\n");

  const macbookArgs = (...extra: string[]) =>
    machineArgs("macbook", macbookConfigPath, macbookRoot, macbookState, remoteDir, root, extra);
  const miniArgs = (...extra: string[]) =>
    machineArgs("mac-mini", miniConfigPath, miniRoot, miniState, remoteDir, root, extra);

  // Seed: the mini (source of truth) pushes first, mirroring the real setup
  // order in docs/machine-setup.md.
  const miniSeed = runCli(miniArgs("--mode", "push"));
  const miniSeedPayload = JSON.parse(miniSeed.stdout);
  assert.equal(miniSeedPayload.runs[0].status, "applied");

  // Cross-machine check, macbook <- mini direction: a fresh "macbook" CLI
  // invocation (macbook's own remapped config, but a throwaway
  // --root-dir/--state-dir it has never used before, so its 3-way-merge base
  // starts empty for every destination) pulls immediately after the mini's
  // seed push above. Its machine-state/frictions syncPaths sources are the
  // SAME sandboxed absolute directories macbookRemap resolved (an absolute
  // source is independent of --root-dir), so this exercises the real
  // cross-machine materialization of the mini's owner file into macbook's
  // sandboxed machine-state/frictions dirs — deliberately run here, before
  // macbook's own real push below, because a machine's OWN push adopts
  // whatever is already in the remote as its local base without ever writing
  // it to disk (production behavior, not this task's concern): running the
  // probe pull afterward would find a base===remote fast path and silently
  // report nothing applied, which would make this check vacuous.
  const macbookProbePull = runCli(
    machineArgs(
      "macbook",
      macbookConfigPath,
      path.join(root, "macbook-probe-workspace"),
      path.join(root, "macbook-probe-state"),
      remoteDir,
      root,
      ["--mode", "pull"]
    )
  );
  const macbookProbePullPayload = JSON.parse(macbookProbePull.stdout);
  assert.equal(macbookProbePullPayload.runs[0].status, "applied");
  assert.notEqual(
    macbookProbePullPayload.runs[0].appliedFiles.length,
    0,
    "macbook probe pull reported status 'applied' but appliedFiles is empty — status alone doesn't prove the " +
      "mini's seed push actually materialized anything for macbook"
  );

  const macbookMachineStateDir = macbookRemap.sandboxSourceByDestination["machine-state"];
  const macbookFrictionsDir = macbookRemap.sandboxSourceByDestination["frictions"];
  assert.equal(fileExists(path.join(macbookMachineStateDir, "mac-mini.json")), true);
  assert.equal(
    JSON.parse(readText(path.join(macbookMachineStateDir, "mac-mini.json"))).machine,
    "mac-mini",
    "macbook's sandboxed machine-state dir did not receive the mini's owner file on pull"
  );
  assert.equal(fileExists(path.join(macbookFrictionsDir, "mac-mini.json")), true);
  assert.equal(
    JSON.parse(readText(path.join(macbookFrictionsDir, "mac-mini.json"))).machine,
    "mac-mini",
    "macbook's sandboxed frictions dir did not receive the mini's owner file on pull"
  );

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

  // The mini's pull above also carries the machine-state/frictions
  // destinations (macbookPush offered macbook's own owner file for both,
  // ownerScoped): the mini's SANDBOXED machine-state/frictions dirs must now
  // hold macbook's owner file, proving the remapped syncPaths sources still
  // exercise the real cross-machine sync path end to end, not just the
  // memory destination.
  const miniMachineStateDir = miniRemap.sandboxSourceByDestination["machine-state"];
  const miniFrictionsDir = miniRemap.sandboxSourceByDestination["frictions"];
  assert.equal(fileExists(path.join(miniMachineStateDir, "macbook.json")), true);
  assert.equal(
    JSON.parse(readText(path.join(miniMachineStateDir, "macbook.json"))).machine,
    "macbook",
    "mini's sandboxed machine-state dir did not receive macbook's owner file on pull"
  );
  assert.equal(fileExists(path.join(miniFrictionsDir, "macbook.json")), true);
  assert.equal(
    JSON.parse(readText(path.join(miniFrictionsDir, "macbook.json"))).machine,
    "macbook",
    "mini's sandboxed frictions dir did not receive macbook's owner file on pull"
  );

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
  // committed files, independent of any CLI/git plumbing. profileFiles is
  // derived structurally (readdirSync, see listProfileFiles above), so it
  // always includes linux.example.json (the copy-paste source for any new
  // machine) without listing filenames by hand: a future template edit
  // that reintroduces a per-machine placeholder (as this template
  // originally had, mirroring the pre-fix macbook/mac-mini profiles) is
  // caught here too, not just on the profiles already in active use.
  const profileFiles = listProfileFiles();
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

  // Same pin for the machine-state entry, closing the identical #64
  // coverage gap for every committed profile, including linux.example.json:
  // the template now carries the entry too (placeholder <linux-username>
  // source), precisely so a future third machine copied from it starts with
  // the entry present instead of repeating the hand-patch divergence
  // linux.json/macbook.json/mac-mini.json needed before this fix (agent-tasks
  // 10df0d9d; see machine-setup.md section e)/f)). The endsWith check below
  // tolerates the template's placeholder segment (the path is still
  // absolute-shaped and still ends with the literal suffix).
  for (const file of profileFiles) {
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

// Pins the three path invariants documented in every profile's "//" field
// (real profiles' "rootDir/stateDir use a resolved absolute path, not '~'"
// paragraph; the template's identical paragraph): rootDir/stateDir must be
// absolute, must not start with '~' (agent-memory-sync's config loader
// never expands it; see resolveRunConfig() in src/config/loader.ts, which
// treats a leading '~' as a literal path segment, not the home directory),
// and stateDir must sit OUTSIDE rootDir (otherwise the recursive '.'
// syncPaths walk would also pick up this tool's own state (queue/base/tmp)
// and try to sync it as memory content). profileFiles is the same
// structurally-derived list used above, so linux.example.json is included:
// its placeholder segments (e.g. '<linux-username>', '<linux-hostname>')
// keep both paths absolute-shaped (still start with '/') and un-prefixed by
// '~', and its stateDir/rootDir still resolve to different subtrees, so all
// three checks hold for the template's placeholder values with no
// special-casing: these are pure string checks, never filesystem lookups,
// so an unresolved placeholder segment does not make them fail or need to
// be skipped.
test("all committed profiles keep rootDir/stateDir absolute, un-expanded (no leading '~'), and stateDir outside rootDir", () => {
  const profileFiles = listProfileFiles();
  const settingsByFile = Object.fromEntries(
    profileFiles.map((file) => [file, JSON.parse(readText(path.join(PROFILES_DIR, file)))])
  );

  for (const file of profileFiles) {
    const { rootDir, stateDir } = settingsByFile[file];

    assert.ok(
      typeof rootDir === "string" && path.isAbsolute(rootDir),
      `profiles/${file} rootDir must be an absolute path, got: ${JSON.stringify(rootDir)}`
    );
    assert.ok(
      typeof stateDir === "string" && path.isAbsolute(stateDir),
      `profiles/${file} stateDir must be an absolute path, got: ${JSON.stringify(stateDir)}`
    );
    assert.ok(
      !(rootDir as string).startsWith("~"),
      `profiles/${file} rootDir must not start with '~' (the config loader never expands it), got: ${rootDir}`
    );
    assert.ok(
      !(stateDir as string).startsWith("~"),
      `profiles/${file} stateDir must not start with '~' (the config loader never expands it), got: ${stateDir}`
    );

    const rel = path.posix.relative(path.posix.normalize(rootDir as string), path.posix.normalize(stateDir as string));
    assert.ok(
      rel !== "" && (rel.startsWith("../") || path.posix.isAbsolute(rel)),
      `profiles/${file} stateDir must sit OUTSIDE rootDir, got rootDir: ${rootDir}, stateDir: ${stateDir}`
    );
  }
});

// Pins Defect B's fix (agent-tasks 06d09cde / .ai/runs/2026-08-03-sync-conflict-markers-echo,
// D-002/D-003): machine-state and frictions are one-owner-file-per-machine
// destinations, so push must never re-offer a peer's file it only pulled —
// ownerScoped: true on both entries in every committed profile is what
// makes collectLocalSyncFiles' ownerFilter (src/memory-sync/config.ts)
// actually engage. profileFiles is the same structurally-derived list used
// by the tests above (see listProfileFiles), so it now includes
// linux.example.json too: an earlier revision of this test hand-scoped the
// list to the 3 real profiles and excluded the template, because the
// template's machine-state entry set ownerScoped: true (mirroring the real
// profiles, agent-tasks 10df0d9d) while its frictions entry still did not;
// including the template would have failed on that entry alone. The
// template's frictions entry now sets ownerScoped: true too, closing that
// gap, so the exclusion is no longer needed and a future regression in the
// template is caught here like any real profile.
test("all committed profiles set ownerScoped: true on both their machine-state and frictions entries", () => {
  const profileFiles = listProfileFiles();
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
