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
const { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  DEFAULT_REACHABILITY_TIMEOUT_MS,
  checkRemoteReachable,
  classifyRemote,
  deriveProbeCommand
} = require("../../src/memory-sync/reachability");

const createdSandboxes: string[] = [];
test.after(() => {
  for (const dir of createdSandboxes) rmSync(dir, { recursive: true, force: true });
});

function sandbox(name: string): string {
  const root = path.join(
    tmpdir(),
    `agent-memory-sync-reachability-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  mkdirSync(root, { recursive: true });
  createdSandboxes.push(root);
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

// classifyRemote's ssh:// branch is `!host || isUnsafeSshHost(host)` — the
// dash-prefixed-host tests below exercise the isUnsafeSshHost side of that
// OR. This pins the other side: an ssh:// URL with no hostname at all
// (extractSshUrlHost returns "" -> falsy), which must be rejected the same
// way, not treated as ssh with an empty host.
test("classifyRemote: ssh:// URL with no hostname (empty host) is unsupported, not ssh", () => {
  const result = classifyRemote("ssh:///repo.git");
  assert.deepEqual(result, { kind: "unsupported" });
});

// extractScpLikeHost's Windows-drive-path guard: "C:\repo" / "C:/repo" must
// not be misread as scp-like "host:path" syntax with an ssh host named "C".
test("classifyRemote: a Windows drive path with a backslash is local, not scp-like ssh", () => {
  const result = classifyRemote("C:\\repo\\memory.git");
  assert.deepEqual(result, { kind: "local", path: "C:\\repo\\memory.git" });
});

test("classifyRemote: a Windows drive path with a forward slash is local, not scp-like ssh", () => {
  const result = classifyRemote("C:/repo/memory.git");
  assert.deepEqual(result, { kind: "local", path: "C:/repo/memory.git" });
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

// checkRemoteReachable's own timeout resolution is `config.reachabilityTimeoutMs
// && config.reachabilityTimeoutMs > 0 ? config.reachabilityTimeoutMs :
// DEFAULT_REACHABILITY_TIMEOUT_MS` — every other test in this file passes an
// explicit positive timeout, so the DEFAULT fallback branch itself was never
// exercised. Pinning the constant's value first, then confirming an
// undefined timeout still produces a correct, real result (not just that no
// exception is thrown).
test("DEFAULT_REACHABILITY_TIMEOUT_MS is 4000ms", () => {
  assert.equal(DEFAULT_REACHABILITY_TIMEOUT_MS, 4000);
});

test("checkRemoteReachable: omitting reachabilityTimeoutMs falls back to the default timeout and still evaluates the probe", () => {
  const result = checkRemoteReachable({
    remoteUrl: "mini:~/memory-sync/pandora-memory.git",
    reachabilityTimeoutMs: undefined,
    reachabilityCheckCommand: [process.execPath, "-e", "process.exit(0)"]
  });
  assert.equal(result.reachable, true);
});

// runProbeCommand's `if (!bin) return {reachable:false, reason: "...is
// empty."}` guard is reachable even though the `.length > 0` check above it
// passed, if the array's first element is itself an empty string.
test("checkRemoteReachable: an injected command whose first element is an empty string reports the empty-command reason", () => {
  const result = checkRemoteReachable({
    remoteUrl: "mini:~/memory-sync/pandora-memory.git",
    reachabilityTimeoutMs: 2000,
    reachabilityCheckCommand: [""]
  });
  assert.equal(result.reachable, false);
  assert.match(result.reason, /reachability check command is empty/);
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

// ─── checkRemoteReachable: default ssh probe (no override) ──────────────────
//
// Every checkRemoteReachable test above either overrides
// reachabilityCheckCommand (bypassing deriveProbeCommand entirely) or uses a
// non-ssh remote. The default probe path for an ssh-classified remote
// (deriveProbeCommand's `ssh -o BatchMode=yes -o ConnectTimeout=<n> <host>
// true` actually being spawned by runProbeCommand) was therefore never
// exercised end-to-end. Hermetic: a stub `ssh` executable is prepended onto
// PATH for the duration of the test (restored in `finally`), the same
// spawn-a-real-controlled-process approach this file's header describes —
// no real ssh binary or network access involved.

function withStubSshOnPath<T>(root: string, script: string, fn: () => T): T {
  const stubDir = path.join(root, "bin");
  mkdirSync(stubDir, { recursive: true });
  const stubSshPath = path.join(stubDir, "ssh");
  writeFileSync(stubSshPath, script, "utf8");
  chmodSync(stubSshPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${originalPath || ""}`;
  try {
    return fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

test("checkRemoteReachable: an ssh-classified remote with no override spawns the default ssh probe, and a successful probe is reachable", () => {
  const root = sandbox("ssh-default-probe-ok");
  const result = withStubSshOnPath(root, "#!/bin/sh\nexit 0\n", () =>
    checkRemoteReachable({
      remoteUrl: "mini:~/memory-sync/pandora-memory.git",
      reachabilityTimeoutMs: 2000,
      reachabilityCheckCommand: null
    })
  );

  assert.equal(result.reachable, true);
  assert.match(result.reason, /ssh -o BatchMode=yes -o ConnectTimeout=2 mini true/);
});

test("checkRemoteReachable: an ssh-classified remote with no override is unreachable when the default ssh probe exits non-zero", () => {
  const root = sandbox("ssh-default-probe-fail");
  const result = withStubSshOnPath(root, "#!/bin/sh\nexit 255\n", () =>
    checkRemoteReachable({
      remoteUrl: "mini:~/memory-sync/pandora-memory.git",
      reachabilityTimeoutMs: 2000,
      reachabilityCheckCommand: null
    })
  );

  assert.equal(result.reachable, false);
  assert.match(result.reason, /exited with code 255/);
});

test("checkRemoteReachable: https remotes have no dedicated probe and are assumed reachable", () => {
  const result = checkRemoteReachable({
    remoteUrl: "https://github.com/example/agent-memory.git",
    reachabilityTimeoutMs: DEFAULT_REACHABILITY_TIMEOUT_MS,
    reachabilityCheckCommand: null
  });
  assert.equal(result.reachable, true);
  assert.match(result.reason, /no dedicated/);
});
