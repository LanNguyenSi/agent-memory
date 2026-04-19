---
name: No force-push to shared branches
description: Force-push on master/main overwrites history
type: feedback
topics: [destructive_ops]
severity: critical
triggers:
  command_pattern: "git\\s+push\\s+.*--force|git\\s+push\\s+-f\\b"
---

Never force-push to master or main. Always warn the user and confirm
before running this.

**Why:** destroys upstream history, easy to lose work.
**How to apply:** block on `git push --force` / `-f` against shared refs.
