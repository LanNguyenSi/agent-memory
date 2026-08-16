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

# Negative: nothing matches, stdout stays empty (Claude's context stays
# clean). This scratch corpus has no embedding index (see below), so the
# semantic path no-ops entirely here; once an index exists, an unrelated
# prompt still yields empty stdout because the relevance floor
# (MEMORY_ROUTER_BLEND_MIN_SEMANTIC) filters out noise-level cosine scores
# before they can produce a hit, see "How it works" below.
echo '{"prompt":"rename foo to bar"}' \
  | MEMORY_ROUTER_DIR=/tmp/memory-router-demo \
    node dist/hooks/user-prompt-submit.js
```

## What a run looks like

The positive prompt prints one line of JSON on stdout (plus a stderr line; see below):

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"**memory-router**: 1 relevant memory applies:\n\n### No force-push to shared branches  _(topic · 1.00)_\nNEVER force-push to master or main. The history is shared; rewriting\nit costs every collaborator a hard reset and loses uncommitted work.\nFor local-branch fixes, prefer a fixup commit + interactive rebase\nbefore push."}}
```

`1.00` is the flat pre-blend topic score for this demo (no embedding index, see below, so the semantic path contributes nothing and the blend degrades to exactly the old topic-only sync path, see "How it works" below), not a blended value. This scratch corpus has no embedding index, so **both** commands above also print one line on stderr: `memory-router: embedding index missing; run 'memory-router index <dir>' to build it.`; the score-blend resolver (mm-v1-T004) attempts the semantic path on every prompt, not only when the deterministic gates stay silent, so this warning surfaces even on the positive prompt the Topic Gate already matched. It's informational, not a failure: stdout still carries the hit above (and stays empty for the negative prompt, exit 0 either way).

Claude Code consumes the stdout contract on every prompt and injects `additionalContext` as system context for the model. The negative prompt prints nothing on stdout and exits 0: when no signal fires, stdout stays empty so the context window stays clean. Here that's because this scratch corpus has no embedding index at all (the semantic path no-ops entirely, see above); once an index exists, the same "no signal, no output" guarantee is enforced by the relevance floor (`MEMORY_ROUTER_BLEND_MIN_SEMANTIC`, default 0.5) discarding any sub-floor cosine score before it can produce a hit, not by the semantic path staying silent on its own.

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

`UserPromptSubmit` and the MCP server's `memory_resolve` both resolve a prompt through the **score-blend resolver** (`resolveBlended`, mm-v1-T004): every signal below is combined into one score per memory, deduped by memory id (highest score wins), and capped at N (default 5); with a deterministic Tool Gate hit always privileged into that cap ahead of blend-scored memories, see the Tool Gate paragraph below.

| Signal | What it is | Role in the blend |
|------|--------|---------------|
| **Semantic score** | sqlite-vec cosine similarity between the prompt and each memory's embedding | The dominant signal. Runs unconditionally whenever an embedding index + provider are available for the corpus; no longer gated behind the deterministic signals staying silent (see "Why a blend, not gates" below). A score below the relevance floor (`MEMORY_ROUTER_BLEND_MIN_SEMANTIC`, default 0.5) is dropped before it can enter the blend at all; treated as no semantic score, not a weak one |
| **Topic boost** | Keyword dictionary mapped to memory `topics:` | A boost added on top of whatever else fires for that memory. No longer a standalone full-score (1.0) hit |
| **Recency modifier** | Exponential decay on the memory file's mtime | A small tie-breaker: a more recently touched memory ranks slightly higher, all else equal |
| **Type modifier** | Memory `type` (`feedback` weighted highest) | A small tie-breaker: the type most consistently actionable in the corpus today gets a small nudge |

