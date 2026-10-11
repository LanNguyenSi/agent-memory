# Knowledge bundle index

Curated OKF knowledge bundle for the `agent-memory-sync` package (bundle
granularity is per package, like the `memory-router` bundle in this
repository). The package README and `docs/` describe installation, machine
setup, supervision and the CLI; this bundle adds the code anchors (file and
line) behind the mechanisms that span several source files, and does not
repeat those docs.

## Overview

- [agent-memory-sync overview](overview.md): the four commands, the
  state directory layout, and the exit codes, with pointers to the docs
  below.

## Modules

- [Configuration resolution and precedence](config-resolution.md): config
  file path order, the merge order of defaults, environment, config file
  and CLI options, and the config-file and environment values that the
  CLI's own option defaults replace.
- [Offline queue, replay and escalation, and the state-directory lock](offline-queue-and-lock.md):
  when a push queues, how the queue is replayed and when it escalates to
  exit 6, and how `lock.json` serialises `run`, `watch` and `restore`.

## Invariants

- [Base snapshot lifecycle and per-path advance](base-snapshot-lifecycle.md):
  every reader and writer of `stateDir/base`, the per-path rule a push
  advances it by, and the three call sites that keep unmapped hub paths out
  of it.
- [Destructive-write safety chain and its exit codes](destructive-write-safety-chain.md):
  the ordered checks in front of every local deletion or overwrite and
  every published deletion, with the exit code of each refusal and the
  scope of the two override flags.

## Runbooks

- [Responding to a stopped or refused sync run](stopped-run-runbook.md):
  per exit code, what the stopped run left behind and the next step.

## Maintenance

Each doc's `timestamp` means "last verified against sources," not "created
on." When a change touches a path listed in a doc's `sources:`, re-verify
the doc against the change and re-stamp it, then add a line to
[log.md](log.md). The warn-only `okf-staleness` CI workflow checks this
bundle and the `memory-router` bundle on pull requests against `master`;
bundle findings never fail it, only a tool or usage error of the check
itself does.

Log entries record what changed and what was re-verified, not suite
totals: a total describes one tree and goes stale when a test is added
or removed.
