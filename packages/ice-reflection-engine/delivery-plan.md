# Delivery Plan

## Execution Waves

## wave-1

Lock scope, assumptions, and engineering baseline.

- 001 Write project charter and architecture baseline
- 002 Set up repository and delivery baseline

## wave-2

Deliver the first critical capabilities and required controls.

- 003 Implement scan daily memory files in configurable directory
- 004 Implement extract decisions, lessons, and key events using heuristic analysis

## wave-3

Expand feature coverage once the core path is in place.

- 005 Implement score entries by significance and recency
- 006 Implement write distilled summaries to MEMORY.md without overwriting existing content
- 007 Implement dry-run mode to preview changes before writing
- 008 Implement configurable significance threshold

## wave-4

Harden, verify, and prepare the system for release.

- 009 Add integration and error-handling coverage

## Dependency Edges

- 001 -> 002
- 001 -> 003
- 002 -> 003
- 001 -> 004
- 002 -> 004
- 001 -> 005
- 002 -> 005
- 001 -> 006
- 002 -> 006
- 001 -> 007
- 002 -> 007
- 001 -> 008
- 002 -> 008
- 003 -> 009
- 004 -> 009
- 005 -> 009
- 006 -> 009
- 007 -> 009
- 008 -> 009

## Critical Path

001 -> 002 -> 003 -> 009
