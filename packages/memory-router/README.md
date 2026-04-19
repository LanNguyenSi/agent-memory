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

Existing Claude-Code memory files already use YAML frontmatter (`name`, `description`, `type`). memory-router adds three optional fields:

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
---

body markdown here
```

All new fields are optional — legacy memories are still loaded and can still fire via Confidence Gate (once wired) or via semantic match.

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
  "hooks": {
    "UserPromptSubmit": [
      {
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
  },
  "env": {
    "MEMORY_ROUTER_DIR": "/home/you/.claude/projects/YOURPROJECT/memory"
  }
}
```

Both binaries read JSON from stdin (Claude-Code hook contract) and emit `{ "hits": [...] }` on stdout.

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
- 🚧 Confidence Gate — ambiguity heuristic wired, but the semantic match that would actually produce hits is stubbed pending sqlite-vec integration. Gate currently returns no hits at runtime.
- ✅ Hook binaries (`UserPromptSubmit`, `PreToolUse`) with stdin/stdout contract
- 🚧 MCP server (`memory_search`, `memory_apply`, `memory_resolve`) — stub only
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
