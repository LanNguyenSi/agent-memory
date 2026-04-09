# ADR-0001: Language and Framework Choice

## Status

Accepted

## Context

ice-reflection-engine is a new CLI tool: A TypeScript CLI that analyzes an AI agent's daily memory logs and distills them into structured long-term memory entries. Reads YYYY-MM-DD.md files, identifies patterns and decisions, and writes curated summaries to MEMORY.md using semantic scoring.

We needed to select an implementation language and a CLI framework. The following requirements
guided the decision:

- Distribute as: **binary**
- Target users are developers comfortable with a terminal
- The tool may be invoked in scripts and CI pipelines, so predictable exit codes and machine-readable output are required
- The codebase should be approachable for contributors familiar with the chosen language

### Options Evaluated

#### Languages

| Language | Strengths | Weaknesses |
|----------|-----------|------------|
| Python | Fast iteration, large library ecosystem, easy scripting | Requires runtime; distribution of executables is complex |
| Go | Compiles to static binary, fast startup, good stdlib | Verbose error handling; less ergonomic for argument parsing |
| Rust | Best performance, memory safety, excellent binary output | Steep learning curve; slower compile times |
| TypeScript | Familiar for web developers, rich ecosystem | Requires Node.js runtime; startup time higher than compiled |

#### CLI Frameworks

| Framework | Language | Strengths |
|-----------|----------|-----------|
| Typer | Python | Type-annotation-first, auto-generates help, integrates with Rich |
| Click | Python | Mature, flexible, decorator-based, well-documented |
| Cobra | Go | De facto Go CLI standard, used by kubectl and many major tools |
| Clap | Rust | Derive-macro ergonomics, excellent validation, shell completions |
| Commander | TypeScript/Node | Most widely used Node CLI library, flexible |

## Decision

We chose **typescript** with **commander**.

### Rationale

**TypeScript** was selected because the team has deep JavaScript/TypeScript expertise and
the tool shares logic with an existing Node.js codebase.

**Commander** was selected because:

- Widest adoption in the Node CLI ecosystem
- Minimal, predictable API
- First-class TypeScript support
- No magic - explicit option and command registration


### Distribution: binary

Distributing as a pre-compiled binary removes any runtime dependency for users. Binaries are
cross-compiled for Linux, macOS (amd64 and arm64), and Windows using CI. Users download
from GitHub Releases.

## Consequences

### Positive

- Shared code with existing Node.js services
- Large npm ecosystem for parsing, formatting, and networking
- Familiar toolchain for the team

### Negative

- Requires Node.js runtime (typically not an issue for developer tools)
- Startup time includes Node.js and module loading
- Build step required before distribution

### Risks

- If the distribution model changes later (e.g., from pip to binary), the build pipeline
  will need to be redesigned.
- Adding a new command that requires a heavy dependency should trigger a new ADR to assess
  the impact on binary size or install footprint.

## References

- [Architecture documentation](../architecture.md)
- [Ways of working](../ways-of-working.md)
- [Commander.js documentation](https://github.com/tj/commander.js)
