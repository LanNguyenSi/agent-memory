---
type: module
title: Configuration resolution and precedence
description: How resolveRunConfig builds the run configuration. Config file path order, the merge order of defaults, environment, config file and CLI options, the settings derived afterwards, and which config-file and environment values the CLI's own option defaults hide.
tags: [config, precedence, environment, cli, defaults]
timestamp: 2026-10-11T12:47:47Z
sources:
  - packages/agent-memory-sync/src/config/loader.ts
  - packages/agent-memory-sync/src/commands/run.ts
  - packages/agent-memory-sync/src/commands/watch.ts
  - packages/agent-memory-sync/src/commands/restore.ts
  - packages/agent-memory-sync/src/commands/config.ts
---

# Configuration resolution and precedence

## Responsibility

`src/config/loader.ts` owns reading the config file, reading the
`AGENT_MEMORY_SYNC_*` environment variables, merging both with the
built-in defaults and the command's CLI options, and validating the result.
It does not decide which options a command passes; each command's action
handler builds that override object itself, and that is where the
precedence surprises below come from.

## Entry points

- `loadConfig`, `resolveRunConfig` and `requireRemoteUrl`, called in that
  order by `run`, `watch` and `restore`.
- `readPersistedConfig`, `writePersistedConfig`, `getConfigValue`,
  `setConfigValue`, used by the `config` subcommands.

## Which config file is read

`resolveConfigPath` takes `--config`, then `AGENT_MEMORY_SYNC_CONFIG`, then
the default path
(`packages/agent-memory-sync/src/config/loader.ts:314-318#"path.resolve(candidate)"`),
which is `$XDG_CONFIG_HOME/agent-memory-sync/config.json`, or
`~/.config/agent-memory-sync/config.json` when `XDG_CONFIG_HOME` is unset
(`packages/agent-memory-sync/src/config/loader.ts:149-153#"config.json"`).
A missing file yields empty settings, except that `run`, `watch` and
`restore` pass `requireExisting`, and for them a path named through
`--config` or `AGENT_MEMORY_SYNC_CONFIG` that does not exist is exit 3
(`packages/agent-memory-sync/src/config/loader.ts:171-172#"options.requireExisting &&"`).

The file's keys are accepted in camelCase or snake_case, and `files` is an
alias for `syncPaths`
(`packages/agent-memory-sync/src/config/loader.ts:469-471#"files:"`). Any
other key is dropped without a message
(`packages/agent-memory-sync/src/config/loader.ts:488-492#"continue;"`).
`mode` is not a config key at all
(`packages/agent-memory-sync/src/config/loader.ts:289-312#"snapshotGenerations"`);
it only comes from `run --mode`.

## Merge order

`resolveRunConfig` spreads four layers, later ones winning:

1. `DEFAULTS`
   (`packages/agent-memory-sync/src/config/loader.ts:129-147#"snapshotGenerations: DEFAULT_SNAPSHOT_GENERATIONS"`);
2. the environment, `readEnvConfig()`;
3. the config file's settings;
4. the command's CLI overrides, after `dropUndefined` removes keys whose
   value is `undefined`
   (`packages/agent-memory-sync/src/config/loader.ts:194-201#"as RunConfig"`).

So a value in the config file overrides the same setting from an
environment variable: with `branch` in the file and
`AGENT_MEMORY_SYNC_BRANCH` set, the file's branch is used. An environment
variable only takes effect for a key the config file does not set.

`dropUndefined` removes `undefined` and nothing else
(`packages/agent-memory-sync/src/config/loader.ts:701-705#"as Partial<T>"`):
an override that is `false`, `"text"` or `"default"` replaces whatever the
lower layers said.

## CLI option defaults that hide config and environment values

Commander fills an option's declared default when the flag is absent, so
these overrides are never `undefined`:

- `run` declares `[profile]` with default `default`, `--mode` with default
  `sync`
  (`packages/agent-memory-sync/src/commands/run.ts:38-40#"Sync mode: sync, push, pull"`),
  and `--output` (`text`), `--verbose` (`false`), `--quiet` (`false`) and
  `--no-color` (which makes `color` default to `true`)
  (`packages/agent-memory-sync/src/commands/run.ts:72-76#"Disable colored diagnostics"`),
  and passes all of them to `resolveRunConfig`
  (`packages/agent-memory-sync/src/commands/run.ts:96-115#"?? undefined"`).
- `watch` declares the same `[profile]`, `--output`, `--verbose`, `--quiet`
  and `--no-color` defaults and passes them the same way
  (`packages/agent-memory-sync/src/commands/watch.ts:80-94#"stateDir: options.stateDir"`).
- `restore` passes `--output`, `--verbose`, `--quiet` and `--no-color` the
  same way. Its profile comes from the first positional only in the
  `--from-commit`/`--from-snapshot` form; the older `restore <sha>` form
  passes no profile
  (`packages/agent-memory-sync/src/commands/restore.ts:116#"? undefined : mode.profile"`).

