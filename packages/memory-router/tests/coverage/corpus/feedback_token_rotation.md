---
name: token-rotation
description: Rotate any leaked token or credential within one hour of discovery.
type: feedback
topics: [security]
severity: critical
---

When a token, API key, or password is discovered in a commit, log, screenshot, or message, rotate it within an hour and document the rotation in the incident log.

**Why:** synthetic fixture — generic secrets-hygiene guardrail.
**How to apply:** any prompt mentioning secrets, tokens, credentials, auth keys.
