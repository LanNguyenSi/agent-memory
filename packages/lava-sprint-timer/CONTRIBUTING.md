# Contributing to lava-sprint-timer

Thanks for your interest! This is a small focused tool — contributions welcome.

## Setup

```bash
git clone https://github.com/LanNguyenSi/lava-sprint-timer
cd lava-sprint-timer
npm install
npm run build
npm test
```

## Guidelines

- Keep it small. This tool does one thing: track focus sessions and commit their end.
- Tests for new behavior. `npm test` must pass.
- TypeScript strict mode — no `any`.
- PRs should explain: what problem does this change solve?

## Ideas welcome

- Better CURRENT.md parsing heuristics
- Multiple timer modes (deep work, meeting, etc.)
- Integration with other log formats

## Running locally

```bash
npm run build
node dist/cli.js start
node dist/cli.js status
node dist/cli.js end --message "what I did"
```
