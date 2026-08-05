# Machine setup: Mac mini as source of truth

This document wires together the pieces already documented individually
(README.md's Quick Start / Configuration / systemd unit, and
`docs/launchd/`) into the actual multi-machine layout this repo runs:

- **Mac mini** — single source of truth. Hosts the bare git repository every
  other machine syncs against.
- **MacBook** (and any further machines) — fallbacks. They push debounced
  snapshots via `watch` and pull periodically via a scheduled `run --mode
  sync` (see below — **both are required**, not just `watch`).
- **All machines share ONE remote tree, via `repositorySubdir` — not via the
  profile name.** Every committed profile (`profiles/*.json`) sets
  `"repositorySubdir": "pandora"`, identically. This is the only config
  field that determines where in the bare repo a machine's files land (see
  `toRepositoryRelativePath` in `src/memory-sync/config.ts`); the `"profile"`
  field is a completely separate, purely local setting (see (b) below). An
  earlier version of these profiles set `repositorySubdir` to a
  per-machine value (mirroring the profile name) — that made every machine
  write to its own top-level tree in the bare repo and none of them ever
  saw each other's pushes, caught by a live cross-machine E2E test
  (`pull` reporting `applied=0`). The `memory` entry in every profile's
  `syncPaths` — a `source: "."` directory entry with `destination:
  "memory"` — covers the whole `rootDir` (flat `.md` files, no fixed
  subdirectory layout), so it syncs to `pandora/memory/...` in the bare
  repo, including any file added later (profiles carry further,
  independent `syncPaths` entries beyond this one — see (e) and (f)
  below). The directory walk skips hidden files/dot-directories
  (`.DS_Store`, `._*` AppleDouble shadows, `.git`, ...) by design — macOS
  cruft never becomes a synced file or a recurring inline-conflict-marker
  diff between machines — and it never follows symlinks under `rootDir`
  either (silently skipped,
  not descended into; intentional containment). See `isHiddenEntryName` in
  `src/memory-sync/config.ts` / `src/memory-sync/git-client.ts`.
- Conflict strategy is `inline-markers` everywhere — concurrent edits that
  aren't a clean append merge land as `<<<<<<< local` / `>>>>>>> remote`
  markers in the file for a human to resolve, rather than silently picking a
  winner.
- **Reachability precheck coverage.** `watch`'s push now goes through the
  same base-snapshot-aware `performPush` (`src/memory-sync/push.ts`) that
  `run`'s `pull`/`push`/`sync` use, so a `watch` tick gets the same fast
  reachability precheck in `src/memory-sync/reachability.ts` and the same
  offline-queue behavior: an unreachable mini during a tick is queued
  locally (`stateDir/queue`) and replayed on the next successful `watch`
  tick or `run`, with a clean exit `0` — no `git ls-remote` hang. This is a
  deliberate contract change from `watch`'s earlier behavior, where any push
  failure (including a merely unreachable remote) surfaced as a non-zero
  exit and relied on launchd/systemd to restart the process; see the
  README.md `watch` section for the exact new boundary. The
  queue-instead-of-crash handling is narrow, not a general catch-all: only a
  failure `GitClient.lookupRemoteHead` / `GitClient.push` attributes to the
  remote itself (unreachable, rejected, non-fast-forward — see
  `RemoteUnavailableError` in `src/errors.ts`) is queued. Errors raised
  while collecting local sync files, before the remote working copy is even
  prepared (e.g. a required `syncPaths` entry missing), and any other
  git-level failure while that working copy is being prepared or committed
  (a full disk, a corrupted git config, a broken commit hook, ...) still
  exit non-zero.
