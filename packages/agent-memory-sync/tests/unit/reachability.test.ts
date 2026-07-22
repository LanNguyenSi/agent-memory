// Unit tests for the remote reachability precheck.
//
// Goal: pull/push/queue-replay must never hang on an unreachable remote (an
// ssh host that is down, a stale VPN, etc.). Before any real git network
// operation, checkRemoteReachable() runs a fast, bounded probe and reports
// reachable/unreachable with a reason — callers use that to short-circuit
// into a clean no-op instead of letting `git ls-remote`/`fetch` hang or spam
// retries.
//
// These tests are hermetic: no real ssh or git network access. The "probe
// command" is always a local `node -e ...` one-liner (fast exit 0, fast
// non-zero exit, or a deliberate sleep to trigger the timeout path) injected
// via the same `reachabilityCheckCommand` override a real deployment would
// use to point at a custom probe. This mirrors the existing test suite's
// pattern of spawning real, controlled local processes rather than mocking.

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  DEFAULT_REACHABILITY_TIMEOUT_MS,
  checkRemoteReachable,
  classifyRemote,
  deriveProbeCommand
} = require("../../src/memory-sync/reachability");

function sandbox(name: string): string {
  const root = path.join(
    tmpdir(),
    `agent-memory-sync-reachability-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  mkdirSync(root, { recursive: true });
  return root;
}

// ─── classifyRemote ──────────────────────────────────────────────────────────

test("classifyRemote: scp-like 'host:path' is classified as ssh with the bare host", () => {
  const result = classifyRemote("mini:~/memory-sync/pandora-memory.git");
  assert.deepEqual(result, { kind: "ssh", host: "mini" });
});

test("classifyRemote: scp-like 'user@host:path' strips the user prefix", () => {
  const result = classifyRemote("lan@mini:~/memory-sync/pandora-memory.git");
  assert.deepEqual(result, { kind: "ssh", host: "mini" });
});

test("classifyRemote: ssh:// URL is classified as ssh with the URL hostname", () => {
  const result = classifyRemote("ssh://lan@mini.local:2222/~/memory-sync/pandora-memory.git");
  assert.deepEqual(result, { kind: "ssh", host: "mini.local" });
});

test("classifyRemote: absolute local path is classified as local", () => {
  const result = classifyRemote("/srv/git/agent-memory.git");
  assert.deepEqual(result, { kind: "local", path: "/srv/git/agent-memory.git" });
});

test("classifyRemote: relative local path is classified as local", () => {
  const result = classifyRemote("./fixtures/remote.git");
  assert.deepEqual(result, { kind: "local", path: "./fixtures/remote.git" });
});

test("classifyRemote: file:// URL is classified as local with the scheme stripped", () => {
  const result = classifyRemote("file:///srv/git/agent-memory.git");
  assert.deepEqual(result, { kind: "local", path: "/srv/git/agent-memory.git" });
});

test("classifyRemote: https:// URL has no dedicated probe and is classified unsupported", () => {
  const result = classifyRemote("https://github.com/example/agent-memory.git");
  assert.deepEqual(result, { kind: "unsupported" });
});

// ─── classifyRemote / deriveProbeCommand: dash-prefixed host guard ──────────
//
// A "host" that begins with '-' is not a hostname to the ssh client we
// spawn — ssh parses a leading-dash token as an *option*. A scp-like remote
// like "-oProxyCommand=id:repo.git" (extracted host "-oProxyCommand=id")
// would, if ever handed to `execFileSync("ssh", [..., host, "true"])`,
// splice an attacker-controlled `-oProxyCommand=<arbitrary command>` flag
// into the ssh invocation — the same option-injection class as
// CVE-2017-1000117 (which hardened git's own scp-like remote parsing
// against exactly this). Our precheck must never build that argv in the
// first place; classifyRemote/deriveProbeCommand must treat such remotes as
// "unsupported" (precheck skipped) rather than "ssh", regardless of which
// syntax form (scp-like or ssh://) carries the dash-prefixed host — the
// real `git` operation downstream applies its own hardening and handles it
// safely from there.

test("classifyRemote: scp-like host beginning with '-' is unsupported, not ssh (option-injection guard)", () => {
  const result = classifyRemote("-oProxyCommand=id:repo.git");
  assert.deepEqual(result, { kind: "unsupported" });
});

test("classifyRemote: scp-like 'user@-host' with a dash-prefixed host (after stripping the user) is unsupported", () => {
  const result = classifyRemote("user@-oProxyCommand=id:repo.git");
  assert.deepEqual(result, { kind: "unsupported" });
});

test("classifyRemote: ssh:// URL with a dash-prefixed hostname is unsupported, not ssh", () => {
  const result = classifyRemote("ssh://-oProxyCommand=id/repo.git");
  assert.deepEqual(result, { kind: "unsupported" });
});

test("deriveProbeCommand: never builds an ssh argv for a dash-prefixed host (scp-like or ssh://)", () => {
  assert.equal(deriveProbeCommand("-oProxyCommand=id:repo.git", 4000), null);
  assert.equal(deriveProbeCommand("ssh://-oProxyCommand=id/repo.git", 4000), null);
});

test("checkRemoteReachable: a dash-prefixed-host remote never spawns ssh — skips the precheck instead", () => {
  // No reachabilityCheckCommand override: if the dash-prefixed host were
  // still classified as ssh, this would spawn a real `ssh -oProxyCommand=id
  // ...` process. Classified unsupported instead, it takes the
  // no-dedicated-probe skip path and never spawns anything.
  const result = checkRemoteReachable({
    remoteUrl: "-oProxyCommand=id:repo.git",
    reachabilityTimeoutMs: DEFAULT_REACHABILITY_TIMEOUT_MS,
    reachabilityCheckCommand: null
  });
  assert.equal(result.reachable, true);
  assert.match(result.reason, /no dedicated/);
});

