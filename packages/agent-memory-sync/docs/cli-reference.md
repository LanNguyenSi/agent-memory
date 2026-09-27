# agent-memory-sync CLI reference

Full flag reference for every subcommand. See the [README](../README.md)
for a quick-start example of each. Options are per-subcommand: pass them
after the subcommand name (`agent-memory-sync run --config x`), never
before it.

## `run [profile]`

Execute a sync profile.

```
Options:
  --mode <sync|push|pull>                Action to perform  [default: sync]
  --remote <url>                         Override remote Git repository URL
  --branch <name>                        Override branch  [default: main]
  --repository-subdir <path>             Override remote subdirectory
  --root-dir <path>                      Override workspace root
  --state-dir <path>                     Override local state directory
  --schedule "<cron expression>"         Run on a 5-field cron-compatible schedule
  --max-runs <count>                     Limit scheduled runs
  --conflict-strategy <strategy>         inline-markers, local-wins, remote-wins
  --reachability-timeout-ms <ms>         Timeout for the remote reachability precheck before
                                         pull/push  [default: 4000]
  --allow-mass-delete                    Push a plan the mass-delete guard would refuse (see
                                         massDeleteGuard in the config). It does not override an
                                         unreliable checkout: a working copy that came back
                                         missing files, or present but emptied to zero bytes, is
                                         still refused
  --accept-mass-delete                   Apply a remote change that deletes more of a destination
                                         than the guard allows, and adopt a checkout the run would
                                         otherwise call unreliable, for a working copy missing
                                         files outright. The destination is copied into
                                         stateDir/snapshots first. Use it only once the remote
                                         deletion is known to be genuine, for one run; it cannot
                                         be combined with --allow-mass-delete. It does NOT adopt a
                                         checkout with files present but emptied to zero bytes:
                                         that is refused regardless of this flag
  --dry-run                              Show what would happen without making changes
  --output <text|json|yaml>              Output format  [default: text]
  --verbose                              Enable verbose diagnostics
  --quiet                                Suppress non-error diagnostics
  --no-color                             Disable colored diagnostics
  --help                                 Show this message and exit
```

`--dry-run` honours both mass-delete flags without changing anything: with
`--accept-mass-delete` it reports the paths the real run would adopt (under
`deletedFiles`, with a `would adopt N remote deletion(s)` note) instead of
refusing the checkout, and takes no snapshot, removes no local file and
moves no base snapshot.

## `watch [profile]`

Watch the local workspace and push a snapshot commit per debounce window.

```
Options:
  --debounce-ms <ms>             Aggregate rapid changes within this window
                                 (default 5000, env AGENT_MEMORY_SYNC_WATCH_DEBOUNCE_MS)
  --max-runs <count>             Exit after this many watch ticks complete: pushed or
                                 queued locally when the remote is unreachable
                                 (primarily for tests)
  --allow-mass-delete            Push a plan the mass-delete guard would refuse (see
                                 massDeleteGuard in the config). It does not override
                                 an unreliable checkout: a working copy that came back
                                 missing files, or present but emptied to zero bytes,
                                 is still refused
  --remote <url>                 Override remote Git repository URL
  --branch <name>                Override branch
  --repository-subdir <path>     Override remote subdirectory
  --root-dir <path>              Override workspace root
  --state-dir <path>             Override local state directory
  --output <text|json|yaml>      Output format  [default: text]
  --verbose, --quiet, --no-color
  --help
```

A single edit produces an `update <path>` commit; several edits within the
debounce window land as a single `update N memories` commit with a
bulleted body listing each path. Deletions become `remove <path>`. With
`--verbose`, each tick prints `watch tick pushing snapshot` to stderr the
instant it starts the actual git work, ahead of the tick's own result line.
`SIGINT` / `SIGTERM` flush any pending debounce before exiting. See
[Sync behavior](sync-behavior.md) for what happens when a push fails, and
[Service supervision](service-supervision.md) for running `watch` under
systemd or launchd.

## `restore [OPTIONS]`

Restore memory files from a specific snapshot commit, or a whole sync
destination from a commit or from a local pre-apply snapshot.

```
agent-memory-sync restore <sha> [OPTIONS]
agent-memory-sync restore <profile> <destination> --from-commit <sha> [OPTIONS]
agent-memory-sync restore <profile> <destination> --from-snapshot [<id>|latest] [OPTIONS]

Options:
  --from-commit <sha>            Restore a whole sync destination from this commit
  --from-snapshot [id]           Restore a whole sync destination from a local
                                 pre-apply snapshot  [default: latest]
  --path <relative>              Restore only this remote-relative path
                                 (relative to repositorySubdir)
  --dry-run                      List what would be restored without writing
  --yes                          Confirm a full-snapshot restore, or a whole-destination
                                 restore (--from-commit/--from-snapshot), without prompting
  --remote <url>                 Override remote Git repository URL
  --branch <name>                Override remote branch
  --repository-subdir <path>     Override remote subdirectory
  --root-dir <path>              Override workspace root
  --state-dir <path>             Override local state directory
  --output <text|json|yaml>      Output format  [default: text]
  --verbose, --quiet, --no-color
  --help
```

A full-tree restore requires `--yes` (or `--dry-run` to preview), and so
do both destination-shaped forms; a single file via `--path MEMORY.md`
does not. Files are written byte-identical to their contents at `<sha>`.
`<sha>` may be abbreviated as long as the commit is reachable from the
configured branch; a short sha that is not reachable fails loudly with an
explicit "use the full 40-character sha" message.

```bash
agent-memory-sync restore 7c4d2e1 --path MEMORY.md      # roll back one file
agent-memory-sync restore 7c4d2e1 --yes                 # restore the entire snapshot
agent-memory-sync restore 7c4d2e1 --yes --dry-run        # preview
agent-memory-sync restore default logs --from-commit 7c4d2e1 --yes
agent-memory-sync restore default logs --from-snapshot latest --yes
```

The two destination-shaped forms replace the destination rather than
merging into it: files the source has are written, files it does not are
removed, and the destination's current tree is copied into
`<stateDir>/snapshots` first. `--from-commit` also moves the base
snapshot for that destination to the CURRENT remote tree, so recovered
files publish as additions on the next push instead of being deleted
again. `--from-snapshot` leaves the base snapshot alone and needs no
remote at all.

## `config`

```bash
agent-memory-sync config show              # Print current config
agent-memory-sync config set KEY VALUE     # Set a config value
agent-memory-sync config get KEY           # Get a config value
agent-memory-sync config reset             # Remove persisted config
```

Registers only `--config` (path override); `config show` also registers
`-o, --output <format>` (text, json, yaml).

## `--version`

```bash
agent-memory-sync --version
# 0.1.0
```

## Global options

| Option | Description |
|--------|-------------|
| `--help` | Show help and exit |
| `--version` | Show version and exit |

## Common per-subcommand options

`run`, `watch`, and `restore` each register these; they must come after
the subcommand name.

| Option                  | Description                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--config PATH`         | Path to config file (default: `$XDG_CONFIG_HOME/agent-memory-sync/config.json`, else `~/.config/agent-memory-sync/config.json`). `run`, `watch` and `restore` refuse an explicitly named path (this flag or `AGENT_MEMORY_SYNC_CONFIG`) that does not exist, exit `3`, instead of running on defaults. |
| `-o, --output <format>` | Output format: text, json, yaml (default: text)                                                                                 |
| `-v, --verbose`         | Enable verbose output                                                                                                           |
| `-q, --quiet`           | Suppress non-error output                                                                                                       |
| `--no-color`            | Disable colored output                                                                                                          |