A memory with neither a semantic score (once the relevance floor is applied) nor a topic match contributes nothing and is excluded; the recency/type modifiers alone can never surface an otherwise-silent memory, only shape the ranking of one some other signal already selected. Blend weights are overridable via the `MEMORY_ROUTER_BLEND_*` env namespace (`MEMORY_ROUTER_BLEND_TOPIC_BOOST`, `MEMORY_ROUTER_BLEND_RECENCY_WEIGHT`, `MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS`, `MEMORY_ROUTER_BLEND_TYPE_WEIGHT`, `MEMORY_ROUTER_BLEND_MIN_SEMANTIC`, `MEMORY_ROUTER_BLEND_CANDIDATE_K`); `topicBoost` (0.05) and `candidateK` (5) were **calibrated** in mm-v1-T008 against the reference corpus, see [Calibration](#calibration-mm-v1-t008) below; the relevance floor (`MEMORY_ROUTER_BLEND_MIN_SEMANTIC`) keeps a permissive default (0.5) because raw cosine ranges are provider- and model-specific, tune it per corpus (0.78 measured for Ollama `bge-m3`); see `src/gates/confidence.ts` for the exact defaults and shape rationale. A negative override for any of these is invalid and falls back to the built-in default rather than being accepted (a "boost"/"weight"/"floor"/candidate count that goes negative would invert the blend's intended shape, not merely rescale it).

Without an embedding index or a resolvable embedding provider, on a semantic-search failure, or when every semantic-search hit for a prompt falls below the relevance floor, the blend degrades to exactly the same output the old topic-only sync path (`resolve()`) would produce: the same memories, in the same order, at the same flat `1.0` score. No topic boost, no recency/type modifier is applied in this case, so a corpus with more topic candidates than the cap behaves identically to today's topic-only degradation. On score ties (the normal case on this flat path) hit order preserves corpus load order, which is deterministic; see the load-order note under [Accepted frontmatter locations](#accepted-frontmatter-locations).

### Calibration (mm-v1-T008)

The default `topicBoost` (0.05) and `candidateK` (5) come from a 2026-08-14 calibration run on the reference corpus (289 memories, German/English mixed, golden set of 16 positive prompts + 4 negative controls, expanded 2026-08-14 from the 6-prompt seed; Ollama embeddings, relevance floor swept per model). Aggregate precision/recall/MRR over the positive prompts, negative controls (NK) reported separately. All figures below use this expanded golden set; older documents quote the 4-positive-prompt seed baseline (P=0.100 R=0.167 MRR=0.375), which is not comparable.

| Configuration | P | R | MRR | NK |
|---|---|---|---|---|
| Topic-only baseline (default 5-topic vocabulary) | 0.083 | 0.156 | 0.193 | 4/4 |
| Blend, `nomic-embed-text`, best NK-clean floor (0.85) | 0.075 | 0.146 | 0.263 | 4/4 |
| Blend, `bge-m3`, floor 0.77, pre-calibration (K=10, boost 0.15) | 0.238 | 0.453 | 0.648 | 4/4 |
| Blend, `bge-m3`, floor 0.77, calibrated (K=5, boost 0.05) | 0.288 | 0.547 | 0.710 | 4/4 |
| Blend, `bge-m3`, floor 0.78, calibrated (K=5, boost 0.05) | 0.250 | 0.484 | 0.710 | 4/4 |

The calibration deltas quoted in the CHANGELOG (P 0.238 -> 0.288, R 0.453 -> 0.547, MRR 0.648 -> 0.710) compare the two floor-0.77 rows. The recommended operating floor for this corpus is nevertheless **0.78**: 0.77 maximizes the positives but sits one hundredth above a failing negative control (0.76 -> NK 3/4), so 0.78 trades a little P/R for NK margin at identical MRR.

These results held on this corpus; they are not validated elsewhere (single run, one corpus, one embedding model per row, 16 positive prompts; a P move of 0.05 is roughly one prompt's worth). On this corpus: a small `topicBoost` let the semantic signal dominate the ranking; a small `candidateK` kept weak semantic candidates from flooding the final cap. Note the flip side: at the default cap the pool now equals the cap, so a memory outside the raw semantic top-`maxHits` can no longer be lifted into the result by a topic boost unless `MEMORY_ROUTER_BLEND_CANDIDATE_K` is raised; `recencyWeight`/`typeWeight` showed no golden-set effect beyond single-tie noise (re-confirmed at the calibrated boost) and keep their shaped values. What is explicitly corpus-coupled: the relevance floor. Cosine ranges differ per provider and model (`bge-m3` separates relevance from junk around 0.77-0.79 on this corpus; `nomic-embed-text` cannot separate German junk prompts from the corpus at any floor without collapsing the positives; OpenAI embeddings score far lower overall), so `MEMORY_ROUTER_BLEND_MIN_SEMANTIC` stays at a permissive 0.5 default and must be tuned per corpus with `memory-router eval` and negative controls. On a multilingual corpus prefer a multilingual embedding model (`MEMORY_ROUTER_OLLAMA_EMBED_MODEL=bge-m3`); switching models requires an index rebuild (`rm -rf <dir>/.memory-router && memory-router index <dir>`).

Reproduction (requires the reference corpus, which lives in the operator's memory dir, not this repo, see [Golden-set eval](#golden-set-eval-memory-router-eval)): `MEMORY_ROUTER_OLLAMA_EMBED_MODEL=bge-m3 MEMORY_ROUTER_BLEND_MIN_SEMANTIC=<floor> memory-router eval <dir>/golden.yml --dir <dir> --json` after `memory-router index <dir>`; per-run JSON artifacts from the calibration session are archived in the operator's run directory (`.ai/runs/2026-08-14-mm-v1-t008-rollout/`).

Separately, the **Tool Gate** (`PreToolUse` hook, against memory `triggers.command_pattern` and `triggers.tools`) stays a deterministic, unblended full-score (1.0) match; before `Bash(git push --force)`, `Bash(docker compose up)`, etc. It is not part of the semantic blend (there is no prompt to embed at that point in the tool-call lifecycle), but `memory_resolve` still consults it when a `tool` argument is passed, exactly as before. Within an active blend, a Tool Gate hit is privileged into the final N-slot cap ahead of blend-scored memories: since a blended score (semantic + topic boost + modifiers) can exceed the Tool Gate's flat `1.0`, plain highest-score-wins slot allocation could otherwise evict a deterministic tool match on a prompt with more than N strong blend candidates.

#### Why a blend, not gates

Earlier versions ran the sync gates (topic, tool) first and only fell through to an async semantic "Confidence Gate" when they stayed silent. In practice the Topic Gate's flat 1.0 score pre-empted the semantic path almost every real prompt; three different prompts sharing a topic keyword produced an identical top-5 regardless of what each prompt actually meant, and a golden-set baseline measured before this change confirmed the semantic path essentially never ran. The blend above replaces that shadowing: the semantic score always contributes when it can, and the deterministic Topic Gate becomes a boost rather than an override.

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

The loader reads the memory directory in deterministic lexicographic order (plain code-unit `Array#sort` over the directory listing, locale-independent), not in the filesystem's `readdir` order, so hook injection and `eval` see the same corpus order on every machine and filesystem. This holds for byte-identical filenames; a memory file whose name differs in Unicode normalization between machines (NFD vs NFC) can still sort differently.

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
  - `memory-router lint --unknown-topics` also falls back to the built-in default for the scan itself, but prints the rejection reason at the top of its report instead of hiding it, and exits 1 for the rejection alone, even when the fallback scan itself finds zero unknown-topic hits.

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

on stdout, Claude Code injects `additionalContext` as system context for the model. When no gate fires, stdout stays empty to keep the model's context clean; once an embedding index exists, that guarantee rests on the relevance floor (`MEMORY_ROUTER_BLEND_MIN_SEMANTIC`, default 0.5, see "How it works" below): a genuinely unrelated prompt still yields zero hits because a weak/noise cosine score never clears the floor, rather than leaking a near-irrelevant memory into context.

Cost/privacy note: once an embedding index exists AND an embedding provider resolves (see "Embedding provider" below), the score-blend resolver queries it on **every** prompt sent through the hook, not only when the deterministic gates stay silent (see "Why a blend, not gates" below); this is an ongoing per-prompt cost (OpenAI API calls) or local load (Ollama), and the prompt text itself leaves the machine to whichever endpoint is configured. To stop this, delete the index (`rm -rf <dir>/.memory-router`): the resolver then fails open to the topic-only sync path, same as before an index was ever built.

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
| `memory_resolve(prompt, cwd?, tool?)` | Same score-blend resolver the UserPromptSubmit hook uses (semantic + topic + recency + type, plus the Tool Gate when `tool` is passed), same hit shape the hook would inject. See "How it works" above. |
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

### Migrating to schema v1 (`memory-router migrate`)

`tag` above proposes `topics`/`severity` from a scored keyword match. `migrate` is narrower and more mechanical: it backfills a memory's frontmatter to schema v1 shape (`name`, `description`, top-level `type`, `topics: [...]` with at least one entry, `created`) from what's already on disk or in the filesystem, with **no LLM and no guessing**; whatever can't be derived mechanically stays untouched and is surfaced in the report instead of invented.

```bash
# Dry-run (default): prints what would change, per file, and a summary.
memory-router migrate --dir ~/.claude/projects/PROJECT/memory

# Commit the changes.
memory-router migrate --dir ~/.claude/projects/PROJECT/memory --apply

# With a curated topic-mapping file (see below).
memory-router migrate --dir ~/.claude/projects/PROJECT/memory --mapping mapping.yml --apply

# Machine-readable report.
memory-router migrate --dir ~/.claude/projects/PROJECT/memory --json
```

Corpus dir resolution is the same as `test`/`eval`: `--dir` flag, then `$MEMORY_ROUTER_DIR`. Only `*.md` files are scanned; `MEMORY.md` and non-`.md` files (`topics.yml`, `golden.yml`, ...) are never touched. Three independent, additive-only rules, each of which **never overwrites an existing canonical value**:

- **`type`**: hoists `metadata.type` (the Claude Code auto-memory location, see [Accepted frontmatter locations](#accepted-frontmatter-locations)) to top-level `type`, only when no valid top-level `type` already exists, and only when the value is one of the four known types. A file with no valid `type` at either location is left alone and reported under `missing type`.
- **`topics`**: derives top-level `topics` from, in order, whichever of these five states applies (visible in the report via `action`/`source`, see the `--json` schema below):
  1. **kept**: a non-empty top-level `topics` already exists, left untouched, regardless of shape. A shape other than a non-empty list of strings is still kept, never overwritten, but flagged under `invalid topics shape` in the report (`source: "invalid-shape"`) for manual review instead of being silently treated as canonical.
  2. **hoisted**: `metadata.topics` (the Claude Code auto-memory location) is a non-empty list of strings, hoisted to top-level `topics` **verbatim** (byte-identical values, no trim/dedupe/reorder), analogous to the `type` hoist above. The loader (see [Accepted frontmatter locations](#accepted-frontmatter-locations)) already reads `metadata.topics` liberally as a second source, and a small number of real corpus files (4 at the time of writing) carry curated topics only there; this hoist canonicalizes them instead of discarding and re-deriving. An invalid shape (not a list, or a list containing a non-string entry) is **not** hoisted; it falls through to the next step rather than crashing.
  3. **mapped**: a curated `--mapping` file rule matches.
  4. **derived**: a vocabulary pattern match (the same [topic vocabulary](#topic-vocabulary-topicsyml) the Topic Gate uses) against `name` + `description` **only**, never the body.
  5. **untagged**: no match at any step; reported under `untagged topics`.
- **`created`**: stamped from the file's mtime, marked `# approx (mtime)` so it's visibly an approximation rather than a real authored date, only when no `created` key exists yet.

The vocabulary step (4) is disclosed up front, not just when it fails: the report's `vocabulary:` header line reads `default (no topics.yml)`, `custom (topics.yml)`, or `default (topics.yml rejected: <reason>)` when the corpus has a `topics.yml` that fails to load (same three states the `--json` output exposes via `vocabulary`/`vocabularyError`). A rejected `topics.yml` is a setup error under `--apply` (exit 1, same as an invalid `--mapping` file, before anything is written); a dry run still runs, with the rejection reason shown as the hint.

Frontmatter is re-serialized with `yaml`'s Document API, serialized with `lineWidth: 0` so an existing scalar longer than 80 columns (most commonly `description:`) is never silently re-wrapped. This preserves key order and comments and only appends new fields; bodies are never touched (byte-identical before/after, comments included). It is not a byte-for-byte "preserves formatting" guarantee, though: `yaml` still normalizes trailing whitespace after a key, and a folded/literal block scalar's internal line wrapping is controlled by the format itself, not by `lineWidth`. A file with nothing to change is never rewritten at all, which is what makes a second `migrate --apply` run a true no-op.

**Mapping file format** (`--mapping <file>`), a curated fallback for memories no vocabulary pattern can classify; a top-level YAML list, first-rule-wins:

```yaml
# mapping.yml
- prefix: "feedback_"
  topics: [workflow]
- id: "reference_codebase_oracle"
  topics: [testing, workflow]
```

Each entry sets exactly one of `id` (exact memory id, i.e. filename without `.md`) or `prefix` (filename-prefix match), plus `topics` (a non-empty list of strings, used verbatim, not validated against the loaded vocabulary). An invalid or unreadable `--mapping` file is a setup error (exit 1), never silently ignored: a curated mapping the operator explicitly pointed at must not be quietly skipped over a typo.

`--json` emits a stable, documented report:

```jsonc
{
  "dir": "/path/to/memory",
  "mapping": "mapping.yml",      // or null
  "apply": false,                // true only under --apply
  "vocabulary": "default",       // "default" | "custom" (a topics.yml is present and valid)
  "vocabularyError": null,       // the rejection reason string when a present topics.yml is invalid, else null
  "files": [
    {
      "id": "feedback_example",
      "path": "/path/to/memory/feedback_example.md",
      "skipped": false,          // true for files that aren't valid memories at all (no frontmatter, missing `name`, ...)
      "reason": null,
      "changed": true,
      "type": { "action": "set", "value": "feedback", "source": "metadata.type" },
      // topics.source is one of "metadata.topics" (hoisted), "mapping" (mapped),
      // "vocabulary-pattern" (derived), or "invalid-shape" (kept as-is, but not
      // a list of strings, needs manual review); see the topics precedence above.
      "topics": { "action": "set", "value": ["deployment"], "source": "vocabulary-pattern" },
      "created": { "action": "set", "value": "2026-08-13", "source": "mtime (approx)" }
    }
  ],
  "summary": {
    "total": 1, "changed": 1, "unchanged": 0, "skipped": 0,
    "untaggedTopics": [], "missingType": [], "invalidTopicsShape": [],
    "applied": null,             // null in a dry run, a write count under --apply
    "errored": []
  }
}
```

Each field's `action` is `"kept"` (already canonical or, for `topics`, an existing value of any shape, never overwritten either way), `"set"` (this run derived/would derive a value), or `"missing"` (nothing mechanically derivable; needs manual review); for `topics`, `"missing"` renders as `untagged` in both the text and `--json` reports. `source` names which state an `action: "set"`/`"kept"` result actually landed in: for `topics`, `metadata.topics` (hoisted), `mapping` (mapped), `vocabulary-pattern` (derived), or `invalid-shape` (kept as-is, but not a list of strings, surfaced under `invalid topics shape` in the summary for manual review); `type`'s only source is `metadata.type`; `created`'s only source is `mtime (approx)`. A report, not a gate, like `eval`, for a dry run or for untagged/missing/invalid-shape findings, which always exit 0 regardless of how many files need manual review; under `--apply`, a non-empty `errored` list (a real per-file write failure) does exit 1.

### Corpus health report (`memory-router consolidate`)

Report-only corpus health check. **No LLM, no automatic merges, and it never writes anything** (not even a temp file inside the corpus dir); every finding is for the operator to act on by hand.

```bash
memory-router consolidate --dir ~/.claude/projects/PROJECT/memory
memory-router consolidate --dir ~/.claude/projects/PROJECT/memory --near-threshold 0.9 --json
memory-router consolidate --dir ~/.claude/projects/PROJECT/memory --repo-root ~/git/myrepo
```

Corpus dir resolution is the same as `test`/`eval`/`migrate`: `--dir` flag, then `$MEMORY_ROUTER_DIR`. Four independent, read-only passes:

- **Exact duplicates.** Groups memories whose BODY, after normalization, hashes identically. Frontmatter (`name`, `topics`, `severity`, ...) is not compared, only the body. Normalization: trim, collapse whitespace runs (spaces/tabs/newlines) to a single space, lowercase, then sha256 the result. An empty or whitespace-only body never forms a group with another empty body (two memories with no content share nothing meaningful); such memories are listed separately under `exactDupes.emptyBodies` instead of silently vanishing from the report.
- **Near duplicates.** Pairwise cosine similarity over EXISTING embedding-index vectors only (`<dir>/.memory-router/index.sqlite`, built separately by [`memory-router index`](#building-the-embedding-index)); this pass makes no live embedding API calls, and opens the index **read-only** (a write attempt through it is rejected by SQLite itself, not merely discouraged by convention). It runs only when the index exists AND was built under the currently configured embedding provider/model (the same provenance contract `memory-router index` enforces, see "Embedding provider" below); a missing, incompatible, or corrupted/unreadable index is SKIPPED with an explicit reason in the report, never a silent gap and never a crash of the whole `consolidate` run. `--near-threshold` sets the cosine floor (default `0.95`, in `(0, 1]`; the value is strictly validated as a whole number, e.g. `0.5abc` is rejected rather than silently truncated to `0.5`). When `indexedCount < totalCount`, the report also discloses whether the gap is because those memories were never indexed at all, or because they ARE indexed but under a different embedding model than the one currently active (`staleModelRows`/`staleModelReason`): the latter needs a rebuild (`memory-router index`), not just a re-run, and looks identical to the former from the counts alone otherwise.
- **Stale references.** Delegates entirely to [`memory-router stale`](#stale-memory-references), unchanged: same `verify:` frontmatter contract, same output, default repo root `process.cwd()`. Override with `--repo-root <path>` / `--repo-roots <p1> <p2> ...`, the same two flag forms `stale` itself accepts.
- **Schema metrics.** `untagged` (the resolved topics value, top-level `topics:` when present and non-null else `metadata.topics`, mirroring the loader's own `fm.topics ?? fm.metadata?.topics ?? []` precedence exactly, so an explicit top-level `topics: []` shadows a non-empty `metadata.topics` the same way it does at runtime, is an empty array), `invalid topics shape` (that resolved value is present but isn't a list at all, e.g. a string or a YAML map; reported separately from `untagged` rather than folded into it, the same distinction [`migrate`](#migrating-to-schema-v1-memory-router-migrate) makes), `legacy format` (`metadata.type` present without a top-level `type`, the pre-schema-v1 shape `migrate` backfills) with its rate, and `loader rejects` (files `src/memory/loader.ts` silently drops, with the reject reason, since the loader itself only debug-warns them and never surfaces why).

Always a report, never a gate: exits 0 on any error-free run regardless of how many findings it surfaces (same contract as `eval`/`migrate`'s dry-run path).

`--json` emits a stable, documented report:

```jsonc
{
  "dir": "/path/to/memory",
  "scannedCount": 42,               // memories loadMemoriesFromDir() actually loaded
  "exactDupes": {
    "normalization": "trim, collapse whitespace runs (spaces/tabs/newlines) to a single space, lowercase, then sha256 the result",
    "groups": [
      { "hash": "…", "ids": ["a", "b"], "paths": ["/path/to/memory/a.md", "/path/to/memory/b.md"] }
    ],
    "emptyBodies": [{ "id": "blank", "path": "/path/to/memory/blank.md" }]
  },
  "nearDupes": {
    "status": "ok",                 // "ok" | "skipped"
    "reason": null,                 // always present: null on "ok" (shown here), the skip explanation on "skipped" (a stable key set either way)
    "threshold": 0.95,
    "indexedCount": 40,             // memories that had a usable, same-model index vector
    "totalCount": 42,               // indexedCount < totalCount means the index is stale
    "pairs": [
      { "aId": "a", "aPath": "/path/to/memory/a.md", "bId": "c", "bPath": "/path/to/memory/c.md", "similarity": 0.97 }
    ]
    // "staleModelRows"/"staleModelReason" only appear on an "ok" result when
    // indexedCount < totalCount AND some of the missing rows exist in the
    // index but under a different embedding model than the one active now.
  },
  "stale": { /* verbatim StaleReport, see "Stale memory references" --json */ },
  "schema": {
    "scannedCount": 42,
    "untaggedCount": 2, "untaggedIds": ["…"],
    "legacyFormatCount": 5, "legacyFormatRate": 0.119, "legacyFormatIds": ["…"],
    "invalidTopicsShapeCount": 1, "invalidTopicsShapeIds": ["…"],
    "loaderRejects": [{ "path": "/path/to/memory/broken.md", "reason": "no YAML frontmatter delimiter (`---`) found" }]
  }
}
```

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

`MEMORY_ROUTER_EMBED_PROVIDER` is case-insensitive and tolerates surrounding whitespace; an unrecognized value is treated as unset (falls through to auto-detect) rather than erroring. An explicit `openai` selection with no `OPENAI_API_KEY` fails open (same as today), it never silently substitutes Ollama.

Privacy note: under auto-detect with no `OPENAI_API_KEY`, prompt text and memory bodies are sent as-is to whichever endpoint `MEMORY_ROUTER_OLLAMA_BASE_URL` resolves to (default `http://localhost:11434`), with no check that the endpoint is actually who it claims to be.

Overrides:

- `MEMORY_ROUTER_EMBED_MODEL`: model name override. Applies to OpenAI always, and to Ollama when the provider was chosen *explicitly* (`MEMORY_ROUTER_EMBED_PROVIDER=ollama`, a deliberate choice). It is deliberately NOT consulted on the *auto-detected* Ollama path: a `MEMORY_ROUTER_EMBED_MODEL` left over in the environment was almost certainly set for OpenAI, and picking it up there would silently point Ollama at a model name it doesn't have.
- `MEMORY_ROUTER_OLLAMA_EMBED_MODEL`: model name override for the auto-detected Ollama path specifically; not consulted anywhere else.
- `OPENAI_BASE_URL`: OpenAI-compatible proxy base URL (OpenAI path only).
- `MEMORY_ROUTER_OLLAMA_BASE_URL`: Ollama base URL, default `http://localhost:11434`. Ollama is queried through its OpenAI-compatible `/v1/embeddings` endpoint, unauthenticated.

Model-variable precedence:

| Path | Model resolution |
| --- | --- |
| Explicit OpenAI, or auto-detected OpenAI (`OPENAI_API_KEY` present) | `MEMORY_ROUTER_EMBED_MODEL`, else `text-embedding-3-small` |
| Explicit Ollama (`MEMORY_ROUTER_EMBED_PROVIDER=ollama`) | `MEMORY_ROUTER_EMBED_MODEL`, else `nomic-embed-text` |
| Auto-detected Ollama (no `OPENAI_API_KEY`, no explicit provider) | `MEMORY_ROUTER_OLLAMA_EMBED_MODEL`, else `nomic-embed-text` (`MEMORY_ROUTER_EMBED_MODEL` is not consulted) |

Embedding dimensionality is never hardcoded: it's read off the first real embed response and recorded in the index alongside the provider and model. An index opened under a different provider refuses at open time to silently compare incompatible vector spaces. A same-provider dimensionality change (rare, e.g. switching to a differently-sized OpenAI model) isn't checked at open time; it's instead caught the moment it's actually written or queried, by the same plain dimension check that would fire against sqlite-vec's fixed column width anyway. Either way `memory-router index`/the Confidence Gate raise an error naming the exact rebuild command (`rm -rf '<dir>/.memory-router' && memory-router index '<dir>'`) instead of returning wrong neighbours. Switching `MEMORY_ROUTER_EMBED_MODEL` between two *same-dimension* models of the same provider (e.g. two same-width OpenAI models) is unaffected by either check: the existing per-memory model tag already excludes stale rows from a search, no rebuild required.

Local Ollama setup: `ollama pull nomic-embed-text`, then run `ollama serve` (or use the app) before `memory-router index`/normal hook usage.

#### Query-embedding cache

Repeated vague prompts (`"mal schauen"`, `"check mal"`) re-pay one OpenAI embedding call (~150–300 ms + ~$0.00002) every time the Confidence Gate fires. The router memoizes prompt → embedding in the same `index.sqlite` file under a `query_cache` table:

- **Key:** sha256(prompt) prefix (8 bytes, plenty for the LRU cap).
- **Eviction:** LRU by `accessed_at`, hard cap of 1000 entries. Switching `MEMORY_ROUTER_EMBED_MODEL` lazily evicts entries stored under the previous model on the next put.
- **Persistence:** survives hook process restarts (the file is the only state).
- **Observability:** set `MEMORY_ROUTER_DEBUG=1` to see `[memory-router] query cache hit (size=N)` / `[memory-router] query cache miss; embedding (size=N)` lines on stderr without polluting the hook's stdout contract. Same `[memory-router]` prefix as loader rejection warnings, so `grep '^\[memory-router\]'` catches every gated diagnostic.

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

`tests/coverage/` above is a pass/fail regression net (every labelled prompt is an assertion). `memory-router eval <golden.yml>` is the companion **measurement** tool: it runs a golden set of `(prompt, expected memory ids)` pairs against a real corpus and reports precision, recall, and MRR: a number to track over time, not a gate. v1 deliberately has no threshold/exit-code contract on the metrics themselves: it exits 0 on any error-free run no matter how the numbers look. The intent is measuring the router's actual retrieval behavior against a baseline, so a retrieval change's effect (e.g. the score-blend resolver, mm-v1-T004) is measurable instead of argued from vibes.

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

**What gets measured:** `eval` mirrors exactly what the `UserPromptSubmit` hook would select for the same prompt: the score-blend resolver (`resolveBlended`, mm-v1-T004, see "How it works" above), with the same fail-open fallback on a semantic-search error. Without an embedding index (`<dir>/.memory-router/index.sqlite`, built by `memory-router index`) and a resolvable embedding provider (an `OPENAI_API_KEY`, or, since mm-v1-T003, an auto-detected local Ollama daemon, see "Embedding provider" below), the semantic signal can't contribute a score; `eval` still runs and measures the Topic Gate's degraded contribution, and the report says so explicitly via `"semantic path: inactive"` rather than silently reporting a gap as a "measured" zero. `"semantic path: configured"` means only that an index exists and a provider resolved, not that the provider is actually reachable: this is a config check, not a live reachability probe, so a configured-but-unreachable Ollama daemon (or one missing the configured model) still reports as configured until the first real embed call fails, same fail-open shape as an unreachable OpenAI endpoint already has today. When the semantic path IS configured, this has a real-world cost: since mm-v1-T004 the semantic signal runs for **every** prompt in the golden set, not only the ones a deterministic gate missed, so it costs money (OpenAI) or local compute (Ollama) once per prompt against your configured provider, and the prompt text leaves the machine to whichever endpoint is configured; size your golden set with that in mind.

Golden ids that don't resolve against the corpus (a stale or mistyped memory id) are reported, not silenced: the text report prints a `WARNING:` line listing them, and `--json` carries the same list as the top-level `unknownExpectIds` array (empty when every id resolves). This never changes precision/recall/MRR (an unresolvable id still deflates recall for its prompt exactly as before); it just makes the cause visible instead of a silent gap.

The report also states which topic vocabulary the Topic Gate used for the run, via `vocabularySource`: `"built-in default"`, or `"custom (<dir>/topics.yml)"` when the corpus overrides it (see [Topic vocabulary](#topic-vocabulary-topicsyml)). `eval` always scores against `--dir`'s (or `$MEMORY_ROUTER_DIR`'s) own `topics.yml`, never a stray `MEMORY_ROUTER_DIR` left over in the environment, so a run pointed at the wrong corpus, or hitting a broken `topics.yml`, shows up here instead of silently scoring against the wrong vocabulary.

The report also states, via `semanticContributedCount`, how many of the golden set's prompts had at least one hit actually won by the semantic/confidence gate (a semantic score that cleared the relevance floor and beat out the other candidates for a slot); printed as a `semantic contributed: N/M prompts` line in the text report. This is distinct from `semanticPathActive` above: that only proves an index + provider are *configured*; `semanticContributedCount` proves the semantic signal actually *won* a slot for a given prompt, which can be far lower than `M` even with `semanticPathActive: true` (e.g. every candidate falling below `MEMORY_ROUTER_BLEND_MIN_SEMANTIC` on a given prompt, or the Topic Gate simply out-scoring it).

**Metric definitions**, per prompt:

- **Precision** = `|expect ∩ got| / |got|` (`0` when nothing was returned).
- **Recall** = `|expect ∩ got| / |expect|`.
- **Reciprocal rank** = `1 / rank` of the first `got` id that's also in `expect` (1-indexed), or `0` if none of `expect` ever appears in `got`.
- **Negative control** (`expect: []`): precision = recall = `1.0` when `got` is empty, else `0.0`. Reciprocal rank is undefined (`null`) for negative controls (they carry no ranking signal), and negative controls are **never** blended into the aggregate precision/recall/MRR below; they're reported as their own pass/fail count.

Caveat: when two or more memories tie on score for the same prompt, the tie is broken by corpus load order. That order is deterministic: the loader sorts its directory listing lexicographically (code-unit order, `src/memory/loader.ts`), so a tied prompt's reciprocal rank (and therefore MRR) reproduces across machines and filesystems. Renaming a memory file can still move it within its tie group and shift MRR without any gate-logic change.

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
  "semanticContributedCount": 0,
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

- ✅ Score-blend resolver (mm-v1-T004): semantic score (sqlite-vec, OpenAI or Ollama, filtered by a relevance floor) as the dominant signal, Topic Gate as a boost, recency/type as tie-breaking modifiers, a Tool Gate hit always privileged into the final cap. Runs unconditionally whenever an index + provider are available; fails open to the exact flat pre-blend topic-only resolver (no recency/type modifiers) if no provider is configured/reachable, the index is absent, every candidate falls below the relevance floor, or the semantic call errors.
- ✅ Topic Gate (deterministic keyword → topic map; built-in 5-topic default, corpus-overridable via `topics.yml`, see [Topic vocabulary](#topic-vocabulary-topicsyml))
- ✅ Tool Gate (regex match on Bash command + tool-name match, with ReDoS guardrails)
- ✅ Hook binaries (`UserPromptSubmit`, `PreToolUse`) with stdin/stdout contract
- ✅ MCP server (`memory_search`, `memory_apply`, `memory_resolve`)
- ✅ Lint surface (`drift`, `unknown-topics`, `conflicts`)
- ✅ Stale detector (`stale --repo-root <path>` with `verify:` frontmatter contract)
- ✅ Schema v1 migration (`migrate --dir <path> [--apply] [--mapping <file>]`, mm-v1-T006): mechanical, idempotent frontmatter backfill (hoist `metadata.type`, derive `topics` in order from a `metadata.topics` hoist, a curated mapping, then a vocabulary pattern match, stamp `created` from mtime). No LLM, no guessing.
- ✅ Corpus health report (`consolidate --dir <path> [--near-threshold <n>] [--repo-root <path>]`, mm-v1-T007, fix round): exact-dupe body-hash groups (empty/whitespace-only bodies reported separately, never grouped), near-dupe cosine over a **read-only** view of the existing embedding index (skipped-with-reason when missing/incompatible/corrupted, never silent, never a crash; distinguishes "never indexed" from "indexed under a stale model"), stale references (reuses `stale` unmodified, `--repo-root`/`--repo-roots` threaded through), and schema metrics (untagged, invalid topics shape, legacy-format rate, loader rejects). No LLM, no automatic merges, never writes.
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
