# ADR-001: Initial Architecture Shape

## Context

Project: agent-memory-sync

Summary: A CLI tool that syncs agent memory files across multiple OpenClaw instances via a central Git repository. Agents can push/pull their MEMORY.md and daily logs to stay in sync.

## Decision

Start with modular monolith as the default architecture.

## Consequences

### Positive

- Faster alignment on a high-leverage decision.
- Better reviewability for future changes.

### Negative

- This decision may need revision as requirements sharpen.

### Follow-Up

- Validate this ADR during the first implementation wave.
- Update if significant scope or risk assumptions change.
