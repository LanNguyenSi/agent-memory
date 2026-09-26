# agent-memory-sync

A CLI tool that syncs agent memory files across multiple machines via a
central Git repository, with push, pull, full sync, inline conflict
handling, offline queueing, cron-compatible scheduling, and dry-run
previews.

> **Internal tool: not published to npm.** This CLI is used from source
> within this repo and is intentionally not a published package
> (`private: true`); this repo publishes only `@lannguyensi/memory-router`.
> Build and run it from the monorepo rather than installing from npm.

## Overview

`agent-memory-sync` keeps `MEMORY.md` and daily logs synchronized between
machines through a shared Git repository, rather than a live network
service. `run` performs a one-shot sync (or push/pull only, optionally on
a schedule); `watch` pushes a debounced snapshot commit on every local
edit for continuous backup; `restore` rolls a file or a whole destination
back to a prior commit or local snapshot. A remote that is temporarily
unreachable queues changes locally instead of failing; deletion guards and
pre-apply snapshots protect against a destination being wiped by a bad
sync.

## Key features

- `run` in `sync`, `push`, or `pull` mode, with optional cron-compatible scheduling
- `watch`: continuous, debounced snapshot commits per memory edit
- Offline push queue, with escalation once a remote has stayed broken too long
- Mass-delete guards and pre-apply snapshots before any destructive write
- `restore` from a commit or a local pre-apply snapshot, whole-destination or single-file
- Config via file, `AGENT_MEMORY_SYNC_*` environment variables, or CLI flags

## Install / quick start

