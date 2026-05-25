---
name: branch-naming
description: Branch names follow `<type>/<short-slug>` where type is one of feat, fix, chore, docs.
type: feedback
topics: [workflow]
severity: low
---

When cutting a new branch, use `<type>/<short-slug>` where type ∈ {feat, fix, chore, docs, refactor, test}. Slug is kebab-case, ≤ 6 words.

**Why:** synthetic fixture — generic branch-naming convention.
**How to apply:** when running `git checkout -b ...` for a new piece of work.
