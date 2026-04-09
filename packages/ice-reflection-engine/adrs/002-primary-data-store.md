# ADR-002: Primary Data Store

## Context

Project: ice-reflection-engine

Summary: A TypeScript CLI that analyzes an AI agent's daily memory logs and distills them into structured long-term memory entries. Reads YYYY-MM-DD.md files, identifies patterns and decisions, and writes curated summaries to MEMORY.md using semantic scoring.

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
