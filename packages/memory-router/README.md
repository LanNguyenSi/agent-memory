# memory-router

**Deterministic memory injection for Claude Code.** Loads your `~/.claude/projects/*/memory/*.md` files and injects the relevant ones into a session whenever the prompt or a pending tool call matches their declared triggers. The agent cannot accidentally skip a memory.

> Most memory tooling loads your notes and hopes the model notices. `memory-router` replaces that judgment with deterministic enforcement: when the trigger fires, the memory is injected, full stop. Critical rules ("never force-push to master", "VPS deploy needs `-f docker-compose.prod.yml`") stop being suggestions and start being part of the system prompt.

## Try it in 60 seconds

```bash
git clone https://github.com/LanNguyenSi/agent-memory
cd agent-memory/packages/memory-router
npm install && npm run build

# Tiny scratch corpus so the demo doesn't touch your real memory dir.
mkdir -p /tmp/memory-router-demo
cat > /tmp/memory-router-demo/feedback_force_push.md <<'EOF'
---
name: No force-push to shared branches
description: Force-push on master/main overwrites history
type: feedback
topics: [destructive_ops]
severity: critical
---

NEVER force-push to master or main. The history is shared; rewriting
it costs every collaborator a hard reset and loses uncommitted work.
For local-branch fixes, prefer a fixup commit + interactive rebase
before push.
EOF

# Positive: prompt mentions force-push, the topic gate fires, the memory
# is injected.
echo '{"prompt":"can I git push --force to master to fix this?"}' \
  | MEMORY_ROUTER_DIR=/tmp/memory-router-demo \
    node dist/hooks/user-prompt-submit.js

# Negative: nothing matches, stdout stays empty (Claude's context stays clean).
echo '{"prompt":"rename foo to bar"}' \
  | MEMORY_ROUTER_DIR=/tmp/memory-router-demo \
    node dist/hooks/user-prompt-submit.js
```

## What a run looks like

The positive prompt prints one line of JSON on stdout:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"**memory-router** — 1 relevant memory applies:\n\n### No force-push to shared branches  _(topic · 1.00)_\nNEVER force-push to master or main. The history is shared; rewriting\nit costs every collaborator a hard reset and loses uncommitted work.\nFor local-branch fixes, prefer a fixup commit + interactive rebase\nbefore push."}}
```

Claude Code consumes that contract on every prompt and injects `additionalContext` as system context for the model. The negative prompt prints nothing and exits 0: when no gate fires, stdout stays empty so the context window stays clean.

The same scratch corpus works through `memory-router lint` (drift / topics / conflict checks), `memory-router stale --repo-root <path>` (stale path / symbol references), and the MCP server (`memory_search`, `memory_resolve`). The wiring for all of those is below.

## Install

From npm:

```bash
npm install -g @lannguyensi/memory-router
```

Or from source:

```bash
git clone https://github.com/LanNguyenSi/agent-memory
cd agent-memory/packages/memory-router
npm install && npm run build
```

The `bin/` entries land in `node_modules/.bin/` (and on `PATH` for a global install or `npm link`):

| Bin | Purpose |
|-----|---------|
| `memory-router` | CLI: `tag`, `index`, `lint`, `stale` |
| `memory-router-user-prompt-submit` | Claude Code `UserPromptSubmit` hook |
| `memory-router-pre-tool-use` | Claude Code `PreToolUse` hook |
| `memory-router-mcp` | MCP server for explicit `memory_search` / `memory_resolve` calls |

## How it works

memory-router runs three gates in parallel, dedupes hits by memory id, keeps the highest-scoring hit per memory, and caps the output at N (default 5).

| Gate | Signal | When it fires |
|------|--------|---------------|
| **Topic** | Keyword dictionary mapped to memory `topics:` | Prompt contains `deploy`, `merge`, `rm -rf`, `force-push`, etc., and matches every memory tagged with that topic |
| **Tool** | `PreToolUse` hook against memory `triggers.command_pattern` and `triggers.tools` | Before `Bash(git push --force)`, `Bash(docker compose up)`, etc., a regex match on the planned command |
| **Confidence** | Ambiguity heuristic on the prompt + sqlite-vec semantic search | Fallback: short or vague prompts lower the threshold so semantic matches fire as a safety net |

## Memory Frontmatter Extension

Existing Claude Code memory files already use YAML frontmatter. memory-router adds four optional fields:

```yaml
---
name: No force-push to shared branches
description: Force-push on master/main overwrites history
type: feedback
topics: [destructive_ops]           # enables Topic Gate
severity: critical                  # critical | normal | low
triggers:                           # enables Tool Gate
  command_pattern: "git\\s+push\\s+.*--force"
  tools: [Bash]
  keywords: [force-push]
  globs: ["**/*.sh"]
