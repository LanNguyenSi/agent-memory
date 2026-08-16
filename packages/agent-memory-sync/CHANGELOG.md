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
