// Coverage for the `run --schedule` escalation-continuation fix (agent-tasks
// 11424b5e fix round, MEDIUM finding #6): measured before this fix, a
// scheduled `run` died on the FIRST tick that threw
// RemoteQueueEscalationError — exit 6 after tick 1 of 3, zero stdout, and
// (since `run --schedule` is its own scheduler/replay loop, not something an
// external supervisor restarts) no later tick ever got a chance to replay
// the queue once the remote recovered. src/commands/run.ts's scheduling
// loop now catches RemoteQueueEscalationError, records it, and keeps
// ticking — the whole invocation still exits 6 once the loop ends, just
// after every remaining tick had its shot and after the JSON payload
// (including every tick that ran) has been written to stdout.
//
// Real-time cost, deliberate: this package's cron parser (src/memory-sync/
// scheduler.ts) has no sub-minute granularity, so "short interval" here
// means the shortest expressible one — "* * * * *" (every minute) — and a
// 2-tick run genuinely waits for one real cron boundary (up to ~60s) between
// ticks. There is no seam to inject a fake clock into the scheduling loop
// without expanding this fix's scope, so this test pays that real wait
// rather than skip end-to-end coverage of the loop itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { createSandbox, runCli, writeProjectConfig, writeText } = require("../helpers/cli.ts");

function createConfig(workspaceRoot: string, remoteDir: string) {
  return {
    rootDir: workspaceRoot,
    remoteUrl: remoteDir,
    branch: "main",
    repositorySubdir: "shared",
    stateDir: ".agent-memory-sync/default",
    reachabilityTimeoutMs: 500,
    // A trivially small threshold: this test is about the SCHEDULING LOOP's
    // continue-past-escalation behavior, not about reproducing the real 24h
    // default, so every tick here is engineered to escalate quickly. 5s
    // (not smaller) deliberately keeps the clock-skew sanity ceiling
    // (30x threshold, push.ts's checkQueueEscalation — see fix #3 in the
    // same round) at 150s, comfortably above the up-to-~60s real cron wait
    // this test pays between its two ticks (scheduler.ts has no sub-minute
    // granularity) — a smaller threshold here would make the sanity guard
    // itself (correctly) suppress the SECOND tick's escalation.
    queueEscalationThresholdMs: 5000,
    syncPaths: [{ source: "MEMORY.md", destination: "MEMORY.md", kind: "file" }]
  };
}

function queueDirFor(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent-memory-sync", "default", "queue");
}

function backdateQueuedSnapshots(workspaceRoot: string, ageMs: number): void {
  const queueDir = queueDirFor(workspaceRoot);
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  for (const id of readdirSync(queueDir)) {
    const manifestPath = path.join(queueDir, id, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, createdAt }, null, 2)}\n`, "utf8");
  }
}

test(
  "run --schedule keeps ticking past an escalating tick and exits 6 only after every scheduled tick ran",
  { timeout: 150_000 },
  () => {
    const root = createSandbox("schedule-escalation");
    const offlineRemoteDir = path.join(root, "missing-remote.git");
    const workspaceRoot = path.join(root, "workspace");
    const configPath = path.join(root, "config.json");

    writeText(path.join(workspaceRoot, "MEMORY.md"), "seed\n");
    writeProjectConfig(configPath, createConfig(workspaceRoot, offlineRemoteDir));

    // Seed one queued snapshot, then backdate it past the 5s threshold
    // above, so the FIRST tick of the scheduled run below is already
    // escalating — no real waiting needed to reach that state.
    const seed = runCli(["run", "default", "--config", configPath, "--mode", "push", "--output", "json"]);
    assert.equal(JSON.parse(seed.stdout).runs[0].status, "queued");
    backdateQueuedSnapshots(workspaceRoot, 6000);

    const result = runCli(
      [
        "run",
        "default",
        "--config",
        configPath,
        "--mode",
        "push",
        "--schedule",
        "* * * * *",
        "--max-runs",
        "2",
        "--output",
        "json"
      ],
      { expectFailure: true }
    );

    assert.equal(
      result.status,
      6,
      `expected the invocation to still exit 6 overall once both scheduled ticks ran. stderr: ${result.stderr}`
    );

    const payload = JSON.parse(result.stdout);
    assert.equal(
      payload.runs.length,
      2,
      `expected BOTH scheduled ticks to run (the pre-fix bug died after tick 1). runs: ${JSON.stringify(payload.runs)}`
    );
    for (const run of payload.runs) {
      assert.equal(run.status, "escalated", `expected every tick here to have escalated. run: ${JSON.stringify(run)}`);
      assert.match(run.notes.join(" "), /remote has been unreachable for/);
    }

    // Both ticks enqueued their own "current" snapshot on top of the seed —
    // none of them ever drained (the remote stayed offline the whole time),
    // so all three snapshots are still safely queued for replay.
    assert.equal(readdirSync(queueDirFor(workspaceRoot)).length, 3);
  }
);
