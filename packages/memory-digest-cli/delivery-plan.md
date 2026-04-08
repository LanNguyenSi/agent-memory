# Delivery Plan

## Execution Waves

## wave-1

Lock scope, assumptions, and engineering baseline.

- 001 Write project charter and architecture baseline
- 002 Set up repository and delivery baseline

## wave-2

Deliver the first critical capabilities and required controls.

- 003 Implement Scan markdown files in a directory for recent entries
- 004 Implement Extract important events, decisions, and insights

## wave-3

Expand feature coverage once the core path is in place.

- 005 Implement Generate structured daily digest reports
- 006 Implement Support for memory importance scoring
- 007 Implement Output in markdown and JSON formats

## wave-4

Harden, verify, and prepare the system for release.

- 008 Add integration and error-handling coverage

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
- 003 -> 008
- 004 -> 008
- 005 -> 008
- 006 -> 008
- 007 -> 008

## Critical Path

001 -> 002 -> 003 -> 008
