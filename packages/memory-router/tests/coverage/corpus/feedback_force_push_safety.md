---
name: force-push-safety
description: Force-push to shared branches requires explicit operator confirmation.
type: feedback
topics: [destructive_ops, workflow]
severity: critical
---

Never `git push --force` to main, master, or any shared branch without explicit operator confirmation. Use `--force-with-lease` for personal feature branches only.

**Why:** synthetic fixture — placeholder for the family of "destructive git op" guardrails.
**How to apply:** when about to run `git push --force` or `git reset --hard` against a shared ref.
