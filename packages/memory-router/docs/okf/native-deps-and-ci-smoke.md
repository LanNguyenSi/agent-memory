---
type: module
title: Native-dependency smoke check
description: Pointer doc. Why the CI matrix runs a dedicated native-addon load before typecheck/build, which matrix legs it actually exercises, and how its two-line probe maps onto the exact calls index-store.ts makes at runtime.
tags: [native-deps, ci-smoke, better-sqlite3, sqlite-vec]
timestamp: 2026-09-27T14:48:54Z
sources:
  - .github/workflows/ci.yml
  - packages/memory-router/src/embed/index-store.ts
  - packages/memory-router/tests/index-store.test.ts
  - packages/memory-router/README.md
---

# Native-dependency smoke check

See [README.md "Development"](../../README.md#development) for the one-line
summary of what CI runs. This doc states only what that line does not: why
the smoke check is a separate step ahead of typecheck/build rather than
being left to the test suite, and exactly what it does and does not cover.

## Why a separate, early step

`agent-memory` is a matrix build over independent packages
(`packages/agent-memory-sync`, `packages/memory-digest-cli`,
`packages/memory-router`); only `memory-router` links a native addon
(`better-sqlite3` for sqlite, `sqlite-vec` as its loadable extension). The
"Native-dep smoke" step in `.github/workflows/ci.yml:47-51` runs
immediately after `npm ci` and before Typecheck/Build/Lint/Test, gated on
`matrix.package == 'memory-router'` (a no-op for the other two legs): a
native addon's ABI mismatch against the runner's Node version fails at
`require()` time, not at compile time, so running this probe first turns
that failure into one clearly-named CI step instead of an opaque crash
partway through the (much slower) test run that follows.

## What the probe actually checks

The step's command,
`` `node -e "const s = require('sqlite-vec'); const D = require('better-sqlite3'); const db = new D(':memory:'); s.load(db); console.log('native deps OK');"` `` (`.github/workflows/ci.yml:50`),
is not an arbitrary probe: it is the same load sequence
`packages/memory-router/src/embed/index-store.ts` runs on every real
`openIndex()` call, `require('better-sqlite3')` and `require('sqlite-vec')`
at module scope (`packages/memory-router/src/embed/index-store.ts:81-82`),
then `new Database(...)` followed by `sqliteVec.load(db)` per open
(`packages/memory-router/src/embed/index-store.ts:300-303`), just against
an in-memory database instead of a real index file. A green smoke step is
therefore a direct guarantee that the exact require/instantiate/load
sequence the embedding-index and query-cache code path depends on works on
that runner, not merely that the packages installed without error.

## What it does not cover

The smoke check only proves the addon loads. It says nothing about the
schema-migration or embedding-provenance behavior layered on top inside
the same file (`packages/memory-router/src/embed/index-store.ts`) once a
real index is opened; those paths are exercised by
`packages/memory-router/tests/index-store.test.ts` and the coverage-gated
test suite, not by this step.
