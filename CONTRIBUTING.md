# Contributing to agent-memory

Thanks for your interest. This is a TypeScript monorepo of small, independent memory tools.

## Issues

- Bug reports: include repro steps, expected vs. actual, Node version, package name (`packages/<tool>`).
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `master` (e.g. `feat/memory-router-cli-test`, `fix/digest-import-loop`).
2. Keep changes scoped to one package where possible.
3. Run the package's local checks (`npm run build`, `npm test`) inside the changed package.
4. For `memory-router/src/hooks/*` and Gate-logic changes, the per-package checks are not enough on their own; the dogfood step below is load-bearing.
5. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/agent-memory
cd agent-memory/packages/<tool>
npm install
npm run build
npm test
```

Each package is self-contained, no root install.

## Dogfooding hook changes

When changing anything under `packages/memory-router/src/hooks/*` or the Gate logic, validate against the actual `~/.claude/projects/-home-lan-git-pandora/memory/` directory, not just test fixtures. After `npm run build` in `packages/memory-router/`, pipe a real prompt through the hook with `MEMORY_ROUTER_DIR` pointing at the user's memory dir and verify the positive case emits `hookSpecificOutput.additionalContext` while the negative case exits clean. See [packages/memory-router/README.md](packages/memory-router/README.md) for hook wiring and the trust model.

## Style

Match the surrounding code. Prefer small, reviewable diffs.
