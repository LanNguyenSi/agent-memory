# Ways of Working: ice-reflection-engine

## Definition of Done

A command, feature, or bug fix is done when:

- [ ] Code compiles / passes linting with no new warnings
- [ ] Tests are written and passing (unit-tests strategy - see below)
- [ ] Exit codes are correct for success and failure paths
- [ ] Help text is accurate and complete (`--help` for the affected command)
- [ ] Error messages follow the project's message format (see Error Messages)
- [ ] Documentation is updated if a public interface changed
- [ ] Code has been reviewed by at least one other contributor
- [ ] Change has been manually tested against a real terminal (not just unit tests)
- [ ] Config changes are backward compatible, or migration is documented

## CLI UX Conventions

These rules govern how the tool behaves from a user perspective. All contributors must follow them.

### Exit Codes

Always use the canonical exit codes from [docs/architecture.md](architecture.md#exit-codes).

- Exit `0` on success, even if there is nothing to do
- Exit `2` for usage errors (wrong argument types, mutually exclusive flags)
- Exit `1` for all other failures if no more specific code applies
- Never call `sys.exit()` / `os.Exit()` inside command logic - propagate errors to the top-level handler

### stdout vs stderr

| Stream | What goes here |
|--------|----------------|
| `stdout` | All program output meant for the user or downstream tools |
| `stderr` | Warnings, progress messages, debug logs, error messages |

This makes the tool composable:

```bash
ice-reflection-engine run --output json | jq '.items[]'
```

### Error Messages

Errors written to stderr must follow this format:

```
error: <what went wrong>. <how to fix it>.
```

Examples:

```
error: required argument TARGET was not provided. Run 'ice-reflection-engine run --help' to see usage.
error: config key 'output_format' has invalid value 'xml'. Allowed values: text, json, yaml.
error: could not read file at path '/tmp/data.csv': no such file or directory.
```

Never expose raw exception traces to the user by default. Use `--debug` to show stack traces.

### Color Output

- Use color to aid readability, not to convey meaning alone (accessibility)
- Always respect `NO_COLOR=1` (see [no-color.org](https://no-color.org))
- Always respect `--no-color` flag
- Disable color automatically when stdout/stderr is not a TTY (i.e., when piped)
- Suggested palette: red for errors, yellow for warnings, green for success, cyan for labels

### Progress Indicators

For operations that may take more than one second:

- Show a spinner or progress bar on stderr
- Clear the progress indicator before printing final output to stdout
- Disable progress indicators when `--quiet` is passed or when not a TTY
- Never mix progress output into stdout

### Output Formats

Commands that produce structured data must support `--output` / `-o`:

| Value | Description |
|-------|-------------|
| `text` | Human-readable, may include color and formatting |
| `json` | Newline-terminated JSON object or array, no color |
| `yaml` | YAML document, no color |

Default is `text`. When `--output json` is used, the schema must remain stable across releases.

### --dry-run

Commands that mutate state must support `--dry-run`:

- Print what would happen, prefixed with `[dry-run]` on stderr
- Exit `0` without making any changes
- Output must be human-readable; not required to be machine-parseable in dry-run mode

### Interactive vs Non-interactive

- The tool must function fully in non-interactive mode (no TTY, no stdin)
- Never prompt for input unless stdin is a TTY and no flag was provided
- Prompts must have a `--yes` / `--no` flag equivalent for scripting

## Versioning

This project follows [Semantic Versioning](https://semver.org/):

- **MAJOR**: breaking change to CLI interface (removed flag, changed exit code, changed output schema)
- **MINOR**: new subcommand, new option, new output field (backward compatible)
- **PATCH**: bug fix, documentation fix, internal refactor with no interface change

### What Counts as a Breaking Change

- Removing or renaming a command or flag
- Changing the meaning of an exit code
- Changing the JSON output schema in a way that removes or renames fields
- Changing a flag from optional to required

### What Does NOT Count as a Breaking Change

- Adding a new optional flag
- Adding new fields to JSON output
- Changing help text wording
- Improving error messages

## Release Process

1. Update `CHANGELOG.md`
2. Commit: `chore(release): v1.2.3`
3. Tag: `git tag v1.2.3`
4. Push tag: `git push origin v1.2.3`
5. CI cross-compiles and publishes release artifacts to GitHub Releases

## Branching Strategy

Trunk-based development with short-lived feature branches.

### Branch Naming

```
feature/<ticket>-<short-description>
fix/<ticket>-<short-description>
chore/<description>
docs/<description>
```

### Workflow

1. Branch from `main`
2. Make small, focused commits
3. Open a Pull Request (draft if in progress)
4. Pass CI checks
5. Get at least one review approval
6. Squash-merge into `main`
7. Delete the branch

## Pull Request Conventions

### PR Title

Use conventional commit format:

```
feat(run): add --format flag for structured output
fix(config): handle missing config dir gracefully
docs(architecture): document exit code table
chore(deps): update commander to latest
```

### PR Description

Include:

- **What**: what changed
- **Why**: motivation or ticket reference
- **Testing**: how you verified it (command invocations, test names)
- **UX impact**: any change to output, flags, or exit codes

## Testing Expectations

Strategy: **unit-tests**

### Unit Test Rules

- Every command module has a corresponding test file in `tests/commands/`
- Config loader is tested in `tests/config/`
- Test function naming: `test_<command>_<scenario>_<expected_outcome>`
- Tests must not touch the filesystem except through temp directories (`tmp_path` in pytest, `t.TempDir()` in Go)
- Tests must not make network calls
- Tests must not depend on environment variables unless explicitly set in the test
- Aim for >80% branch coverage on `src/commands/` and `src/config/`

### Test Naming

```
test_<command>_<scenario>_<expected_result>
```

Examples:

```
test_run_missing_required_arg_exits_2
test_config_set_invalid_key_prints_error
test_version_outputs_json_when_requested
```

## Architecture Decision Records (ADRs)

Write an ADR in `docs/adrs/` when:

- Choosing a library or external dependency
- Changing the output schema of any command
- Establishing a new pattern not covered by existing docs
- Deprecating or removing a command or flag

### ADR Format

```markdown
# ADR-NNNN: Title

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-XXXX

## Context
What is the situation? What constraints or requirements exist?

## Decision
What did we decide to do?

## Consequences
What are the trade-offs? What becomes easier or harder?
```

## Documentation Expectations

- **README**: always reflects actual install and usage instructions
- **`--help` text**: updated whenever flags or commands change; treat it as part of the public API
- **architecture.md**: updated when subsystem structure or data flow changes
- **ADRs**: written before merging significant decisions, not after
- **AI_CONTEXT.md**: updated when adding new commands or changing patterns

## AI Collaboration Guidelines

This project is configured for AI-assisted development. Read `AI_CONTEXT.md` before working on the codebase.

### For AI Agents

- Read `AI_CONTEXT.md` before starting any task
- Follow the command module pattern exactly - do not invent new file layouts
- Use the exit code table from architecture.md for all error paths
- Write `--help` text for every new flag and command
- Match the test naming convention
- Do not add dependencies without creating an ADR

### For Developers Working with AI

- Point the agent to the specific command file and test file to modify
- Provide the expected `--help` output as part of the specification
- Review exit code handling and stderr vs stdout routing carefully
- Run the full test suite after AI-generated changes
- Update `AI_CONTEXT.md` if new patterns are introduced

## Communication

- Prefer async: comments on PRs and issues over meetings
- Document decisions in ADRs, not chat logs
- Changelog entries are written from the user's perspective, not the developer's