verify:                             # stale-marker check on recall
  - kind: path
    value: packages/gh-push-guard/src/cli.ts
---

body markdown here
```

All new fields are optional. Legacy memories still load and can fire via the Confidence Gate (once wired) or via semantic match.

### Accepted frontmatter locations

Canonically, `type` and `topics` live top-level (as in the example above). Most real Claude Code auto-memories instead nest them under `metadata.` (in the reference corpus as of 2026-08, roughly 230 of 285 files carry only `metadata.type`). The loader accepts both locations; on conflict the top-level value wins. New tooling should write top-level. `type` must be one of `user`, `feedback`, `project`, `reference`: a file with an unknown or non-string type is skipped entirely (visible only with `MEMORY_ROUTER_DEBUG=1`), so a typo'd `type` removes that memory from all gates until `memory-router lint --drift` surfaces it.

### Topic vocabulary (`topics.yml`)

The Topic Gate's keyword → topic map ships a built-in 5-topic default (`deployment`, `destructive_ops`, `workflow`, `security`, `testing`, see `src/topic-patterns.ts`). A corpus can override it wholesale (replace, not merge) by dropping a `topics.yml` file at the root of `MEMORY_ROUTER_DIR`:

```yaml
# <MEMORY_ROUTER_DIR>/topics.yml
- name: deployment
  description: Deploys, releases, migrations, rollbacks.
  patterns:
    - '\bdeploy(?:ing|ed|ment)?\b'
    - '\brelease\b'
- name: incident_response
  description: Production incidents, outages, on-call escalation.
  patterns:
    - '\bincident\b'
    - '\boutage\b'
