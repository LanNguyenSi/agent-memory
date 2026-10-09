# Sync behavior, guards, and design rationale

Deep-dive reference for how `run`/`watch`/`push`/`pull` decide what to
write, what they refuse, and why. See the [README](../README.md) for the
command-level summary and [Exit codes](../README.md#exit-codes) for what
each refusal reports on exit.

## Sync behavior

- `sync` runs `pull` first and then `push`.
- Before any pull/push network operation (including replaying a queue), a
  fast reachability precheck runs first: for ssh/scp-style remotes it
  derives an `ssh -o BatchMode=yes -o ConnectTimeout=<n>` probe against the
  remote host; for a local filesystem remote it's a plain existence check;
  other transports (https, git://) have no dedicated probe and are assumed
  reachable. If the remote is unreachable, the command is a clean no-op:
  one clear note in the output, exit code `0`, no hang, and the queue (if
  any) is left untouched. Tune the timeout with `--reachability-timeout-ms`
  / `reachabilityTimeoutMs` (default 4000ms), or fully override the probe
  with `reachabilityCheckCommand` (an argv array; config file /
  `AGENT_MEMORY_SYNC_REACHABILITY_CHECK_COMMAND` only, no CLI flag). The
  env form must be a JSON array of non-empty strings (e.g.
  `["ssh","-o","BatchMode=yes","host","true"]`); a value that fails to
  parse that way prints a visible warning naming the offending value and
  falls back to the default probe. An empty string is treated as unset,
  silently. To disable the probe entirely, set `reachabilityCheckCommand`
  to a command that always exits `0`, e.g. `["true"]`.
- Failed pushes (including ones skipped by the reachability precheck) are
  queued locally in `stateDir/queue` and replayed on the next successful
  push.
- If the OLDEST queued snapshot is older than `queueEscalationThresholdMs`
  (config file / `AGENT_MEMORY_SYNC_QUEUE_ESCALATION_THRESHOLD_MS`, default
  24h), the tick throws instead of returning a clean "queued" result: a
  message on stderr and exit code `6`, so a permanently misconfigured
  remote (wrong `remoteUrl`, a renamed repository path, a host that
  accepts a connection but cannot serve the repository) does not queue
  silently forever. Below the threshold nothing changes: silent, exit `0`,
  every tick. See [Queue escalation](#queue-escalation) below for the
  full rationale. Set `queueEscalationThresholdMs` to `null` (config file,
  or `config set queueEscalationThresholdMs null`) to disable this check
  entirely; a computed age past a 30x-threshold sanity ceiling is also
  never escalated even with a finite threshold configured (more likely a
  clock problem than a genuinely stuck remote), and a diagnostic note is
  emitted on that otherwise-silent "queued" outcome instead.
- Append-only concurrent edits are merged automatically; other conflicts
  default to inline conflict markers in the local file only. A push never
  publishes markers: a path whose local content carries markers, or whose
  merge against the hub could only produce them, is held back (the hub keeps
  its content, the base entry stays, the path is counted in `conflicts=N` and
  named in a note), and it is held back again until the local file is
  resolved. A hub file that itself carries markers is never merged into, on
  either side: `pull` leaves the local file byte-identical and `push` skips
  the path, whatever the strategy says; both report it and keep its base
  entry. A conflict exits `0`. See the README's "What a push publishes, and
  conflicts" for the recovery procedure.
- For an `ownerScoped` directory destination (see
  [docs/machine-setup.md](machine-setup.md) section e), `pull` mirrors
  every file other than this machine's own `<profile>.json` from the
  remote unconditionally instead of 3-way merging it. If the remote copy
  itself carries conflict markers, the mirror still takes it and reports the
  path in `conflictFiles`; later runs name it in a stale-marker note. This is
  the special case of the general markered-remote rule above, which leaves a
  non-peer local file untouched. A
  local file left with stale conflict markers by a run is named once per
  file in that run's `notes`.
- A `pull` result's JSON/YAML carries a `skippedFiles` array listing
  remote paths that run saw changed but did not write locally, because no
  configured `syncPaths` entry maps them back to a local destination. See
  [Unmapped remote paths and base snapshots](#unmapped-remote-paths-and-base-snapshots)
  below for why such a path is also excluded from both machines' base
  snapshot stores.
- `--dry-run` previews the result without changing local files or the
  remote repository.
- A `syncPaths` destination, or a local file name underneath one, that
  contains a literal backslash is refused with exit `3` naming the
  offending path, on every platform except win32 (where a backslash is a
  path separator). This refusal aborts the whole run. The same check
  applies to an operator-typed `restore --path` value and to the
  `repositorySubdir` config value.
- A **hub-side** path with a literal backslash (committed by a foreign
  writer, or synced from a win32 machine) is skipped instead: this
  machine did not create it and cannot rename it, so `pull` does not abort
  the run for it. A note in the result names the hub path; every other
  file in the run still pulls, and the run still exits `0`. `restore
--from-commit` restoring the backslash-named path itself to a local
  destination is still refused outright: every source path is mapped and
  validated before the destination's pre-apply snapshot is taken or any
  file is written, so an unmappable backslash path anywhere in the source
  list aborts the whole destination restore before it touches the
  filesystem.

## Deletion guards

A pull, a push and a watch tick all ask whether the deletions they are
about to make are plausible before making them, and a pull copies what it
is about to change.

- **Thresholds** (`massDeleteGuard`): a plan that deletes more than
  `maxFiles` files (default 20), or more than `maxRatio` of a destination
  (default `0.1`, i.e. 10 percent), is refused. The proportional rule
  needs at least two deletions in one plan before it applies. The
  absolute rule is checked plan-wide, across destinations and including
  paths outside `repositorySubdir` that the commit would carry.
- **Untrustworthy working copies**: a fetched working copy missing that
  much of what the base snapshot tracks, or with that much of it present
  but emptied to zero bytes, is refused before any merge runs (exit `7`),
  on both the pull and the push side. The emptied half has no escape at
  all: a destination present but zeroed is almost always the checkout
  itself coming back zeroed rather than a remote that genuinely emptied
  it, so `--accept-mass-delete` refuses it too. If the hub really did
  empty those files on purpose, the route forward is not that flag:
  re-commit real content at the hub, or raise
  `massDeleteGuard.maxFiles`/`maxRatio` in the config for one run.
- **Pre-apply snapshots**: before a pull deletes or overwrites anything in
  a destination, the destination's current tree is copied to
  `<stateDir>/snapshots/<destination>/<timestamp>/`. The copy this run takes plus the newest
  `snapshotGenerations`-1 earlier ones are kept (default 3 in all). A run with nothing to
  apply writes nothing. `restore --from-snapshot` reads them back.
- **`--allow-mass-delete`** (on `run` and `watch`) applies a PUSH plan the
  thresholds refuse. It does not override an untrustworthy working copy.
- **`--accept-mass-delete`** (on `run` only) applies a REMOTE deletion the
  thresholds refuse, and overrides the untrustworthy-working-copy refusal
  for a working copy MISSING files. The destination is copied into
  `<stateDir>/snapshots` first, then the remote's state is applied
  locally (on the push side, that means removing the local copies the
  remote no longer has), and the base snapshot moves with it, so the next
  run is clean instead of republishing what was just accepted as deleted.
  Before the first local file is removed, the snapshot is read back and must
  hold a stored copy of every file about to be removed; when it does not,
  the run exits `12` with no file removed and the base snapshot unmoved (see
  the [exit-code table](../README.md#exit-codes)), and running it again takes
  a fresh snapshot. It cannot be combined
  with `--allow-mass-delete` (usage error, exit `2`). It is a one-shot
  decision about one observed remote state, which is why `watch` does not
  take it.
- **The state-directory lock**: `run`, `watch` and `restore` take an
  advisory lock on the state directory (`<stateDir>/lock.json`). A run
  that cannot have it exits `8`; a watch tick defers and retries. A lock
  older than `lockStaleMs` (default 1800000ms / 30min), or one whose
  process is gone on this host, is taken over automatically.

## Unmapped remote paths and base snapshots

A remote path with no configured `syncPaths` mapping (the `skippedFiles`
case above) is never recorded into either machine's _base snapshot_
store, the local record of "what the remote last looked like" that `pull`
and `push` both use to detect changes.

This matters because base snapshots feed a 3-way merge: `push` visits
every path in `local files UNION base files`, and a path present only in
`baseFiles` looks exactly like "the local copy of this file was deleted".
Recording an unmapped path there let `push` see that shape and, on the
next run, delete an unrelated peer's file from the remote and report it
under `appliedFiles` as legitimately applied, a data-loss bug: commit a
file directly into the remote's `repositorySubdir` (outside any
configured machine's `push`), `pull` (used to record it into base
snapshots regardless), `push` (used to then delete it from the remote).

A second, narrower variant reached the same outcome through `push` alone:
`push` writes its base snapshot after every successful push from a fresh
read of the remote `repositorySubdir` tree (`collectRemoteFiles` in
`src/memory-sync/push.ts`), unmapped paths included. Left unfiltered, that
write alone re-contaminated the base store on every push, so even a machine
that never calls `pull` could still delete a peer's unmapped file two pushes
later.

That write is per path, not a replacement of the whole store: a path's base
entry advances to the hub content only where the local copy equals it, is
dropped where the path is absent on both sides, and otherwise keeps its
previous entry (or stays absent). A path the local copy does not match
(stale, never pulled, held back as a conflict, or markered on the hub) keeps
its old base, so the next push still sees the true difference instead of
"local unchanged against base" and does not republish a stale copy over a
peer's newer version or delete a hub file this machine never pulled. When
several queued snapshots are replayed in one push, the base chains: after
each replay the next snapshot merges against what that replay published.

The shipped fix excludes unmapped paths from base snapshots entirely,
filtered at three call sites, all permanently load-bearing:

- `pull` (`src/memory-sync/pull.ts`) filters what it writes as the new
  base snapshot after every run.
- `push` (`src/memory-sync/push.ts`) filters what it writes as the new
  base snapshot after every successful push too (on top of the per-path
  advance described above; the owner-scoped filter is deliberately not
  applied to this write, only to push's read side, so a peer's deletion of
  its own `ownerScoped` file still propagates).
- `push` also filters its own base snapshot _read_ (and any already-queued
  snapshot's stored `baseFiles`) before the 3-way merge runs, guarding
  against a store restored from an old backup or otherwise edited outside
  `pull`/`push`'s own code paths.

All three call sites route through the same helper,
`filterUnmappedBaseMap` in `src/memory-sync/config.ts`.

### Removing a syncPaths mapping (config shrink)

Dropping an entry from `syncPaths` entirely makes that path unmapped from
every future run's point of view, exactly like a path this machine never
configured at all. The remote file the dropped mapping used to track is
left in place rather than deleted: `filterUnmappedBaseMap` excludes it
from the shrunk config's own base write, so it simply stops being synced
instead of being actively removed from the remote on the next run.

## Queue escalation

The queue-instead-of-crash handling is deliberately silent for a remote
that is merely _offline_. But a remote that is _correctly_ classified
`RemoteUnavailableError` can still be **permanently** wrong (a bad
`remoteUrl`, a renamed repository path, a host that accepts an SSH/TCP
connection but cannot serve the repository), which without a second
signal looks identical to an offline laptop and would queue cleanly,
exit `0`, forever, never syncing again.

Every enqueue checks the age of the OLDEST currently-queued snapshot
(`stateDir/queue/<id>/manifest.json`'s `createdAt`) against
`queueEscalationThresholdMs` (default 24h). Once the oldest queued
snapshot is older than the threshold, meaning the remote has been
_continuously_ unreachable for that long, the tick throws instead: a
clear message on stderr and exit code `6`. The snapshot itself is never
lost; it stays queued and is replayed automatically once the remote is
reachable again. 24h is sized against this package's own committed
periodic-sync tick interval (900s / 15min, see
[docs/machine-setup.md](machine-setup.md)), about 96 missed ticks.

## Push authentication

`watch` (and `run --mode push`) invoke the system `git` binary;
authentication is whatever `git` itself is configured to use, e.g. an SSH
key, an OS credential helper, or a
`https://x-access-token:$TOKEN@github.com/...` URL. If you mint
short-lived GitHub App installation tokens via a `gh-token.sh`-style
helper, point `remoteUrl` at a wrapper script that refreshes the URL
before each invocation, or wire it through a credential helper.
agent-memory-sync intentionally does not embed token-minting logic.
