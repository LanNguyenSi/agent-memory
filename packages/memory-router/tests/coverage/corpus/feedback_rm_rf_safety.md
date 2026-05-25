---
name: rm-rf-safety
description: rm -rf must always have an absolute path and operator confirmation.
type: feedback
topics: [destructive_ops]
severity: critical
---

Never run `rm -rf` with a relative path or unexpanded shell variable. Use absolute paths and confirm the target with the operator before running.

**Why:** synthetic fixture — generic destructive-op guardrail.
**How to apply:** when about to run `rm -rf` from any script or shell session.
