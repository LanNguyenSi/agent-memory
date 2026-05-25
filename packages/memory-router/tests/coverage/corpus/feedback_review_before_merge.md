---
name: review-before-merge
description: Review every PR with a subagent before merging, even small ones.
type: feedback
topics: [workflow]
severity: critical
---

Every PR must go through the review subagent workflow before merge: create PR, transition to review, spawn reviewer, fix findings, then merge.

**Why:** synthetic fixture — stands in for the real "always run review" pattern without leaking real-corpus content.
**How to apply:** every PR, no exceptions, not even for docs or batch jobs.
