# Memory-dir hygiene pass — 2026-04-22

Record of content-level fixes applied to the user's personal memory corpus
(`~/.claude/projects/-home-lan-git-pandora/memory/`) after the drift
linter flagged them. Kept here because the memory files themselves
live outside any git repo — this is the repo-side audit trail.

Related agent-tasks:
- [`de65c0ed`](https://agent-tasks.opentriologue.ai/tasks/de65c0ed-d897-4fcf-adc6-ea4cf83ea132) (HIGH) — silent YAML parse error
- [`20e42396`](https://agent-tasks.opentriologue.ai/tasks/20e42396-df90-468d-9914-d4bf2e7ebbc4) (LOW) — overlong descriptions

## Findings surfaced by `memory-router lint --drift`

1. **`feedback_agent_tasks_pr_merge_webhook.md`** — YAML parse error.
   The `name:` value contained a bare colon: `agent-tasks PR-merge: webhook vs REST endpoint paths`.
   YAML parsed that as a nested mapping, `loadMemoriesFromDir` returned
   `null`, the memory was **silently dead** in the loader — it never
   fired through any gate (topic / tool / confidence) despite being
   listed in `MEMORY.md`.
   **Fix:** quote the value. `name: "agent-tasks PR-merge: webhook vs …"`.

2. Five descriptions over the 150-char cap (MEMORY.md line budget):

   | File                                    | Before | After |
   |-----------------------------------------|:------:|:-----:|
   | feedback_agent_relay_container_name.md  | 157    | ≤150  |
   | feedback_agent_tasks_pr_merge_webhook.md | 227*   | ≤150  |
   | feedback_release_dogfood.md             | 151    | ≤150  |
   | feedback_stacked_pr_base.md             | 157    | ≤150  |
   | feedback_subpackage_tsconfig_exclude.md | 195    | ≤150  |

   *The 227-char description on `feedback_agent_tasks_pr_merge_webhook.md`
   only became visible **after** fixing finding #1 — the YAML parse
   error had masked the description-length check.

Each rewrite preserves the load-bearing keyword so the topic-gate still
matches the same prompts as before.

## Verification

```bash
$ cd ~/git/pandora/agent-memory/packages/memory-router && npm run build
$ node dist/cli.js lint ~/.claude/projects/-home-lan-git-pandora/memory --drift
memory-router drift: 26 memory file(s) scanned, MEMORY.md 26 line(s), no drift found
# exit 0
```

## Why this doc exists

Content-only tasks (edits to files outside any git repo) can't satisfy
the agent-tasks `prPresent` precondition via the affected files
themselves. Bundling the audit trail as a persistent repo artifact is
the cleanest workaround — future hygiene passes should reuse this
pattern (one doc per pass, listing the findings + fixes).

Follow-up [`610ca95d`](https://agent-tasks.opentriologue.ai/tasks/610ca95d-f757-4da2-af39-ead8adfc3d6f)
tracks the matching backend work: REST `/claim` today silently bypasses
the same precondition stack that MCP `task_start` enforces.
