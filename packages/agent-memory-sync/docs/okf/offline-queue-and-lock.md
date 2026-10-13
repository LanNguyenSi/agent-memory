---
type: module
title: Offline queue, replay and escalation, and the state-directory lock
description: How push queues a snapshot when the hub is unreachable, how the next successful push replays the queue, when a growing queue escalates to exit 6, and how the advisory lock in stateDir/lock.json serialises run, watch and restore (exit 8).
tags: [queue, replay, escalation, lock, offline, watch, schedule]
timestamp: 2026-10-13T19:30:31Z
sources:
  - packages/agent-memory-sync/src/memory-sync/push.ts
  - packages/agent-memory-sync/src/memory-sync/state-store.ts
  - packages/agent-memory-sync/src/memory-sync/git-client.ts
  - packages/agent-memory-sync/src/memory-sync/lock.ts
  - packages/agent-memory-sync/src/commands/run.ts
  - packages/agent-memory-sync/src/commands/watch.ts
  - packages/agent-memory-sync/src/commands/restore.ts
---

# Offline queue, replay and escalation, and the state-directory lock

## Responsibility

The queue lets a push that cannot reach the hub succeed locally: the
current local state is stored under `stateDir/queue/` and published by a
later push. The lock keeps two processes of this package from working on
one `stateDir` at the same time. Neither one decides what is merged or
deleted; that is the [safety chain](destructive-write-safety-chain.md).

## Entry points

- `performPush` and its helpers `enqueueCurrentSnapshot` and
  `checkQueueEscalation`, `src/memory-sync/push.ts`.
- `StateStore.enqueueSnapshot`, `listQueuedSnapshots`,
  `removeQueuedSnapshot` and `oldestQueuedSnapshotAgeMs`,
  `src/memory-sync/state-store.ts`.
- `acquireStateDirLock`, `src/memory-sync/lock.ts`.

## When a push queues

A push queues the current snapshot in exactly two cases:

- the reachability precheck fails before any git command runs
  (`packages/agent-memory-sync/src/memory-sync/push.ts:225-236#"ownerScopedWarnings"`);
- a `RemoteUnavailableError` is thrown inside the push; any other error
  inside the same block is rethrown
  (`packages/agent-memory-sync/src/memory-sync/push.ts:477-478#"throw error;"`).

`RemoteUnavailableError` is thrown only by a failing `git ls-remote`
(`packages/agent-memory-sync/src/memory-sync/git-client.ts:62-71#"Check connectivity and repository access."`)
and a failing `git push`
(`packages/agent-memory-sync/src/memory-sync/git-client.ts:239-247#"git push failed"`).
Every other failed git command raises a plain `CliError` with the same exit
code 4, and is not queued: the exit code alone does not tell the two apart,
the error class does.

`StateStore.enqueueSnapshot` writes the snapshot's local files and its base
under `queue/<id>/`, with a `manifest.json` holding `createdAt`; the id
starts with the enqueue time in milliseconds
(`packages/agent-memory-sync/src/memory-sync/state-store.ts:92-105#"return id;"`).
A queued push reports status `queued` and exits 0. A dry run never
enqueues; it reports that the real run would
(`packages/agent-memory-sync/src/memory-sync/push.ts:194-209#"would enqueue a snapshot instead of pushing immediately"`).

## Replay

Every push lists the queue sorted by id, oldest first
(`packages/agent-memory-sync/src/memory-sync/state-store.ts:107-118#"left.id.localeCompare(right.id)"`),
filters each queued snapshot's maps the same way it filters the current
one, and places them ahead of the current snapshot, each with the commit
message `sync(queue): replay <id>`
(`packages/agent-memory-sync/src/memory-sync/push.ts:157-168#"sync(queue): replay"`).
All of them are merged and committed in one working copy, with the base
chained from one to the next (see
[base-snapshot-lifecycle.md](base-snapshot-lifecycle.md)), and one
`git push` publishes them together. Only after that push succeeds are the
queued snapshots removed
(`packages/agent-memory-sync/src/memory-sync/push.ts:431-433#"removeQueuedSnapshot(queuedSnapshot.id)"`).
If the push fails again, the existing entries stay and the current snapshot
is queued next to them. If a guard refuses one of the snapshots (exit 5 or
7), nothing is pushed and the queue stays as it was.

## Escalation, exit 6

After every enqueue, `checkQueueEscalation` runs
(`packages/agent-memory-sync/src/memory-sync/push.ts:543-548#"checkQueueEscalation(stateStore, queueEscalationThresholdMs)"`).
It measures the age of the oldest queued snapshot from the `createdAt`
values; a missing or unparsable manifest is left out of the computation
(`packages/agent-memory-sync/src/memory-sync/state-store.ts:174-175#"Number.isFinite(parsed) ? parsed : null"`).
Because a successful push empties the whole queue, that age is the time
since the first failed tick of the current failure streak.

