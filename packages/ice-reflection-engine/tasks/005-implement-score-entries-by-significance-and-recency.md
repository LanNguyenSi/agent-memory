# Task 005: Implement score entries by significance and recency

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

Design and implement the capability for: score entries by significance and recency.

## Problem

The product cannot satisfy its initial scope until score entries by significance and recency exists as a reviewable, testable capability.

## Solution

Add a focused module for score entries by significance and recency that matches the recommended modular monolith and keeps integration boundaries explicit.

## Files To Create Or Modify

- src/modules/score-entries-by-significance-and-recenc/index.ts
- src/modules/score-entries-by-significance-and-recenc/score-entries-by-significance-and-recenc.service.ts
- src/modules/score-entries-by-significance-and-recenc/score-entries-by-significance-and-recenc.repository.ts
- tests/integration/score-entries-by-significance-and-recenc.test.js

## Acceptance Criteria

- [ ] The score entries by significance and recency capability is available through the intended application surface.
- [ ] Core validation, error handling, and persistence for score entries by significance and recency are covered by tests.

## Implementation Notes

- Start from domain rules and access constraints before UI or transport details.
- Keep module boundaries explicit so later extraction remains possible if the system grows.
- Update docs and tests in the same change instead of leaving them for cleanup.
