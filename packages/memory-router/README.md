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

Existing Claude Code memory files already use YAML frontmatter (`name`, `description`, `type`). memory-router adds four optional fields:

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
| `memory_search(query, k?)` | Raw semantic hits from the sqlite-vec index. Returns `[]` if the index is missing or `OPENAI_API_KEY` is unset. |
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
- Default model: `text-embedding-3-small` (1536 dim). Override with `MEMORY_ROUTER_EMBED_MODEL`.
- Re-runs are incremental, unchanged files (by mtime) are skipped, removed files are purged.
- If the key or index are missing, the Confidence Gate silently returns no hits; the Topic and Tool Gates still fire.

The hook never builds the index inline, cold-start latency would block every prompt by seconds. Run `memory-router index` manually or wire it into a cron/agent-memory-sync post-sync step.

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

Exits 1 on any STALE / malformed finding, 0 otherwise. `--json` emits a structured report on stdout that CI can consume directly.

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

## Status

**v1, scaffold.**

- ✅ Topic Gate (deterministic keyword → topic map)
- ✅ Tool Gate (regex match on Bash command + tool-name match, with ReDoS guardrails)
- ✅ Confidence Gate (ambiguity heuristic + sqlite-vec semantic search). Runs only when sync gates are silent; fails open if `OPENAI_API_KEY` is missing or the index is absent.
- ✅ Hook binaries (`UserPromptSubmit`, `PreToolUse`) with stdin/stdout contract
- ✅ MCP server (`memory_search`, `memory_apply`, `memory_resolve`)
- ✅ Lint surface (`drift`, `unknown-topics`, `conflicts`)
- ✅ Stale detector (`stale --repo-root <path>` with `verify:` frontmatter contract)
- 🚧 Embedding pipeline, follow-up task (share with [codebase-oracle](https://github.com/LanNguyenSi/codebase-oracle))

## Trust Model

Memory files under `MEMORY_ROUTER_DIR` are treated as **author-trusted code**. They ship regexes (`triggers.command_pattern`), keyword lists, and markdown bodies that directly shape Claude's context. In the current deployment they live alongside your Claude-Code session (`~/.claude/...`) and are synced via [agent-memory-sync](../agent-memory-sync), i.e. you wrote them.

The tool gate defends against **author mistakes**, not a malicious author:

- `command_pattern` is rejected when it exceeds 200 characters or contains an obvious nested-quantifier shape (`(a+)+`, `(a*)*`, etc.), the two most common ReDoS footguns.
- No sandbox / `vm` timeout: a subtle pathological pattern would still stall the PreToolUse hook. Don't point `MEMORY_ROUTER_DIR` at untrusted content.

If memory files ever arrive from a shared or remote source, tighten this before deploying: add a regex execution timeout, move matching off the hook hot path, or move to a backtracking-free engine (e.g. `re2`).

## Non-Goals

- **Storage.** memory-router reads existing memory files; [agent-memory-sync](../agent-memory-sync) owns sync.
- **Agent self-confidence.** LLM self-reports are unreliable; ambiguity is measured via deterministic proxy signals only.
- **Cross-session memory migration.** See [MW3 Context Indexer](https://github.com/LanNguyenSi/memory-weaver).

## Design discussion

See the task description in [agent-tasks](https://ops.opentriologue.ai) (task `c35dfdf4`) and the MW3-overlap analysis in its comments.
