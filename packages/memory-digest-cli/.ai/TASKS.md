# TASKS

## Critical Path

001 -> 002 -> 003 -> 008

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

### 003 Implement Scan markdown files in a directory for recent entries

- Priority: P0
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Scan markdown files in a directory for recent entries.

### 004 Implement Extract important events, decisions, and insights

- Priority: P0
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Extract important events, decisions, and insights.

## wave-3

Expand feature coverage once the core path is in place.

### 005 Implement Generate structured daily digest reports

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Generate structured daily digest reports.

### 006 Implement Support for memory importance scoring

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Support for memory importance scoring.

### 007 Implement Output in markdown and JSON formats

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Output in markdown and JSON formats.

## wave-4

Harden, verify, and prepare the system for release.

### 008 Add integration and error-handling coverage

- Priority: P1
- Category: quality
- Depends on: 003, 004, 005, 006, 007
- Summary: Verify the critical path, failure handling, and integration boundaries with tests.
