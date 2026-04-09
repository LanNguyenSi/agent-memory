# Task 004: Implement extract decisions, lessons, and key events using heuristic analysis

## Category

feature

## Priority

P0

## Wave

wave-2

## Delivery Phase

implementation

## Depends On

- 001
- 002

## Blocks

- 009

## Summary

Design and implement the capability for: extract decisions, lessons, and key events using heuristic analysis.

## Problem

The product cannot satisfy its initial scope until extract decisions, lessons, and key events using heuristic analysis exists as a reviewable, testable capability.

## Solution

Add a focused module for extract decisions, lessons, and key events using heuristic analysis that matches the recommended modular monolith and keeps integration boundaries explicit.

## Files To Create Or Modify

- lib/audit/types.ts — AuditEntry, AuditAction interfaces
- lib/audit/service.ts — Log audit events, query audit trail
- lib/audit/middleware.ts — Automatic audit logging for mutations
- app/api/audit/route.ts — GET audit trail with filters
- app/admin/audit/page.tsx — Audit log viewer page
- prisma/schema.prisma — AuditLog model with actor, action, resource, timestamp
- tests/audit/service.test.ts — Audit logging tests

## Acceptance Criteria

- [ ] The extract decisions, lessons, and key events using heuristic analysis capability is available through the intended application surface.
- [ ] Core validation, error handling, and persistence for extract decisions, lessons, and key events using heuristic analysis are covered by tests.

## Implementation Notes

- Start from domain rules and access constraints before UI or transport details.
- Keep module boundaries explicit so later extraction remains possible if the system grows.
- Update docs and tests in the same change instead of leaving them for cleanup.