- Below `queueEscalationThresholdMs` (default 24 hours,
  `packages/agent-memory-sync/src/memory-sync/state-store.ts:32#"DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS = 24 * 60 * 60 * 1000"`)
  nothing happens
  (`packages/agent-memory-sync/src/memory-sync/push.ts:600-601#"oldestAgeMs < thresholdMs"`).
- At or above it, the tick throws `RemoteQueueEscalationError`, exit 6,
  after the snapshot was already stored
  (`packages/agent-memory-sync/src/memory-sync/push.ts:624#"throw new RemoteQueueEscalationError("`).
- Above 30 times the threshold the age is treated as a clock error: the
  tick does not escalate and adds a note to its `queued` result instead
  (`packages/agent-memory-sync/src/memory-sync/push.ts:612-613#"oldestAgeMs > sanityCeilingMs"`).
- `queueEscalationThresholdMs: null` in the config file disables the
  check (see [config-resolution.md](config-resolution.md)).

How each command handles exit 6:

- A single `run` exits 6 at once.
- `run --schedule` records the error, keeps ticking, and exits 6 after the
  last tick, once the result of every completed tick has been written
  (`packages/agent-memory-sync/src/commands/run.ts:174#"queueEscalationError = error;"`,
  `packages/agent-memory-sync/src/commands/run.ts:214-215#"throw queueEscalationError;"`).
- `watch` logs a queued tick as an info line and counts it toward
  `--max-runs`
  (`packages/agent-memory-sync/src/commands/watch.ts:195-197#"watch tick queued locally instead of pushing"`).
  An escalation is not a guard refusal, so it stops the watcher with exit 6
  (`packages/agent-memory-sync/src/commands/watch.ts:281-282#"handleSnapshotError(error);"`).

## The state-directory lock, exit 8

`acquireStateDirLock` creates `stateDir/lock.json` with an exclusive create
(`wx`), recording pid, host, command and acquisition time
(`packages/agent-memory-sync/src/memory-sync/lock.ts:227#"writeFileSync(filePath, payload"`).
If the file exists, the existing lock is treated as stale when its record is
unreadable, older than `lockStaleMs` (default 30 minutes,
`packages/agent-memory-sync/src/memory-sync/lock.ts:36#"DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000"`),
or held by a process on this host that no longer exists. A stale lock is
removed and the create is tried once more; a live lock, or losing the
second attempt, is `StateDirLockedError`, exit 8
(`packages/agent-memory-sync/src/memory-sync/lock.ts:238-243#"throw new StateDirLockedError(describeHeldLock(input.stateDir"`).
A holder on another host always counts as alive, since its pid means
nothing here
(`packages/agent-memory-sync/src/memory-sync/lock.ts:127-129#"return true;"`).

`release()` removes the file only while it still carries this holder's own
record, so a process whose lock was taken over as stale does not remove the
new holder's lock
(`packages/agent-memory-sync/src/memory-sync/lock.ts:79-80#"current.acquiredAt !== this.record.acquiredAt"`).
Held locks are also released on process exit, and on SIGINT or SIGTERM
when no other handler for that signal is installed
(`packages/agent-memory-sync/src/memory-sync/lock.ts:163-165#"if (hadOtherListeners) {"`).
A SIGKILL leaves the file behind until it goes stale.

Who takes the lock, and when:

- `run` takes it per tick, before anything reads the workspace or the
  state directory, and releases it before waiting for the next scheduled
  tick
  (`packages/agent-memory-sync/src/commands/run.ts:136-140#"staleMs: runConfig.lockStaleMs"`,
  `packages/agent-memory-sync/src/commands/run.ts:187-189#"lock.release();"`).
  A locked `run` exits 8.
- `watch` takes it per tick before it consumes the pending changes; a
  locked tick logs a warning, keeps the changes pending and schedules
  itself again
  (`packages/agent-memory-sync/src/commands/watch.ts:258-259#"scheduleFlush();"`).
  The shutdown flush takes it too, and a locked flush leaves the changes on
  disk without failing the shutdown
  (`packages/agent-memory-sync/src/commands/watch.ts:356-357#"watch shutdown flush deferred"`).
- `restore` takes it for its whole run
  (`packages/agent-memory-sync/src/commands/restore.ts:165-166#"staleMs: runConfig.lockStaleMs"`).
- The `config` subcommands do not take it.

The lock is what keeps one job from removing another job's working copy
while that copy is in use. As a second layer, each operation clears only
its own `tmp/<label>` directory
(`packages/agent-memory-sync/src/memory-sync/state-store.ts:197-199#"mkdirSync(this.tempDir()"`),
and `watch` uses the label `watch` rather than sharing `push` with a
concurrent `run`.

## Invariants enforced here

- [Destructive-write safety chain](destructive-write-safety-chain.md):
  every check in it runs under this lock.
