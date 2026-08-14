---
name: stale ref example
description: references a path that does not exist under the configured repo root
type: reference
topics: [testing]
verify:
  - kind: path
    value: does/not/exist.ts
---

This memory declares a verify: path ref that is stale against any repoRoot used in tests.
