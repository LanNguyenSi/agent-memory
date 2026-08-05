// Coverage for the queue escalation rework (agent-tasks 11424b5e), closing
// the mirror case 1b63070d left open: 1b63070d fixed a NON-network error
// being misclassified as "remote unavailable" (see
// tests/integration/watch-mirror-delete.test.ts's stub-git-fails-on-commit
// test). The mirror case is a remote that IS correctly classified
// RemoteUnavailableError (src/errors.ts) — but PERMANENTLY, not
// transiently: a wrong remoteUrl, a renamed repository path, a host that
// accepts an SSH/TCP connection but cannot serve git-upload-pack. Before
// this rework that queued cleanly, exit 0, every tick, forever — completely
// indistinguishable from a laptop that is legitimately, temporarily
// offline.
//
// The fix (src/memory-sync/push.ts's checkQueueEscalation, backed by
// StateStore.oldestQueuedSnapshotAgeMs in src/memory-sync/state-store.ts):
// age-based, not counter-based — the OLDEST queued snapshot's already-
// persisted manifest.json `createdAt` IS "how long has the remote been
// continuously unreachable" (a successful push clears the whole queue in
// one shot), so no new state is needed. Once that age crosses
// queueEscalationThresholdMs (default 24h — see
// DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS's comment in state-store.ts for the
// full rationale, including the real launchd/systemd tick interval it is
// sized against), the tick throws RemoteQueueEscalationError instead of
// returning a benign "queued" result — non-zero exit, a clear stderr
// message — while leaving every snapshot safely queued for replay.
//
// These tests never wait in real time: they backdate an already-queued
// snapshot's manifest.json directly (the same file StateStore.enqueueSnapshot
// writes), so the REAL production default threshold (24h) is exercised
// deterministically and fast, rather than a test-only tiny override.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const {
  createSandbox,
  fileExists,
  runCli,
  writeProjectConfig,
  writeText
} = require("../helpers/cli.ts");
const { runWatchTick } = require("../helpers/watch-process.ts");

function createConfig(workspaceRoot: string, remoteDir: string) {
  return {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    // Local-path remotes resolve reachability via a plain fs existsSync
    // check (see src/memory-sync/reachability.ts's classifyRemote), so this
    // has no real timing effect here — set small anyway, matching this
    // suite's existing convention (see memory-sync.test.ts).
    reachabilityTimeoutMs: 500,
    syncPaths: [{ source: "MEMORY.md", destination: "MEMORY.md", kind: "file" }]
  };
}

function queueDirFor(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent-memory-sync", "default", "queue");
}

// Rewrites the manifest.json of every currently-queued snapshot to claim it
// was created `ageMs` before now — the same field
// StateStore.enqueueSnapshot (src/memory-sync/state-store.ts) writes on
// every real enqueue, so this is indistinguishable to
// oldestQueuedSnapshotAgeMs from a snapshot that has genuinely been sitting
// there that long.
function backdateQueuedSnapshots(workspaceRoot: string, ageMs: number): void {
  const queueDir = queueDirFor(workspaceRoot);
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  for (const id of readdirSync(queueDir)) {
    const manifestPath = path.join(queueDir, id, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, createdAt }, null, 2)}\n`, "utf8");
  }
}

// ─── AC2: below the threshold stays silent, exit 0 ──────────────────────────

test("push stays a silent, exit-0 queue while the oldest queued snapshot is well under the escalation threshold", () => {
  const root = createSandbox("escalation-below-threshold");
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "first\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, offlineRemoteDir));

  // First tick: nothing queued yet, so the oldest age is effectively 0ms —
  // nowhere near the 24h default threshold.
  const firstRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const firstPayload = JSON.parse(firstRun.stdout);
  assert.equal(firstRun.status, 0);
  assert.equal(firstPayload.runs[0].status, "queued");

  // Second tick, still offline: the queue now holds a real snapshot from
  // moments ago — still nowhere near 24h old.
  writeText(path.join(workspaceRoot, "MEMORY.md"), "second\n");
  const secondRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const secondPayload = JSON.parse(secondRun.stdout);
  assert.equal(secondRun.status, 0, `expected a clean exit 0 below threshold. stderr: ${secondRun.stderr}`);
  assert.equal(secondPayload.runs[0].status, "queued");
  assert.equal(readdirSync(queueDirFor(workspaceRoot)).length, 2);
});

// ─── AC1: above the threshold becomes visible (non-zero exit) ───────────────

test("push crashes loud with a clear message once the oldest queued snapshot is older than the escalation threshold", () => {
  const root = createSandbox("escalation-above-threshold");
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "first\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, offlineRemoteDir));

  const firstRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(JSON.parse(firstRun.stdout).runs[0].status, "queued");

  // Backdate the just-queued snapshot to 25h old — past the real 24h
  // production default (DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS in
  // state-store.ts), without waiting a single real second.
  backdateQueuedSnapshots(workspaceRoot, 25 * 60 * 60 * 1000);

  writeText(path.join(workspaceRoot, "MEMORY.md"), "second\n");
  const secondRun = runCli(
    ["run", "default", "--config", configPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(secondRun.status, 6, `expected the escalation's own exit code. stderr: ${secondRun.stderr}`);
  assert.match(secondRun.stderr, /remote has been unreachable for/);
  assert.match(secondRun.stderr, /permanently misconfigured/);
  assert.match(secondRun.stderr, /remoteUrl\/branch\/repositorySubdir/);

  // The escalating tick's own snapshot must still be safely persisted, not
  // dropped — enqueueSnapshot runs before the escalation check throws.
  const queuedEntries = readdirSync(queueDirFor(workspaceRoot));
  assert.equal(queuedEntries.length, 2, `expected both snapshots to remain queued, found: ${queuedEntries.join(", ")}`);
});