Requires Node.js 20 or newer. Not published to npm; build from source
(`agent-memory-sync` is part of the [`agent-memory`](https://github.com/LanNguyenSi/agent-memory) monorepo):

```bash
git clone https://github.com/LanNguyenSi/agent-memory
cd agent-memory/packages/agent-memory-sync
npm install
npm run build
```

This produces `dist/src/main.js`. Run it with `node dist/src/main.js`, or
put `agent-memory-sync` on your `PATH` with `npm link`.

```bash
agent-memory-sync --help
agent-memory-sync run                 # full sync with the default profile
agent-memory-sync run --dry-run       # preview without writing locally or remotely
```

## Usage

Global options: `--help`, `--version`. Per-subcommand options (`--config`,
`-o/--output`, `-v/--verbose`, `-q/--quiet`, `--no-color`) go after the
subcommand name, for example `agent-memory-sync run --config x`, not
`agent-memory-sync --config x run`. See
[docs/cli-reference.md](docs/cli-reference.md) for the full option list
for every subcommand.

```bash
agent-memory-sync run --mode push                       # push only
agent-memory-sync watch --verbose                        # continuous backup
agent-memory-sync restore 7c4d2e1 --path MEMORY.md       # roll back one file
agent-memory-sync config show                             # print resolved config
agent-memory-sync --version
```

### Exit codes

Every non-zero exit a supervisor can see, and what it means. This table is
canonical; other docs in this package link here rather than keeping a
second copy.

| Code | Meaning | What to do |
|---|---|---|
| `0` | Success, including a tick that queued locally because the remote was unreachable. | Nothing. |
| `1` | An unrecognized flag or argument, or another commander-level usage error (the parser exits before any command code runs). | Fix the invocation; `--help` on the subcommand lists what it accepts. |
| `2` | A flag combination or value this command rejects: `--accept-mass-delete` together with `--allow-mass-delete`, an invalid `--mode`, a destination `restore` without `--yes`, a malformed sha or cron expression. | Fix the invocation. |
| `3` | Configuration error: an unsupported key, or a config value that is present but invalid. For a supported key that simply has no value persisted yet, see `11` below. Also a local sync path (or an operator-typed `--path`) whose name contains a literal backslash on a non-win32 platform, naming the path; see [Sync behavior](docs/sync-behavior.md). | Fix the config file or the flag; for a backslash name, rename the file. |
| `4` | A git or remote operation failed. | Read the message; a push/fetch failure is queued instead of exiting, so this is usually a local git problem. |
| `5` | A push plan was refused by the mass-delete guard: it would remove more of a destination, or of the plan as a whole, than the thresholds allow. | Check whether the local workspace was emptied by something else. If the deletion is intended, re-run with `--allow-mass-delete`. |
| `6` | The replay queue has been failing to drain for longer than `queueEscalationThresholdMs`. | The remote is probably misconfigured rather than temporarily offline; check `remoteUrl`, `branch` and `repositorySubdir`. |
| `7` | The fetched working copy is missing too much of what the base snapshot tracks, or too much of it came back present but emptied to zero bytes, so it cannot be trusted to represent the remote. | Re-run once nothing else is touching `stateDir/tmp`. If the finding is missing files (not emptied ones) and the remote really did drop them, run `run` once with `--accept-mass-delete`; otherwise bring them back with `restore --from-commit <sha> --yes`. |
| `8` | Another agent-memory-sync process holds the lock on this state directory. | Wait for it and re-run. A lock older than `lockStaleMs`, or one whose process is gone on this host, is taken over automatically. |
| `9` | A remote change would delete more of a destination, or of the plan as a whole, than the thresholds allow. | Confirm the remote deletion is genuine, then run `run` once with `--accept-mass-delete`. |
| `10` | A restore source was not found: no such pre-apply snapshot, or the commit holds nothing to restore under the requested path or destination. | List `<stateDir>/snapshots/<destination>/` for the available generations, or pick a commit that still had the files (`git log` on the remote). |
| `11` | `config get` was asked for a supported key (see `3` above for an unsupported one) that is not currently persisted. | Set the key with `config set`, or check the `--config` path. |

See [docs/service-supervision.md](docs/service-supervision.md) for how a
systemd or launchd supervisor should account for these exit codes when
running `watch` continuously.

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

See [docs/service-supervision.md](docs/service-supervision.md) for the
`StartLimitIntervalSec`/`StartLimitBurst` restart-budget math, the macOS
launchd equivalent, and which failures do (and do not) count against that
budget.

## Configuration

Config is stored at `$XDG_CONFIG_HOME/agent-memory-sync/config.json`,
falling back to `~/.config/agent-memory-sync/config.json` when
`XDG_CONFIG_HOME` is unset. `--config` overrides the path.

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
  "massDeleteGuard": { "maxRatio": 0.1, "maxFiles": 20 },
  "snapshotGenerations": 3,
  "lockStaleMs": 1800000,
  "syncPaths": [
    { "source": "MEMORY.md", "destination": "MEMORY.md", "kind": "file" },
    { "source": "logs", "destination": "logs", "kind": "directory" }
  ]
}
```

For a real multi-machine setup (Mac mini as source of truth, MacBook/Linux
as fallbacks) see the committed profiles under
[`profiles/`](profiles/) and [docs/machine-setup.md](docs/machine-setup.md)
instead of hand-writing a config file from scratch.

Config keys can be overridden via environment variables prefixed with
`AGENT_MEMORY_SYNC_` (e.g. `AGENT_MEMORY_SYNC_REMOTE_URL`,
`AGENT_MEMORY_SYNC_OUTPUT_FORMAT`), with one exception: `massDeleteGuard`
is file-only and has no environment override. Priority order (highest to
lowest): CLI flags > environment variables > config file > defaults.

## Documentation

- [docs/cli-reference.md](docs/cli-reference.md) - full option reference for every subcommand
- [docs/sync-behavior.md](docs/sync-behavior.md) - reachability precheck, offline queue, deletion guards, base-snapshot design rationale
- [docs/service-supervision.md](docs/service-supervision.md) - running `watch` under systemd or launchd
- [docs/machine-setup.md](docs/machine-setup.md) - multi-machine bootstrap, activation, restore/rollback
- [docs/architecture.md](docs/architecture.md) - internal command/config/output structure
- [docs/ways-of-working.md](docs/ways-of-working.md) - contribution conventions and definition of done

## Development

```bash
git clone https://github.com/LanNguyenSi/agent-memory
cd agent-memory/packages/agent-memory-sync
npm install
npm run build
npm test
npm run test:coverage
npm run lint
npm run format
```

CI (`.github/workflows/ci.yml`) runs typecheck, build, lint, and the
coverage-gated test suite on every pull request and push to `master`.
Tests invoke the compiled binary and assert on exit codes and
stdout/stderr; run `npm run build` first. See
[docs/ways-of-working.md](docs/ways-of-working.md) for full contribution
guidelines.

## License

MIT License. See [LICENSE](../../LICENSE) for details.
