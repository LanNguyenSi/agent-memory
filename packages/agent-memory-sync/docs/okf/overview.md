---
type: overview
title: agent-memory-sync overview
description: Orientation for the agent-memory-sync package. The four commands, the state directory they share, the order one sync tick runs in, and the exit codes, with pointers to the docs that cover each mechanism in depth.
tags: [overview, agent-memory-sync, cli, state-dir, exit-codes]
timestamp: 2026-10-11T16:31:20Z
sources:
  - packages/agent-memory-sync/src/main.ts
  - packages/agent-memory-sync/src/errors.ts
  - packages/agent-memory-sync/src/commands/run.ts
  - packages/agent-memory-sync/src/commands/watch.ts
  - packages/agent-memory-sync/src/commands/restore.ts
  - packages/agent-memory-sync/src/memory-sync/state-store.ts
  - packages/agent-memory-sync/src/memory-sync/pre-apply-snapshot.ts
  - packages/agent-memory-sync/src/memory-sync/lock.ts
  - packages/agent-memory-sync/src/memory-sync/git-client.ts
---

# agent-memory-sync overview

## What this covers

`agent-memory-sync` keeps a configured set of local files (the `syncPaths`)
in a subdirectory of a shared Git repository, the hub, and merges each file
three ways: local copy, hub copy, and a base snapshot this machine stores of
the hub content its last pull merged against or, after a push, the final
hub content of each path whose local copy equals it, including every path
the push published (see
[base-snapshot-lifecycle.md](base-snapshot-lifecycle.md) for the other
writers). This bundle covers the mechanisms that span
several source files: configuration resolution, the base snapshot's
lifecycle, the guards in front of every destructive write, and the offline
queue with the state-directory lock. Installation, machine setup and the
full CLI reference live in the package README and `docs/`; this bundle does
not repeat them.

## Where to start reading

- `packages/agent-memory-sync/src/main.ts:18-21#"registerRestoreCommand(program);"`
  registers the four commands `run`, `config`, `watch` and `restore`. An
  error that reaches the top-level catch sets the process exit code from its
  `exitCode` property, or 1 when it has none
  (`packages/agent-memory-sync/src/main.ts:23-27#".exitCode : 1;"`).
- `run` executes one mode per tick through `executeMode`: `push` calls
  `performPush`, `pull` calls `performPull`, and `sync` runs the pull and
  then the push
  (`packages/agent-memory-sync/src/commands/run.ts:252-262#"const pushResult = await performPush(runConfig, options);"`).
  With `--schedule` it repeats ticks on a five-field cron expression.
- `watch` never pulls. Each debounce window becomes one `performPush` call
  with its own working-copy label `watch`
  (`packages/agent-memory-sync/src/commands/watch.ts:187-192#"allowMassDelete: options.allowMassDelete"`).
- `restore` writes files back from a hub commit with no pre-apply
  snapshot, or replaces a whole sync destination from a commit or from a
  local pre-apply snapshot. `config` reads and writes the config file only.

## Key modules

- [Configuration resolution](config-resolution.md): where each setting
  comes from, in which order, and which config-file keys the CLI's own
  option defaults hide.
- [Base snapshot lifecycle](base-snapshot-lifecycle.md): every reader and
  writer of `stateDir/base`, and the per-path rule push advances it by.
- [Destructive-write safety chain](destructive-write-safety-chain.md): the
  ordered checks a pull and a push pass before they delete or overwrite
  anything, and the exit code each one stops with.
- [Offline queue and state-directory lock](offline-queue-and-lock.md):
  queueing, replay and escalation when the hub is unreachable, and the
  advisory lock that serialises `run`, `watch` and `restore`.
- [Responding to a stopped run](stopped-run-runbook.md): what state each
  refusal leaves behind and the next command to run.

## State directory layout

All syncing commands of one profile share one `stateDir`. The
`StateStore` defines `tmp/`, `base/`, `queue/` and `state.json`
(`packages/agent-memory-sync/src/memory-sync/state-store.ts:202-216#"state.json"`);
the pre-apply snapshot store and the lock add the other two entries.

| Path under `stateDir`           | Holds                                                                                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state.json`                    | `lastRemoteHead` and `lastRunAt`, written after a pull or push completes.                                                                                                                                                                                  |
| `base/`                         | The base snapshot: one file per tracked path, each with a `<path>.meta.json` marker; a deleted path has only its marker, with `deleted: true` (`packages/agent-memory-sync/src/memory-sync/state-store.ts:219-235#"writeFileSync(absolutePath, content"`). |
| `queue/<id>/`                   | One queued push: `local/`, `base/` and a `manifest.json` with `createdAt`.                                                                                                                                                                                 |
| `tmp/<label>/`                  | A disposable working copy of the hub, one label per operation: `pull`, `push`, `watch`, `push-preview`, `restore` (`packages/agent-memory-sync/src/memory-sync/git-client.ts:255-260#"return repoDir;"`).                                                  |
| `snapshots/<destination>/<id>/` | A pre-apply snapshot of one destination, with `files/` and `manifest.json`.                                                                                                                                                                                |
| `lock.json`                     | The advisory lock record (`packages/agent-memory-sync/src/memory-sync/lock.ts:45-47#"lock.json"`).                                                                                                                                                         |

## Exit codes

Every refusal is a `CliError` subclass with its own default exit code
(`packages/agent-memory-sync/src/errors.ts:232-248#"formatErrorMessage"`).

| Code | Raised as                                                              | Meaning                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | any error without its own code                                         | Unclassified failure.                                                                                                                                                                                                           |
| 2    | `CliError(..., 2)`                                                     | Usage error, for example `--accept-mass-delete` combined with `--allow-mass-delete`.                                                                                                                                            |
| 3    | `CliError(..., 3)`                                                     | Configuration error: missing `remoteUrl`, an invalid key or value, a missing explicit config file.                                                                                                                              |
| 4    | `RemoteUnavailableError`, or a generic git failure                     | `RemoteUnavailableError` comes only from `ls-remote` and `push`; every other failed git command is a plain `CliError` with the same code (`packages/agent-memory-sync/src/memory-sync/git-client.ts:381#"git command failed"`). |
| 5    | `MassDeleteRefusedError`                                               | A push plan deletes more than the mass-delete guard allows.                                                                                                                                                                     |
| 6    | `RemoteQueueEscalationError`                                           | The offline queue has not drained for longer than the escalation threshold.                                                                                                                                                     |
| 7    | `UnreliableCheckoutError`                                              | The fetched working copy is missing or zeroing files the base snapshot tracks.                                                                                                                                                  |
| 8    | `StateDirLockedError`                                                  | Another process holds the state-directory lock.                                                                                                                                                                                 |
| 9    | `RemoteDeletionRefusedError`                                           | A pull would apply more deletions than the guard allows.                                                                                                                                                                        |
| 10   | `RestoreSourceNotFoundError`                                           | The named commit or snapshot holds nothing to restore.                                                                                                                                                                          |
| 11   | `ConfigKeyNotSetError`                                                 | `config get` on a supported key with no persisted value.                                                                                                                                                                        |
| 12   | `AdoptionSnapshotNotIntactError`, `RestoreDestinationNotWritableError` | Stopped before any local write: a pre-apply snapshot cannot hold or does not hold what is about to change, or a restore target is not writable.                                                                                 |
| 13   | `PartialApplyError`                                                    | Stopped part way through applying a plan; some files were already written or removed.                                                                                                                                           |