- **Queue escalation: silent-forever is not the same as offline.** The
  queue-instead-of-crash behavior above is deliberately quiet for a machine
  that is merely offline (closed overnight, on a flight, a weekend without
  connectivity) — but a remote that is `RemoteUnavailableError` for a
  *permanent* reason (a typo'd `remoteUrl`, a renamed bare-repo path on the
  mini, an SSH host that accepts the connection but can no longer serve
  `git-upload-pack`) would otherwise look identical: queued, exit `0`,
  every tick, forever, never actually syncing again. Every enqueue now
  checks the age of the OLDEST currently-queued snapshot
  (`stateDir/queue/<id>/manifest.json`'s `createdAt`, already written on
  every enqueue — no new persisted state) against
  `queueEscalationThresholdMs` (config file /
  `AGENT_MEMORY_SYNC_QUEUE_ESCALATION_THRESHOLD_MS`, default 24h). Below the
  threshold, nothing changes. Once the oldest queued snapshot is older than
  the threshold — meaning the remote has been *continuously* unreachable for
  that long, not merely on this one tick, since a successful push clears the
  whole queue at once — the tick throws instead of returning a clean
  "queued" result: a clear message on stderr and a non-zero exit (`6`), the
  same supervisor-restart surface a non-network failure already uses (see
  the previous bullet). The queued snapshot itself is never lost either way;
  it stays queued and replays automatically once the remote is reachable
  again. The 24h default is sized against this document's own committed
  periodic-sync tick interval — 900s / 15min, see
  `docs/launchd/com.agent-memory-sync.sync.plist.template`'s `StartInterval`
  (macOS) and the systemd `OnUnitActiveSec=15min` timer in (c) below (Linux)
  — 96 missed ticks at that cadence, comfortably past an overnight or
  weekend offline window while still bounding a genuinely broken remote's
  silence to about a day. See README.md's "Queue escalation" section under
  `watch` for the full rationale.
- **`watch` is edge-triggered and does not pull — this is why the periodic
  sync job is required, not optional.** `watch` only commits+pushes when
  *this* machine's local files change; it never reads from the remote. Its
  push reuses the same base-snapshot-aware `performPush`
  (`src/memory-sync/push.ts`) that `run --mode sync/push` uses: a 3-way
  merge (`mergeText` in `src/memory-sync/merge.ts`) over this workspace's
  local files and its own last-known base snapshot, so a remote file this
  machine has never pulled — e.g. a peer's file — is left untouched rather
  than deleted, and a file changed both locally and on the remote is merged
  (or conflict-marked, per `conflictStrategy`) rather than blindly
  overwritten with the local version. What `watch` still does not do is
  pull: if the mini (or another machine) pushes changes while this machine
  was offline or simply not editing anything, those changes only reach this
  machine's local files on the next successful `pull`/`sync` — `watch`'s
  file-watcher has no signal to trigger that, since nothing changed here.
  Without the periodic sync job, a MacBook that reconnects after being
  offline overnight silently sits on stale memory until a human runs
  `run --mode pull` manually. Both `watch` **and** the periodic sync job
  must be running on every fallback machine.

Machine-specific values (paths, SSH alias) are committed as profile files
under `profiles/`: `profiles/macbook.json`, `profiles/mac-mini.json`,
`profiles/linux.json` (the Linux desktop set up via (c) below), and a
template for further machines, `profiles/linux.example.json`. Each profile
file documents its own placeholders and the namespace-divergence gotcha
in its `"//"` field — read the profile you're activating before copying
commands from here.

## a) Bootstrap the bare repo on the mini

Run this once, on the mini itself (or via `ssh mini '...'` from another
machine that already has the `mini` SSH host alias configured):

```bash
ssh mini 'mkdir -p ~/memory-sync && git init --bare --initial-branch=main ~/memory-sync/pandora-memory.git'
```

This creates the empty bare repository every other machine's `remoteUrl`
points at over ssh (`mini:~/memory-sync/pandora-memory.git` in
macbook.json/linux.example.json — see the scp-like syntax note there). The
mini's own profile (mac-mini.json) points `remoteUrl` at the same
repository's plain local filesystem path instead
(`/Users/lannguyensi/memory-sync/pandora-memory.git`), since it runs on the
mini itself and doesn't need to loop back through ssh to reach its own
bare repo — see that profile's `"//"` field for the full reasoning. Nothing
else is required server-side — `agent-memory-sync` pushes plain commits
over ordinary `git push`/`git fetch`/`git ls-remote`; there is no
server-side hook or service to install.

Prerequisite: an SSH host alias named `mini` in `~/.ssh/config` on every
*other* client machine (the mini does not need an alias for itself), e.g.:

```
Host mini
    HostName mini.local          # or the mini's LAN IP / Tailscale name
    User lannguyensi
    IdentityFile ~/.ssh/id_ed25519
```

