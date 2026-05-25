---
name: vitest-mocks
description: vi.clearAllMocks does not drain mockResolvedValueOnce queues.
type: feedback
topics: [testing]
severity: normal
---

`vi.clearAllMocks()` resets call history but leaves queued `mockResolvedValueOnce` / `mockRejectedValueOnce` entries in place. Use `vi.resetAllMocks()` or `vi.restoreAllMocks()` in `afterEach` to actually drain the queue.

**Why:** synthetic fixture — stand-in for vitest-specific testing gotchas.
**How to apply:** when writing or debugging vitest specs that use one-shot mocks.
