# Task 004: Implement Extract important events, decisions, and insights

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

- 008

## Summary

Design and implement the capability for: Extract important events, decisions, and insights.

## Problem

The product cannot satisfy its initial scope until Extract important events, decisions, and insights exists as a reviewable, testable capability.

## Solution

Add a focused module for Extract important events, decisions, and insights that matches the recommended modular monolith and keeps integration boundaries explicit.

## Files To Create Or Modify

- lib/audit/types.ts — AuditEntry, AuditAction interfaces
- lib/audit/service.ts — Log audit events, query audit trail
- lib/audit/middleware.ts — Automatic audit logging for mutations
- app/api/audit/route.ts — GET audit trail with filters
- app/admin/audit/page.tsx — Audit log viewer page
- prisma/schema.prisma — AuditLog model with actor, action, resource, timestamp
- tests/audit/service.test.ts — Audit logging tests

## Acceptance Criteria

- [ ] The Extract important events, decisions, and insights capability is available through the intended application surface.
- [ ] Core validation, error handling, and persistence for Extract important events, decisions, and insights are covered by tests.

## Implementation Notes

- Start from domain rules and access constraints before UI or transport details.
- Keep module boundaries explicit so later extraction remains possible if the system grows.
- Update docs and tests in the same change instead of leaving them for cleanup.
