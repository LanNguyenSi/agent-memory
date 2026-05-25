---
name: user-profile
description: Synthetic user-profile memory with no topics — never fires on topic gate.
type: user
---

Synthetic fixture — stand-in for an unscoped user-profile memory. Carries no `topics:` so the Topic Gate cannot match it on any prompt. The Confidence Gate (out of scope for this CI suite) is the only path that could surface it.

**How to apply:** never via the Topic Gate — that's the point of including it in the corpus.