// ─── classifyRemote: whitespace-padded host guard (isUnsafeSshHost bypass) ──
//
// isUnsafeSshHost only checked host.startsWith("-"). A host with leading
// whitespace before the dash — " -oProxyCommand=..." or a leading tab —
// does not start with "-" (it starts with the whitespace character), so it
// slipped past that check and was classified "ssh", with the raw
// (unstripped) host handed to the ssh probe argv. Not exploitable in
// practice (ssh's own argv-option parser expects the option token itself,
// not a whitespace-padded string, to start with "-"), but it defeats the
// guard's stated intent and is fixed for defense in depth: the host must
// match a plausible hostname character set — letters, digits, dot, hyphen,
// underscore — with no leading/trailing whitespace and no leading hyphen.

test("classifyRemote: scp-like host with a leading space before a dash-option is unsupported (whitespace bypass guard)", () => {
  const result = classifyRemote(" -oProxyCommand=id:repo.git");
  assert.deepEqual(result, { kind: "unsupported" });
});

test("classifyRemote: scp-like host with a leading tab before a dash-option is unsupported (whitespace bypass guard)", () => {
  const result = classifyRemote("\t-oProxyCommand=id:repo.git");
  assert.deepEqual(result, { kind: "unsupported" });
});

test("classifyRemote: scp-like 'user@ -host' with a leading space after the user is unsupported (whitespace bypass guard)", () => {
  const result = classifyRemote("user@ -oProxyCommand=id:repo.git");
  assert.deepEqual(result, { kind: "unsupported" });
});

test("classifyRemote: scp-like host with trailing whitespace is unsupported", () => {
  const result = classifyRemote("mini :repo.git");
  assert.deepEqual(result, { kind: "unsupported" });
});

test("classifyRemote: legitimate hyphenated/dotted/numeric hosts remain classified as ssh (whitespace guard does not over-reject)", () => {
  assert.deepEqual(classifyRemote("my-host:repo.git"), { kind: "ssh", host: "my-host" });
  assert.deepEqual(classifyRemote("mini.local:repo.git"), { kind: "ssh", host: "mini.local" });
  assert.deepEqual(classifyRemote("192.168.1.5:repo.git"), { kind: "ssh", host: "192.168.1.5" });
});

// ─── deriveProbeCommand ───────────────────────────────────────────────────────

test("deriveProbeCommand: builds a BatchMode/ConnectTimeout ssh probe for scp-like remotes", () => {
  const command = deriveProbeCommand("mini:~/memory-sync/pandora-memory.git", 4000);
  assert.deepEqual(command, ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "mini", "true"]);
});

