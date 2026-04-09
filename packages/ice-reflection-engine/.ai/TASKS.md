# TASKS

## Critical Path

001 -> 002 -> 003 -> 009

## wave-1

Lock scope, assumptions, and engineering baseline.

### 001 Write project charter and architecture baseline

- Priority: P0
- Category: foundation
- Depends on: none
- Summary: Capture the product scope, users, constraints, architecture shape, and open questions.

### 002 Set up repository and delivery baseline

- Priority: P0
- Category: foundation
- Depends on: 001
- Summary: Create the repository structure, quality checks, and basic documentation needed for implementation.

## wave-2

Deliver the first critical capabilities and required controls.

### 003 Implement scan daily memory files in configurable directory

- Priority: P0
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: scan daily memory files in configurable directory.

### 004 Implement extract decisions, lessons, and key events using heuristic analysis

- Priority: P0
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: extract decisions, lessons, and key events using heuristic analysis.

## wave-3

Expand feature coverage once the core path is in place.

### 005 Implement score entries by significance and recency

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: score entries by significance and recency.

### 006 Implement write distilled summaries to MEMORY.md without overwriting existing content

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: write distilled summaries to MEMORY.md without overwriting existing content.

### 007 Implement dry-run mode to preview changes before writing

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: dry-run mode to preview changes before writing.

### 008 Implement configurable significance threshold

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: configurable significance threshold.

## wave-4

Harden, verify, and prepare the system for release.

### 009 Add integration and error-handling coverage

- Priority: P1
- Category: quality
- Depends on: 003, 004, 005, 006, 007, 008
- Summary: Verify the critical path, failure handling, and integration boundaries with tests.