Verify it works (this is exactly the probe the reachability precheck runs
internally, so a manual pass here means `run`'s `pull`/`push`/`sync` — and
`watch`, which shares the same precheck, see the coverage note above — will
see the mini as reachable too):

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 mini true && echo reachable
```

## b) Activate a profile on a machine

`agent-memory-sync` selects behavior from **the config file passed via
`--config`, plus the `[profile]` positional argument** — there is no
separate "which profile is active" registry. Concretely:

```bash
# One-off sync (pull then push) using the MacBook profile
agent-memory-sync run macbook --config profiles/macbook.json

# Push-only / pull-only
agent-memory-sync run macbook --config profiles/macbook.json --mode push
agent-memory-sync run macbook --config profiles/macbook.json --mode pull
```

Pass **both** `--config <profile file>` and the profile name positionally.
The CLI's `[profile]` argument defaults to `"default"` and always overrides
the `"profile"` field inside the config file when it isn't given explicitly
(see `src/commands/run.ts` — `resolveRunConfig(loaded, { profile, ... })`).
What that override does and does not affect is more subtle than it looks —
see the next paragraph before assuming it controls where state files land.

**What the profile name actually controls — and what it does not.** The
`"profile"` field / `[profile]` argument (`macbook`, `mac-mini`, ...) is, in
general, only a fallback: `resolveRunConfig()` derives a default `stateDir`
of `.agent-memory-sync/<profile>` (relative to `rootDir`) *when `stateDir`
is not set explicitly*. Every committed profile under `profiles/` sets
`stateDir` explicitly (a machine-specific absolute path outside `rootDir`;
see any profile's `"//"` field for why), so `"profile"` currently has **no
effect on any file path at all** for these profiles — it only ends up
recorded as a cosmetic label inside that machine's own `state.json`
(`StateStore.loadState()`'s default `profile` field) and echoed in a run's
JSON/text output. Passing it on the command line anyway (see the CLI
snippets below) keeps invocations self-documenting and that label correct;
it is not load-bearing for path resolution here. Either way it has **no
effect on the remote** and is safe to differ, or even coincide, across
machines. The field that must be identical everywhere for machines to
actually see each other's changes is `repositorySubdir` — see the shared
remote tree bullet at the top of this document. Committing a profile with
a machine-specific `repositorySubdir` (as an earlier version of these
profiles did, by analogy with the machine-specific profile name) silently
partitions the bare repo into disjoint per-machine trees instead of sharing
one — there is no error, no warning, `push` reports `status: "applied"`
normally on each machine, and only a subsequent `pull` on another machine
reveals the problem (`applied: []`/`appliedFiles.length === 0`).

For the continuous fallback setup, **two** jobs are required on every
fallback machine — `watch` (push on local edit) **and** a periodic
`run --mode sync` (pull, so changes made elsewhere actually arrive here).
See the "edge-triggered" note above for why skipping the second one leaves
a real gap, not a nice-to-have:

- **macOS (MacBook, Mac mini)**: copy both
  `docs/launchd/com.agent-memory-sync.watch.plist.template` and
  `docs/launchd/com.agent-memory-sync.sync.plist.template` to
  `~/Library/LaunchAgents/com.agent-memory-sync.{watch,sync}.<profile>.plist`,
  fill in the `__PLACEHOLDER__`s in both (absolute paths — no `~`/`$HOME`
  expansion inside a plist), then load both:

  ```bash
  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.agent-memory-sync.watch.<profile>.plist
  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.agent-memory-sync.sync.<profile>.plist

  launchctl print gui/$UID/com.agent-memory-sync.watch.<profile>   # status
  launchctl print gui/$UID/com.agent-memory-sync.sync.<profile>    # status
  tail -f ~/Library/Logs/agent-memory-sync/watch.<profile>.err.log # logs
  tail -f ~/Library/Logs/agent-memory-sync/sync.<profile>.err.log  # logs

  launchctl bootout gui/$UID/com.agent-memory-sync.watch.<profile> # stop
  launchctl bootout gui/$UID/com.agent-memory-sync.sync.<profile>  # stop
  ```

  Full placeholder reference, the KeepAlive/ThrottleInterval rationale (for
  `watch`), and the StartInterval rationale (for the sync companion) are in
  each template's own header comment.

- **Linux**: use the systemd `watch` unit in README.md (`#systemd-unit`)
  with `Environment=AGENT_MEMORY_SYNC_CONFIG=/absolute/path/to/profiles/<name>.json`
  added alongside its existing `Environment=` lines, and
  `ExecStart=... watch <profile-name> --verbose` (positional profile name,
  same reasoning as above) — **plus** a systemd timer + oneshot service
  pair for the periodic sync companion, systemd's equivalent of launchd's
  StartInterval. See (c) below for the full Linux walkthrough including
  both units.

