# memory-router

**Retrieval and policy layer for Claude-Code memory files.** Decides *when* and *which* memories to inject into a Claude-Code session, based on deterministic topic/tool-call matches and a confidence heuristic. Complements [agent-memory-sync](../agent-memory-sync) (which keeps memory files fresh across machines) — the router reads those files and enforces their application at runtime.

## Why

Today, Claude-Code memory files in `~/.claude/projects/*/memory/*.md` are loaded at session start, but *applying* a specific memory depends on the agent noticing its relevance. Critical memories (e.g. "never force-push to master", "VPS deploy needs `-f docker-compose.prod.yml`") are silently skipped when the agent doesn't connect the dots.

memory-router replaces judgment with deterministic enforcement: when the prompt or a pending tool call matches a memory's declared triggers, the memory is injected — the agent cannot accidentally skip it.

## Three Gates

| Gate | Signal | When it fires |
|------|--------|---------------|
| **Topic** | Keyword dictionary → memory `topics:` | Prompt matches `deploy`, `merge`, `rm -rf`, etc. → all memories tagged with that topic |
| **Tool** | `PreToolUse` hook → memory `triggers.command_pattern` / `triggers.tools` | Before `Bash(git push --force)`, `Bash(docker compose up)`, etc. — matches command regex |
| **Confidence** | Ambiguity heuristic on prompt | Fallback: short/vague prompts lower the threshold so semantic matches fire as a safety net |

Gates run in parallel; the router dedupes by memory id, keeps the highest-scoring hit per memory, and caps the output at N (default 5).

## Memory Frontmatter Extension

Existing Claude-Code memory files already use YAML frontmatter (`name`, `description`, `type`). memory-router adds four optional fields:

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

All new fields are optional — legacy memories are still loaded and can still fire via Confidence Gate (once wired) or via semantic match.

### `verify:` — stale-marker on recall

A memory that names a concrete file, symbol, or flag is making a claim about the current repo state. Memories don't self-update: a file renamed or deleted leaves the memory silently wrong. When a matched memory has `verify:` entries and any `kind: path` entry no longer exists on disk, the router prefixes the memory's injected context with:

```
> ⚠️ **stale:** path '...' not found at ...
>
> This memory references something that no longer exists. Verify before acting.
```

The memory is **not** suppressed — the agent still sees the rule. It just knows to be skeptical.

