class CliError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

// A narrow CliError subclass thrown ONLY from the two GitClient operations
// that can fail because the *remote* is unavailable or rejecting (see
// GitClient.lookupRemoteHead / GitClient.push in memory-sync/git-client.ts):
// performPush's catch (memory-sync/push.ts) checks for this specific type
// before converting a failure into a queued-for-replay outcome, so a
// non-network failure elsewhere in the same try block (a full disk, a
// broken commit hook, a corrupted git config, ...) is not misclassified as
// "remote unavailable" and silently swallowed into a benign-looking queue —
// it re-throws instead, preserving fail-loud/supervisor-restart semantics
// for that class of error. A plain CliError (e.g. from GitClient.run's
// generic "git command failed" fallback) is deliberately NOT treated as a
// remote failure by that check, even though it shares the same exitCode 4 —
// the exit code alone does not discriminate why a git subcommand failed,
// only the throw site does.
class RemoteUnavailableError extends CliError {
  constructor(message: string, exitCode = 4) {
    super(message, exitCode);
    this.name = "RemoteUnavailableError";
  }
}

// Thrown when the QUEUE — not any single git operation — has been failing
// to drain for longer than the configured escalation threshold (default
// 24h; see StateStore.oldestQueuedSnapshotAgeMs and push.ts's
// checkQueueEscalation). Deliberately NOT a RemoteUnavailableError subclass:
// push.ts's catch discriminates on `instanceof RemoteUnavailableError` to
// decide "queue quietly, exit 0" vs. "something else is wrong, crash loud"
// (see the RemoteUnavailableError comment above) — a RemoteUnavailableError
// raised on any single tick is exactly that: one tick could not reach the
// remote, which by itself is indistinguishable from a laptop that is
// legitimately, temporarily offline (the case the whole queue-instead-of-
// crash contract exists to protect). This error represents a different,
// higher-level fact instead: the queue has now been failing to drain for so
// long that continuing to report a clean "queued" outcome would itself
// become the failure mode — a permanently misconfigured remote (wrong
// remoteUrl, a renamed repository path, a host that accepts a connection but
// cannot serve the repository) is ALSO classified RemoteUnavailableError and
// would otherwise queue forever, exit 0 every tick, indefinitely. Once the
// threshold is crossed this error must propagate and crash loud exactly
// like a non-network failure does, even though its underlying cause is
// still "the remote is unreachable" — that is the whole point of the
// escalation.
class RemoteQueueEscalationError extends CliError {
  constructor(message: string, exitCode = 6) {
    super(message, exitCode);
    this.name = "RemoteQueueEscalationError";
  }
}

function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "unexpected error.";
}

module.exports = {
  CliError,
  RemoteUnavailableError,
  RemoteQueueEscalationError,
  isCliError,
  formatErrorMessage
};