test("deriveProbeCommand: rounds up sub-second timeouts to at least 1 second", () => {
  const command = deriveProbeCommand("mini:~/memory-sync/pandora-memory.git", 250);
  assert.deepEqual(command, ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=1", "mini", "true"]);
});

test("deriveProbeCommand: returns null for non-ssh remotes (caller falls back to fs/skip)", () => {
  assert.equal(deriveProbeCommand("/srv/git/agent-memory.git", 4000), null);
  assert.equal(deriveProbeCommand("https://github.com/example/agent-memory.git", 4000), null);
});

// ─── checkRemoteReachable: local path remotes ────────────────────────────────

test("checkRemoteReachable: local path that exists is reachable without spawning a process", () => {
  const root = sandbox("local-exists");
  const result = checkRemoteReachable({
    remoteUrl: root,
    reachabilityTimeoutMs: DEFAULT_REACHABILITY_TIMEOUT_MS,
    reachabilityCheckCommand: null
  });
  assert.equal(result.reachable, true);
  assert.match(result.reason, /exists/);
});

test("checkRemoteReachable: local path that does not exist is unreachable", () => {
  const root = sandbox("local-missing");
  const missing = path.join(root, "does-not-exist.git");
  assert.equal(existsSync(missing), false);

  const result = checkRemoteReachable({
    remoteUrl: missing,
    reachabilityTimeoutMs: DEFAULT_REACHABILITY_TIMEOUT_MS,
    reachabilityCheckCommand: null
  });
  assert.equal(result.reachable, false);
  assert.match(result.reason, /does not exist/);
});

// ─── checkRemoteReachable: injected probe command (stands in for ssh) ───────

test("checkRemoteReachable: injected command exiting 0 is reachable", () => {
  const result = checkRemoteReachable({
    remoteUrl: "mini:~/memory-sync/pandora-memory.git",
    reachabilityTimeoutMs: 2000,
    reachabilityCheckCommand: [process.execPath, "-e", "process.exit(0)"]
  });
  assert.equal(result.reachable, true);
});

test("checkRemoteReachable: injected command exiting non-zero is unreachable", () => {
  const result = checkRemoteReachable({
    remoteUrl: "mini:~/memory-sync/pandora-memory.git",
    reachabilityTimeoutMs: 2000,
    reachabilityCheckCommand: [process.execPath, "-e", "process.exit(1)"]
  });
  assert.equal(result.reachable, false);
  assert.match(result.reason, /exited with code 1/);
});

test("checkRemoteReachable: injected command that hangs past the timeout is unreachable (bounded, no hang)", () => {
  const timeoutMs = 200;
  const startedAt = Date.now();

  const result = checkRemoteReachable({
    remoteUrl: "mini:~/memory-sync/pandora-memory.git",
    reachabilityTimeoutMs: timeoutMs,
    // Sleeps far longer than the timeout; if the timeout guard did not work
    // this call — and the whole test run — would hang for 30s per case.
    reachabilityCheckCommand: [process.execPath, "-e", "setTimeout(() => {}, 30000)"]
  });

  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.reachable, false);
  assert.match(result.reason, /timed out/);
  assert.ok(
    elapsedMs < timeoutMs * 10,
    `expected the probe to be killed near the ${timeoutMs}ms timeout, took ${elapsedMs}ms`
  );
});

test("checkRemoteReachable: an empty injected command array falls back to the derived default probe", () => {
  // An empty array must be treated the same as "no override" (falsy-length
  // check), not as "run a command with no binary".
  const result = checkRemoteReachable({
    remoteUrl: sandbox("empty-override"),
    reachabilityTimeoutMs: DEFAULT_REACHABILITY_TIMEOUT_MS,
    reachabilityCheckCommand: []
  });
  assert.equal(result.reachable, true);
});

test("checkRemoteReachable: an unresolvable probe binary reports unreachable instead of throwing", () => {
  const result = checkRemoteReachable({
    remoteUrl: "mini:~/memory-sync/pandora-memory.git",
    reachabilityTimeoutMs: 2000,
    reachabilityCheckCommand: ["agent-memory-sync-definitely-not-a-real-binary--probe"]
  });
  assert.equal(result.reachable, false);
  assert.match(result.reason, /failed to start/);
});

// ─── checkRemoteReachable: unsupported scheme skips the precheck ────────────

test("checkRemoteReachable: https remotes have no dedicated probe and are assumed reachable", () => {
  const result = checkRemoteReachable({
    remoteUrl: "https://github.com/example/agent-memory.git",
    reachabilityTimeoutMs: DEFAULT_REACHABILITY_TIMEOUT_MS,
    reachabilityCheckCommand: null
  });
  assert.equal(result.reachable, true);
  assert.match(result.reason, /no dedicated/);
});
