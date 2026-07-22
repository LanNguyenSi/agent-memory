const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

// Fast, bounded remote-reachability precheck. Runs before pull/push/queue-replay
// network operations so an unreachable remote (ssh host down, VPN dropped, ...)
// produces a clean no-op instead of letting `git ls-remote`/`fetch`/`push` hang
// or spam retries — see performPull/performPush in ./pull.ts and ./push.ts.

interface ReachabilityCheckConfig {
  remoteUrl: string;
  reachabilityTimeoutMs?: number | null;
  reachabilityCheckCommand?: string[] | null;
}

interface ReachabilityResult {
  reachable: boolean;
  reason: string;
}

type ClassifiedRemote =
  | { kind: "ssh"; host: string }
  | { kind: "local"; path: string }
  | { kind: "unsupported" };

const DEFAULT_REACHABILITY_TIMEOUT_MS = 4000;

function checkRemoteReachable(config: ReachabilityCheckConfig): ReachabilityResult {
  const timeoutMs =
    config.reachabilityTimeoutMs && config.reachabilityTimeoutMs > 0
      ? config.reachabilityTimeoutMs
      : DEFAULT_REACHABILITY_TIMEOUT_MS;

  if (config.reachabilityCheckCommand && config.reachabilityCheckCommand.length > 0) {
    return runProbeCommand(config.reachabilityCheckCommand, timeoutMs);
  }

  const classified = classifyRemote(config.remoteUrl);

  if (classified.kind === "local") {
    return existsSync(classified.path)
      ? { reachable: true, reason: `local remote path '${classified.path}' exists` }
      : { reachable: false, reason: `local remote path '${classified.path}' does not exist` };
  }

  if (classified.kind === "unsupported") {
    // No cheap dedicated probe for this transport (e.g. https://, git://).
    // Assume reachable and let the real git operation surface any error —
    // this keeps behavior unchanged for remotes we cannot fast-check safely.
    return {
      reachable: true,
      reason: "no dedicated reachability probe for this remote scheme; skipping precheck"
    };
  }

  const probeCommand = deriveProbeCommand(config.remoteUrl, timeoutMs) as string[];
  return runProbeCommand(probeCommand, timeoutMs);
}

// Classifies a remoteUrl the same way GitClient ultimately hands it to `git`:
// scp-like/`ssh://` targets are reachable over ssh, everything without a
// network scheme is a local filesystem path (as used throughout this
// package's own bare-repo test fixtures), and anything else (https://,
// git://, ...) has no dedicated fast probe here.
function classifyRemote(remoteUrl: string): ClassifiedRemote {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(remoteUrl)) {
    if (remoteUrl.startsWith("ssh://")) {
      const host = extractSshUrlHost(remoteUrl);
      return host ? { kind: "ssh", host } : { kind: "unsupported" };
    }

    if (remoteUrl.startsWith("file://")) {
      return { kind: "local", path: remoteUrl.slice("file://".length) };
    }

    return { kind: "unsupported" };
  }

  const scpHost = extractScpLikeHost(remoteUrl);
  if (scpHost) {
    return { kind: "ssh", host: scpHost };
  }

  return { kind: "local", path: remoteUrl };
}

// Builds the default `ssh -o BatchMode=yes -o ConnectTimeout=<n> <host> true`
// probe for an ssh-style remote. Returns null for remotes classifyRemote does
// not consider ssh (local paths, unsupported schemes) — callers fall back to
// a filesystem check or skip the precheck entirely.
function deriveProbeCommand(remoteUrl: string, timeoutMs: number): string[] | null {
  const classified = classifyRemote(remoteUrl);
  if (classified.kind !== "ssh") {
    return null;
  }

  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return ["ssh", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${timeoutSeconds}`, classified.host, "true"];
}

function extractScpLikeHost(remoteUrl: string): string | null {
  const colonIndex = remoteUrl.indexOf(":");
  if (colonIndex <= 0) {
    return null;
  }

  const beforeColon = remoteUrl.slice(0, colonIndex);
  // A slash before the colon means it's a path (e.g. "./fixtures/x:y"), not
  // scp-like "host:path" syntax.
  if (beforeColon.includes("/")) {
    return null;
  }

  // Guard against a Windows drive path like "C:\repo" or "C:/repo" being
  // misread as an ssh host named "C".
  if (/^[a-zA-Z]$/.test(beforeColon) && /^[\\/]/.test(remoteUrl.slice(colonIndex + 1))) {
    return null;
  }

  const host = beforeColon.includes("@") ? beforeColon.slice(beforeColon.indexOf("@") + 1) : beforeColon;
  return host || null;
}

function extractSshUrlHost(remoteUrl: string): string | null {
  try {
    return new URL(remoteUrl).hostname || null;
  } catch {
    return null;
  }
}

function runProbeCommand(command: string[], timeoutMs: number): ReachabilityResult {
  const [bin, ...args] = command;
  if (!bin) {
    return { reachable: false, reason: "reachability check command is empty." };
  }

  const label = command.join(" ");

  let result: { error?: Error & { code?: string }; signal?: string | null; status?: number | null };
  try {
    result = spawnSync(bin, args, {
      timeout: timeoutMs,
      stdio: "ignore"
    });
  } catch (error) {
    return { reachable: false, reason: `reachability probe threw (${label}): ${(error as Error).message}` };
  }

  // Node sets `error.code === "ETIMEDOUT"` (and kills the child) when the
  // `timeout` option elapses — this is the primary signal that the probe
  // hung and was cut off. `result.signal` is a secondary indicator for the
  // (rarer) case where the child was killed but spawnSync did not surface
  // an ETIMEDOUT error.
  if (result.error?.code === "ETIMEDOUT" || result.signal) {
    return { reachable: false, reason: `reachability probe timed out after ${timeoutMs}ms (${label})` };
  }

  if (result.error) {
    return { reachable: false, reason: `reachability probe failed to start (${label}): ${result.error.message}` };
  }

  if (result.status !== 0) {
    return { reachable: false, reason: `reachability probe exited with code ${result.status} (${label})` };
  }

  return { reachable: true, reason: `reachability probe succeeded (${label})` };
}

module.exports = {
  DEFAULT_REACHABILITY_TIMEOUT_MS,
  checkRemoteReachable,
  classifyRemote,
  deriveProbeCommand
};
