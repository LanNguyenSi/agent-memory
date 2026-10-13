---
type: runbook
title: Responding to a stopped or refused sync run
description: Per exit code (5, 6, 7, 8, 9, 12, 13), what state a stopped run leaves behind and the next step, taken from the remediation text each refusal prints.
tags: [runbook, exit-codes, recovery, restore, mass-delete]
timestamp: 2026-10-13T16:28:37Z
sources:
  - packages/agent-memory-sync/src/errors.ts
  - packages/agent-memory-sync/src/memory-sync/guards.ts
  - packages/agent-memory-sync/src/memory-sync/pull.ts
  - packages/agent-memory-sync/src/memory-sync/push.ts
  - packages/agent-memory-sync/src/memory-sync/lock.ts
  - packages/agent-memory-sync/src/commands/restore.ts
---

# Responding to a stopped or refused sync run

## When to use this

- A `run`, `watch` or `restore` invocation, or its supervisor log, ended
  with exit code 5, 6, 7, 8, 9, 12 or 13. The error message on stderr names
  the destination, the counts and the snapshot generations involved; this
  runbook says what each code leaves behind. The checks themselves are
  described in
  [destructive-write-safety-chain.md](destructive-write-safety-chain.md).

## Preconditions

- The same config file and profile the stopped run used: the profile
  selects the `stateDir`, and so the lock, the base snapshot and the
  pre-apply snapshots (see [config-resolution.md](config-resolution.md)).
- For a recovery with `restore`, a pause of the scheduled sync jobs on this
  machine, so that no tick runs between the steps below.
- `restore <sha>` overwrites local files without a pre-apply snapshot, and
  a destination restore does not read its snapshot back. Copy aside any
  local file whose current content you may need before running either
  (see
  [destructive-write-safety-chain.md](destructive-write-safety-chain.md#restore-writes)).

## Steps

1. **Exit 8, state directory locked.** Nothing was read or written. Wait
   for the named holder to finish and run the command again. A lock older
   than `lockStaleMs`, or one whose process is gone on this host, is taken
   over automatically; remove `stateDir/lock.json` by hand only when
   neither applies and the holder is really gone
   (`packages/agent-memory-sync/src/memory-sync/lock.ts:265-270#"If neither applies and the holder is really gone"`).
2. **Exit 7, unreliable checkout.** Nothing was deleted locally and nothing
   was pushed.
   - If the message names files _missing_ from the working copy: run the
     command again once nothing else uses `stateDir/tmp`. If the hub really
     dropped those files on purpose, run `run --accept-mass-delete` once.
     To bring them back instead, restore the destination from a commit that
     still had them and let the next run push them
     (`packages/agent-memory-sync/src/memory-sync/guards.ts:581-588#"and let the next run push them"`).
   - If it names files _emptied to zero bytes_: `--accept-mass-delete`
     does not apply. Run again once nothing else uses `stateDir/tmp`, or
     restore from a commit; if the hub emptied them on purpose, commit real
     content at the hub or raise `massDeleteGuard` for one run
     (`packages/agent-memory-sync/src/memory-sync/guards.ts:566-577#"raise massDeleteGuard.maxFiles/maxRatio in the config for one run"`).
3. **Exit 5, push plan refused.** Nothing was pushed. Check first whether
   the local workspace or the working copy was emptied by another process.
   Only if the deletion is intended, run again with `--allow-mass-delete`
   (`packages/agent-memory-sync/src/memory-sync/guards.ts:302-306#"another process first."`).
4. **Exit 9, pull deletion refused.** Nothing was deleted locally and
   nothing was pushed. If the hub really dropped those files, run
   `run --accept-mass-delete` once; the destination is copied into
   `stateDir/snapshots` before the deletion is applied. If it did not,
   recover the hub first
   (`packages/agent-memory-sync/src/memory-sync/guards.ts:342-346#"before syncing again"`),
   for example with
   `agent-memory-sync restore <profile> <destination> --from-commit <sha> --yes`,
   naming a hub commit that still has the files, and let the next push
   publish them.
5. **Exit 12, stopped before any write.** No local file was written or
   removed and the base snapshot did not move. Run the same command again.
   - If a pull or `--accept-mass-delete` stops again at the same path, that
     path is not a regular file the sync collects; move it aside and run
     again. If it stops on a snapshot that is not intact, check the
     snapshot store at `stateDir/snapshots/<destination>/` for free space,
     permissions, another process removing generations, or the clock
     (`packages/agent-memory-sync/src/memory-sync/pull.ts:436-441#"removing generations, or the machine"`).
   - If a destination restore stops, fix the permission or the entry at the
     named path, or the alias it names, then run the restore again
     (`packages/agent-memory-sync/src/commands/restore.ts:494-497#"then run the restore again"`).
6. **Exit 13, stopped part way.** Some files were already written or
   removed; the message lists them and the snapshot generations that hold
   their previous content
   (`packages/agent-memory-sync/src/memory-sync/pull.ts:792#"--from-snapshot <id>)"`).
   The base snapshot did not move, so running the command again applies the
   rest, but every rerun that writes a snapshot rotates older generations
   away. Copy the named generation directory aside, or pause the scheduled
   sync, before retrying
   (`packages/agent-memory-sync/src/errors.ts:193-195#"copy the generation named above aside"`).
   Fix the cause named in the message, then run the command again. To go
   back to the previous content instead, preview and run
   `agent-memory-sync restore <profile> <destination> --from-snapshot <id> --dry-run`,
   then the same command with `--yes`.
7. **Exit 6, queue escalation.** The current snapshot was stored in the
   queue before the error. The hub has been unreachable for longer than
   `queueEscalationThresholdMs`; check `remoteUrl`, `branch` and
   `repositorySubdir`
   (`packages/agent-memory-sync/src/memory-sync/push.ts:624-628#"Check remoteUrl/branch/repositorySubdir."`).
   Once the hub is reachable, the next successful push replays every queued
   snapshot (see [offline-queue-and-lock.md](offline-queue-and-lock.md)).

## Verification

- Run `agent-memory-sync run <profile> --dry-run` with the same profile.
  Without writing anything, a dry run runs the checkout check and the plan
  guards on both sides, and the collectability check on the pull side, so a
  clean dry run shows that the next tick will not stop at those refusals.
- After `restore --from-commit`, the base snapshot for the destination
  matches the current hub tree, so the next push publishes the recovered
  files
  (`packages/agent-memory-sync/src/commands/restore.ts:82-84#"the next push publishes the recovered files as additions"`).
