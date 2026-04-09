# AI Context: ice-reflection-engine

> Read this file before making any changes to the codebase.
> It describes the project's structure, conventions, and rules for AI agents.

## Project Overview

**ice-reflection-engine** is a CLI tool that a typescript cli that analyzes an ai agent's daily memory logs and distills them into structured long-term memory entries. reads yyyy-mm-dd.md files, identifies patterns and decisions, and writes curated summaries to memory.md using semantic scoring..

- **Language:** typescript
- **Framework:** commander
- **Distribution:** binary
- **Test strategy:** unit-tests
- **Config format:** json (at `~/.config/ice-reflection-engine/config.json`)

## Repository Structure

```
ice-reflection-engine/
├── src/
│   ├── commands/         # One file per subcommand
│   ├── config/           # Config loading and validation
│   └── main.ts
├── tests/
│   ├── commands/         # Tests for each command (mirrors src/commands/)
│   └── config/           # Tests for config loading
├── docs/
│   ├── architecture.md   # Subsystem design, exit codes, output rules
│   ├── ways-of-working.md
│   └── adrs/             # Architecture Decision Records
└── AI_CONTEXT.md         # This file
```

## How to Add a New Command

Follow these steps exactly. Do not deviate from the file layout.

### Step 1: Create the command file

Create `src/commands/<name>.ts`:

```typescript
import { Command } from "commander";

export function register<Name>(program: Command): void {
    program
        .command("<name>")
        .description("One-line description of what this command does")
        .option("-v, --verbose", "Verbose output", false)
        .action(async (options) => {
            await execute<Name>(options);
        });
}

async function execute<Name>(options: { verbose: boolean }): Promise<void> {
    // Implementation here
}
```

### Step 2: Register the command

In `src/main.ts`, add:
```typescript
import { register<Name> } from "./commands/<name>";
register<Name>(program);
```

### Step 3: Write tests

Create `tests/commands/test_<name>.ts`.

Test naming: `test_<name>_<scenario>_<expected_outcome>`

Test the following cases:
- Happy path with default options
- Each optional flag changes behavior as expected
- Invalid arguments produce exit code `2` and an error on stderr
- Error conditions produce the correct exit code and message


## Argument Patterns

Use these patterns consistently across all commands.

### Flags vs positional arguments

- Use **positional arguments** for the primary subject (e.g., a file path, a name)
- Use **flags** for options and modifiers
- Never require a flag that has a sensible default

### Standard flags every command should support

| Flag | Short | Type | Description |
|------|-------|------|-------------|
| `--output` | `-o` | `text\|json\|yaml` | Output format (on commands with structured output) |
| `--dry-run` | - | bool | Preview without changes (on mutating commands) |
| `--verbose` | `-v` | bool | More diagnostic output to stderr |
| `--quiet` | `-q` | bool | Suppress all non-error output |

### Mutually exclusive flags

When two flags cannot be used together:
- Validate at parse time, not in business logic
- Exit with code `2` and message: `error: --flag-a and --flag-b cannot be used together.`

## Config Access Patterns

Config is loaded once at startup by the main entrypoint and passed to each command as a parameter.
Commands do not read config directly from disk.

```
main entrypoint
  -> load config (src/config/loader)
  -> pass config to command function
     -> command uses config.field_name
```

### Adding a new config key

1. Add the key to the config schema/struct in `src/config/loader.ts`
2. Set a sensible default
3. Document the key in README.md under the Configuration section
4. Add an environment variable override: `ICE_REFLECTION_ENGINE_<KEY_NAME>`
5. Write a test in `tests/config/` verifying the default, env var override, and file override

Config values must never be read from global state. Always inject config as a parameter.


## Output Formatting Rules

**Never write to stdout with unstructured print/fmt/println statements inside command logic.**

Use the output module in `src/output.ts`:

- `output.success(message)` - green checkmark + message to stdout
- `output.error(message)` - "error: message" to stderr
- `output.warning(message)` - "warning: message" to stderr
- `output.info(message)` - diagnostic message to stderr (suppressed with `--quiet`)
- `output.result(data, format)` - structured data to stdout in the requested format

Color rules:
- Respect `NO_COLOR` environment variable
- Respect `--no-color` flag
- Disable color when stdout is not a TTY

## Testing Patterns

### Unit test structure

```
tests/
├── commands/
│   ├── test_run.ts
│   └── test_config.ts
└── config/
    └── test_loader.ts
```

### What to test per command

1. Default options produce expected output
2. Each flag is tested independently
3. Invalid input exits with code `2`
4. Errors produce correct exit code and stderr message
5. `--output json` produces valid parseable JSON

### Mocking

- Mock the filesystem using temp directories (never write to real paths in tests)
- Mock external calls at the function boundary, not by patching internals
- Do not mock the config loader - construct a Config object directly in the test


## Exit Code Enforcement

All commands must exit with one of these codes. Check against this list before completing any error path:

| Code | When to use |
|------|-------------|
| `0` | Success |
| `1` | Unexpected runtime error |
| `2` | Bad arguments / usage error |
| `3` | Config error |
| `4` | External service / IO error |
| `5` | Resource not found |

If you are not sure which code to use, use `1` and leave a comment in the code.

## What NOT to Do

- Do not add a new dependency without checking if an existing one covers the use case
- Do not write directly to stdout/stderr - use the output module
- Do not call `sys.exit()` / `os.Exit()` inside command logic - propagate errors
- Do not read environment variables or config files inside commands - receive config as a parameter
- Do not add interactive prompts to commands that will be used in CI pipelines
- Do not ignore error return values
- Do not commit secrets, tokens, or real filesystem paths
- Do not skip `--help` text for new flags or commands
- Do not introduce a new pattern without updating this file and `docs/architecture.md`
