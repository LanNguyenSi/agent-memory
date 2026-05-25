---
name: deploy-checklist
description: VPS deploys require an env-file backup and compose-file preflight.
type: feedback
topics: [deployment]
severity: normal
---

Before any VPS deploy: snapshot the existing `.env`, confirm the compose file matches the production override, and dry-run the migration.

**Why:** synthetic fixture — stand-in for deploy-time guardrails.
**How to apply:** any time the prompt mentions deploying, releasing, or rolling back a service.