- `kind: 'path'` — checked inline via `fs.statSync`. Relative values resolve against `repoRoot` (default `process.cwd()`) and must stay inside it.
- `kind: 'symbol' | 'flag'` — accepted in the shape but skipped inline (the hook stays zero-dep and sub-10 ms). Use the `verify_memory_reference` MCP tool from [agent-grounding/grounding-mcp](https://github.com/LanNguyenSi/agent-grounding/tree/master/packages/grounding-mcp) for those.

## Install

```bash
npm install
npm run build
```

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

on stdout — Claude Code injects `additionalContext` as system context for the model. When no gate fires, stdout stays empty to keep the model's context clean.

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

All three are stateless and read-only — write tools (`memory_create`, `memory_update`) stay out of scope until the `tag` CLI is proven enough to move under an agent.

Trust model matches the hook: `MEMORY_ROUTER_DIR` is treated as author-trusted (see [Trust Model](#trust-model)). The MCP server surfaces memory bodies verbatim — any risk from a compromised memory file (ReDoS in a `command_pattern`, misleading body content) is identical to what the hook would inject.

### Migrating existing memories

Legacy memory files (`name`/`description`/`type` only) never fire through the router — they're missing `topics:` and `triggers:`. The `memory-router tag` CLI proposes those fields based on a scored keyword match (name 3×, description 2×, body 1×; top 2 topics per file; minimum score 3):

```bash
# Dry-run — prints a diff per file and a stderr hint block for bodies that
# mention dangerous shell commands worth a Tool-Gate trigger.
memory-router tag ~/.claude/projects/PROJECT/memory

# Commit the changes.
memory-router tag ~/.claude/projects/PROJECT/memory --apply

# Limit to a single file.
memory-router tag ~/.claude/projects/PROJECT/memory --only feedback_stacked_pr_base
```

Idempotent — re-running is a no-op on files already tagged. Existing frontmatter is preserved; only `topics` and `severity` are added when missing. `triggers.command_pattern` is never auto-generated (too risky); candidates are printed to stderr for manual review.

### Building the embedding index

The Confidence Gate's semantic match requires a one-time index build:

```bash
OPENAI_API_KEY=sk-... memory-router index ~/.claude/projects/PROJECT/memory
```

- Stores embeddings under `<dir>/.memory-router/index.sqlite` via sqlite-vec (cosine distance).
- Default model: `text-embedding-3-small` (1536 dim). Override with `MEMORY_ROUTER_EMBED_MODEL`.
- Re-runs are incremental — unchanged files (by mtime) are skipped, removed files are purged.
- If the key or index are missing, the Confidence Gate silently returns no hits; the Topic and Tool Gates still fire.

The hook never builds the index inline — cold-start latency would block every prompt by seconds. Run `memory-router index` manually or wire it into a cron/agent-memory-sync post-sync step.

#### Query-embedding cache

Repeated vague prompts (`"mal schauen"`, `"check mal"`) re-pay one OpenAI embedding call (~150–300 ms + ~$0.00002) every time the Confidence Gate fires. The router memoizes prompt → embedding in the same `index.sqlite` file under a `query_cache` table:

- **Key:** sha256(prompt) prefix (8 bytes, plenty for the LRU cap).
- **Eviction:** LRU by `accessed_at`, hard cap of 1000 entries. Switching `MEMORY_ROUTER_EMBED_MODEL` lazily evicts entries stored under the previous model on the next put.
- **Persistence:** survives hook process restarts (the file is the only state).
- **Observability:** set `MEMORY_ROUTER_DEBUG=1` to see `query cache hit (size=N)` / `query cache miss — embedding (size=N)` lines on stderr without polluting the hook's stdout contract.

No flag turns the cache off — it's always on when the Confidence Gate is. `memory-router index` does not touch the cache; only switching embed models does.

### Keep MEMORY.md clean

`MEMORY.md` is the canonical index Claude-Code loads at session start. It drifts: pointers to deleted files, memory files never added to the index, duplicates, or a file that grows past the 200-line truncation cap (lines after 200 are silently dropped from context). The drift linter catches all of these before they cost you a missing recall in a real session:

```bash
# Dry-run — exits non-zero on any finding.
memory-router lint ~/.claude/projects/PROJECT/memory --drift

# Auto-apply safe fixes (append missing pointers, remove duplicate entries).
# Orphan pointers are never auto-deleted — might be intentional while a file
# is temporarily absent. Invalid frontmatter and duplicate names also need
# hand-review.
memory-router lint ~/.claude/projects/PROJECT/memory --drift --fix

# Machine-readable for CI.
memory-router lint ~/.claude/projects/PROJECT/memory --drift --json
```

Checks:
- **Orphan pointer** — MEMORY.md lists `file.md` but the file no longer exists.
- **Missing pointer** — a memory file exists in the dir but is not listed in MEMORY.md.
- **Duplicate entry** — the same filename appears twice in MEMORY.md.
- **Duplicate name** — two memory files share a frontmatter `name` (case-insensitive).
- **Length warning** — MEMORY.md > 200 lines (anything past line 200 is truncated by the runtime).
- **Invalid frontmatter** — missing `name`/`description`/`type`, unknown `type`, or YAML that fails to parse. The runtime loader silently drops such files, so they never fire through any gate.
- **Description too long** — frontmatter `description` > 150 chars; the same text is used as the MEMORY.md hook, where it would blow the one-line budget.

Without any check flag `lint` runs drift **and** the `--unknown-topics` frontmatter check; pass `--drift` or `--unknown-topics` to narrow.

Pre-commit hook snippet — rejects drift before it lands:

```bash
# .git/hooks/pre-commit (or a pre-commit framework config)
memory-router lint ~/.claude/projects/PROJECT/memory --drift --json \
  || { echo "memory-router drift check failed — run with --fix or resolve manually"; exit 1; }
```

### Programmatically

```typescript
import { loadMemoriesFromDir, resolve } from 'memory-router';

const memories = loadMemoriesFromDir('/path/to/memory');
const hits = resolve({ prompt: 'merge PR 42' }, memories);
// → [{ memory, gate: 'topic', score: 1.0, reason: 'topic match: workflow' }]
```

## Status

**v1 — scaffold.**

- ✅ Topic Gate (deterministic keyword → topic map)
- ✅ Tool Gate (regex match on Bash command + tool-name match, with ReDoS guardrails)
- ✅ Confidence Gate (ambiguity heuristic + sqlite-vec semantic search). Runs only when sync gates are silent; fails open if `OPENAI_API_KEY` is missing or the index is absent.
- ✅ Hook binaries (`UserPromptSubmit`, `PreToolUse`) with stdin/stdout contract
- ✅ MCP server (`memory_search`, `memory_apply`, `memory_resolve`)
- 🚧 Embedding pipeline — follow-up task (share with [codebase-oracle](https://github.com/LanNguyenSi/codebase-oracle))

## Trust Model

Memory files under `MEMORY_ROUTER_DIR` are treated as **author-trusted code**. They ship regexes (`triggers.command_pattern`), keyword lists, and markdown bodies that directly shape Claude's context. In the current deployment they live alongside your Claude-Code session (`~/.claude/...`) and are synced via [agent-memory-sync](../agent-memory-sync) — i.e. you wrote them.

The tool gate defends against **author mistakes**, not a malicious author:

- `command_pattern` is rejected when it exceeds 200 characters or contains an obvious nested-quantifier shape (`(a+)+`, `(a*)*`, etc.) — the two most common ReDoS footguns.
- No sandbox / `vm` timeout: a subtle pathological pattern would still stall the PreToolUse hook. Don't point `MEMORY_ROUTER_DIR` at untrusted content.

If memory files ever arrive from a shared or remote source, tighten this before deploying: add a regex execution timeout, move matching off the hook hot path, or move to a backtracking-free engine (e.g. `re2`).

## Non-Goals

- **Storage.** memory-router reads existing memory files; [agent-memory-sync](../agent-memory-sync) owns sync.
- **Agent self-confidence.** LLM self-reports are unreliable; ambiguity is measured via deterministic proxy signals only.
- **Cross-session memory migration.** See [MW3 Context Indexer](https://github.com/LanNguyenSi/memory-weaver).

## Design discussion

See the task description in [agent-tasks](https://ops.opentriologue.ai) (task `c35dfdf4`) and the MW3-overlap analysis in its comments.
