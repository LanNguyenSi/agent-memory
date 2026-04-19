---
name: Stacked PR base
description: Retarget child PR to master before merge
type: feedback
topics: [workflow]
severity: critical
triggers:
  keywords: [merge, PR, rebase]
---

Before merging a stacked child PR, retarget its base to master. Otherwise
the changes silently land in an orphan branch.

**Why:** past incident where a stacked merge shipped nothing to master.
**How to apply:** every time a PR lists another branch as its base.
