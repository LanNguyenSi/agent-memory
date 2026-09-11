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

// Thrown when a PUSH plan would delete more of a destination than the
// mass-delete guard allows (src/memory-sync/guards.ts). Deliberately NOT a
// RemoteUnavailableError: performPush's catch queues only that type and
// re-throws everything else, which is exactly what must happen here. A
// refused plan is a fail-loud condition, not something to persist into the
// replay queue and retry every tick. Exit code 5 keeps it distinguishable
// from a usage error (2), a config error (3), a git/remote failure (4) and
// the queue escalation (6) in a launchd/systemd log.
//
// Origin: the 2026-09-11 wipe (agent-tasks cda5b12c, pandora run
// .ai/runs/2026-09-11-memory-sync-wipe). A sync tick whose pull
// had just emptied the local workspace pushed the deletion of the whole
// tracked corpus, and the peer machine mirrored it one tick later. Nothing
// in the push path asked whether deleting the entire tracked corpus at once
// was plausible.
class MassDeleteRefusedError extends CliError {
  constructor(message: string, exitCode = 5) {
    super(message, exitCode);
    this.name = "MassDeleteRefusedError";
  }
}

// Thrown when the temporary working copy a pull or push just prepared cannot
// be trusted to represent the remote: git reported success, but a sync
// destination the base snapshot knows to hold files came back with none
// (src/memory-sync/guards.ts). In the 2026-09-11 incident that was the
// stateDir/tmp wipe race (StateStore.clearTemp removes the WHOLE tmp root,
// and the watch and sync jobs share one stateDir), which is indistinguishable
// from a genuine remote deletion at the file level and was read as one.
//
// Exit code 7, and again deliberately not a RemoteUnavailableError: an
// unreliable checkout must stop the run rather than be queued or retried as
// a push.
class UnreliableCheckoutError extends CliError {
  constructor(message: string, exitCode = 7) {
    super(message, exitCode);
    this.name = "UnreliableCheckoutError";
  }
}

// Thrown when a PULL would apply more deletions to the local workspace than
// the mass-delete guard allows (src/memory-sync/guards.ts). The mirror image
// of MassDeleteRefusedError: same thresholds, opposite direction, and a
// different question for the operator, which is why it is a different error
// with a different flag (--accept-mass-delete, "yes, the remote really did
// drop these") and a different exit code.
//
// Exit code 9, distinct from the push-side refusal (5) and from an
// untrustworthy working copy (7), so a launchd/systemd log says which of the
// three happened without parsing the message.
class RemoteDeletionRefusedError extends CliError {
  constructor(message: string, exitCode = 9) {
    super(message, exitCode);
    this.name = "RemoteDeletionRefusedError";
  }
}

// Thrown when another agent-memory-sync process already holds the advisory
// lock on this stateDir (src/memory-sync/lock.ts). Exit code 8, distinct
// from every other refusal so a launchd/systemd log tells "someone else is
// working on this state directory right now" apart from a refused plan (5)
// or an untrustworthy working copy (7).
//
// Not an error condition in the usual sense: the run stopped before reading
// or writing anything, and the same invocation a moment later is expected to
// succeed. `watch` treats it as a deferred tick and keeps watching rather
// than shutting down.
class StateDirLockedError extends CliError {
  constructor(message: string, exitCode = 8) {
    super(message, exitCode);
    this.name = "StateDirLockedError";
  }
}

// Thrown when a restore's source has nothing to restore: the named pre-apply
// snapshot does not exist (src/memory-sync/pre-apply-snapshot.ts), or the
// commit holds no file, or not the named file, under the requested path or
// destination (src/commands/restore.ts). Exit code 10, its own code: a
// source that is not there is neither a refused push plan (5), which the
// exit-code table used to send an operator to --allow-mass-delete for, nor
// a configuration error (3). The operator named a source; the answer is
// "not that one", and the fix is to pick another.
class RestoreSourceNotFoundError extends CliError {
  constructor(message: string, exitCode = 10) {
    super(message, exitCode);
    this.name = "RestoreSourceNotFoundError";
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
  MassDeleteRefusedError,
  RemoteDeletionRefusedError,
  UnreliableCheckoutError,
  StateDirLockedError,
  RestoreSourceNotFoundError,
  isCliError,
  formatErrorMessage
};
