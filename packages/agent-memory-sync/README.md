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

This produces `dist/main.js`. Run it with `node dist/main.js`, or put `agent-memory-sync` on your `PATH` with `npm link`.

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
| `--config PATH` | Path to config file (default: `~/.config/agent-memory-sync/config.json`) |
| `--verbose` | Enable verbose output |
| `--quiet` | Suppress non-error output |
| `--no-color` | Disable colored output |

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
StartLimitIntervalSec=300
StartLimitBurst=10

[Install]
WantedBy=multi-user.target
```

The `StartLimitIntervalSec` / `StartLimitBurst` pair caps systemd's restart loop for the class of failure that still exits non-zero — a config/data error such as a required `syncPaths` entry missing — so a persistently broken config does not crashloop forever; a network hiccup or a rejected push no longer exits at all (see below), so it never spends this budget. Inspect `journalctl -u agent-memory-sync-watch.service` for the `snapshot push failed: ...` line `watch` writes to stderr before exiting on that remaining class of failure.

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
relied on launchd/systemd to restart the process; a genuine config/data
error (e.g. a required `syncPaths` entry missing) is the only class of
failure that still exits non-zero and reaches the supervisor-restart path
described above.

`watch` still never pulls — it is edge-triggered on local changes only, so a
machine that was offline while changes landed elsewhere will not pick them
up until its own next local edit, even though its own push is now safe to
run against a stale local view (see [docs/machine-setup.md](docs/machine-setup.md)
for what that safety does and does not cover). For that reason, a periodic
`run --mode sync` running alongside `watch` is a **required** part of any
fallback-machine setup, not an optional extra — see
[docs/machine-setup.md](docs/machine-setup.md) for the launchd/systemd
companion jobs.

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

#### `agent-memory-sync version`

Show detailed version information.

```bash
agent-memory-sync version
# agent-memory-sync v0.1.0
# Language: typescript
# Framework: commander
# Build: (commit hash)
```

## Configuration

agent-memory-sync stores configuration at:

- **Linux/macOS**: `~/.config/agent-memory-sync/config.json`
- **Windows**: `%APPDATA%\agent-memory-sync\config.json`

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
  either crashing the CLI or silently substituting the default with no explanation
- failed pushes (including ones skipped by the reachability precheck) are queued locally in
  `stateDir/queue` and replayed on the next successful push
- append-only concurrent edits are merged automatically; other conflicts default to inline conflict markers
- `--dry-run` previews the result without changing local files or the remote repository

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

Continuous integration runs on every pull request and push to `main`:

- Lint and format check
- Unit tests
- Build verification
- Cross-platform build (Linux, macOS, Windows)

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

MIT License. See [LICENSE](LICENSE) for details.

---

*Generated with [ScaffoldKit](https://github.com/LanNguyenSi/scaffoldkit)*
