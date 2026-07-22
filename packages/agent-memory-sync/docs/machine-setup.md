# Machine setup: Mac mini as source of truth

This document wires together the pieces already documented individually
(README.md's Quick Start / Configuration / systemd unit, and
`docs/launchd/`) into the actual multi-machine layout this repo runs:

- **Mac mini** — single source of truth. Hosts the bare git repository every
  other machine syncs against.
- **MacBook** (and any further machines) — fallbacks. They pull on connect
  and push debounced snapshots via `watch`; if the mini is unreachable, pulls
  and pushes skip/queue cleanly instead of failing loudly (see the
  reachability precheck in `src/memory-sync/reachability.ts`).
- Conflict strategy is `inline-markers` everywhere — concurrent edits that
  aren't a clean append merge land as `<<<<<<< local` / `>>>>>>> remote`
  markers in the file for a human to resolve, rather than silently picking a
  winner.

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

This creates the empty bare repository that `remoteUrl` in every profile
points at (`mini:~/memory-sync/pandora-memory.git`). Nothing else is
required server-side — `agent-memory-sync` pushes plain commits over
ordinary `git push`/`git fetch`/`git ls-remote`; there is no server-side
hook or service to install.

Prerequisite: an SSH host alias named `mini` in `~/.ssh/config` on every
client machine, e.g.:

```
Host mini
    HostName mini.local          # or the mini's LAN IP / Tailscale name
    User lannguyensi
    IdentityFile ~/.ssh/id_ed25519
```

Verify it works (this is exactly the probe the reachability precheck runs
internally, so a manual pass here means `pull`/`push`/`watch` will see the
mini as reachable too):

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

For the continuous debounced-push daemon, use `watch` with a launchd
(macOS) or systemd (Linux) unit instead of a one-off `run`:

- **macOS (MacBook, Mac mini)**: copy
  `docs/launchd/com.agent-memory-sync.watch.plist.template` to
  `~/Library/LaunchAgents/com.agent-memory-sync.watch.<profile>.plist`, fill
  in the `__PLACEHOLDER__`s (absolute paths — no `~`/`$HOME` expansion
  inside a plist), then:

  ```bash
  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.agent-memory-sync.watch.<profile>.plist
  launchctl print gui/$UID/com.agent-memory-sync.watch.<profile>   # status
  tail -f ~/Library/Logs/agent-memory-sync/watch.<profile>.err.log # logs
  launchctl bootout gui/$UID/com.agent-memory-sync.watch.<profile> # stop
  ```

  Full placeholder reference and the KeepAlive/ThrottleInterval rationale
  are in the template's header comment.

- **Linux**: use the systemd unit in README.md (`#systemd-unit`) with
  `Environment=AGENT_MEMORY_SYNC_CONFIG=/absolute/path/to/profiles/<name>.json`
  added alongside its existing `Environment=` lines, and
  `ExecStart=... watch <profile-name> --verbose` (positional profile name,
  same reasoning as above). See (c) below for a full Linux walkthrough.

Whichever mechanism starts `watch`, a fresh machine should also run one
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
5. Install the systemd unit from README.md (`#systemd-unit`), adjusting:
   - `Environment=AGENT_MEMORY_SYNC_CONFIG=/absolute/path/to/profiles/linux.json`
   - `ExecStart=/usr/local/bin/agent-memory-sync watch <profile-name> --verbose`
     (positional profile name — same reasoning as (b) above; the unit's
     example `ExecStart` only shows the bare `watch` form, so add the name)
   Then `systemctl --user daemon-reload && systemctl --user enable --now
   agent-memory-sync-watch.service` (or as a system unit under `/etc/systemd`
   as written, with `User=` set to whichever account should own it).

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
