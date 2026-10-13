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

A minimal local setup with an empty bare repository as the hub (use your
own paths):

```bash
git init --bare --initial-branch=main <path>/memory-hub.git
agent-memory-sync config set remoteUrl <path>/memory-hub.git
agent-memory-sync config set rootDir <your memory directory>
agent-memory-sync config set repositorySubdir shared
agent-memory-sync run --dry-run       # preview without writing locally or remotely
agent-memory-sync run                 # full sync with the default profile
```

`run` exits `3` until `remoteUrl` is set; `rootDir` defaults to the
current directory. Every machine that should share one tree in the hub
sets the same `repositorySubdir` (see [Configuration](#configuration)).

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
agent-memory-sync config show                             # print the config file path and its persisted settings (JSON)
agent-memory-sync --version
```

### Exit codes

Every non-zero exit a supervisor can see, and what it means. This table is
canonical; other docs in this package link here rather than keeping a
second copy.

| Code | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `0`  | Success, including a tick that queued locally because the remote was unreachable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `1`  | An unrecognized flag or argument, or another commander-level usage error (the parser exits before any command code runs). Also any unexpected error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Fix the invocation; `--help` on the subcommand lists what it accepts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |     |
| `2`  | A flag combination or value this command rejects: `--accept-mass-delete` together with `--allow-mass-delete`, an invalid `--mode`, a destination `restore` without `--yes`, a malformed sha or cron expression.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Fix the invocation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `3`  | Configuration error: an unsupported key, or a config value that is present but invalid. For a supported key that simply has no value persisted yet, see `11` below. Also a local sync path (or an operator-typed `--path`) whose name contains a literal backslash on a non-win32 platform, naming the path; see [Sync behavior](docs/sync-behavior.md). Also, for `run`, `watch` and `restore`, a config file named explicitly by `--config` or `AGENT_MEMORY_SYNC_CONFIG` that does not exist, naming the path. Also a config file, `AGENT_MEMORY_SYNC_SYNC_PATHS` value or `config set` JSON value that is not valid JSON, naming the path, variable or key.                                                                                                                                                                                                                                                                                                                                                    | Fix the config file or the flag; for a backslash name, rename the file; for a missing config file, restore the file or correct the path (see [Real per-machine profiles are local-only](docs/machine-setup.md#real-per-machine-profiles-are-local-only)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `4`  | A git or remote operation failed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Read the message; a push/fetch failure is queued instead of exiting, so this is usually a local git problem.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `5`  | A push plan was refused by the mass-delete guard: it would remove more of a destination, or of the plan as a whole, than the thresholds allow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Check whether the local workspace was emptied by something else. If the deletion is intended, re-run with `--allow-mass-delete`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `6`  | The replay queue has been failing to drain for longer than `queueEscalationThresholdMs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The remote is probably misconfigured rather than temporarily offline; check `remoteUrl`, `branch` and `repositorySubdir`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `7`  | The fetched working copy is missing too much of what the base snapshot tracks, or too much of it came back present but emptied to zero bytes, so it cannot be trusted to represent the remote.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Re-run once nothing else is touching `stateDir/tmp`. If the finding is missing files (not emptied ones) and the remote really did drop them, run `run` once with `--accept-mass-delete`; otherwise bring them back with `restore --from-commit <sha> --yes`. An emptied finding is never adopted by `--accept-mass-delete`; this is almost always the checkout itself coming back zeroed, but if the hub really did empty these files on purpose, re-commit real content at the hub, or raise `massDeleteGuard.maxFiles`/`maxRatio` in the config for one run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `8`  | Another agent-memory-sync process holds the lock on this state directory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Wait for it and re-run. A lock older than `lockStaleMs`, or one whose process is gone on this host, is taken over automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `9`  | A remote change would delete more of a destination, or of the plan as a whole, than the thresholds allow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Confirm the remote deletion is genuine, then run `run` once with `--accept-mass-delete`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `10` | A restore source was not found: no such pre-apply snapshot, or the commit holds nothing to restore under the requested path or destination.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | List `<stateDir>/snapshots/<destination>/` for the available generations, or pick a commit that still had the files (`git log` on the remote).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `11` | `config get` was asked for a supported key (see `3` above for an unsupported one) that is not currently persisted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Set the key with `config set`, or check the `--config` path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `12` | A run stopped before writing or removing anything because a pre-apply snapshot it needs was not intact, or could not have been: a `pull` (including the pull half of `sync`, and `pull --dry-run`, which stops the same way) whose snapshot of a destination is gone or holds no stored copy of a local file the pull was about to overwrite or remove, or that would reach a path no snapshot can hold; a `run --accept-mass-delete` push whose snapshot is missing a local file the adoption was about to remove, or that would reach such a path; or a `restore <profile> <destination>` whose destination holds a path it cannot write or remove (a read-only directory or file, a directory where a file is expected), or a local file it would remove that is the same file as one it restores (a case-only rename on a case-insensitive filesystem, a hard link, a symlink to it, or one file covered by two `syncPaths` entries). No local file was written or removed and the base snapshot did not move. | Run the same command again. If a snapshot read-back stopped it and it repeats, check the free space and permissions of `<stateDir>/snapshots/<destination>/` and the clock of the machine. When the message says "<path> exists on disk but is not a regular file the sync collects", the entry at that path is not a regular file the sync collects (a symlink, a directory, or a name that differs from the hub path only by case or Unicode normalization on a case-insensitive filesystem), or it was created after the run collected its files: run the command again first, and only if it stops again at the same path move that path aside. When a `restore` names a path it cannot write, fix the permissions or the entry at that path and run it again; when it names two paths that are the same file, rename the local one to the source's spelling (case or Unicode alias), remove the extra link (hard link), replace the symlink with a regular file (symlink), or fix the overlapping `syncPaths` entries (one file under two entries). The uncollected-path stop and the restore writability and same-file stops happen before any snapshot is written, so repeating them does not use up the earlier snapshot generations. A snapshot read-back stop has already written a generation, so repeating that one does rotate. |
| `13` | A `pull` or an `--accept-mass-delete` push failed part way through applying its plan (for example a removal in a read-only directory) after its snapshots were written and verified. Some files were already written or removed; the message lists them and names the snapshot generation only for applied paths that had previous content (overwrites and removals), naming those paths; a created path has no previous content, so a failure after only creates points at no snapshot content, and a failing create says so. A pull that only creates files writes no snapshot and says that instead. The base snapshot did not move.                                                                                                                                                                                                                                                                                                                                                                            | Fix the cause named in the message first. Running the same command again applies the rest. When the message names a snapshot generation, every rerun takes a new snapshot and rotates older generations away, so copy that generation aside (`<stateDir>/snapshots/<destination>/<id>`) or pause the scheduled sync before retrying. To undo what was applied, `restore <profile> <destination> --from-snapshot <id>` with the id from the message, while that generation still exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

See [docs/service-supervision.md](docs/service-supervision.md) for how a
systemd or launchd supervisor should account for these exit codes when
running `watch` continuously.

### What a push publishes, and conflicts

A push publishes only the changes this machine made relative to its base
snapshot (its record of what the hub looked like at the last sync). After a
push the base advances per path, and only where the local copy converged with
the hub: to the hub content where the local file equals it, to no entry where
the path is absent on both sides, and otherwise the previous entry is kept. A
file this machine has not pulled yet is therefore never mistaken for a local
deletion, and a stale local copy is never republished over a peer's newer
version.

Conflicts stay on the machine that has them:

- A path whose local content carries conflict markers, or whose three-way
  merge against the hub could only produce markers, is held back. The hub is
  left unchanged for that path, it is counted in `conflicts=N` and named in a
  note, and its base entry is not touched. It is held back again on every
  later push until the local file is resolved (or `pull`/`sync` merges it
  cleanly). A configured `local-wins` or `remote-wins` strategy that resolves
  to marker-free content still publishes.
- A hub file that itself carries conflict markers is never merged into, on
  either side: `pull` leaves the local file byte-identical, `push` skips the
  path whatever the local copy or the strategy says, and the path is reported
  the same way. A local copy that is already equal to the markered hub copy
  is not counted as a conflict; a stale-marker note names it and says to
  repair the hub copy. Under `local-wins` a clean local edit does not repair
  a markered hub copy implicitly; the hub copy has to be repaired at the hub.
  (An `ownerScoped` peer file keeps its mirror-and-flag rule as a special
  case of this rule.)
- A conflict exits `0`. It is visible only through `conflicts=N` and the
  notes, so check those after a `sync`. A `watch` tick that holds paths back
  logs how many and which. The note names the next step per case: pull or
  sync first (merge conflict), resolve the markers (markered local file),
  repair the hub copy (markered hub copy), or copy back the one snapshotted
  file named in the note (a local copy removed by an accepted mass deletion;
  the whole-destination restore fallback also brings back every other
  accepted deletion).
- The mass-delete guard (exit `5`) measures net deletions against the hub
  content at the start of the run, so a file created and deleted again while
  the remote was unreachable does not count. A remote that cannot be reached
  queues the push and exits `0`; exit `4` is a git or remote failure that is
  not queued.

#### Recovering a hub that already holds a markered or regressed file

1. Stop the periodic `sync` job and the `watch` job on every machine.
2. Commit the clean file straight into the hub, from a worktree on the bare
   repository or from any clone.
3. Overwrite every machine's local copy of the file with the same bytes.
4. Run one controlled `agent-memory-sync run --mode sync` per machine and
   check that the result reports `conflicts=0` and that no note names the
   file (stale markers, not published, not pulled). A machine whose state
   directory still holds queued snapshots replays them on this run; the
   `replayed N queued snapshot(s)` note is the signal to look at the result
   closely.
5. Restart the periodic and watch jobs.

### systemd unit

```ini
# /etc/systemd/system/agent-memory-sync-watch.service
[Unit]
Description=agent-memory-sync watch (continuous memory backup)
After=network-online.target

[Service]
Type=simple
User=<linux-username>
Environment=AGENT_MEMORY_SYNC_REMOTE_URL=git@github.com:you/memory-backup.git
Environment=AGENT_MEMORY_SYNC_ROOT_DIR=/home/<linux-username>/.claude/projects/<claude-code-slug-for-this-machine>/memory
Environment=AGENT_MEMORY_SYNC_BRANCH=main
ExecStart=/usr/local/bin/agent-memory-sync watch --verbose
Restart=on-failure
RestartSec=5s
StartLimitIntervalSec=1800
StartLimitBurst=30

[Install]
WantedBy=multi-user.target
```

The `Environment=` values apply only to keys that the config file (the
default config file, see [Configuration](#configuration), or the file named
by `AGENT_MEMORY_SYNC_CONFIG`) does not set.

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
  "rootDir": "/home/<user>/agent-workspace",
  "remoteUrl": "/srv/git/agent-memory.git",
  "branch": "main",
  "repositorySubdir": "shared",
  "stateDir": ".agent-memory-sync/default",
  "schedule": "*/15 * * * *",
  "conflictStrategy": "inline-markers",
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
as fallbacks) see the committed profile templates under
[`profiles/`](profiles/) and [docs/machine-setup.md](docs/machine-setup.md)
instead of hand-writing a config file from scratch. Each machine's actual,
filled-in profile is local-only and git-ignored. See
docs/machine-setup.md's "Real per-machine profiles are local-only" section.

Each config key except `massDeleteGuard` can also be set through an
environment variable named after it with the `AGENT_MEMORY_SYNC_` prefix
(e.g. `AGENT_MEMORY_SYNC_REMOTE_URL`). Priority order (highest to lowest):
CLI flags > environment variables > config file > defaults. An environment
variable therefore overrides the config file for the key it names.

For `run`, `watch` and `restore`, `--output`, `--verbose`, `--quiet` and
`--no-color` apply only when they are actually passed; an omitted flag
leaves the decision to the `outputFormat`, `verbose`, `quiet` and `color`
keys (config file or environment variable). Diagnostics on stderr are
colored only when the resolved `color` is on, `NO_COLOR` is unset/empty,
and stderr is a terminal — `NO_COLOR` or piping stderr turns color off even
when `color` is on. Likewise, `run` and `watch` take `profile` from their
`[profile]` argument when it is given, otherwise from `AGENT_MEMORY_SYNC_PROFILE`
or the file's `profile` key, otherwise `default`.

| Key                          | Default                                                           | Environment variable                              | Value format                                                     |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| `outputFormat`               | `text`                                                            | `AGENT_MEMORY_SYNC_OUTPUT_FORMAT`                 | `text`, `json`, `yaml`                                           |
| `verbose`                    | `false`                                                           | `AGENT_MEMORY_SYNC_VERBOSE`                       | boolean                                                          |
| `quiet`                      | `false`                                                           | `AGENT_MEMORY_SYNC_QUIET`                         | boolean                                                          |
| `color`                      | `true` unless `NO_COLOR` is set                                   | `AGENT_MEMORY_SYNC_COLOR`                         | boolean                                                          |
| `profile`                    | `default`                                                         | `AGENT_MEMORY_SYNC_PROFILE`                       | string                                                           |
| `rootDir`                    | the current directory                                             | `AGENT_MEMORY_SYNC_ROOT_DIR`                      | path                                                             |
| `remoteUrl`                  | none (`run`, `watch` and commit-based `restore` exit `3`)         | `AGENT_MEMORY_SYNC_REMOTE_URL`                    | git URL or path                                                  |
| `branch`                     | `main`                                                            | `AGENT_MEMORY_SYNC_BRANCH`                        | string                                                           |
| `repositorySubdir`           | `agents/<AGENT_MEMORY_SYNC_AGENT_ID or hostname>`                 | `AGENT_MEMORY_SYNC_REPOSITORY_SUBDIR`             | relative path                                                    |
| `stateDir`                   | `<rootDir>/.agent-memory-sync/<profile>`                          | `AGENT_MEMORY_SYNC_STATE_DIR`                     | path; a relative one resolves against `rootDir`                  |
| `schedule`                   | none                                                              | `AGENT_MEMORY_SYNC_SCHEDULE`                      | 5-field cron expression                                          |
| `conflictStrategy`           | `inline-markers`                                                  | `AGENT_MEMORY_SYNC_CONFLICT_STRATEGY`             | `inline-markers`, `local-wins`, `remote-wins`                    |
| `syncPaths`                  | `MEMORY.md` (file), `daily` and `logs` (directories)              | `AGENT_MEMORY_SYNC_SYNC_PATHS`                    | JSON array                                                       |
| `gitBinary`                  | `git`                                                             | `AGENT_MEMORY_SYNC_GIT_BINARY`                    | command                                                          |
| `reachabilityTimeoutMs`      | `4000`                                                            | `AGENT_MEMORY_SYNC_REACHABILITY_TIMEOUT_MS`       | positive integer (ms)                                            |
| `reachabilityCheckCommand`   | none (built-in probe, see [Sync behavior](docs/sync-behavior.md)) | `AGENT_MEMORY_SYNC_REACHABILITY_CHECK_COMMAND`    | JSON array of strings, or `null`                                 |
| `queueEscalationThresholdMs` | `86400000` (24 h)                                                 | `AGENT_MEMORY_SYNC_QUEUE_ESCALATION_THRESHOLD_MS` | positive integer (ms); `null` (not via the environment) disables |
| `massDeleteGuard`            | `{ "maxRatio": 0.1, "maxFiles": 20 }`                             | none (config file only)                           | JSON object                                                      |
| `lockStaleMs`                | `1800000` (30 min)                                                | `AGENT_MEMORY_SYNC_LOCK_STALE_MS`                 | positive integer (ms)                                            |
| `snapshotGenerations`        | `3`                                                               | `AGENT_MEMORY_SYNC_SNAPSHOT_GENERATIONS`          | positive integer                                                 |

In environment variables and `config set`, booleans accept `true`,
`false`, `1` and `0`. An unset `repositorySubdir` defaults to
`agents/<AGENT_MEMORY_SYNC_AGENT_ID or hostname>`, so machines only share
one tree when they set the same `repositorySubdir`.

Environment variables that are not config keys:

| Variable                                 | Effect                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `AGENT_MEMORY_SYNC_CONFIG`               | Config file path (`--config` takes precedence).                           |
| `AGENT_MEMORY_SYNC_AGENT_ID`             | Feeds the `repositorySubdir` default instead of the hostname.             |
| `AGENT_MEMORY_SYNC_WATCH_DEBOUNCE_MS`    | `watch` debounce window (default 5000; `--debounce-ms` takes precedence). |
| `AGENT_MEMORY_SYNC_WATCH_ARM_TIMEOUT_MS` | Bound on the `watch` startup wait for a live file watch (default 5000).   |

## Documentation

- [docs/cli-reference.md](docs/cli-reference.md) - full option reference for every subcommand
- [docs/sync-behavior.md](docs/sync-behavior.md) - reachability precheck, offline queue, deletion guards, base-snapshot design rationale
- [docs/service-supervision.md](docs/service-supervision.md) - running `watch` under systemd or launchd
- [docs/machine-setup.md](docs/machine-setup.md) - multi-machine bootstrap, activation, restore/rollback
- [docs/architecture.md](docs/architecture.md) - internal command/config/output structure
- [docs/ways-of-working.md](docs/ways-of-working.md) - contribution conventions and definition of done
- [docs/okf/index.md](docs/okf/index.md) - curated knowledge bundle: code anchors behind the mechanisms that span several source files

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

CI (the repository root's `.github/workflows/ci.yml`, one matrix job per
package) runs typecheck, build, lint, a Prettier `format:check`, and the
coverage-gated test suite on every pull request and push to `master`.
Tests run `src/main.ts` through tsx as a subprocess and assert on exit
codes and stdout/stderr; no build is needed first. See
[docs/ways-of-working.md](docs/ways-of-working.md) for full contribution
guidelines.

## License

MIT License. See [LICENSE](../../LICENSE) for details.
