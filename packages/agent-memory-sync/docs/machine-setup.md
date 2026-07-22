# Machine setup: Mac mini as source of truth

This document wires together the pieces already documented individually
(README.md's Quick Start / Configuration / systemd unit, and
`docs/launchd/`) into the actual multi-machine layout this repo runs:

- **Mac mini** — single source of truth. Hosts the bare git repository every
  other machine syncs against.
- **MacBook** (and any further machines) — fallbacks. They push debounced
  snapshots via `watch` and pull periodically via a scheduled `run --mode
  sync` (see below — **both are required**, not just `watch`).
- Conflict strategy is `inline-markers` everywhere — concurrent edits that
  aren't a clean append merge land as `<<<<<<< local` / `>>>>>>> remote`
  markers in the file for a human to resolve, rather than silently picking a
  winner.
- **Reachability precheck coverage — read this before assuming `watch` is
  covered too.** Only `run`'s `pull`/`push`/`sync` (and its queue replay) go
  through the fast reachability precheck in
  `src/memory-sync/reachability.ts`: an unreachable mini is a clean no-op —
  one note, exit `0`, no `git ls-remote` hang, queue left untouched. `watch`
  does **not** use this precheck at all. A network failure during `watch`
  (unreachable mini or an auth/push failure) always surfaces as the
  documented non-zero exit ("by design", README.md `#systemd-unit`), and
  launchd/systemd restarts it per the KeepAlive/Restart config below. This
  is intentional — see the README.md note right after the systemd unit for
  why `watch`'s fail-loud contract was left as-is — but it means `watch`
  alone gives you neither offline queueing nor a "did the last edit actually
  reach the mini" recovery path; that's what the periodic `run --mode sync`
  job in (b)/(c) below is for.
- **`watch` is edge-triggered and does not pull — this is why the periodic
  sync job is required, not optional.** `watch` only commits+pushes when
  *this* machine's local files change; it never reads from the remote. If
  the mini (or another machine) pushes changes while this machine was
  offline or simply not editing anything, those changes only reach this
  machine's local files on the next successful `pull`/`sync` — `watch`'s
  file-watcher has no signal to trigger that, since nothing changed here.
  Without the periodic sync job, a MacBook that reconnects after being
  offline overnight silently sits on stale memory until either a human runs
  `run --mode pull` manually, or a fresh unrelated local edit through `watch`
  happens to succeed and paper over it. Both `watch` **and** the periodic
  sync job must be running on every fallback machine.

Machine-specific values (paths, SSH alias) are committed as profile files
under `profiles/`: `profiles/macbook.json`, `profiles/mac-mini.json`, and a
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
internally, so a manual pass here means `run`'s `pull`/`push`/`sync` will see
the mini as reachable too — `watch` does not run this precheck at all, see
the coverage note above):

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
(see `src/commands/run.ts` — `resolveRunConfig(loaded, { profile, ... })`),
so state files (`queue/`, `base/`, `tmp/`) only land under the profile's own
subdirectory when you pass the name on the command line too. Omitting it
silently falls back to the `default` profile's state directory — the sync
still runs against the right `rootDir`/`remoteUrl` from the config file, but
its queue/base-snapshot bookkeeping would be shared with whatever else uses
that machine's `default` profile, which is almost never what you want.

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
   profile file).
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
# directly against the bare repo)
agent-memory-sync restore <sha> --config profiles/<name>.json --dry-run

# Roll back a single file
agent-memory-sync restore <sha> --config profiles/<name>.json --path MEMORY.md

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