The result for `run` and `watch`: the config-file keys `profile`,
`outputFormat`, `verbose`, `quiet` and `color`, and the environment
variables `AGENT_MEMORY_SYNC_PROFILE`, `AGENT_MEMORY_SYNC_OUTPUT_FORMAT`,
`AGENT_MEMORY_SYNC_VERBOSE`, `AGENT_MEMORY_SYNC_QUIET` and
`AGENT_MEMORY_SYNC_COLOR`, are always replaced by the CLI value, flag given
or not. `NO_COLOR` only feeds `DEFAULTS.color` and is replaced the same way;
`--no-color` is the switch that works. For `restore` the same holds for the
output keys, and for `profile` in the destination forms. The profile matters
beyond naming: it picks the default `stateDir` (below) and, for an
`ownerScoped` sync path, which `<profile>.json` file counts as this
machine's own.

Options a command does not declare are not masked. `watch` passes no
`schedule`, `conflictStrategy` or `reachabilityTimeoutMs`, so those come
from the config file or the environment there.

## Settings derived after the merge

- `rootDir` defaults to the process working directory, captured when the
  loader module is first required; `stateDir` defaults to
  `.agent-memory-sync/<profile>`, and a relative `stateDir` resolves against
  `rootDir`. `repositorySubdir` defaults to `agents/<id>`, where `<id>` is
  `AGENT_MEMORY_SYNC_AGENT_ID` or the host name with every run of other
  characters than letters, digits, `.`, `_` and `-` replaced by `-`
  (`packages/agent-memory-sync/src/config/loader.ts:203-207#"const stateDir = path.resolve(rootDir"`,
  `packages/agent-memory-sync/src/config/loader.ts:707-709#"[^a-zA-Z0-9._-]+"`).
- An absent or empty `syncPaths` list becomes the default list of
  `MEMORY.md`, `daily` and `logs`
  (`packages/agent-memory-sync/src/config/loader.ts:525-526#": DEFAULT_SYNC_PATHS;"`).
- `massDeleteGuard: null` or an absent key means the default thresholds,
  never "no guard"; the per-run override is the `--allow-mass-delete` flag
  (`packages/agent-memory-sync/src/config/loader.ts:610-613#"return { ...DEFAULT_MASS_DELETE_GUARD };"`).
- `queueEscalationThresholdMs: null` is a real value that disables queue
  escalation, distinct from an absent key, which means the default
  (`packages/agent-memory-sync/src/config/loader.ts:596-602#"validatePositiveInteger(value,"`).
  Only the config file can say `null`, written directly or with
  `config set queueEscalationThresholdMs null`
  (`packages/agent-memory-sync/src/config/loader.ts:677-680#": validatePositiveInteger(Number(value)"`);
  the environment variable accepts a positive integer only
  (`packages/agent-memory-sync/src/config/loader.ts:373-379#"DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS"`).

## Environment-only and config-only settings

- `readEnvConfig` reads one variable per config key except
  `massDeleteGuard`, which has no environment variable
  (`packages/agent-memory-sync/src/config/loader.ts:320-432#"return config;"`).
- An unparsable or wrongly shaped `AGENT_MEMORY_SYNC_REACHABILITY_CHECK_COMMAND`
  is ignored with a warning on stderr, and the setting falls through to the
  config file or the default
  (`packages/agent-memory-sync/src/config/loader.ts:407-428#"warnUnparsableReachabilityCheckCommandEnv("`).
- `watch`'s debounce window has no config key: `--debounce-ms`, then
  `AGENT_MEMORY_SYNC_WATCH_DEBOUNCE_MS`, then 5000 ms
  (`packages/agent-memory-sync/src/commands/watch.ts:583-594#"return DEFAULT_DEBOUNCE_MS;"`).

## The `config` subcommands

- `config show` prints the config file's own settings next to the file path
  and the default path
  (`packages/agent-memory-sync/src/commands/config.ts:23-28#"settings: resolved.settings"`).
  It does not apply defaults, the environment or CLI overrides, so it does
  not show the configuration a `run` would use.
- `config get` on a supported key that the file does not set is exit 11
  (`packages/agent-memory-sync/src/commands/config.ts:42-44#"ConfigKeyNotSetError"`);
  an unsupported key is exit 3
  (`packages/agent-memory-sync/src/config/loader.ts:651-655#"is not supported"`).
- `config set` validates the value with the same parsers the loader uses
  and rewrites the whole file from the normalized settings
  (`packages/agent-memory-sync/src/commands/config.ts:56-58#"writePersistedConfig(updated"`).
  Because `readPersistedConfig` normalizes what it reads
  (`packages/agent-memory-sync/src/config/loader.ts:255-258#"settings: normalizeUserConfig("`),
  the rewritten file has lost any unknown key and spells every snake_case
  key in camelCase.

## Invariants enforced here

- [Destructive-write safety chain](destructive-write-safety-chain.md): the
  mass-delete thresholds it uses are resolved here and cannot be switched
  off from configuration.
