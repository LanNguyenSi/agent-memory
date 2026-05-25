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

## Adding a memory to memory-router

When you add a memory to the user's real corpus (or change topics/frontmatter on an existing one), run the coverage suite and decide whether to extend the labelled fixture:

```bash
cd packages/memory-router
npm test  # includes tests/coverage/real-corpus.test.ts
```

The suite emits a `# coverage:` summary line (match-rate, mean hits/prompt, false-negative + false-positive counts). If the new memory's topics overlap with prompts already in `tests/coverage/prompts.fixture.json`, the suite's aggregate numbers shift; that's the regression net working. If the new memory introduces a behaviour not covered, add a labelled prompt to the fixture so future scoring or topic changes can't silently drop it.

The fixture and the corpus under `tests/coverage/corpus/` are **synthetic**. Never paste a real user prompt or a real-corpus memory body in there: they can leak credentials, host names, or session content. For ad-hoc dogfooding against the real corpus, point `MEMORY_ROUTER_COVERAGE_CORPUS_DIR` at the real memory dir locally; that path is uncommitted by design.

## Style

Match the surrounding code. Prefer small, reviewable diffs.

## Releasing

Each package is published independently under the `@lannguyensi/...` scope. The flow for `memory-router` (other packages will follow the same shape once their workflows land):

1. Bump `packages/memory-router/package.json` version on a release branch.
2. Add a `## [<version>] - YYYY-MM-DD` entry at the top of `packages/memory-router/CHANGELOG.md` with the user-visible changes.
3. Open a PR titled `release(memory-router): vX.Y.Z`, get it reviewed and merged.
4. From `master`, push the version tag **on its own**:
   ```bash
   git checkout master && git pull --ff-only
   git tag memory-router-v0.1.0
   git push origin memory-router-v0.1.0
   ```
   GitHub coalesces a multi-tag push into a single push event, so pushing `t1 t2 t3` in one command fires the workflow only once. Tag pushes must be one-at-a-time.
5. The `Publish memory-router to npm` workflow runs version + name + native-dep checks, builds, tests, and publishes with `--provenance`. `Release` runs in parallel and creates a GitHub Release using the matching CHANGELOG section.

`NPM_TOKEN` must be configured as a repository secret before the first publish. The publish workflow's preflight step fails loudly if it is missing.
