---
type: invariant
title: Base snapshot lifecycle and per-path advance
description: Every reader and writer of stateDir/base, when each one moves it, the per-path rule a successful push applies, how queued snapshots chain their bases inside one push, and the three filterUnmappedBaseMap call sites that keep unmapped hub paths out of it.
tags: [base-snapshot, merge, pull, push, restore, invariant]
timestamp: 2026-10-11T12:47:47Z
sources:
  - packages/agent-memory-sync/src/memory-sync/state-store.ts
  - packages/agent-memory-sync/src/memory-sync/pull.ts
  - packages/agent-memory-sync/src/memory-sync/push.ts
  - packages/agent-memory-sync/src/memory-sync/config.ts
  - packages/agent-memory-sync/src/memory-sync/accept-remote-deletions.ts
  - packages/agent-memory-sync/src/commands/restore.ts
---

# Base snapshot lifecycle and per-path advance

The base snapshot is this machine's record of the content it last converged
on with the hub, one entry per remote-relative path. Pull and push both
merge `base`, `local` and `remote` per path, so a base entry that is wrong
in either direction turns into a wrong write: a stale base makes a peer's
newer hub version look unchanged, and a base entry with no local copy
behind it makes the next push delete the hub file.

## The invariant

- `stateDir/base` changes only after the local side and the hub agree on
  the paths it records, and never holds a path that no `syncPaths` entry
  maps to a local file. A run that stops before its final write leaves it
  as it was.

## Storage

`StateStore.readBaseSnapshots` reads the tree under `stateDir/base`, and
`replaceBaseSnapshots` removes that directory and writes the new map in its
place
(`packages/agent-memory-sync/src/memory-sync/state-store.ts:81-90#"writeSnapshotTree(this.baseDir(), files);"`).
A deleted entry is stored as a `<path>.meta.json` marker with
`deleted: true` and reads back as `null`. Every writer below replaces the
whole map; there is no partial update.

## Where it's enforced

Readers:

- Pull reads the stored map unfiltered and uses it for the merge and the
  guards
  (`packages/agent-memory-sync/src/memory-sync/pull.ts:105#"stateStore.readBaseSnapshots()"`).
- Push reads it through `filterOwnerScopedBaseMap` and then
  `filterUnmappedBaseMap`
  (`packages/agent-memory-sync/src/memory-sync/push.ts:132#"let currentBaseMap = filterUnmappedBaseMap(config, filterOwnerScopedBaseMap("`),
  and filters each queued snapshot's stored base the same way
  (`packages/agent-memory-sync/src/memory-sync/push.ts:162#"entry.data.baseFiles"`).
  The owner-scoped filter drops every file under an `ownerScoped` directory
  destination except this profile's own `<profile>.json`
  (`packages/agent-memory-sync/src/memory-sync/config.ts:199-202#"key !== path.posix.join(owningDestination, ownerFileName)"`).

Writers, each with its trigger:

- **Pull**, once every planned local write and removal has succeeded,
  replaces the base with the hub tree it fetched, filtered to mapped paths.
  A path whose hub copy carries conflict markers, which pull refused to
  merge, keeps its previous entry or stays absent
  (`packages/agent-memory-sync/src/memory-sync/pull.ts:512-514#"keepPreviousBaseEntries(filterUnmappedBaseMap(config, remoteMap)"`,
  `packages/agent-memory-sync/src/memory-sync/pull.ts:546-560#"return result;"`).
  Every guard and snapshot check of the pull runs before this line, and a
  dry run returns earlier still
  (`packages/agent-memory-sync/src/memory-sync/pull.ts:403-406#"dry-run"`).
- **Push**, after `git push` succeeded, advances the base per path with
  `nextBaseAfterPush`, starting from the stored base read again from disk
  (`packages/agent-memory-sync/src/memory-sync/push.ts:412-427#"finalRemoteFiles"`).
  For each path: local equal to the final hub content takes the hub
  content; absent on both sides drops the entry; anything else keeps the
  previous entry exactly, present or absent
  (`packages/agent-memory-sync/src/memory-sync/push.ts:1208-1216#"result[key] = previousBase[key];"`).
  Push never writes hub content into local files, so it cannot record
  convergence for a path it did not publish: a held-back conflict or a
  hub-only file keeps its old entry, and a peer's newer hub version is not
  mistaken for "remote unchanged" on the next run. This write applies
  `filterUnmappedBaseMap` but not the owner-scoped filter, so the entries
  pull wrote for a peer's owner-scoped files survive a push.