Whichever mechanism starts these, a fresh machine should also run one
`agent-memory-sync run <profile> --config <profile file> --mode pull` before
first use, so it starts from the mini's current state rather than pushing an
empty/stale local workspace as if it were authoritative.

## c) Setting up a third (Linux) machine

1. Build the CLI on the new machine (README.md → Installation): `npm install
   && npm run build` in `packages/agent-memory-sync`.
2. Add the `mini` SSH host alias to `~/.ssh/config` (same as in (a) above)
   and verify with the `ssh -o BatchMode=yes ...` probe.
3. Copy `profiles/linux.example.json` to e.g. `profiles/linux.json`
   (or any name — it only needs to be unique and match the systemd unit
   below) and fill in its placeholders. In particular, run
   `ls ~/.claude/projects/` on the new machine to read off its actual
   Claude Code slug for `rootDir` — do not guess it from the other
   profiles' slugs, since it encodes this machine's own OS username and
   checkout path (see the namespace-divergence note inside any existing
   profile file). The template's `syncPaths` already includes the
   `machine-state` entry (see (e) below) alongside `memory` and
   `frictions`; fill in its `<linux-username>` placeholder like the rest
   of the file rather than adding the entry by hand.
4. First pull so the machine starts from the mini's current state:
   ```bash
   agent-memory-sync run <profile-name> --config profiles/linux.json --mode pull
   ```
5. Install the `watch` systemd unit from README.md (`#systemd-unit`),
   adjusting:
   - `Environment=AGENT_MEMORY_SYNC_CONFIG=/absolute/path/to/profiles/linux.json`
   - `ExecStart=/usr/local/bin/agent-memory-sync watch <profile-name> --verbose`
     (positional profile name — same reasoning as (b) above; the unit's
     example `ExecStart` only shows the bare `watch` form, so add the name)
   Then `systemctl --user daemon-reload && systemctl --user enable --now
   agent-memory-sync-watch.service` (or as a system unit under `/etc/systemd`
   as written, with `User=` set to whichever account should own it).

6. **Required, not optional** (see the "edge-triggered" note in (b) above):
   install a periodic sync timer alongside `watch` — `watch` only pushes on
   local edits and never pulls, so without this a Linux fallback machine
   would silently sit on stale memory after being offline. This is
   systemd's equivalent of the macOS launchd `sync` template's
   `StartInterval`: a `.timer` unit firing a `oneshot` `.service`, rather
   than a second persistent daemon process.

   ```ini
   # /etc/systemd/system/agent-memory-sync-sync.service
   [Unit]
   Description=agent-memory-sync periodic sync (pull + push)
   After=network-online.target

   [Service]
   Type=oneshot
   User=lan
   Environment=AGENT_MEMORY_SYNC_CONFIG=/absolute/path/to/profiles/linux.json
   ExecStart=/usr/local/bin/agent-memory-sync run <profile-name> --mode sync
   ```

   ```ini
   # /etc/systemd/system/agent-memory-sync-sync.timer
   [Unit]
   Description=Run agent-memory-sync sync periodically

   [Timer]
   OnBootSec=2min
   OnUnitActiveSec=15min
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

   `Persistent=true` catches up a missed tick (e.g. the machine was off)
   shortly after boot instead of waiting a full interval. A tick that fires
   while the mini is unreachable is a fast, clean no-op — same reachability
   precheck `run` always uses — so a short 15-minute interval is safe; it
   will not pile up overlapping ssh attempts or spam logs. Install with:
   `systemctl daemon-reload && systemctl enable --now agent-memory-sync-sync.timer`.

## d) Restore / rollback

Every `watch` snapshot and every `run --mode push`/`sync` push is an
ordinary commit on the bare repo, so rolling back a bad edit on any machine
is `agent-memory-sync restore`:

```bash
# Find a commit to roll back to (from any machine, or `ssh mini` + `git log`
# directly against the bare repo). An abbreviated sha works too as long as
# the commit is reachable from the configured branch: `restore` resolves it
# locally against the branch history its working copy already fetched, no
# extra network round-trip needed. It only falls back to an explicit
# `git fetch origin <sha>` (which only ever accepts a *full* object id from
# a remote) for a sha that history does not already contain — and if that
# still fails, the error says explicitly to use the full 40-char sha instead
# of guessing why a short one did not resolve.
agent-memory-sync restore <sha> --config profiles/<name>.json --dry-run