// Same scenario as above, but through `watch` (not `run --mode push`) —
// pins that watch's escalation surface actually becomes a non-zero exit
// too. watch.ts's handleSnapshotError writes the thrown error's message to
// stderr and sets the exit code unconditionally (not gated by --quiet or
// --verbose, unlike the ordinary "queued locally"/"watching N path(s)"
// info lines) — --verbose is passed below only so this test can use the
// same robust chokidar-ready detection every other watch-spawning test in
// this suite uses (see tests/helpers/watch-process.ts), not because the
// escalation message itself needs it to be visible.
test("watch tick exits non-zero once the queue has been failing to drain past the escalation threshold", async () => {
  const root = createSandbox("escalation-watch");
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, offlineRemoteDir));

  const seedRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(JSON.parse(seedRun.stdout).runs[0].status, "queued");
  backdateQueuedSnapshots(workspaceRoot, 25 * 60 * 60 * 1000);

  const { exitCode, stderr } = await runWatchTick(configPath, () => {
    writeText(path.join(workspaceRoot, "MEMORY.md"), "trigger\n");
  });

  assert.equal(exitCode, 6, `expected the escalation's own exit code. stderr: ${stderr}`);
  assert.match(stderr, /remote has been unreachable for/);
  assert.match(stderr, /permanently misconfigured/);
});

