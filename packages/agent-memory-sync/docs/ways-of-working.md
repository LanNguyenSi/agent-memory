# Ways of Working: agent-memory-sync

## Definition of Done

A command, feature, or bug fix is done when:

- [ ] Code compiles / passes linting with no new warnings
- [ ] Tests are written and passing (integration-tests strategy - see below)
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

Always use the canonical exit codes from [the README's Exit codes table](../README.md#exit-codes).

- Exit `0` on success, even if there is nothing to do
- Exit `2` for usage errors (wrong argument types, mutually exclusive flags)
- Exit `1` for all other failures if no more specific code applies
- Never call `process.exit()` inside command logic - propagate errors to the top-level handler

### stdout vs stderr

| Stream   | What goes here                                            |
| -------- | --------------------------------------------------------- |
| `stdout` | All program output meant for the user or downstream tools |
| `stderr` | Warnings, progress messages, debug logs, error messages   |

This makes the tool composable:

```bash
agent-memory-sync run --output json | jq '.runs[]'
```

### Error Messages

Errors written to stderr must follow this format:

```
error: <what went wrong>. <how to fix it>.
```

Examples:

```
error: required argument TARGET was not provided. Run 'agent-memory-sync run --help' to see usage.
error: config key 'outputFormat' has invalid value 'xml'. Allowed values: text, json, yaml.
error: could not read file at path '/tmp/data.csv': no such file or directory.
```

Never expose raw exception traces to the user.

### Color Output

- Use color to aid readability, not to convey meaning alone (accessibility)
- Color applies only to diagnostics on stderr
- `--no-color` turns it off; `NO_COLOR` and piping do not, because `run`, `watch` and `restore` always pass the color
  flag's CLI default (see [Output Formatting](architecture.md#3-output-formatting))
- Suggested palette: red for errors, yellow for warnings, green for success, cyan for labels

### Progress Indicators

For operations that may take more than one second:

- Show a spinner or progress bar on stderr
- Clear the progress indicator before printing final output to stdout
- Disable progress indicators when `--quiet` is passed or when not a TTY
- Never mix progress output into stdout

### Output Formats

Commands that produce structured data must support `--output` / `-o`:

| Value  | Description                                       |
| ------ | ------------------------------------------------- |
| `text` | Human-readable, may include color and formatting  |
| `json` | Newline-terminated JSON object or array, no color |
| `yaml` | YAML document, no color                           |

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

The package is private and its `package.json` version is not bumped per change, so it does not follow Semantic
Versioning. The lists below still define which CLI changes break scripts that call it.

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

This package is not published or tagged; changes ship by merging to `master`. Record user-visible changes under
`[Unreleased]` in `CHANGELOG.md`.

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

1. Branch from `master`
2. Make small, focused commits
3. Open a Pull Request (draft if in progress)
4. Pass CI checks
5. Get at least one review approval
6. Squash-merge into `master`
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

Strategy: **integration-tests**

### Integration Test Rules

- Tests run `src/main.ts` through tsx as a subprocess (no build needed)
- Always assert on exit code first
- Assert on stdout and stderr separately
- Use temporary directories for any file operations
- CI runs the suite on Linux (ubuntu-latest)
- Keep integration tests in `tests/integration/`; fast unit tests can co-exist in `tests/unit/`

### Test Naming

Tests use `test()` from `node:test`. The name is a plain sentence that states the scenario and the expected outcome,
for example in `tests/integration/memory-sync.test.ts` and `tests/unit/pre-apply-snapshot.test.ts`:

```ts
test("push uploads local memory files to the remote repository", () => {
test("the documented default keeps three generations", () => {
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

## Communication

- Prefer async: comments on PRs and issues over meetings
- Document decisions in ADRs, not chat logs
- Changelog entries are written from the user's perspective, not the developer's
