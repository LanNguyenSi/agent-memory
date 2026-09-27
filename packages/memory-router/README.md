# memory-router

**Deterministic memory injection for Claude Code.** Loads your `~/.claude/projects/*/memory/*.md` files and injects the relevant ones into a session whenever the prompt or a pending tool call matches their declared triggers. The agent cannot accidentally skip a memory.

## Overview

Most memory tooling loads your notes and hopes the model notices.
memory-router replaces that judgment with deterministic enforcement: when
a trigger fires, the memory is injected, full stop. Critical rules
("never force-push to master", "VPS deploy needs `-f
docker-compose.prod.yml`") stop being suggestions and start being part of
the system prompt. `UserPromptSubmit` and `PreToolUse` Claude Code hooks
inject relevant memories automatically; an MCP server exposes the same
resolver for explicit `memory_search`/`memory_resolve` calls. A CLI adds
tagging, linting, staleness detection, schema migration, and corpus
health reporting on top of the same memory files.

## Key features

- Score-blend resolver: semantic similarity, a deterministic topic
  keyword match, and recency/type tie-breakers combined into one ranked
  result (see [How it works](#how-it-works))
- Tool Gate: deterministic regex match on a pending Bash command or tool
  name, always privileged into the result
- Two Claude Code hook binaries (`UserPromptSubmit`, `PreToolUse`) and an
  MCP server (`memory_search`, `memory_resolve`, `memory_apply`)
- `lint`: MEMORY.md drift, unknown-topic, and feedback-conflict checks
- `stale`: verify-frontmatter and body-regex staleness detection against
  a repo root
- `migrate`/`tag`: mechanical schema v1 backfill and content-heuristic
  frontmatter tagging
- `consolidate`: read-only corpus health report (exact/near duplicates,
  stale references, schema metrics)
- `eval`: precision/recall/MRR measurement against a golden prompt set

## Install / quick start

```bash
npm install -g @lannguyensi/memory-router
```

Or from source:

```bash
git clone https://github.com/LanNguyenSi/agent-memory
cd agent-memory/packages/memory-router
npm install && npm run build
```

The `bin/` entries land in `node_modules/.bin/` (and on `PATH` for a
global install or `npm link`):

| Bin | Purpose |
|-----|---------|
| `memory-router` | CLI: `tag`, `index`, `lint`, `stale`, `test`, `eval`, `migrate`, `consolidate` |
| `memory-router-user-prompt-submit` | Claude Code `UserPromptSubmit` hook |
| `memory-router-pre-tool-use` | Claude Code `PreToolUse` hook |
| `memory-router-mcp` | MCP server for explicit `memory_search` / `memory_resolve` calls |

Try it against a scratch corpus (no embedding index, so this exercises
only the deterministic Topic Gate). Run this from `packages/memory-router`
after the from-source build above; substitute
`memory-router-user-prompt-submit` for `node dist/hooks/user-prompt-submit.js`
after a global install or `npm link`:

```bash
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

echo '{"prompt":"can I git push --force to master to fix this?"}' \
  | MEMORY_ROUTER_DIR=/tmp/memory-router-demo \
    node dist/hooks/user-prompt-submit.js

# Negative: nothing matches, stdout stays empty (Claude's context stays clean).
echo '{"prompt":"rename foo to bar"}' \
  | MEMORY_ROUTER_DIR=/tmp/memory-router-demo \
    node dist/hooks/user-prompt-submit.js
```

The positive prompt prints one line of JSON on stdout:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"**memory-router** — 1 relevant memory applies:\n\n### No force-push to shared branches  _(topic · 1.00)_\nNEVER force-push to master or main. The history is shared; rewriting\nit costs every collaborator a hard reset and loses uncommitted work.\nFor local-branch fixes, prefer a fixup commit + interactive rebase\nbefore push."}}
```

`1.00` is the flat pre-blend topic score for this demo: with no embedding
index, both the semantic path and the score blend contribute nothing, so
the result degrades to exactly the old topic-only resolver (see
[How it works](#how-it-works)). The same corpus also prints a stderr
notice that the embedding index is missing; this is informational, not a
failure. Claude Code consumes the stdout contract on every prompt and
injects `additionalContext` as system context for the model; when no
signal fires, stdout stays empty so the context window stays clean.

## How it works

`UserPromptSubmit` and the MCP server's `memory_resolve` both resolve a
prompt through the **score-blend resolver** (`resolveBlended`): a
semantic score, a topic boost, and small recency/type tie-breakers are
combined into one score per memory, deduped by memory id (highest score
wins), and capped at N (default 5), with a deterministic Tool Gate hit
(`PreToolUse`, against `triggers.command_pattern`/`triggers.tools`)
always privileged into that cap ahead of blend-scored memories. Without
a usable embedding index/provider, the blend degrades to the same output
the old topic-only resolver would produce.

See [docs/scoring.md](docs/scoring.md) for the full signal table, the
degradation behavior, the Tool Gate details, why the resolver is a blend
rather than sequential gates, the calibration measurement history, the
model-conditional relevance floor table, and the embedding provider
reference (selection, overrides, timeout budgets, query cache).

### Calibration

The default `topicBoost` (0.05) and `candidateK` (5) come from a
2026-08-14 calibration run on the reference corpus (289 memories,
golden set of 16 positive prompts + 4 negative controls; Ollama
embeddings, relevance floor swept per model). The recommended operating
floor for that corpus is **0.78** for Ollama `bge-m3` (the only
specifically calibrated model); every other Ollama model defaults to the
same `0.78` as a deliberately conservative, uncalibrated fallback; OpenAI
keeps the original flat `0.5` default. An explicit
`MEMORY_ROUTER_BLEND_MIN_SEMANTIC` always wins over these defaults, on
every provider/model path. See [docs/scoring.md](docs/scoring.md#calibration-measurements)
for the full measurement tables, the model-conditional floor rationale,
and the reproduction recipe.

## Memory frontmatter

memory-router adds four optional fields to a memory's YAML frontmatter:
`topics` (Topic Gate), `severity`, `triggers` (Tool Gate), and `verify`
(stale-marker check on recall). See
[docs/memory-schema.md](docs/memory-schema.md) for the full field
reference, where `type`/`topics` are accepted (top-level vs. `metadata.`),
the corpus-overridable topic vocabulary (`topics.yml`), and the
`verify:` staleness contract.

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
`{ "hookSpecificOutput": { "additionalContext": "<rendered markdown>" } }`
on stdout. See [docs/scoring.md](docs/scoring.md#embedding-provider) for
the ongoing per-prompt cost once an embedding index/provider are
configured, and how to fall back to the topic-only path.

### As an MCP server (imperative queries)

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

| Tool | Use |
|------|-----|
| `memory_search(query, k?)` | Raw semantic hits from the sqlite-vec index. Returns `[]` if the index is missing or no embedding provider is configured/reachable. |
| `memory_resolve(prompt, cwd?, tool?)` | Same score-blend resolver the `UserPromptSubmit` hook uses, plus the Tool Gate when `tool` is passed. |
| `memory_apply(id)` | Fetch the full body of a single memory by id (filename without extension). `isError: true` when the id doesn't exist. |

All three are stateless and read-only; write tools (`memory_create`,
`memory_update`) stay out of scope until the `tag` CLI is proven enough
to move under an agent. Trust model matches the hook:
`MEMORY_ROUTER_DIR` is treated as author-trusted (see
[Trust Model](#trust-model)). The MCP server surfaces memory bodies
verbatim; any risk from a compromised memory file is identical to what
the hook would inject.

### CLI verbs

Run `memory-router --help` for the full flag reference; see
[docs/commands.md](docs/commands.md) for JSON schemas, the programmatic
API, and operational recipes not covered by `--help`.

```bash
memory-router tag ~/.claude/projects/PROJECT/memory              # propose topics/severity, dry-run
memory-router index ~/.claude/projects/PROJECT/memory            # build the embedding index
memory-router test "rebase the branch onto master" --dir ~/.claude/projects/PROJECT/memory
memory-router eval golden.yml --dir ~/.claude/projects/PROJECT/memory   # precision/recall/MRR, never a gate
memory-router migrate --dir ~/.claude/projects/PROJECT/memory --apply  # mechanical schema v1 backfill
memory-router consolidate --dir ~/.claude/projects/PROJECT/memory      # read-only corpus health report
memory-router lint ~/.claude/projects/PROJECT/memory --drift --fix     # MEMORY.md drift, auto-fixable
memory-router stale ~/.claude/projects/PROJECT/memory --repo-root ~/git/myrepo
```

`test` deliberately dry-runs the OLD sync-gates-first resolver (Topic
Gate then Tool Gate, plus the Confidence Gate only with `--semantic`), NOT
the score-blend resolver the hook and `eval` actually use; use `eval` to
preview what the hook would inject for a golden set of prompts.

## Trust Model

Memory files under `MEMORY_ROUTER_DIR` are treated as **author-trusted
code**. They ship regexes (`triggers.command_pattern`), keyword lists, and
markdown bodies that directly shape Claude's context. In the current
deployment they live alongside your Claude-Code session (`~/.claude/...`)
and are synced via [agent-memory-sync](../agent-memory-sync), i.e. you
wrote them.

The tool gate (and the topic vocabulary loader for `topics.yml` patterns)
defends against **author mistakes**, not a malicious author:
`command_pattern` and `topics.yml` `patterns:` entries are both rejected
when they exceed 200 characters or contain an obvious nested-quantifier
shape (`(a+)+`, `(a*)*`, etc.), the two most common ReDoS footguns. There
is no sandbox or `vm` timeout: a subtle pathological pattern would still
stall the hook. Don't point `MEMORY_ROUTER_DIR` at untrusted content; if
memory files ever arrive from a shared or remote source, add a regex
execution timeout, move matching off the hook hot path, or move to a
backtracking-free engine (e.g. `re2`) before deploying.

## Non-Goals

- **Storage.** memory-router reads existing memory files;
  [agent-memory-sync](../agent-memory-sync) owns sync.
- **Agent self-confidence.** LLM self-reports are unreliable; ambiguity is
  measured via deterministic proxy signals only.
- **Cross-session memory migration.** See
  [MW3 Context Indexer](https://github.com/LanNguyenSi/memory-weaver).

## Development

```bash
git clone https://github.com/LanNguyenSi/agent-memory
cd agent-memory/packages/memory-router
npm install
npm test              # builds first (pretest), then runs tests/**/*.test.ts
npm run test:coverage
npm run typecheck
npm run build
```

CI (`.github/workflows/ci.yml`) runs a native-dep smoke check
(`better-sqlite3` + `sqlite-vec`), typecheck, build, lint, and the
coverage-gated test suite on every pull request and push to `master`.

## Documentation

- [docs/scoring.md](docs/scoring.md) - score-blend rationale, full calibration measurements, embedding provider reference
- [docs/memory-schema.md](docs/memory-schema.md) - frontmatter fields, accepted locations, topic vocabulary, `verify:` staleness
- [docs/commands.md](docs/commands.md) - CLI JSON schemas, programmatic API, coverage suite, operational recipes

## License

MIT. See [LICENSE](LICENSE) for details. v1, scaffold: some verbs
(`consolidate`, `migrate`) are recent and still under active iteration.
