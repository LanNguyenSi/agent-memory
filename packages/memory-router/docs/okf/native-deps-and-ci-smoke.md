---
type: module
title: Native-dependency smoke check
description: Pointer doc. Why the CI matrix runs a dedicated native-addon load before typecheck/build, which matrix leg it exercises, and how its probe relates to the calls index-store.ts makes at runtime.
tags: [native-deps, ci-smoke, better-sqlite3, sqlite-vec]
timestamp: 2026-09-30T06:54:06Z
sources:
  - .github/workflows/ci.yml
  - packages/memory-router/package.json
  - packages/memory-router/src/embed/index-store.ts
  - packages/memory-router/tests/index-store.test.ts
  - packages/memory-router/README.md
---

# Native-dependency smoke check

See [README.md "Development"](../../README.md#development) for the
summary of what CI runs. This doc adds why the smoke check is a separate
step ahead of typecheck/build rather than being left to the test suite,
and what it does and does not cover.

## Why a separate, early step

`agent-memory`'s CI is a matrix over the packages listed in
`.github/workflows/ci.yml:24-27`. `memory-router` declares `better-sqlite3`
(sqlite) and `sqlite-vec` (its loadable extension) as dependencies
(`packages/memory-router/package.json`). The "Native-dep smoke" step in
`.github/workflows/ci.yml:47-51` runs right after `npm ci` and before
Typecheck/Build/Lint/Test, behind a shell `if` on `matrix.package` being
`memory-router` (a no-op on the other legs): a native addon's ABI
mismatch against the runner's Node version fails at `require()` time, not
at compile time, so running this probe first turns that failure into one
clearly-named CI step instead of a crash partway through the slower test
run that follows.

## What the probe checks

The step's command,
`` `node -e "const s = require('sqlite-vec'); const D = require('better-sqlite3'); const db = new D(':memory:'); s.load(db); console.log('native deps OK');"` `` (`.github/workflows/ci.yml:50`),
makes the same kinds of calls
`packages/memory-router/src/embed/index-store.ts` depends on: it requires
both modules (index-store.ts does so at module scope,
`packages/memory-router/src/embed/index-store.ts:81-82`, with the two
`require`s in the opposite order), constructs a database, and calls
`load` on it (index-store.ts does `new Database(...)` then
`sqliteVec.load(db)` per open,
`packages/memory-router/src/embed/index-store.ts:300-303`), against an
in-memory database instead of an index file. A green step shows that the
addons load and the extension attaches on that runner's Node, not only
that the packages installed.

## What it does not cover

The smoke check shows the addons load. It does not exercise the
schema-migration or embedding-provenance behavior layered on top inside
the same file (`packages/memory-router/src/embed/index-store.ts`) once a
real index is opened; those paths are exercised by
`packages/memory-router/tests/index-store.test.ts` and the coverage-gated
test suite, not by this step.
