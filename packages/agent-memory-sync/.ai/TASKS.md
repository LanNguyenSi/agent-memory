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

### 003 Implement push local memory files to remote git repo

- Priority: P0
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: push local memory files to remote git repo.

### 004 Implement pull and merge memory from remote

- Priority: P0
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: pull and merge memory from remote.

## wave-3

Expand feature coverage once the core path is in place.

### 005 Implement conflict resolution for concurrent agent writes

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: conflict resolution for concurrent agent writes.

### 006 Implement configurable sync interval (cron-compatible)

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: configurable sync interval (cron-compatible).

### 007 Implement dry-run mode to preview changes before sync

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: dry-run mode to preview changes before sync.

## wave-4

Harden, verify, and prepare the system for release.

### 008 Add integration and error-handling coverage

- Priority: P1
- Category: quality
- Depends on: 003, 004, 005, 006, 007
- Summary: Verify the critical path, failure handling, and integration boundaries with tests.
