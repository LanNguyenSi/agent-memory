# Architecture: memory-digest-cli

## Overview

memory-digest-cli is a CLI tool implemented in **typescript** using the **commander** framework.
It follows a command-based architecture where each subcommand is an isolated unit with its own
argument parsing, validation, and execution logic.

## Principles

1. **Single responsibility per command**: Each command file owns one subcommand and nothing else.
2. **Fail fast with clear messages**: Validate inputs at parse time; emit actionable error messages to stderr.
3. **Exit codes are part of the interface**: Always exit with a meaningful code (see Exit Codes below).
4. **Stdout for data, stderr for diagnostics**: Program output goes to stdout; logs, warnings, and errors go to stderr.
5. **Composable with other tools**: Structured output where a command produces structured data (`run --output json`, `generate --json`).
6. **Config is optional**: The tool must work with no config file present; config only overrides defaults.

## System Structure

- `src/scanner/`: file scanning and date filtering
- `src/extractor/`: insight extraction and importance scoring
- `src/digest/`: digest generation and formatting
- `src/commands/`: CLI command implementations (`run`, `generate`, `config`)

```
memory-digest-cli/
├── src/
│   ├── commands/         # One module per subcommand
│   │   ├── run.ts
│   │   ├── generate.ts
│   │   └── config.ts
│   ├── config/           # Config file loading (defaults + file, no env-var merging)
│   │   └── loader.ts
│   ├── scanner/          # File scanning and date filtering
│   ├── extractor/        # Insight extraction and importance scoring
│   ├── digest/           # Digest generation and formatting
│   └── main.ts
│       # Entrypoint: registers commands, sets global flags
├── tests/                # Flat: digest, extractor, generate, run, scanner .test.ts
└── docs/
```

## Key Subsystems

### 1. Command Parsing (commander)

Commands are registered on a `Command` instance. Each subcommand has its own Command object,
following the real `run` command (`src/commands/run.ts:13-42`):

```typescript
// src/commands/run.ts
import { Command } from "commander";
import { loadConfig } from "../config/loader.js";

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Execute the primary action")
    .argument("[target]", "Optional target to operate on", "default")
    .option("--config <path>", "Override config file path")
    .option("--dry-run", "Preview without making changes", false)
    .option("-o, --output <format>", "Output format: text or json", "text")
    .option("-v, --verbose", "Enable verbose diagnostics", false)
    .action(async (target: string, options) => {
      const config = await loadConfig(options.config);
      // ... build payload, write text or JSON to stdout
    });
}
```

The root program is created in `src/main.ts` (`src/main.ts:7-18`) and subcommands are
registered before `program.parseAsync()`.

### 2. Config Loading

Config is loaded in two layers, with the later layer overriding the earlier one:

```
1. Compiled-in defaults (DEFAULT_CONFIG)
2. Config file, if present
```

`--config`/`--output`/`--verbose` and the other CLI flags read by `run` and `generate` are not
merged into the loaded config object; each command reads them directly from its own options and
keeps them separate from `config.settings`.

The config loader lives in `src/config/loader.ts`. It is responsible for:

- Locating the config file (respects an explicit `--config` override, then `XDG_CONFIG_HOME`,
  then `~/.config`)
- Parsing the JSON file and casting it to `Partial<CliConfig>` (no runtime schema validation)
- Merging the parsed file over `DEFAULT_CONFIG`
- Returning a `LoadedConfig` (`path` and `settings`) to each command

Commands receive config as a parameter; they do not read it directly. This keeps commands
testable without touching the filesystem.

Config file path resolution order:

1. The `overridePath` a command passes in (the `--config` flag value)
2. `$XDG_CONFIG_HOME/memory-digest-cli/config.json`, if `XDG_CONFIG_HOME` is set
3. `~/.config/memory-digest-cli/config.json` (fallback)

There is no `MEMORY_DIGEST_CLI_*` environment variable layer: `XDG_CONFIG_HOME` is the only
environment variable the loader reads, and only for locating the file, not for overriding
individual settings.

