# ADR-002: Primary Data Store

## Context

Project: agent-memory-sync

Summary: A CLI tool that syncs agent memory files across multiple OpenClaw instances via a central Git repository. Agents can push/pull their MEMORY.md and daily logs to stay in sync.

## Decision

Use a Git-backed file store as the primary source of truth and keep sync metadata in files unless later requirements justify a separate database.

## Consequences

### Positive

- Faster alignment on a high-leverage decision.
- Better reviewability for future changes.

### Negative

- This decision may need revision as requirements sharpen.

### Follow-Up

- Validate this ADR during the first implementation wave.
- Update if significant scope or risk assumptions change.
