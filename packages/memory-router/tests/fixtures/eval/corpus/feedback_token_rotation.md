---
name: Rotate leaked tokens immediately
description: A leaked API token must be rotated, not just removed from the diff
type: feedback
topics: [security]
severity: critical
---

If a token or secret ever leaks (committed, logged, pasted), rotate it
immediately. Removing the leaked value from a future commit is not enough,
the old value stays valid until it's rotated.
