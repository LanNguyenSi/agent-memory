# Task 006: Implement write distilled summaries to MEMORY.md without overwriting existing content

## Category

feature

## Priority

P1

## Wave

wave-3

## Delivery Phase

implementation

## Depends On

- 001
- 002

## Blocks

- 009

## Summary

Design and implement the capability for: write distilled summaries to MEMORY.md without overwriting existing content.

## Problem

The product cannot satisfy its initial scope until write distilled summaries to MEMORY.md without overwriting existing content exists as a reviewable, testable capability.

## Solution

Add a focused module for write distilled summaries to MEMORY.md without overwriting existing content that matches the recommended modular monolith and keeps integration boundaries explicit.

## Files To Create Or Modify

- src/memory-sync/sync.ts
- src/memory-sync/git-client.ts
- src/memory-sync/config.ts
- src/memory-sync/state-store.ts
- tests/integration/memory-sync.test.ts

## Acceptance Criteria

- [ ] The write distilled summaries to MEMORY.md without overwriting existing content capability is available through the intended application surface.
- [ ] Core validation, error handling, and persistence for write distilled summaries to MEMORY.md without overwriting existing content are covered by tests.

## Implementation Notes

- Start from domain rules and access constraints before UI or transport details.
- Keep module boundaries explicit so later extraction remains possible if the system grows.
- Update docs and tests in the same change instead of leaving them for cleanup.