```

A fuller worked example (three custom topics, descriptions) is available at [`tests/fixtures/vocab/topics.yml`](https://github.com/LanNguyenSi/agent-memory/blob/master/packages/memory-router/tests/fixtures/vocab/topics.yml) in the repo; that path is source-tree only (not part of the published npm package), so treat it as an optional cross-reference; the inline block above is a complete, self-contained example on its own.

Shape: a top-level list of `{ name, description?, patterns? }` entries.

- `name` is required and must be unique across the file.
- `description` is optional, documentation only, not matched against.
- `patterns` is an optional list of regex strings, matched case-insensitively. A topic declared with no `patterns:` at all, whose one pattern fails to compile, or whose pattern is rejected by the ReDoS safety screen (see [Trust Model](#trust-model)) degrades to a keyword match on its own `name` rather than being dropped or crashing anything.

Both the Topic Gate and `memory-router lint --unknown-topics` load and validate against whatever `topics.yml` resolves to:

- **Missing file:** the built-in 5-topic default, unchanged.
- **Present and valid:** the corpus vocabulary, corpus-wide, fully replacing the default: a memory tagged `security` under a custom vocabulary that doesn't declare a `security` entry will not match on that topic anymore.
- **Present and invalid** (YAML error, missing/duplicate `name`, wrong field shape): rejected with a clear error message.
  - The **Topic Gate** never crashes over it, it degrades silently to the built-in default: the `UserPromptSubmit` hook must never block a prompt over a broken corpus file. Set `MEMORY_ROUTER_DEBUG=1` to see the rejection reason on stderr.
  - `memory-router lint --unknown-topics` also falls back to the built-in default for the scan itself, but prints the rejection reason at the top of its report instead of hiding it.

`Topic` is a plain string at the type level; there is no compiled-in closed set left to extend in source. What counts as a known topic is resolved at load time against whichever vocabulary is active, not enforced by TypeScript.

### `verify:` stale-marker on recall

A memory that names a concrete file, symbol, or flag is making a claim about the current repo state. Memories don't self-update: a file renamed or deleted leaves the memory silently wrong. When a matched memory has `verify:` entries and any `kind: path` entry no longer exists on disk, the router prefixes the memory's injected context with:

```
> ⚠️ **stale:** path '...' not found at ...
>
> This memory references something that no longer exists. Verify before acting.
```

The memory is **not** suppressed. The agent still sees the rule, just with the warning that something underneath has changed.

- `kind: 'path'` is checked inline via `fs.statSync`. Relative values resolve against `repoRoot` (default `process.cwd()`) and must stay inside it.
- `kind: 'symbol' | 'flag'` is accepted in the shape but skipped inline (the hook stays zero-dep and sub-10 ms). Use the `verify_memory_reference` MCP tool from [agent-grounding/grounding-mcp](https://github.com/LanNguyenSi/agent-grounding/tree/master/packages/grounding-mcp) for those, or the proactive `memory-router stale` command described below.

## Usage

### As a Claude-Code hook

Wire the two hook binaries in your `~/.claude/settings.json`:

```json
{
  "env": {
    "MEMORY_ROUTER_DIR": "/home/you/.claude/projects/YOURPROJECT/memory"
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [{
          "type": "command",
          "command": "memory-router-user-prompt-submit"
        }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "memory-router-pre-tool-use"
        }]
      }
    ]
  }
}
```

Both binaries consume Claude-Code's hook stdin contract and emit

```json
{ "hookSpecificOutput": { "additionalContext": "<rendered markdown>" } }
```

on stdout, Claude Code injects `additionalContext` as system context for the model. When no gate fires, stdout stays empty to keep the model's context clean.

### As an MCP server (imperative queries)

The hook auto-injects memories on every prompt. For the "check if there's a memory about X before I proceed" pattern, wire memory-router as a Claude-Code MCP server and call it explicitly from a session:

```json
{
  "mcpServers": {
    "memory-router": {
      "command": "memory-router-mcp",
      "env": {
        "MEMORY_ROUTER_DIR": "/home/you/.claude/projects/YOURPROJECT/memory",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Exposes three tools:

| Tool | Use |
|------|-----|
| `memory_search(query, k?)` | Raw semantic hits from the sqlite-vec index. Returns `[]` if the index is missing or no embedding provider is configured/reachable (see "Embedding provider"). |
| `memory_resolve(prompt, cwd?, tool?)` | Full router (topic + tool + confidence), same hit shape the UserPromptSubmit hook would inject. Confidence gate only runs when the sync gates miss. |
| `memory_apply(id)` | Fetch the full body of a single memory by id (filename without extension). `isError: true` when the id doesn't exist. |

All three are stateless and read-only, write tools (`memory_create`, `memory_update`) stay out of scope until the `tag` CLI is proven enough to move under an agent.

Trust model matches the hook: `MEMORY_ROUTER_DIR` is treated as author-trusted (see [Trust Model](#trust-model)). The MCP server surfaces memory bodies verbatim, any risk from a compromised memory file (ReDoS in a `command_pattern`, misleading body content) is identical to what the hook would inject.

### Migrating existing memories

Legacy memory files (`name`/`description`/`type` only) never fire through the router, they're missing `topics:` and `triggers:`. The `memory-router tag` CLI proposes those fields based on a scored keyword match (name 3×, description 2×, body 1×; top 2 topics per file; minimum score 3):

```bash
# Dry-run, prints a diff per file and a stderr hint block for bodies that
# mention dangerous shell commands worth a Tool-Gate trigger.
memory-router tag ~/.claude/projects/PROJECT/memory

# Commit the changes.
memory-router tag ~/.claude/projects/PROJECT/memory --apply

# Limit to a single file.
memory-router tag ~/.claude/projects/PROJECT/memory --only feedback_stacked_pr_base
```

Idempotent, re-running is a no-op on files already tagged. Existing frontmatter is preserved; only `topics` and `severity` are added when missing. `triggers.command_pattern` is never auto-generated (too risky); candidates are printed to stderr for manual review.

### Building the embedding index

The Confidence Gate's semantic match requires a one-time index build:

```bash
OPENAI_API_KEY=sk-... memory-router index ~/.claude/projects/PROJECT/memory
```

- Stores embeddings under `<dir>/.memory-router/index.sqlite` via sqlite-vec (cosine distance).
- Re-runs are incremental, unchanged files (by mtime) are skipped, removed files are purged.
- If no provider is configured/reachable, the Confidence Gate silently returns no hits; the Topic and Tool Gates still fire.

The hook never builds the index inline, cold-start latency would block every prompt by seconds. Run `memory-router index` manually or wire it into a cron/agent-memory-sync post-sync step.

#### Embedding provider

The embedder is configurable, so the semantic path works on a machine with no OpenAI key:

| Selection | How | Model default | Auth |
| --- | --- | --- | --- |
| Explicit OpenAI | `MEMORY_ROUTER_EMBED_PROVIDER=openai` | `text-embedding-3-small` | `OPENAI_API_KEY` |
| Explicit Ollama | `MEMORY_ROUTER_EMBED_PROVIDER=ollama` | `nomic-embed-text` | none |
| Auto-detect | unset | `OPENAI_API_KEY` present → OpenAI; otherwise → Ollama | as above |

`MEMORY_ROUTER_EMBED_PROVIDER` is case-insensitive; an unrecognized value is treated as unset (falls through to auto-detect) rather than erroring. An explicit `openai` selection with no `OPENAI_API_KEY` fails open (same as today), it never silently substitutes Ollama.

Overrides, both providers:

- `MEMORY_ROUTER_EMBED_MODEL` — model name for whichever provider is active.
- `OPENAI_BASE_URL` — OpenAI-compatible proxy base URL (OpenAI path only).
- `MEMORY_ROUTER_OLLAMA_BASE_URL` — Ollama base URL, default `http://localhost:11434`. Ollama is queried through its OpenAI-compatible `/v1/embeddings` endpoint, unauthenticated.

Embedding dimensionality is never hardcoded: it's read off the first real embed response and recorded in the index alongside the provider and model. An index queried under a different provider (or, rarely, a different dimensionality under the same provider) refuses to silently compare incompatible vector spaces — `memory-router index`/the Confidence Gate raise an error naming the exact rebuild command (`rm -rf <dir>/.memory-router && memory-router index <dir>`) instead of returning wrong neighbours. Switching `MEMORY_ROUTER_EMBED_MODEL` between two models of the *same* provider (e.g. two OpenAI models) is unaffected by this check — the existing per-memory model tag already excludes stale rows from a search, no rebuild required.

Local Ollama setup: `ollama pull nomic-embed-text`, then run `ollama serve` (or use the app) before `memory-router index`/normal hook usage.

#### Query-embedding cache

Repeated vague prompts (`"mal schauen"`, `"check mal"`) re-pay one OpenAI embedding call (~150–300 ms + ~$0.00002) every time the Confidence Gate fires. The router memoizes prompt → embedding in the same `index.sqlite` file under a `query_cache` table:

- **Key:** sha256(prompt) prefix (8 bytes, plenty for the LRU cap).
- **Eviction:** LRU by `accessed_at`, hard cap of 1000 entries. Switching `MEMORY_ROUTER_EMBED_MODEL` lazily evicts entries stored under the previous model on the next put.
- **Persistence:** survives hook process restarts (the file is the only state).
- **Observability:** set `MEMORY_ROUTER_DEBUG=1` to see `[memory-router] query cache hit (size=N)` / `[memory-router] query cache miss — embedding (size=N)` lines on stderr without polluting the hook's stdout contract. Same `[memory-router]` prefix as loader rejection warnings, so `grep '^\[memory-router\]'` catches every gated diagnostic.

No flag turns the cache off, it's always on when the Confidence Gate is. `memory-router index` does not touch the cache; only switching embed models does.

### Debugging rejected memories

The loader silently skips memory files with broken YAML frontmatter or missing required fields (`name`, `type`). That is the right default for production hooks (one bad memory must not kill the whole session), but it means a memory author can't tell the file is dead weight without dogfooding.

Set `MEMORY_ROUTER_DEBUG=1` to make the loader print one stderr line per rejected memory, e.g.:

```
[memory-router] skipped /path/to/feedback_yaml_form_quoting.md: YAML parse error: ...
[memory-router] skipped /path/to/legacy.md: missing required field 'name'
```

Stdout (the hook contract) is never touched, so the flag is safe to leave on while a hook is wired into Claude-Code. Each warning is exactly one `\n`-terminated line, even when the underlying YAML error spans multiple lines, so `grep '^\[memory-router\]'` always works.

### Keep MEMORY.md clean

`MEMORY.md` is the canonical index Claude-Code loads at session start. It drifts: pointers to deleted files, memory files never added to the index, duplicates, or a file that grows past the 200-line truncation cap (lines after 200 are silently dropped from context). The drift linter catches all of these before they cost you a missing recall in a real session:

```bash
# Dry-run, exits non-zero on any finding.
memory-router lint ~/.claude/projects/PROJECT/memory --drift

# Auto-apply safe fixes (append missing pointers, remove duplicate entries).
# Orphan pointers are never auto-deleted, might be intentional while a file
# is temporarily absent. Invalid frontmatter and duplicate names also need
# hand-review.
memory-router lint ~/.claude/projects/PROJECT/memory --drift --fix

# Machine-readable for CI.
memory-router lint ~/.claude/projects/PROJECT/memory --drift --json
```

Checks:
- **Orphan pointer**: MEMORY.md lists `file.md` but the file no longer exists.
- **Missing pointer**: a memory file exists in the dir but is not listed in MEMORY.md.
- **Duplicate entry**: the same filename appears twice in MEMORY.md.
- **Duplicate name**: two memory files share a frontmatter `name` (case-insensitive).
- **Length warning**: MEMORY.md > 200 lines (anything past line 200 is truncated by the runtime).
- **Invalid frontmatter**: missing `name`/`description`/`type`, unknown `type`, or YAML that fails to parse. The runtime loader silently drops such files, so they never fire through any gate.
- **Description too long**: frontmatter `description` > 150 chars; the same text is used as the MEMORY.md hook, where it would blow the one-line budget.

Without any check flag `lint` runs drift **and** the `--unknown-topics` frontmatter check; pass `--drift` or `--unknown-topics` to narrow. A third opt-in check, `--conflicts`, finds pairs of `feedback` memories that share a topic and may contradict each other:

```bash
memory-router lint ~/.claude/projects/PROJECT/memory --conflicts
```

The check runs two heuristics: topic overlap among `feedback` memories (INFO level, surface for human glance) and opposite-imperative pairs whose first body lines share substantial subject vocabulary (HIGH, e.g. "ALWAYS amend commits" vs "NEVER amend commits" both tagged `workflow`). Only HIGH findings exit non-zero, so a corpus with normal complementary advice still lets CI stay green. The check is opt-in (off by default) because INFO-level overlap is expected on a mature corpus and would otherwise flood the default `lint` run.

Add `--semantic` to catch paraphrased pairs the regex pass misses, e.g. "always squash before merge" vs "never squash, use fast-forward only": opposite polarity but no shared content tokens, so the Jaccard floor on the regex pass keeps them at INFO. With `--semantic` the linter embeds both memories' name+body and upgrades the pair to HIGH when cosine similarity >= 0.85:

```bash
OPENAI_API_KEY=sk-... memory-router lint ~/.claude/projects/PROJECT/memory --conflicts --semantic
```

Reuses the embedding cache the Confidence Gate already maintains in `~/.claude/projects/PROJECT/memory/.memory-router/index.sqlite` (built by `memory-router index`); pairs not yet in the index are embedded on the fly without persisting. When `OPENAI_API_KEY` is unset the semantic step prints a stderr warning and falls back to the regex-only signal, so CI without secrets stays green.

The polarity vocabulary covers ALL-CAPS and lowercase forms of `always`, `never`, `must`, `must not`, `do`, `do not`, `don't`, `prefer`, `require`, `avoid`, `skip`, plus formal-register markers `mandatory`, `mandate`, `compulsory`, `prohibit`, `forbid`, `disallow`, and `cannot`. So a memory written as "Code review is **mandatory** before merge" and one as "Code review is **forbidden** on hot-fix branches" form a HIGH conflict on the `workflow` topic without either having to spell out `ALWAYS` / `NEVER`.

Pass `--json` for a machine-readable report, mirroring `--drift --json`:

```bash
memory-router lint ~/.claude/projects/PROJECT/memory --conflicts --json
```

The schema is `{ scannedCount, feedbackCount, hits: [{ severity, topic, reason, a: { path, memoryId, firstLine }, b: { ... } }] }`. When combined with `--drift --json`, the drift JSON owns stdout and the conflicts JSON is routed to stderr, so a CI step that consumes the drift payload still sees the conflict signal without parser collisions.

Pre-commit hook snippet, rejects drift before it lands:

```bash
# .git/hooks/pre-commit (or a pre-commit framework config)
memory-router lint ~/.claude/projects/PROJECT/memory --drift --json \
  || { echo "memory-router drift check failed, run with --fix or resolve manually"; exit 1; }
```

### Stale memory references

Memories age: file paths get renamed, functions get removed, branches get merged and deleted. `memory-router stale` walks every memory in a directory and checks each declared reference against a configured repo root:

```bash
memory-router stale ~/.claude/projects/PROJECT/memory --repo-root ~/git/myrepo
memory-router stale ~/.claude/projects/PROJECT/memory --repo-root ~/git/myrepo --json
```

For workspace layouts where one shared corpus references paths in several sibling repos (a pandora-style monorepo of independent packages, an `~/work` folder of microservices, etc.), pass multiple roots. A ref is STALE only when none of the roots resolves it; first hit wins. Mix and match the two flag forms as you like:

```bash
# Repeated --repo-root: explicit, order-insensitive.
memory-router stale ~/.claude/projects/PROJECT/memory \
  --repo-root ~/git/repoA \
  --repo-root ~/git/repoB \
  --repo-root ~/git/repoC

# Variadic --repo-roots: terser. Place the <dir> arg BEFORE --repo-roots
# so the slurp doesn't consume it.
memory-router stale ~/.claude/projects/PROJECT/memory \
  --repo-roots ~/git/repoA ~/git/repoB ~/git/repoC
```

Symbol checks are degraded ("skipped" with a stderr warning) only when EVERY repo root is a non-git path. A single git root among several keeps symbol resolution honest.

By default ONLY refs declared in a memory's `verify:` frontmatter are checked. The contract is the same `MemoryReference[]` shape the runtime side uses (see `src/verify-refs.ts`):

```yaml
---
name: agent-tasks PR-merge paths
description: ...
type: feedback
verify:
  - kind: path
    value: backend/src/routes/github.ts
  - kind: symbol
    value: pickMergeTargetStatus
---
```

Two kinds are checked:

- **Path** refs (`kind: path`) are `fs.statSync`'d against `<repo-root>/<value>`. Missing → STALE.
- **Symbol** refs (`kind: symbol`) are resolved via `git grep -l -w <value>` from the repo root. Zero matches → STALE candidate. If `<repo-root>` is not a git checkout, symbol checks degrade to "skipped" with a one-time stderr warning rather than crashing.

A malformed `verify:` entry (missing `value`, non-identifier symbol shape, etc.) is reported as `malformed` so you fix the YAML rather than chase a phantom missing file.

The `--scan-body` flag additionally extracts refs from a memory's body via a backtick + path-shape regex (paths like `src/foo.ts`) and a function-call regex (`myFn()`, `Class.method()`). It is OFF by default because real corpora contain a lot of backtick'd strings that look like paths but aren't (gh-shorthand `LanNguyenSi/foo`, branch names `feat/...`, env-var snippets `$XDG_CONFIG_HOME/...`, route templates, cross-repo paths). When `verify:` is present on a memory, body-regex extraction is skipped for that memory even with `--scan-body` on; the explicit contract always wins.

A **date-staleness pass** runs unconditionally as INFO. Every memory whose newest ISO 8601 date in the body is older than 90 days AND whose frontmatter has no newer `updatedAt:` is flagged `possibly-stale`. INFO never contributes to exit code, so a slowly-ageing corpus does not break CI; the warning nudges the author to either refresh the memory or stamp `updatedAt: 2026-04-23` when the underlying claim is still current. Memories without body dates are silent.

The **`--check-urls`** flag opt-in HEAD-requests every external URL extracted from each memory's body. Status `4xx` lands the URL as STALE; `5xx` and network errors land it as `skipped` (server / network problem, not a dead link). HEAD calls have a 5-second timeout. Off by default because it's network-dependent.

Exits 1 on any STALE / no-matches / malformed finding, 0 otherwise. `possibly-stale` and `skipped` do not flip the exit code. `--json` emits a structured report on stdout that CI can consume directly.

**Limitations:**

- Single-repo only. v1 resolves every ref against one `--repo-root`; memories that legitimately reference sibling repos in a workspace will surface as STALE under that one root.
- Symbol checks require a git repo root. Non-git directories degrade to "skipped" rather than reporting STALE.
- Date-based and URL-based staleness checks are not yet implemented (filed as follow-ups).
- `git grep` is not AST-aware: a symbol that survives only in a comment or generated file counts as found.

### Programmatically

```typescript
import { loadMemoriesFromDir, resolve } from '@lannguyensi/memory-router';

const memories = loadMemoriesFromDir('/path/to/memory');
const hits = resolve({ prompt: 'merge PR 42' }, memories);
// → [{ memory, gate: 'topic', score: 1.0, reason: 'topic match: workflow' }]
```

The package ships JavaScript only (no `.d.ts` yet); types for the public API are tracked as a follow-up.

### Coverage / regression suite

`tests/coverage/real-corpus.test.ts` runs the sync router against a labelled prompt fixture and a synthetic memory corpus. It catches matcher-recall regressions: a scoring-weight change, a typo in a memory's `topics:`, or an overly-broad new memory all show up as failing assertions naming the `(prompt, memory)` pair.

The suite is part of `npm test`. After every prompt is evaluated it emits one TAP-comment line summarising aggregate stats:

```
# coverage: 93.3% (28/30 prompts matched ≥1) | mean_hits=3.20 | FN=0/76 (0.0%) | FP=0/74 (0.0%)
```

`FN` counts labelled `expectedMatches` that did not fire, `FP` counts labelled `expectedNoMatches` that did fire. Extras outside both labelled sets are tolerated; the gate is recall, not minimality.

The fixture (`tests/coverage/prompts.fixture.json`) and the corpus (`tests/coverage/corpus/`) are synthetic, never real user prompts or real-corpus memory bodies. To dogfood against a real corpus locally, set `MEMORY_ROUTER_COVERAGE_CORPUS_DIR`:

```bash
MEMORY_ROUTER_COVERAGE_CORPUS_DIR=~/.claude/projects/-home-lan-git-pandora/memory npm test
```

Companion verb for one-shot prompt checks: `memory-router test "<prompt>"` (see [Usage](#usage)).

### Golden-set eval (`memory-router eval`)

`tests/coverage/` above is a pass/fail regression net (every labelled prompt is an assertion). `memory-router eval <golden.yml>` is the companion **measurement** tool: it runs a golden set of `(prompt, expected memory ids)` pairs against a real corpus and reports precision, recall, and MRR: a number to track over time, not a gate. v1 deliberately has no threshold/exit-code contract on the metrics themselves: it exits 0 on any error-free run no matter how the numbers look. The intent is a baseline of the router's current (sync-gate-only, in most deployments) behavior captured *before* a retrieval change, so the change's effect is measurable against that baseline instead of argued from vibes.

```bash
memory-router eval golden.yml --dir ~/.claude/projects/PROJECT/memory
MEMORY_ROUTER_DIR=~/.claude/projects/PROJECT/memory memory-router eval golden.yml --json
```

Corpus dir resolution is the same as `test`: `--dir` flag, then `$MEMORY_ROUTER_DIR`.

**`golden.yml` format:**

```yaml
prompts:
  - prompt: "merge this PR for the billing module"
    expect: ["feedback_review_before_merge"]
  - prompt: "what time is it in Berlin"
    expect: []              # negative control: this prompt should match nothing
```

`expect` is a list of memory ids (filename without `.md`). An empty `expect: []` (or an omitted `expect` key) is a **negative control**: the only correct result is zero hits.

Your corpus's own `golden.yml` lives in the memory dir itself (synced alongside the `.md` files by [agent-memory-sync](../agent-memory-sync)), **not** in this repo; this package only ships the synthetic fixture under `tests/fixtures/eval/` used by its own unit tests. Curate your golden set from real prompts you've actually asked, labelled with the memory ids you'd want to fire.

**What gets measured:** `eval` mirrors exactly what the `UserPromptSubmit` hook would select for the same prompt: sync gates (topic, tool) first, then the confidence gate only when the sync gates were silent, with the same fail-open fallback on a semantic-search error. Without an embedding index (`<dir>/.memory-router/index.sqlite`, built by `memory-router index`) and `OPENAI_API_KEY`, the confidence gate can't contribute a hit; `eval` still runs and measures the sync path, and the report says so explicitly via `"semantic path: inactive"` rather than silently reporting a gap as a "measured" zero. When the semantic path IS active, this has a real-world cost: every prompt in the golden set whose sync gates are silent fires a live embeddings API call against your configured provider, so it costs money per call and the prompt text leaves the machine; size your golden set with that in mind.

Golden ids that don't resolve against the corpus (a stale or mistyped memory id) are reported, not silenced: the text report prints a `WARNING:` line listing them, and `--json` carries the same list as the top-level `unknownExpectIds` array (empty when every id resolves). This never changes precision/recall/MRR (an unresolvable id still deflates recall for its prompt exactly as before); it just makes the cause visible instead of a silent gap.

The report also states which topic vocabulary the Topic Gate used for the run, via `vocabularySource`: `"built-in default"`, or `"custom (<dir>/topics.yml)"` when the corpus overrides it (see [Topic vocabulary](#topic-vocabulary-topicsyml)). `eval` always scores against `--dir`'s (or `$MEMORY_ROUTER_DIR`'s) own `topics.yml`, never a stray `MEMORY_ROUTER_DIR` left over in the environment, so a run pointed at the wrong corpus, or hitting a broken `topics.yml`, shows up here instead of silently scoring against the wrong vocabulary.

**Metric definitions**, per prompt:

- **Precision** = `|expect ∩ got| / |got|` (`0` when nothing was returned).
- **Recall** = `|expect ∩ got| / |expect|`.
- **Reciprocal rank** = `1 / rank` of the first `got` id that's also in `expect` (1-indexed), or `0` if none of `expect` ever appears in `got`.
- **Negative control** (`expect: []`): precision = recall = `1.0` when `got` is empty, else `0.0`. Reciprocal rank is undefined (`null`) for negative controls (they carry no ranking signal), and negative controls are **never** blended into the aggregate precision/recall/MRR below; they're reported as their own pass/fail count.

Caveat: when two or more memories tie on score for the same prompt, the tie is broken by corpus load order, which comes from an unsorted `readdirSync` (`src/memory/loader.ts`), i.e. filesystem-dependent. A tied prompt's reciprocal rank (and therefore MRR) can differ between machines or after an unrelated file-touch that changes directory-entry order, even though the underlying gate logic didn't change. Sorting the loader's directory listing would remove this, but that's a separate follow-up (out of scope for `eval` itself).

**Aggregate**, over the golden set:

- `precision`, `recall`, `mrr` are the mean of the per-prompt values above, computed **only** over positive prompts (non-empty `expect`).
- `negativeControls: { total, passed, failed, rate }` reports the negative-control prompts separately.

`--json` emits the full report on stdout with this stable, documented top-level shape:

```jsonc
{
  "goldenPath": "golden.yml",
  "dir": "/path/to/memory",
  "corpusSize": 42,
  "semanticPathActive": false,
  "vocabularySource": "built-in default",
  "unknownExpectIds": [],
  "perPrompt": [
    {
      "prompt": "merge this PR for the billing module",
      "expect": ["feedback_review_before_merge"],
      "got": ["feedback_review_before_merge"],
      "isNegativeControl": false,
      "precision": 1,
      "recall": 1,
      "reciprocalRank": 1
    }
  ],
  "aggregate": {
    "precision": 0.75,
    "recall": 0.625,
    "mrr": 0.75,
    "positiveCount": 4,
    "negativeControls": { "total": 2, "passed": 1, "failed": 1, "rate": 0.5 }
  }
}
```

Exits 1 only on a real setup error: `golden.yml` missing or unparsable, or the corpus dir missing. Exits 0 on any error-free run, regardless of the metric values.

## Status

**v1, scaffold.**

- ✅ Topic Gate (deterministic keyword → topic map; built-in 5-topic default, corpus-overridable via `topics.yml`, see [Topic vocabulary](#topic-vocabulary-topicsyml))
- ✅ Tool Gate (regex match on Bash command + tool-name match, with ReDoS guardrails)
- ✅ Confidence Gate (ambiguity heuristic + sqlite-vec semantic search, OpenAI or Ollama). Runs only when sync gates are silent; fails open if no provider is configured/reachable or the index is absent.
- ✅ Hook binaries (`UserPromptSubmit`, `PreToolUse`) with stdin/stdout contract
- ✅ MCP server (`memory_search`, `memory_apply`, `memory_resolve`)
- ✅ Lint surface (`drift`, `unknown-topics`, `conflicts`)
- ✅ Stale detector (`stale --repo-root <path>` with `verify:` frontmatter contract)
- 🚧 Embedding pipeline, follow-up task (share with [codebase-oracle](https://github.com/LanNguyenSi/codebase-oracle))

## Trust Model

Memory files under `MEMORY_ROUTER_DIR` are treated as **author-trusted code**. They ship regexes (`triggers.command_pattern`), keyword lists, and markdown bodies that directly shape Claude's context. In the current deployment they live alongside your Claude-Code session (`~/.claude/...`) and are synced via [agent-memory-sync](../agent-memory-sync), i.e. you wrote them.

The tool gate (and, since mm-v1-T002, the topic vocabulary loader `src/vocab/loader.ts` for `topics.yml` patterns) defends against **author mistakes**, not a malicious author:

- `command_pattern` (tool gate) and `topics.yml` `patterns:` entries (topic vocabulary) are both rejected when they exceed 200 characters or contain an obvious nested-quantifier shape (`(a+)+`, `(a*)*`, etc.), the two most common ReDoS footguns. A rejected `topics.yml` pattern degrades the same way a non-compiling one does: keyword match on the topic's own `name` (see [Topic vocabulary](#topic-vocabulary-topicsyml)) rather than being compiled and run.
- No sandbox / `vm` timeout: a subtle pathological pattern would still stall the PreToolUse hook (or the UserPromptSubmit hook, for a `topics.yml` pattern). Don't point `MEMORY_ROUTER_DIR` at untrusted content.

If memory files ever arrive from a shared or remote source, tighten this before deploying: add a regex execution timeout, move matching off the hook hot path, or move to a backtracking-free engine (e.g. `re2`).

## Non-Goals

- **Storage.** memory-router reads existing memory files; [agent-memory-sync](../agent-memory-sync) owns sync.
- **Agent self-confidence.** LLM self-reports are unreliable; ambiguity is measured via deterministic proxy signals only.
- **Cross-session memory migration.** See [MW3 Context Indexer](https://github.com/LanNguyenSi/memory-weaver).

## Design discussion

See the task description in [agent-tasks](https://ops.opentriologue.ai) (task `c35dfdf4`) and the MW3-overlap analysis in its comments.