# Roll back a single file — --path is relative to repositorySubdir. Only
# the memory tree's syncPaths destination is "memory" (see the shared
# remote tree bullet at the top of this document); the other payloads
# (machine-state, frictions) use their own destinations instead — see
# (e)/(f) below. So a memory file's path is memory/<file>, not just the
# bare filename:
agent-memory-sync restore <sha> --config profiles/<name>.json --path memory/MEMORY.md

# Roll back the entire synced tree (requires --yes)
agent-memory-sync restore <sha> --config profiles/<name>.json --yes
```

`restore` writes files byte-identical to their contents at `<sha>` and
refuses to touch anything outside the profile's configured `syncPaths` —
see README.md's `restore` section for the full option reference. `restore`
is a one-shot, on-demand command; it does not go through the reachability
precheck the way `pull`/`push`/`sync` do; an unreachable remote during
`restore` fails loudly rather than skipping, since a restore you asked for
that silently did nothing would be worse than a clear error.

Inspecting the bare repo directly (e.g. `ssh mini`, `cd
~/memory-sync/pandora-memory.git`, `git log`/`git show`) shows every
machine's files under the same `pandora/memory/` tree — `git show
<sha>:pandora/memory/MEMORY.md`, for example. Seeing two or more different
top-level directories there (e.g. both `pandora/` and something else) is a
sign `repositorySubdir` has diverged again — see the shared remote tree
bullet at the top of this document.

## e) machine-state payload (toolchain snapshots)

Every committed machine profile (`profiles/mac-mini.json`,
`profiles/macbook.json`, `profiles/linux.json`), and the template,
`profiles/linux.example.json`, carries a **second, independent**
`syncPaths` entry alongside the `memory` one described at the top of this
document:

```json
{ "source": "/Users/<user>/.harness/machine-state", "destination": "machine-state", "kind": "directory", "ownerScoped": true }
```

Unlike the `memory` entry, `source` here is an **absolute path outside
`rootDir`** — `~/.harness/machine-state`, not anywhere under the Claude Code
memory directory — pointing at a per-machine toolchain-snapshot directory
maintained by the (shipped) harness companion `session-start
toolchain-parity`. `resolveWorkspacePath` in `src/memory-sync/config.ts`
treats an absolute `source` as-is instead of resolving it against `rootDir`,
so this entry syncs on its own schedule independent of the memory tree; both
entries still land under the same shared `pandora/` remote tree
(`repositorySubdir`), just under different top-level destinations
(`pandora/memory/...` vs. `pandora/machine-state/...`). In
`profiles/linux.example.json` the entry's `source` uses the same
`<linux-username>` placeholder as `rootDir`/`stateDir` (see (c) above);
copying the template and filling in that one placeholder is all a new
machine needs to do here, rather than adding this entry from scratch.

**Payload convention — one file per machine, owner-writes-only.** Each
machine writes exactly one JSON file under its own `machine-state/`,
named after its own profile (`machine-state/mac-mini.json`,
`machine-state/macbook.json`, ...). This is enforced, not just documented:
the syncPaths entry above sets `"ownerScoped": true`, which is the
mechanism that makes push only ever offer this machine's own
`<profile>.json`, never a peer's file this machine merely pulled (see
`collectLocalSyncFiles`'s `ownerFilter` option in
`src/memory-sync/config.ts`). A machine never writes to another
machine's file — this makes *content* conflicts on this path structurally
impossible (`inline-markers` conflict resolution is never invoked here in
practice, unlike the `memory` tree where concurrent edits are expected).
Only `<profile>.json` belongs in `~/.harness/machine-state`, and never any
secret: the whole directory is synced into a shared, committed remote, so
every file dropped there ends up in git history on every peer. The consumer
is the harness companion `session-start toolchain-parity`, which reads every
machine's file under `machine-state/` to compare toolchain versions across
machines at session start.

**Propagation to this machine's local `machine-state/` still runs through
the periodic `run --mode sync` job, not `watch` — `watch`'s push no longer
deletes peers' snapshot files, but it still never pulls them in.** Same
"edge-triggered" mechanics as the `memory` tree (see the note near the top
of this document): `watch`'s push reuses the base-snapshot-aware
`performPush`, which merges over this workspace's local files and its own
last-known base snapshot, so a peer's `machine-state/<peer>.json` — never
written locally, owner-writes-only — is simply outside that merge and stays
untouched on the remote. What a `watch` tick does NOT do is fetch that
peer's file down into this machine's own `machine-state/` directory; only a
`pull`/`sync` does. A consumer reading `machine-state/` locally is therefore
reading whatever the last successful `pull`/`sync` fetched, not necessarily
each peer's very latest write — keeping the periodic
`run --mode sync` job's interval short is what keeps that staleness window
small. One more edge: `watch` only detects the *first-ever* local write into
`machine-state/` if the parent directory (`~/.harness`) already existed when
`watch` started; on a truly fresh machine the first snapshot travels only
via the periodic sync or after a `watch` restart.

**The local `~/.harness/machine-state` directory does not need to pre-exist.**
`collectLocalSyncFiles` (`src/memory-sync/config.ts`) skips a non-required
`syncPaths` entry whose `source` does not exist locally yet instead of
failing `push`/`pull`/`watch` — so a fresh machine that has not written a
snapshot yet simply syncs nothing for this entry until it does. Conversely,
`pull`'s writer creates the directory on demand
(`mkdirSync(path.dirname(...), { recursive: true })` in
`src/memory-sync/pull.ts`, i.e. `mkdir -p` semantics) the first time a
peer's snapshot is pulled down, so no manual `mkdir` step is required during
machine setup either — though the harness companion consuming these files
may still create the directory itself on first run if it expects it to
exist ahead of any sync.

## f) frictions payload (friction-log exports)

Every committed profile (`profiles/mac-mini.json`, `profiles/macbook.json`,
`profiles/linux.json`, `profiles/linux.example.json`) also carries an
**independent** `syncPaths` entry pointing at `~/.harness/frictions` — the
third entry in every one of them, after `memory` and `machine-state` (see
(e) above; the template carries a placeholder `machine-state` entry too, so
its `syncPaths` array has the same three-entry shape as the real profiles):

```json
{ "source": "/Users/<user>/.harness/frictions", "destination": "frictions", "kind": "directory", "ownerScoped": true }
```

Same convention as the machine-state payload in section e) above: one file
per machine, named after its own profile (`frictions/mac-mini.json`,
`frictions/macbook.json`, ...), owner-writes-only, and never any secret —
the directory is synced into the shared, committed remote, so anything
dropped there ends up in every peer's git history.

**Producer convention.** Each machine configures `friction-log`'s
`sync_export.path` setting to `~/.harness/frictions/<its own profile>.json`
(e.g. `~/.harness/frictions/mac-mini.json`) — `friction-log` writes exactly
that configured path and never derives a filename of its own, so the
owner-writes-only convention above is carried entirely by that per-machine
config, not by anything in this package. The file is also kept current via
write-through from `friction-log`'s six mutating commands, not only by the
dedicated `sync-export` verb, so `frictions/<profile>.json` can reflect a
mutation made through any of those commands, not just an explicit export
step. This producer (`friction-log`, config-gated) is shipped in
`agent-dx`, not in this repo; this `syncPaths` entry only carries the
resulting file, it does not generate it.

The same missing-source tolerance and `mkdir -p`-on-pull behavior described
above for `machine-state` apply here unchanged, since both are plain
non-required, absolute-source, directory-kind `syncPaths` entries handled
by the same code path. The same `watch` caveats from section e) apply too:
`watch` only pushes and never pulls, so a peer's `frictions/<peer>.json`
only shows up locally after the next `pull`/`sync`; and `watch` only
detects this machine's own very first local write into `frictions/` if
`~/.harness` already existed when `watch` started — on a truly fresh
machine the first export travels via the periodic sync job or after a
`watch` restart instead.

**Exposure note.** Friction-log records are free text. Like every other
payload in this document, anything written into
`~/.harness/frictions/<profile>.json` is synced into the shared, committed
remote and therefore counts as published into every peer's git history —
redact anything sensitive before logging it, not after.
