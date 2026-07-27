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
  isCliError,
  formatErrorMessage
};
