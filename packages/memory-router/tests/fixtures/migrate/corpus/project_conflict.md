---
name: conflict case
description: top-level type must win over metadata
type: project
metadata:
  type: user
---

Top-level type must never be overwritten by metadata.type, even
though metadata disagrees with it.
