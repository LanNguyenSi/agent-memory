# agent-memory-sync

A CLI tool that syncs agent memory files across multiple OpenClaw instances via a central Git repository. It supports push, pull, full sync, inline conflict handling, offline queueing, cron-compatible scheduling, and dry-run previews.

> **Internal tool: not published to npm.** This CLI is used from source within this repo and is intentionally not a published package (`private: true`); this repo publishes only `@lannguyensi/memory-router`. Build and run it from the monorepo rather than installing from npm.

## Overview

`agent-memory-sync` is a command-line tool built with **typescript** and **commander**.
It runs on Node.js 20 or newer.

## Installation

Build from source. `agent-memory-sync` is part of the [`agent-memory`](https://github.com/LanNguyenSi/agent-memory) monorepo.

```bash
git clone https://github.com/LanNguyenSi/agent-memory
cd agent-memory/packages/agent-memory-sync
npm install
npm run build
```

This produces `dist/src/main.js`. Run it with `node dist/src/main.js`, or put `agent-memory-sync` on your `PATH` with `npm link`.

## Quick Start

```bash
# Show help
agent-memory-sync --help

# Show version
agent-memory-sync --version

# Run a full sync with the default profile
agent-memory-sync run

# Push only
agent-memory-sync run --mode push

# Pull only
agent-memory-sync run --mode pull

# Preview changes without writing locally or remotely
agent-memory-sync run --dry-run

# Get help for a subcommand
agent-memory-sync run --help
```

## Usage

### Global Options

| Option | Description |
|--------|-------------|
| `--help` | Show help and exit |
| `--version` | Show version and exit |

### Common per-subcommand options

`run`, `watch`, and `restore` register these options; they are not on the program itself, so they must come after the subcommand (for example `agent-memory-sync run --config x`, not `agent-memory-sync --config x run`). `config`'s subcommands only register `--config` (and `config show` also registers `-o, --output`):

| Option                  | Description                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--config PATH`         | Path to config file (default: `$XDG_CONFIG_HOME/agent-memory-sync/config.json`, else `~/.config/agent-memory-sync/config.json`) |
| `-o, --output <format>` | Output format: text, json, yaml (default: text)                                                                                 |
| `-v, --verbose`         | Enable verbose output                                                                                                           |
| `-q, --quiet`           | Suppress non-error output                                                                                                       |
| `--no-color`            | Disable colored output                                                                                                          |

### Commands

#### `agent-memory-sync run [profile]`

Execute a sync profile.

```bash
agent-memory-sync run [profile] [OPTIONS]

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
  --dry-run                              Show what would happen without making changes
  --output <text|json|yaml>              Output format  [default: text]
  --verbose                              Enable verbose diagnostics
  --quiet                                Suppress non-error diagnostics
  --no-color                             Disable colored diagnostics
  --help                                 Show this message and exit
```

#### `agent-memory-sync watch [profile]`

Watch the local workspace and push a snapshot commit per debounce window. Built for backup workflows where every memory edit should land as its own commit in the remote repository, rather than being grouped by a cron tick.

```bash
agent-memory-sync watch [profile] [OPTIONS]

Options:
  --debounce-ms <ms>             Aggregate rapid changes within this window
                                 (default 5000, env AGENT_MEMORY_SYNC_WATCH_DEBOUNCE_MS)
  --max-runs <count>             Exit after this many watch ticks complete — pushed or
                                 queued locally when the remote is unreachable
                                 (primarily for tests)
  --remote <url>                 Override remote Git repository URL
  --branch <name>                Override branch
  --repository-subdir <path>     Override remote subdirectory
  --root-dir <path>              Override workspace root
  --state-dir <path>             Override local state directory
  --output <text|json|yaml>      Output format  [default: text]
  --verbose, --quiet, --no-color
  --help
```

A single edit produces a `update <path>` commit; several edits within the debounce window land as a single `update N memories` commit with a bulleted body listing each path. Deletions become `remove <path>`. A push that fails because the remote is unreachable or rejects it (auth, non-fast-forward, network) is queued locally instead — see [Sync behavior](#sync-behavior) and the note below; a genuine config/data error (e.g. a required `syncPaths` entry missing) still surfaces on stderr with a non-zero exit, and the process never silently swallows *that* class of error. `SIGINT` / `SIGTERM` flush any pending debounce before exiting.

With `--verbose`, each tick prints `watch tick pushing snapshot` to stderr the instant it starts the actual git work (fetch, merge, commit, push), ahead of the tick's own result line (`pushed snapshot ...`, `watch tick queued locally ...`, or `watch tick produced no remote changes`). This is a mid-tick progress signal, not just a start/end pair: an external supervisor (or a test harness, see `tests/helpers/watch-process.ts`'s `withTickDeadline`) can treat it as proof the process is still alive and working, distinct from a genuinely wedged child that stops writing anything at all.

##### systemd unit

```ini
# /etc/systemd/system/agent-memory-sync-watch.service
[Unit]
Description=agent-memory-sync watch (continuous memory backup)
After=network-online.target

[Service]
Type=simple
User=lan
Environment=AGENT_MEMORY_SYNC_REMOTE_URL=git@github.com:you/memory-backup.git
Environment=AGENT_MEMORY_SYNC_ROOT_DIR=/home/lan/.claude/projects/-home-lan-git-pandora/memory
Environment=AGENT_MEMORY_SYNC_BRANCH=main
ExecStart=/usr/local/bin/agent-memory-sync watch --verbose
Restart=on-failure
RestartSec=5s
StartLimitIntervalSec=1800
StartLimitBurst=30

[Install]
WantedBy=multi-user.target
```

The `StartLimitIntervalSec` / `StartLimitBurst` pair caps systemd's restart loop for the failures that still exit non-zero — a config/data error raised before the remote working copy is prepared (e.g. a required `syncPaths` entry missing), or any other git-level failure while preparing/committing that working copy (a full disk, a corrupted git config, a broken commit hook, ...) — so a persistently broken cause does not crashloop forever; a remote that is merely unreachable or rejecting the push (see below) no longer exits at all, so it never spends this budget. The one exception is [queue escalation](#queue-escalation-a-permanently-broken-remote-does-not-queue-forever): once the queue has been failing to drain past `queueEscalationThresholdMs` (default 24h), a tick DOES exit non-zero again — but only on a real local edit (`watch` is edge-triggered), so it does not spend this budget any faster than this machine's memory actually changes while the remote stays broken. Inspect `journalctl -u agent-memory-sync-watch.service` for the `snapshot push failed: ...` line `watch` writes to stderr before exiting on one of those failures.

Honest arithmetic, measured: one crash-restart cycle (a failed start plus `RestartSec`) is ~11s. Under the original `StartLimitBurst=10` / `StartLimitIntervalSec=300` pairing shown in earlier revisions of this doc, 10 crashes exhausted the budget in ~110s — well inside a single ordinary "edit the config, restart, still broken, edit again" debugging session. Once the burst is exhausted, systemd does not just pause the restart loop, it marks the unit `failed` and **stops trying entirely**, even after the underlying cause is fixed, until the failure counter is explicitly cleared:

```bash
systemctl reset-failed agent-memory-sync-watch.service
systemctl restart agent-memory-sync-watch.service   # reset-failed only clears the counter, it does not start the unit
```

The sample unit above raises the pairing to `StartLimitIntervalSec=1800` / `StartLimitBurst=30` (~30 crashes × ~11s ≈ 330s, under 6 minutes of continuous crash-looping) so ordinary iterative config editing has realistic headroom before landing in `failed`, while a genuinely broken cause still gets capped well short of looping forever. macOS's `ThrottleInterval` (see `docs/launchd/com.agent-memory-sync.watch.plist.template`) is not a direct analogue: it only enforces a minimum gap between respawns and has no burst counter or give-up state at all, so a broken `watch` LaunchAgent keeps retrying indefinitely instead of ever reaching a terminal `failed` state that needs a manual reset.

macOS equivalent (LaunchAgent instead of systemd): see
[`docs/launchd/com.agent-memory-sync.watch.plist.template`](docs/launchd/com.agent-memory-sync.watch.plist.template)
and [docs/machine-setup.md](docs/machine-setup.md).

`watch`'s push goes through the same base-snapshot-aware `performPush` that
`run`'s `pull`/`push`/`sync` use (`src/memory-sync/push.ts`), so it gets the
same reachability precheck under [Sync behavior](#sync-behavior) and the
same offline-queue behavior: an unreachable remote, or a push that the
remote rejects (auth, non-fast-forward, network), is queued locally
(`stateDir/queue`) and replayed on the next successful `watch` tick or
`run`, with a clean exit `0`. This is a deliberate contract change from an
earlier version of `watch`, where any push failure exited non-zero and
relied on launchd/systemd to restart the process. The queue-instead-of-crash
handling is narrow, not a general catch-all: only a failure that
`GitClient.lookupRemoteHead` / `GitClient.push` attributes to the remote
itself (unreachable, rejected, non-fast-forward — see `RemoteUnavailableError`
in `src/errors.ts`) is queued. Every other failure still exits non-zero and
reaches the supervisor-restart path described above — a config/data error
raised before the remote working copy is even prepared (e.g. a required
`syncPaths` entry missing), and any other git-level failure while that
working copy is being prepared or committed (a full disk, a corrupted git
config, a broken commit hook, ...).

`watch` still never pulls — it is edge-triggered on local changes only, so a
machine that was offline while changes landed elsewhere will not pick them
up until its own next local edit, even though its own push is now safe to
run against a stale local view (see [docs/machine-setup.md](docs/machine-setup.md)
for what that safety does and does not cover). For that reason, a periodic
`run --mode sync` running alongside `watch` is a **required** part of any
fallback-machine setup, not an optional extra — see
[docs/machine-setup.md](docs/machine-setup.md) for the launchd/systemd
companion jobs.

##### Queue escalation: a permanently broken remote does not queue forever

The queue-instead-of-crash handling above is deliberately silent for a
remote that is merely *offline* — a laptop closed overnight, on a flight, or
disconnected for a weekend. But a remote that is *correctly* classified
`RemoteUnavailableError` can still be **permanently** wrong (a bad
`remoteUrl`, a renamed repository path, a host that accepts an SSH/TCP
connection but cannot serve the repository) — without a second signal, that
looks identical to a laptop on a plane and would queue cleanly, exit `0`,
forever, never syncing again.

Every enqueue therefore checks the age of the OLDEST currently-queued
snapshot (`stateDir/queue/<id>/manifest.json`'s `createdAt`, already written
on every enqueue — no new state) against `queueEscalationThresholdMs`
(config file / `AGENT_MEMORY_SYNC_QUEUE_ESCALATION_THRESHOLD_MS`, default
24h). Below the threshold, behavior is unchanged: silent, exit `0`, every
tick. Once the oldest queued snapshot is older than the threshold — meaning
the remote has been *continuously* unreachable for that long, not just on
this one tick, since a successful push clears the whole queue at once — the
tick throws instead: a clear message on stderr and a non-zero exit (`6`),
the same supervisor-restart surface a non-network failure already uses. The
snapshot itself is never lost; it stays queued and is replayed automatically
once the remote is reachable again. 24h is sized against this package's own
committed periodic-sync tick interval (900s / 15min — see
[docs/machine-setup.md](docs/machine-setup.md) and the launchd/systemd
templates) — 96 missed ticks, comfortably longer than an overnight or
weekend offline window, still bounding how long a genuinely broken remote
can hide to about a day.

##### Push authentication

`watch` (and `run --mode push`) invoke the system `git` binary; authentication is whatever `git` itself is configured to use, e.g. an SSH key, an OS credential helper, or a `https://x-access-token:$TOKEN@github.com/...` URL.

If you mint short-lived GitHub App installation tokens via a `gh-token.sh`-style helper, point `remoteUrl` at a wrapper script that refreshes the URL before each invocation, or wire it through a credential helper. agent-memory-sync intentionally does not embed token-minting logic.

#### `agent-memory-sync restore <sha> [OPTIONS]`

Restore memory files from a specific snapshot commit. Useful for rolling back a bad edit when paired with `watch` or scheduled `run --mode push`.

```bash
agent-memory-sync restore <sha> [OPTIONS]

Options:
  --path <relative>              Restore only this remote-relative path
                                 (relative to repositorySubdir)
  --dry-run                      List what would be restored without writing
  --yes                          Confirm a full-snapshot restore without prompting
  --remote <url>                 Override remote Git repository URL
  --branch <name>                Override branch
  --repository-subdir <path>     Override remote subdirectory
  --root-dir <path>              Override workspace root
  --state-dir <path>             Override local state directory
  --output <text|json|yaml>      Output format  [default: text]
  --verbose, --quiet, --no-color
  --help
```

A full-tree restore requires `--yes` (or `--dry-run` to preview); a single file via `--path MEMORY.md` does not. Files are written byte-identical to their contents at `<sha>`. The command refuses to map a remote path that does not match an entry in `syncPaths`, so a restore cannot scatter files outside the configured workspace. An unknown SHA or a path that did not exist at that commit fails loudly. `<sha>` may be abbreviated as long as the commit is reachable from the configured branch — it resolves locally against the branch history the command already fetches, no extra network round-trip; a short sha that is not reachable that way fails loudly with an explicit "use the full 40-character sha" message, since a plain `git fetch <remote> <ref>` only ever accepts a full object id from a remote.

```bash
# Roll back MEMORY.md to a specific commit
agent-memory-sync restore 7c4d2e1 --path MEMORY.md

# Restore the entire snapshot
agent-memory-sync restore 7c4d2e1 --yes

# Preview a restore
agent-memory-sync restore 7c4d2e1 --yes --dry-run
```

#### `agent-memory-sync config`

Manage tool configuration.

```bash
agent-memory-sync config show              # Print current config
agent-memory-sync config set KEY VALUE     # Set a config value
agent-memory-sync config get KEY           # Get a config value
agent-memory-sync config reset             # Remove persisted config
```

#### `agent-memory-sync --version`

Print the installed version.

```bash
agent-memory-sync --version
# 0.1.0
```

## Configuration

agent-memory-sync stores configuration at:

- `$XDG_CONFIG_HOME/agent-memory-sync/config.json`, falling back to `~/.config/agent-memory-sync/config.json` when `XDG_CONFIG_HOME` is unset. This resolution is the same on every platform; there is no Windows-specific path.

The `--config` flag overrides the default path.

### Example config file

```json
{
  "rootDir": "/home/user/agent-workspace",
  "remoteUrl": "/srv/git/agent-memory.git",
  "branch": "main",
  "repositorySubdir": "shared",
  "stateDir": ".agent-memory-sync/default",
  "schedule": "*/15 * * * *",
  "conflictStrategy": "inline-markers",
  "outputFormat": "text",
  "verbose": false,
  "reachabilityTimeoutMs": 4000,
  "queueEscalationThresholdMs": 86400000,
  "syncPaths": [
    { "source": "MEMORY.md", "destination": "MEMORY.md", "kind": "file" },
    { "source": "logs", "destination": "logs", "kind": "directory" }
  ]
}
```

For a real multi-machine setup (Mac mini as source of truth, MacBook/Linux
as fallbacks) see the committed profiles under [`profiles/`](profiles/) and
[docs/machine-setup.md](docs/machine-setup.md) instead of hand-writing a
config file from scratch.

### Environment Variables

All config keys can be overridden via environment variables prefixed with `AGENT_MEMORY_SYNC_`:

```bash
export AGENT_MEMORY_SYNC_REMOTE_URL=/srv/git/agent-memory.git
export AGENT_MEMORY_SYNC_OUTPUT_FORMAT=json
export AGENT_MEMORY_SYNC_VERBOSE=true
```

Priority order (highest to lowest): CLI flags > environment variables > config file > defaults.

### Sync behavior

- `sync` runs `pull` first and then `push`
- before any pull/push network operation (including replaying a queue), a fast reachability
  precheck runs first: for ssh/scp-style remotes it derives an
  `ssh -o BatchMode=yes -o ConnectTimeout=<n>` probe against the remote host; for a local
  filesystem remote it's a plain existence check; other transports (https, git://) have no
  dedicated probe and are assumed reachable. If the remote is unreachable, the command is a
  clean no-op — one clear note in the output, exit code `0`, no hang, and the queue (if any)
  is left untouched. Tune the timeout with `--reachability-timeout-ms` / `reachabilityTimeoutMs`
  (default 4000ms), or fully override the probe with `reachabilityCheckCommand` (an argv array;
  config file / `AGENT_MEMORY_SYNC_REACHABILITY_CHECK_COMMAND` only, no CLI flag — same pattern
  as `syncPaths`). The env form must be a JSON array of non-empty strings (e.g.
  `["ssh","-o","BatchMode=yes","host","true"]`); a value that fails to parse that way (invalid
  JSON, or valid JSON of the wrong shape — a bare `false`, a string, an object, ...) prints a
  visible warning naming the offending value and falls back to the default probe, instead of
  either crashing the CLI or silently substituting the default with no explanation. An empty
  string is the one exception: it is treated as unset, silently, same as the env var not being
  set at all — a deliberate convention (an unset/cleared shell variable commonly round-trips as
  `""`), not a warning candidate. To actually disable the probe (always treat the remote as
  reachable and let the real git operation surface any failure on its own), set
  `reachabilityCheckCommand` to a command that always exits `0`, e.g. `["true"]` — there is no
  separate on/off switch, this is the supported way to opt out
- failed pushes (including ones skipped by the reachability precheck) are queued locally in
  `stateDir/queue` and replayed on the next successful push
- if the OLDEST queued snapshot is older than `queueEscalationThresholdMs`
  (config file / `AGENT_MEMORY_SYNC_QUEUE_ESCALATION_THRESHOLD_MS`, default 24h) — i.e. the
  remote has been *continuously* unreachable for that long, not just on this one tick — the
  tick throws instead of returning a clean "queued" result: a message on stderr and exit code
  `6`, so a permanently misconfigured remote (wrong `remoteUrl`, a renamed repository path, a
  host that accepts a connection but cannot serve the repository) does not queue silently
  forever. Below the threshold nothing changes: silent, exit `0`, every tick — a merely offline
  machine is unaffected. See [watch's "Queue escalation" section](#queue-escalation-a-permanently-broken-remote-does-not-queue-forever)
  for the full rationale. Set `queueEscalationThresholdMs` to `null` (config file, or
  `config set queueEscalationThresholdMs null`) to disable this check entirely — mirrors
  `reachabilityCheckCommand`'s null-is-a-real-value convention above. The queue then keeps
  queuing silently, exit `0`, forever, regardless of age; a computed age past a 30x-threshold
  sanity ceiling is also never escalated even with a finite threshold configured, since an age
  that implausible more likely reflects this machine's clock having been wrong when the
  snapshot was queued than a genuinely stuck remote — a diagnostic note is emitted on that
  otherwise-silent "queued" outcome instead
- append-only concurrent edits are merged automatically; other conflicts default to inline conflict markers
- a `pull` result's JSON/YAML carries a `skippedFiles` array (alongside `appliedFiles`,
  `mergedFiles`, `conflictFiles`, `deletedFiles`) listing remote paths that run saw changed but did
  not write locally, because no configured `syncPaths` entry maps them back to a local destination
  (e.g. a file committed to the remote's `repositorySubdir` outside of any `push` from a configured
  machine). Within pull's own reporting such a path never appears in `appliedFiles`, which is
  otherwise a "files this run actually wrote or deleted" list, not a "files this run noticed"
  list. Under the default `--mode sync` the same path also never lands in the combined result's
  `appliedFiles`/`conflictFiles`: an unmapped path is excluded from the base snapshot store both
  `pull` and `push` write (see
  [Unmapped remote paths and base snapshots](#unmapped-remote-paths-and-base-snapshots) below), so
  the push half of a sync run has no base entry for it either and leaves it untouched on the
  remote. `skippedFiles` on a sync result is therefore pull's own honest accounting AND the whole
  story for that path in that payload. Because the path can now never enter either machine's base
  store, this is also deterministic run over run: the same unmapped path is reported in
  `skippedFiles` on every single `pull` for as long as it remains present on the remote and
  unmapped, not just the first time it is noticed. Not every result carries the field at all:
  like `deletedFiles`, `skippedFiles` comes from pull's own accounting, so a raw push result never
  has it (the exit-code-4 remote-unavailable-during-pull fallback inside `run`'s `executeMode`, and
  the synthetic result a scheduled tick produces on queue escalation, are both push-only payloads
  without a `skippedFiles` key). `--output text` reflects a present, non-empty `skippedFiles` as a
  `skipped=N` segment (mirroring the existing `deleted=N` segment); the full list of paths is only
  in `json`/`yaml` output. This per-path list is a different thing from a run's own top-level
  `status: "skipped"` (the reachability precheck above skipping the whole run because the remote
  itself was unreachable): a completed run can list entries in `skippedFiles` for individual paths
  while its own `status` is `applied`
- `--dry-run` previews the result without changing local files or the remote repository

### Unmapped remote paths and base snapshots

A remote path with no configured `syncPaths` mapping (the `skippedFiles` case above) is never
recorded into either machine's *base snapshot* store — the local record of "what the remote last
looked like" that `pull` and `push` both use to detect changes. This matters because base
snapshots feed a 3-way merge: `push`, in particular, visits every path in `local files UNION base
files`, and a path present only in `baseFiles` (base non-null, local null because there is, and
never will be, a local file for it) looks exactly like "the local copy of this file was deleted" —
the same shape a genuine local delete produces. Recording an unmapped path there let `push` see
that shape and, on the very next run, delete an unrelated peer's file from the remote and report it
under `appliedFiles` as if it had been legitimately applied — a data-loss bug (agent-tasks
65380570), reproducible with: commit a file directly into the remote's `repositorySubdir` (outside
any configured machine's `push`), `pull` (used to record it into base snapshots regardless),
`push` (used to then delete it from the remote).

A second, narrower variant of the same bug reached the same outcome through `push` alone, with no
`pull` involved at all: `push` rebuilds its own base snapshot after every successful push from a
fresh read of the *entire* remote `repositorySubdir` tree (`collectRemoteFiles` in
`src/memory-sync/push.ts`), unmapped paths included, regardless of what that particular push
actually touched. Left unfiltered, that write alone re-contaminates the base store on every single
push, so even a machine that never once calls `pull` could still delete a peer's unmapped file two
pushes later.

Two designs were considered for the fix:

- **Exclude unmapped paths from base snapshots entirely** (the one shipped): an unmapped path was
  never materialized locally and never will be, so there is no local state for a base snapshot to
  track "did local change relative to" in the first place — recording it at all was the bug, not
  an under-annotated version of correct behavior. This needs no change to the base snapshot's
  shape (still a plain `path -> content | null` map) and keeps `skippedFiles`'s own contract
  (a `pull`-only concern, orthogonal to what either side's base snapshot store holds) untouched.
- **Keep the path but mark it "foreign"** (not shipped): closer to how `ownerScoped` peer files are
  handled today (`filterOwnerScopedBaseMap`), but those files DO have a configured local mapping —
  they are foreign only in the sense of "not this machine's own file within a shared directory",
  a materially different situation from a path with no mapping at all. Doing the same for unmapped
  paths would need either a wrapper value or a sibling "foreign paths" list alongside the existing
  map, purely to represent something the fix can instead just not store.

The shipped fix filters at three call sites, all permanently load-bearing: none of them is "the
real fix" with the others left in as removable legacy-compat backstops.

- `pull` (`src/memory-sync/pull.ts`) filters what it writes as the new base snapshot after every
  run: the root-cause fix for the pull-then-push cascade described above.
- `push` (`src/memory-sync/push.ts`) filters what IT writes as the new base snapshot after every
  successful push too, the same root-cause fix applied to push's own, independent
  `replaceBaseSnapshots` call, closing the push-only variant above.
- `push` also filters its own base snapshot *read* (and any already-queued snapshot's stored
  `baseFiles`) before the 3-way merge runs. This is not a compatibility shim for stores written
  before this fix shipped. It is the last line of defense against a base map contaminated by
  anything other than the two filtered writes above: a store restored from an old backup, migrated
  from a pre-fix on-disk copy, or otherwise edited outside `pull`/`push`'s own code paths. Dropping
  it re-opens the deletion path for exactly that class of store, even with both writes above
  intact.

All three call sites route through the same helper, `filterUnmappedBaseMap` in
`src/memory-sync/config.ts`.

### Removing a syncPaths mapping (config shrink)

Dropping an entry from `syncPaths` entirely, an operator stops tracking a path that used to be
configured, makes that path unmapped from every future run's point of view, exactly like a path
this machine never configured at all. The remote file the dropped mapping used to track is
therefore left in place rather than deleted: `filterUnmappedBaseMap` excludes it from the shrunk
config's own base write, and neither `pull` nor `push` ever visits it again (it is in neither the
new config's local nor base map), so it simply stops being synced instead of being actively removed
from the remote on the next run. This is the safer of the two possible semantics for a config
shrink, and this fix-round made it deliberate rather than an undocumented side effect of the
unmapped-path fix above.

## Project Structure

```
agent-memory-sync/
├── src/
│   ├── commands/         # One file per subcommand
│   ├── config/           # Config loading and validation
│   ├── memory-sync/      # Pull/push/watch/reachability/merge/state
│   └── main.ts
├── tests/
│   └── ...               # Test files mirroring src/
├── profiles/              # Committed per-machine configs (mac mini, MacBook, Linux template)
├── docs/
│   ├── architecture.md
│   ├── ways-of-working.md
│   ├── machine-setup.md   # Multi-machine bootstrap, activation, restore/rollback
│   ├── launchd/            # macOS LaunchAgent template for `watch`
│   └── adrs/
└── README.md
```

## Development

### Prerequisites

- Node.js 20+
- npm or pnpm

### Setup

```bash
git clone https://github.com/LanNguyenSi/agent-memory
cd agent-memory/packages/agent-memory-sync
npm install
npm run build
```

### Running Tests

```bash
npm test
npm run test:coverage
```

### Linting and Formatting

```bash
npm run lint
npm run format
```

## CI/CD

Continuous integration runs on every pull request and push to `master`:

- Typecheck
- Build
- Lint (typecheck)
- Test + coverage gate

See `.github/workflows/` for pipeline definitions.

## Testing

Strategy: **integration-tests**

Tests invoke the compiled binary and assert on exit codes and stdout/stderr.
Run them after building the project.

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes with tests
4. Run the full test suite
5. Open a pull request

See [ways-of-working](docs/ways-of-working.md) for full contribution guidelines.

## License

MIT License. See [LICENSE](../../LICENSE) for details.

---

*Generated with [ScaffoldKit](https://github.com/LanNguyenSi/scaffoldkit)*
