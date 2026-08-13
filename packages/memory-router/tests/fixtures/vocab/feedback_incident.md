---
name: incident memory
description: Fires only when the custom vocabulary from this dir's topics.yml is loaded
type: feedback
topics: [incident_response]
---

Only matches when `topics.yml` at this directory is actually consulted for
the topic vocabulary. Proves that `--dir` (or `ctx.memoryDir`) decides which
vocabulary applies, not a stray ambient `MEMORY_ROUTER_DIR` env var
(mm-v1-T002 review round 2, fix 1).
