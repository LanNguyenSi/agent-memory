---
type: module
title: Configuration resolution and precedence
description: How resolveRunConfig builds the run configuration. Config file path order, the merge order of defaults, config file, environment and CLI options, the settings derived afterwards, which CLI options carry no default, and how invalid JSON is reported.
tags: [config, precedence, environment, cli, defaults]
timestamp: 2026-10-13T16:28:37Z
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
  order by `run`, `watch` and `restore`; `restore --from-snapshot` skips
  `requireRemoteUrl`, since it reads only the state directory
  (`packages/agent-memory-sync/src/commands/restore.ts:133-135#"requireRemoteUrl(resolved);"`).
- `readPersistedConfig`, `writePersistedConfig`, `getConfigValue`,
  `setConfigValue`, used by the `config` subcommands.

## Which config file is read

`resolveConfigPath` takes `--config`, then `AGENT_MEMORY_SYNC_CONFIG`, then
the default path
(`packages/agent-memory-sync/src/config/loader.ts:330-334#"path.resolve(candidate)"`),
which is `$XDG_CONFIG_HOME/agent-memory-sync/config.json`, or
`~/.config/agent-memory-sync/config.json` when `XDG_CONFIG_HOME` is unset
(`packages/agent-memory-sync/src/config/loader.ts:149-153#"config.json"`).
A missing file yields empty settings, except that `run`, `watch` and
`restore` pass `requireExisting`, and for them a path named through
`--config` or `AGENT_MEMORY_SYNC_CONFIG` that does not exist is exit 3
(`packages/agent-memory-sync/src/config/loader.ts:171-172#"options.requireExisting &&"`).

The file's keys are accepted in camelCase or snake_case, and `files` is an
alias for `syncPaths`
(`packages/agent-memory-sync/src/config/loader.ts:487-489#"files:"`). Any
other key is dropped without a message
(`packages/agent-memory-sync/src/config/loader.ts:506-510#"continue;"`).
`mode` is not a config key at all
(`packages/agent-memory-sync/src/config/loader.ts:305-328#"snapshotGenerations"`);
it only comes from `run --mode`.

## Merge order

`resolveRunConfig` spreads four layers, later ones winning:

1. `DEFAULTS`
   (`packages/agent-memory-sync/src/config/loader.ts:129-147#"snapshotGenerations: DEFAULT_SNAPSHOT_GENERATIONS"`);
2. the config file's settings;
3. the environment, `readEnvConfig()`;
4. the command's CLI overrides, after `dropUndefined` removes keys whose
   value is `undefined`
   (`packages/agent-memory-sync/src/config/loader.ts:208-215#"as RunConfig"`).

So an environment variable overrides the same setting from the config
file: with `branch` in the file and `AGENT_MEMORY_SYNC_BRANCH` set, the
environment's branch is used. This is the documented order, CLI flags >
environment > config file > defaults.

`dropUndefined` removes `undefined` and nothing else
(`packages/agent-memory-sync/src/config/loader.ts:726-730#"as Partial<T>"`):
an override that is `false`, `"text"` or `"default"` replaces whatever the
lower layers said, which is why an option must stay `undefined` when its
flag was not passed.

## CLI options that carry no default

`--output`, `--verbose`, `--quiet` and the `[profile]` positional of `run`
and `watch` are declared without a commander default, so an omitted flag
reaches `resolveRunConfig` as `undefined` and the config file or
environment value applies:

- `run` builds its overrides in `buildRunOverrides`, which passes each
  option through and turns `--no-color` into an override only when the
  caller says the flag was passed
  (`packages/agent-memory-sync/src/commands/run.ts:227-237#"color: colorOnlyFromCli ? options.color : undefined,"`).
  Commander always reports `color === true` for a `--no-color` option, so
  the action asks `command.getOptionValueSource("color") === "cli"`
  (`packages/agent-memory-sync/src/commands/run.ts:103#"getOptionValueSource"`).
  `--mode` is the exception that keeps its default `sync`
  (`packages/agent-memory-sync/src/commands/run.ts:43-45#"Sync mode: sync, push, pull"`).
- `watch` passes the same options inline and applies the same
  `getOptionValueSource("color")` test
  (`packages/agent-memory-sync/src/commands/watch.ts:93#"getOptionValueSource"`).
- `restore` does the same for `--output`, `--verbose`, `--quiet` and
  `--no-color`
  (`packages/agent-memory-sync/src/commands/restore.ts:126#"getOptionValueSource"`).
  Its profile comes from the first positional only in the
  `--from-commit`/`--from-snapshot` form; the older `restore <sha>` form
  passes no profile
  (`packages/agent-memory-sync/src/commands/restore.ts:122#"? undefined : mode.profile"`).

The profile is `AGENT_MEMORY_SYNC_PROFILE` or the config file's `profile`
when no positional is given, and `default` when none of the three is set
(`packages/agent-memory-sync/src/config/loader.ts:217#"merged.profile ||"`).
It matters beyond naming: it picks the default `stateDir` (below) and, for
an `ownerScoped` sync path, which `<profile>.json` file counts as this
machine's own.

