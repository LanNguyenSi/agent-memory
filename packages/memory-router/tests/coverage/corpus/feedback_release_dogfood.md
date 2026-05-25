---
name: release-dogfood
description: Before tagging a release, dogfood it end-to-end against a live system.
type: feedback
topics: [deployment, testing]
severity: normal
---

Don't tag a release that hasn't been exercised against a live system. Run the binary, hit the API, watch one full request cycle. Tests alone are not enough.

**Why:** synthetic fixture — generic release-readiness pattern.
**How to apply:** before any version bump or git tag.
