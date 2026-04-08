# Task 007: Implement dry-run mode to preview changes before sync

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

- 008

## Summary

Design and implement the capability for: dry-run mode to preview changes before sync.

## Problem

The product cannot satisfy its initial scope until dry-run mode to preview changes before sync exists as a reviewable, testable capability.

## Solution

Add a focused module for dry-run mode to preview changes before sync that matches the recommended modular monolith and keeps integration boundaries explicit.

## Files To Create Or Modify

- src/memory-sync/preview.ts
- src/memory-sync/git-client.ts
- src/memory-sync/config.ts
- src/memory-sync/state-store.ts
- tests/integration/memory-sync.test.ts

## Acceptance Criteria

- [ ] The dry-run mode to preview changes before sync capability is available through the intended application surface.
- [ ] Core validation, error handling, and persistence for dry-run mode to preview changes before sync are covered by tests.

## Implementation Notes

- Start from domain rules and access constraints before UI or transport details.
- Keep module boundaries explicit so later extraction remains possible if the system grows.
- Update docs and tests in the same change instead of leaving them for cleanup.
