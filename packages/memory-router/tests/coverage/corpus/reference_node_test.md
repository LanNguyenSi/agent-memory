---
name: node-test-runner
description: This repo uses node:test, not jest or vitest.
type: reference
topics: [testing]
---

Test files live under `tests/`, end in `.test.ts`, and run via `node --import tsx --test`. No vitest, no jest. Subtests use `t.test(...)`. Assertions come from `node:assert/strict`.

**Why:** synthetic fixture — placeholder for runner-choice reference memories.
**How to apply:** when authoring or reading test files in memory-router.