- **`run --accept-mass-delete`** on the push side removes the adopted
  paths from the stored base right after removing their local copies,
  before the merge and the push run
  (`packages/agent-memory-sync/src/memory-sync/accept-remote-deletions.ts:243-247#"replaceBaseSnapshots(storedBase)"`).
  If the push then fails, the adoption stays.
- **`restore --from-commit`** drops every entry under the restored
  destination
  (`packages/agent-memory-sync/src/commands/restore.ts:693-697#"delete stored[key];"`)
  and records the destination's files from the current hub tree, not from
  the restored commit
  (`packages/agent-memory-sync/src/commands/restore.ts:724-727#"stateStore.replaceBaseSnapshots(stored);"`),
  so the next push sees the restored files as local changes against the
  hub and publishes them. `restore --from-snapshot` and the
  `restore <sha>` form do not touch the base
  (`packages/agent-memory-sync/src/commands/restore.ts:558-560#"notes = moveBaseToCurrentRemote("`).

## Chaining across queued snapshots in one push

A push replays queued snapshots before the current one, each as its own
commit in the same working copy (see
[offline-queue-and-lock.md](offline-queue-and-lock.md)). A queued snapshot
merges against the base it was enqueued with. After each queued commit,
`recordBaseAdvance` computes what `nextBaseAfterPush` would make of that
snapshot against the hub tree as the commit left it, filtered to mapped
paths, and stores the difference in a sparse overlay
(`packages/agent-memory-sync/src/memory-sync/push.ts:1168-1170#"const after = filterUnmappedBaseMap("`,
`packages/agent-memory-sync/src/memory-sync/push.ts:362-364#"recordBaseAdvance(config, baseDelta, snapshot"`).
Every later snapshot merges against its own base with that overlay applied;
for the current snapshot, paths adopted by `--accept-mass-delete` are
removed from it again
(`packages/agent-memory-sync/src/memory-sync/push.ts:321-327#"snapshot.baseFiles = isLast ?"`).
The final write applies the same overlay to the stored base before the
per-path rule. Without the overlay, a later snapshot that reverts what a
replayed one just published would read the published content as "local
unchanged against base", and the revert would never be published.

## Unmapped paths: three call sites

`filterUnmappedBaseMap` drops every key that `mapRemotePathToLocalAbsolute`
cannot map to a local file
(`packages/agent-memory-sync/src/memory-sync/config.ts:299-313#"return result;"`).
It runs at pull's base write, at push's base write, and at push's base read
(the three citations above). An unmapped hub path, for example another
machine's directory that this profile does not sync, has no local copy by
construction; a base entry for it would read as `base = content`,
`local = null` in push's merge, and with the hub unchanged that resolves to
a deletion published from this machine.

## Local-only files are never pull deletions

Pull checks, before the merge, for a path that has a local copy, no base
entry and no hub copy, and skips it as protected
(`packages/agent-memory-sync/src/memory-sync/pull.ts:190-194#"protectedFiles.push(remoteRelativePath);"`).
Such a file is a candidate for the next push. Because pull's base write
contains hub paths only, the file still has no base entry after the pull,
and the protection holds on every later pull until a push publishes it.

## What breaks it

- Moving pull's base write ahead of the apply loop: after a part-way
  failure (exit 13) the base would already hold hub content for files that
  were never written, and the next push would treat their old local
  content as local edits and publish it over the hub.
- Removing `filterUnmappedBaseMap` from any one of the three sites: a base
  entry for an unmapped hub path reaches push's merge, as described above.
- Replacing `nextBaseAfterPush` with a whole-tree copy of the hub: a
  hub-only file this machine never pulled gains a base entry with no local
  copy, and the push after that deletes it from the hub.