// ─── AC4: the precheck-bypass path still queues via lookupRemoteHead ────────
//
// Reviewer-named positive test: a remote whose scheme the reachability
// precheck waves through as "unsupported" (see classifyRemote in
// src/memory-sync/reachability.ts — https/git have no dedicated fast probe,
// so checkRemoteReachable assumes reachable and lets the real git operation
// surface any failure) must still be caught by GitClient.lookupRemoteHead's
// own RemoteUnavailableError (src/memory-sync/git-client.ts) and QUEUE
// cleanly — not crash — exactly like the precheck's own unreachable path
// does. git://127.0.0.1:1/... is hermetic (loopback only, no real network
// access, no DNS) and fails fast with a connection refusal, since nothing
// listens on port 1.
test("push still queues cleanly when an unsupported-scheme remote (precheck assumes reachable) actually fails at lookupRemoteHead", () => {
  const root = createSandbox("escalation-precheck-bypass");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const bypassRemoteUrl = "git://127.0.0.1:1/definitely-not-a-real-remote.git";

  writeText(path.join(workspaceRoot, "MEMORY.md"), "content\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, bypassRemoteUrl));

  const result = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(result.status, 0, `expected a clean exit 0, not a crash. stderr: ${result.stderr}`);
  assert.equal(payload.runs[0].status, "queued");
  assert.ok(payload.runs[0].queuedSnapshotId);
  assert.equal(fileExists(queueDirFor(workspaceRoot)), true);
  assert.equal(readdirSync(queueDirFor(workspaceRoot)).length, 1);
});

// Reviewer-named positive test (agent-tasks 11424b5e fix round, finding
// #11): escalation must fire from the catch-all git-failure path
// (push.ts's catch block around GitClient.lookupRemoteHead/push, ~line
// 225-234), not only from the reachability-precheck skip path every test
// above exercises. Reuses AC4's precheck-bypass mechanism above (an
// unsupported-scheme remote the precheck assumes reachable, so the failure
// only ever surfaces once the real git operation runs and throws inside the
// try block) — but this time with the queue already backdated past the
// threshold, so the SAME checkQueueEscalation call now runs from inside the
// catch block instead of the reachability-precheck branch.
test("escalation also fires from the catch-all git-failure path, not only the reachability-precheck path", () => {
  const root = createSandbox("escalation-catch-path");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const bypassRemoteUrl = "git://127.0.0.1:1/definitely-not-a-real-remote.git";

  writeText(path.join(workspaceRoot, "MEMORY.md"), "first\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, bypassRemoteUrl));

  const firstRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(JSON.parse(firstRun.stdout).runs[0].status, "queued");

  backdateQueuedSnapshots(workspaceRoot, 25 * 60 * 60 * 1000);

  writeText(path.join(workspaceRoot, "MEMORY.md"), "second\n");
  const secondRun = runCli(
    ["run", "default", "--config", configPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(
    secondRun.status,
    6,
    `expected escalation via the catch-all git-failure path. stderr: ${secondRun.stderr}`
  );
  assert.match(secondRun.stderr, /remote has been unreachable for/);
  assert.match(secondRun.stderr, /permanently misconfigured/);

  // The escalating tick's own snapshot must still be safely persisted.
  const queuedEntries = readdirSync(queueDirFor(workspaceRoot));
  assert.equal(queuedEntries.length, 2, `expected both snapshots to remain queued, found: ${queuedEntries.join(", ")}`);
});

// ─── Clock-skew guard: an implausibly large age skips escalation ────────────
//
// Reviewer finding (MEDIUM #3): a queued manifest's `createdAt` is a
// wall-clock ISO timestamp, so oldestQueuedSnapshotAgeMs is only ever as
// trustworthy as this machine's system clock was AT ENQUEUE TIME. A machine
// that enqueued under a wrong-in-the-past clock must not turn crash-loud the
// moment NTP corrects it forward. checkQueueEscalation (push.ts) guards this
// with a sanity ceiling (30x the effective threshold) — past it, the tick
// stays a clean, silent-except-for-one-note "queued" outcome instead of
// escalating.
test("push does not escalate when the oldest queued snapshot's age is implausibly large (clock-skew guard) — stays exit 0 with a diagnostic note", () => {
  const root = createSandbox("escalation-clock-skew");
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "first\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, offlineRemoteDir));

  const firstRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(JSON.parse(firstRun.stdout).runs[0].status, "queued");

  // 100x the real 24h production default — well past the 30x sanity
  // ceiling, so this must be treated as an implausible clock artifact, not
  // 100 days of genuine remote unavailability.
  backdateQueuedSnapshots(workspaceRoot, 100 * 24 * 60 * 60 * 1000);

  writeText(path.join(workspaceRoot, "MEMORY.md"), "second\n");
  const secondRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const secondPayload = JSON.parse(secondRun.stdout);

  assert.equal(secondRun.status, 0, `expected a clean exit 0 despite the implausible age. stderr: ${secondRun.stderr}`);
  assert.equal(secondPayload.runs[0].status, "queued");
  assert.ok(
    (secondPayload.runs[0].notes || []).some((note: string) => /implausible/.test(note)),
    `expected a clock-skew diagnostic note, got: ${JSON.stringify(secondPayload.runs[0].notes)}`
  );
});

// A plain 25h age (well under the 30x sanity ceiling) must still escalate —
// this is the SAME assertion the "push crashes loud..." AC1 test above
// already makes; restated here in the same section as the guard's negative
// case per the fix-round brief, without duplicating the full test body.
test("push still escalates a plain 25h age — the clock-skew guard does not swallow genuine escalations", () => {
  const root = createSandbox("escalation-clock-skew-normal");
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "first\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, offlineRemoteDir));

  const firstRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(JSON.parse(firstRun.stdout).runs[0].status, "queued");

  backdateQueuedSnapshots(workspaceRoot, 25 * 60 * 60 * 1000);

  writeText(path.join(workspaceRoot, "MEMORY.md"), "second\n");
  const secondRun = runCli(
    ["run", "default", "--config", configPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(secondRun.status, 6, `expected the escalation's own exit code. stderr: ${secondRun.stderr}`);
  assert.match(secondRun.stderr, /remote has been unreachable for/);
});

// ─── Config wiring: queueEscalationThresholdMs must actually reach
//     checkQueueEscalation (MEDIUM finding #2 — mutation-invisible before
//     this fix: every prior test above uses the 24h default, so unwiring
//     the config/env override entirely at loader.ts still left every
//     existing test green). Each case below backdates the queued manifest
//     to an age LESS than the real 24h default but MORE than the override
//     configured — so a run that silently fell back to the default instead
//     of honoring the override would wrongly stay exit 0 here, catching
//     exactly the mutation this finding names. See the mutation-verify note
//     in the fix-round summary for the actual red/green run against this
//     pair. ──────────────────────────────────────────────────────────────

const CONFIG_WIRING_OVERRIDE_MS = 60 * 60 * 1000; // 1h — well under 24h
const CONFIG_WIRING_BACKDATE_MS = 2 * 60 * 60 * 1000; // 2h — under 24h, over the 1h override

test("queueEscalationThresholdMs from the project config file is actually wired through", () => {
  const root = createSandbox("escalation-config-override");
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "first\n");
  writeProjectConfig(configPath, {
    ...createConfig(workspaceRoot, offlineRemoteDir),
    queueEscalationThresholdMs: CONFIG_WIRING_OVERRIDE_MS
  });

  const firstRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(JSON.parse(firstRun.stdout).runs[0].status, "queued");

  backdateQueuedSnapshots(workspaceRoot, CONFIG_WIRING_BACKDATE_MS);

  writeText(path.join(workspaceRoot, "MEMORY.md"), "second\n");
  const secondRun = runCli(
    ["run", "default", "--config", configPath, "--mode", "push", "--output", "json"],
    { expectFailure: true }
  );

  assert.equal(
    secondRun.status,
    6,
    `expected the configured 1h override to escalate at 2h old (would stay exit 0 under the unwired 24h ` +
      `default). stderr: ${secondRun.stderr}`
  );
  assert.match(secondRun.stderr, /remote has been unreachable for/);
});

test("queueEscalationThresholdMs from AGENT_MEMORY_SYNC_QUEUE_ESCALATION_THRESHOLD_MS is actually wired through", () => {
  const root = createSandbox("escalation-env-override");
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const env = {
    ...process.env,
    AGENT_MEMORY_SYNC_QUEUE_ESCALATION_THRESHOLD_MS: String(CONFIG_WIRING_OVERRIDE_MS)
  };

  writeText(path.join(workspaceRoot, "MEMORY.md"), "first\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, offlineRemoteDir));

  const firstRun = runCli(
    ["run", "default", "--config", configPath, "--mode", "push", "--output", "json"],
    { env }
  );
  assert.equal(JSON.parse(firstRun.stdout).runs[0].status, "queued");

  backdateQueuedSnapshots(workspaceRoot, CONFIG_WIRING_BACKDATE_MS);

  writeText(path.join(workspaceRoot, "MEMORY.md"), "second\n");
  const secondRun = runCli(
    ["run", "default", "--config", configPath, "--mode", "push", "--output", "json"],
    { env, expectFailure: true }
  );

  assert.equal(
    secondRun.status,
    6,
    `expected the env override to escalate at 2h old. stderr: ${secondRun.stderr}`
  );
  assert.match(secondRun.stderr, /remote has been unreachable for/);
});

test("an invalid AGENT_MEMORY_SYNC_QUEUE_ESCALATION_THRESHOLD_MS value fails loud with a config error, not a silent fallback", () => {
  const root = createSandbox("escalation-env-invalid");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");
  const env = { ...process.env, AGENT_MEMORY_SYNC_QUEUE_ESCALATION_THRESHOLD_MS: "not-a-number" };

  writeText(path.join(workspaceRoot, "MEMORY.md"), "content\n");
  writeProjectConfig(configPath, createConfig(workspaceRoot, path.join(root, "unused-remote.git")));

  const result = runCli(
    ["run", "default", "--config", configPath, "--mode", "push", "--output", "json"],
    { env, expectFailure: true }
  );

  assert.equal(result.status, 3, `expected a config error exit code. stderr: ${result.stderr}`);
  assert.match(result.stderr, /AGENT_MEMORY_SYNC_QUEUE_ESCALATION_THRESHOLD_MS/);
  assert.match(result.stderr, /positive integer/);
});

// ─── Off switch: null disables escalation entirely (MEDIUM finding #8) ──────
test("queueEscalationThresholdMs: null disables escalation entirely — an ancient queue stays exit 0", () => {
  const root = createSandbox("escalation-disabled");
  const offlineRemoteDir = path.join(root, "missing-remote.git");
  const workspaceRoot = path.join(root, "workspace");
  const configPath = path.join(root, "config.json");

  writeText(path.join(workspaceRoot, "MEMORY.md"), "first\n");
  writeProjectConfig(configPath, {
    ...createConfig(workspaceRoot, offlineRemoteDir),
    queueEscalationThresholdMs: null
  });

  const firstRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  assert.equal(JSON.parse(firstRun.stdout).runs[0].status, "queued");

  // Far older than the real 24h default — would escalate under any finite
  // threshold, including the default this machine would otherwise fall
  // back to.
  backdateQueuedSnapshots(workspaceRoot, 365 * 24 * 60 * 60 * 1000);

  writeText(path.join(workspaceRoot, "MEMORY.md"), "second\n");
  const secondRun = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
  const secondPayload = JSON.parse(secondRun.stdout);

  assert.equal(secondRun.status, 0, `expected escalation to stay disabled. stderr: ${secondRun.stderr}`);
  assert.equal(secondPayload.runs[0].status, "queued");
});
