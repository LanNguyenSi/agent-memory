---
name: rebase-preferred
description: Prefer rebase over merge commits on short-lived feature branches.
type: feedback
topics: [workflow]
severity: normal
---

Rebase feature branches onto master rather than producing merge commits. Linear history makes bisect easier and keeps the log readable.

**Why:** synthetic fixture — generic git-workflow preference.
**How to apply:** when integrating a short-lived branch back into master.
