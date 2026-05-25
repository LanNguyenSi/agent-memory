---
name: docker-compose-drift
description: Never leave deployment patches as uncommitted local mods on a VPS compose file.
type: feedback
topics: [deployment]
severity: critical
---

If a docker-compose.yml on a VPS has uncommitted local edits, either upstream them or move them into an override file. Never let drift between the repo and the deployed compose persist.

**Why:** synthetic fixture — stand-in for deployment-drift guardrails.
**How to apply:** when editing or inspecting a `docker-compose.yml` on a production host.
