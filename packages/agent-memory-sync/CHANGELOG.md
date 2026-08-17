# Changelog

All notable changes to `agent-memory-sync` are recorded here. This is a
private, internal-only tool (not published to npm; see `package.json`), so
there is no semver release process to anchor entries to — each entry below
is dated instead. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- `watch --verbose` now prints `watch tick pushing snapshot` to stderr the instant a tick starts the git push work, instead of staying silent until the tick's result is known.
- `withTickDeadline` (test helper) gained an inactivity mode: it resets its deadline on either the ready line or the new push-start line, so a per-tick test budget bounds the gap since the last observed signal instead of the tick's total duration. A second, independent absolute cap (2.5x the inactivity budget) still bounds a tick that keeps signaling forever, failing with a distinct message.
- A pre-existing failure class under this package's documented load scenario stalls before either progress signal can fire: a chokidar filesystem-event delivery issue under CPU contention, present at the merge base too, at roughly a 30-40% failure rate under load on both. No timeout size fixes this; it is out of scope for this change and tracked as a follow-up.
- New unit tests in `tests/unit/watch-process-inactivity.test.ts` pin the inactivity and absolute-cap semantics directly, without a real spawn.
- Root-caused (but did not fix, see below) the follow-up above (agent-tasks f876dff6). Isolated outside chokidar entirely (a standalone script, no test harness), a bare `fs.watch()` on macOS can permanently miss a write issued <1ms after the watch is reported armed — Node's own documented, currently-unfixed behavior (nodejs/node#52601), not a chokidar bug; chokidar 4.x (this package's version) uses neither `fsevents` nor polling by default, so neither of that follow-up's original "polling vs fsevents" or "atomic-write visibility" candidates were actually in play. A second candidate mechanism — the parent test-runner process's own delayed reading of the child's stderr pipe under load — was measured and ruled out: p99 9ms / max 11ms across 600 samples under load, far too small to account for missing a 90s budget. Against this package's own documented 10-worker load scenario, the historical 30-40% stall did not reproduce: a 2026-08-16/17 measurement ran the scenario 5/5 green on the merge base, both idle and under load. No retry/workaround code was added as a result — the failure this task originally investigated is not currently reproducible, and speculative retry logic tried in an earlier iteration of this task was found on review to add a deterministic regression for no measurable benefit, so it was removed again. The one behavior change kept: `spawnWatch` (test helper) now spawns its child with stdout `'ignore'` instead of an unread `'pipe'`, since nothing reads it and an unread pipe backs up once the child writes past the OS pipe buffer (64KB), which would otherwise look exactly like an unexplained stall. See `tests/helpers/watch-process.ts`'s header comment and `src/commands/watch.ts`'s ready-line comment for the full measurement notes.
