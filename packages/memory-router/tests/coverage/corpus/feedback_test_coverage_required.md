---
name: test-coverage-required
description: New features land with tests; bug fixes land with a regression test.
type: feedback
topics: [testing]
severity: normal
---

A PR that adds behaviour without a corresponding test is incomplete. Bug fixes need a regression test that fails on the un-fixed code.

**Why:** synthetic fixture — generic testing-discipline guardrail.
**How to apply:** when writing or reviewing a PR that changes runtime behaviour.