`color` is on by default unless `NO_COLOR` is set (`DEFAULTS.color`); the
config key and `AGENT_MEMORY_SYNC_COLOR` can change that, `--no-color`
overrides both when passed. The resolved value is not the final word:
`applyColor` also drops color when `NO_COLOR` is set or stderr is not a
terminal
(`packages/agent-memory-sync/src/output.ts:55#"!process.stderr.isTTY"`).

Options a command does not declare are not overridden at all. `watch`
passes no `schedule`, `conflictStrategy` or `reachabilityTimeoutMs`, so
those come from the config file or the environment there.

## Invalid JSON in a config source

A config file, an `AGENT_MEMORY_SYNC_SYNC_PATHS` value and a `config set`
value for a JSON-valued key (`syncPaths`, `massDeleteGuard`,
`reachabilityCheckCommand`) all go through `parseJson`, which turns a
`JSON.parse` failure into a `CliError` with exit 3 naming the source
(`packages/agent-memory-sync/src/config/loader.ts:196-201#"is not valid JSON"`).

## Settings derived after the merge

- `rootDir` defaults to the process working directory, captured when the
  loader module is first required; `stateDir` defaults to
  `.agent-memory-sync/<profile>`, and a relative `stateDir` resolves against
  `rootDir`. `repositorySubdir` defaults to `agents/<id>`, where `<id>` is
  `AGENT_MEMORY_SYNC_AGENT_ID` or the host name, either one with every run
  of other characters than letters, digits, `.`, `_` and `-` replaced by
  `-`
  (`packages/agent-memory-sync/src/config/loader.ts:217-221#"const stateDir = path.resolve(rootDir"`,
  `packages/agent-memory-sync/src/config/loader.ts:732-734#"[^a-zA-Z0-9._-]+"`).
- An absent or empty `syncPaths` list becomes the default list of
  `MEMORY.md`, `daily` and `logs`
  (`packages/agent-memory-sync/src/config/loader.ts:543-544#": DEFAULT_SYNC_PATHS;"`).
- `massDeleteGuard: null` or an absent key means the default thresholds,
  never "no guard"
  (`packages/agent-memory-sync/src/config/loader.ts:631-634#"return { ...DEFAULT_MASS_DELETE_GUARD };"`).
  The per-run overrides are the `--allow-mass-delete` and
  `--accept-mass-delete` flags, each for its own checks (see
  [destructive-write-safety-chain.md](destructive-write-safety-chain.md#the-two-override-flags)).
- `queueEscalationThresholdMs: null` is a real value that disables queue
  escalation, distinct from an absent key, which means the default
  (`packages/agent-memory-sync/src/config/loader.ts:614-620#"validatePositiveInteger(value,"`).
  Only the config file can say `null`, written directly or with
  `config set queueEscalationThresholdMs null`
  (`packages/agent-memory-sync/src/config/loader.ts:698-701#": validatePositiveInteger(Number(value)"`);
  the environment variable accepts a positive integer only
  (`packages/agent-memory-sync/src/config/loader.ts:391-397#"DEFAULT_QUEUE_ESCALATION_THRESHOLD_MS"`).

## Environment-only and config-only settings

- `readEnvConfig` reads one variable per config key except
  `massDeleteGuard`, which has no environment variable
  (`packages/agent-memory-sync/src/config/loader.ts:338-450#"return config;"`).
- An unparsable or wrongly shaped `AGENT_MEMORY_SYNC_REACHABILITY_CHECK_COMMAND`
  is ignored with a warning on stderr, and the setting falls through to the
  config file or the default
  (`packages/agent-memory-sync/src/config/loader.ts:425-446#"warnUnparsableReachabilityCheckCommandEnv("`).
- `watch`'s debounce window has no config key: `--debounce-ms`, then
  `AGENT_MEMORY_SYNC_WATCH_DEBOUNCE_MS`, then 5000 ms
  (`packages/agent-memory-sync/src/commands/watch.ts:589-600#"return DEFAULT_DEBOUNCE_MS;"`).

## The `config` subcommands

- `config show` prints the config file's own settings next to the file path
  and the default path
  (`packages/agent-memory-sync/src/commands/config.ts:23-28#"settings: resolved.settings"`).
  It does not apply defaults, the environment or CLI overrides, so it does
  not show the configuration a `run` would use.
- `config get` on a supported key that the file does not set is exit 11
  (`packages/agent-memory-sync/src/commands/config.ts:42-44#"ConfigKeyNotSetError"`);
  an unsupported key is exit 3
  (`packages/agent-memory-sync/src/config/loader.ts:672-676#"is not supported"`).
- `config set` validates the value with the same parsers the loader uses
  and rewrites the whole file from the normalized settings
  (`packages/agent-memory-sync/src/commands/config.ts:56-58#"writePersistedConfig(updated"`).
  Because `readPersistedConfig` normalizes what it reads
  (`packages/agent-memory-sync/src/config/loader.ts:269-271#"settings: normalizeUserConfig("`),
  the rewritten file has lost any unknown key and spells every snake_case
  key in camelCase.

## Invariants enforced here

- [Destructive-write safety chain](destructive-write-safety-chain.md): the
  mass-delete thresholds it uses are resolved here and cannot be switched
  off from configuration.