### 3. Output Formatting

The `run` command supports `-o, --output <format>` with two values: `text` (default) or `json`.
`json` output is `JSON.stringify(payload, null, 2)`; `text` output is a single formatted line.
The `generate` command instead uses a boolean `--json` flag to choose between
`formatDigestMarkdown` and `formatDigestJSON`.

`CliConfig.outputFormat` is typed as `"text" | "json" | "yaml"`, but no command implements a
YAML output path, and there is no shared output/color module: there is no `NO_COLOR` handling,
no `--no-color` flag, and no TTY detection anywhere in the CLI. Output is written directly with
`process.stdout.write` / `console.log`.

### 4. Error Handling and Exit Codes

Only two exit codes are actually used: `0` (implicit success) and `1`.

#### Exit Code Reference

| Code | Meaning                        | Where                                                                                                                                  |
| ---- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success                        | Implicit (no error thrown/exit called)                                                                                                 |
| `1`  | Unhandled error in any command | `main.ts`'s `parseAsync().catch()` sets `process.exitCode = 1`; `generate`'s action calls `process.exit(1)` from its own `catch` block |

`run` and `config show` have no `catch` of their own and rely on the top-level handler in
`main.ts`. `generate` catches locally and calls `process.exit(1)` directly instead of raising.
Exit codes `2`-`5` are not implemented; there is no dedicated usage-error, config-error,
runtime-error, or not-found code.

Error messages are written with a plain `error: <message>` (in `main.ts`) or `Error:
<message>` (in `generate`) prefix; there is no "how to fix it" suffix convention.

### 5. Logging and Verbosity

`run` has a `-v, --verbose` flag that is read into the `run` payload but does not currently gate
any diagnostic output. `generate` writes its progress and warning lines to `console.error`
unconditionally (scan/extract/digest progress, warnings), with no verbosity gate. There is no
`--debug` flag anywhere in the CLI.

## CI/CD Architecture

The repo has no root `package.json`/npm workspaces; CI (`.github/workflows/ci.yml`) runs one
`ci` job matrixed over packages (including `memory-digest-cli`), each with
`working-directory: packages/<package>`, on Node 22:

1. `npm ci --no-audit --no-fund`
2. A native-dep smoke check (a no-op for `memory-digest-cli`; it only exercises
   `memory-router`'s native bindings)
3. `npm run typecheck --if-present` (`tsc --noEmit`)
4. `npm run build --if-present`
5. `npm run lint --if-present`, which for this package is an alias for `typecheck`
   (`"lint": "npm run typecheck"` in `package.json`), not `eslint`
6. `npm run test:coverage --if-present`: `tsx --test` with
   `--experimental-test-coverage` and `--test-coverage-lines=90
--test-coverage-branches=80 --test-coverage-functions=92` thresholds, so a
   coverage regression fails the build

There is no `prettier --check` step and no `npm pack` step in this workflow. A
`packages/memory-digest-cli/.github/workflows/ci.yml` file also exists in this repo, but GitHub
Actions only runs workflows from the repository root's `.github/workflows/`, so that nested file
is never triggered.

## Testing Strategy

Approach: a mix of direct unit calls and subprocess integration tests.

- `digest.test.ts`, `extractor.test.ts`, and `scanner.test.ts` call the exported functions
  directly with controlled inputs.
- `generate.test.ts` mostly drives `registerGenerateCommand`'s parsed options by spying on the
  action handler, plus a few tests that run the real action against a temp directory (writing
  files, checking `process.exit(1)` on a write failure) without spawning a subprocess.
- `run.test.ts` spawns the CLI as a real subprocess via `execFileSync` (running `src/main.ts`
  through `tsx`) and asserts on its stdout/exit behavior for both the `run` and `config show`
  commands; it is the closest thing to a dedicated test file for `config`, which has no
  `config.test.ts` of its own.
- Only `generate.test.ts` exercises both text/markdown and JSON output; `digest.test.ts` only
  formats markdown.

## Decisions

See [ADR log](adrs/) for architectural decisions and their rationale.
