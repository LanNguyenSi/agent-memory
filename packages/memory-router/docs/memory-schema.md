# Memory frontmatter schema

Full reference for the frontmatter fields memory-router reads, where it
accepts them, and how the topic vocabulary can be overridden per corpus.
See the [README](../README.md) for the score-blend resolver these fields
feed into.

## Fields

Existing Claude Code memory files already use YAML frontmatter.
memory-router adds four optional fields:

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

All new fields are optional. Legacy memories still load and can fire via
semantic match.

The loader reads the memory directory in deterministic lexicographic order
(plain code-unit `Array#sort` over the directory listing, locale-independent),
not the filesystem's `readdir` order, so hook injection and `eval` see the
same corpus order on every machine and filesystem. This holds for
byte-identical filenames; a memory file whose name differs in Unicode
normalization between machines (NFD vs NFC) can still sort differently.

## Accepted frontmatter locations

Canonically, `type` and `topics` live top-level (as in the example above).
Most real Claude Code auto-memories instead nest them under `metadata.`
(in the reference corpus as of 2026-08, roughly 230 of 285 files carry
only `metadata.type`). The loader accepts both locations; on conflict the
top-level value wins. New tooling should write top-level. `type` must be
one of `user`, `feedback`, `project`, `reference`: a file with an unknown
or non-string type is skipped entirely (visible only with
`MEMORY_ROUTER_DEBUG=1`), so a typo'd `type` removes that memory from all
gates until `memory-router lint --drift` surfaces it.

## Topic vocabulary (`topics.yml`)

The Topic Gate's keyword to topic map ships a built-in 5-topic default
(`deployment`, `destructive_ops`, `workflow`, `security`, `testing`, see
`src/topic-patterns.ts`). A corpus can override it wholesale (replace, not
merge) by dropping a `topics.yml` file at the root of `MEMORY_ROUTER_DIR`:

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

A fuller worked example (three custom topics, descriptions) is available
at [`tests/fixtures/vocab/topics.yml`](https://github.com/LanNguyenSi/agent-memory/blob/master/packages/memory-router/tests/fixtures/vocab/topics.yml)
in the repo; that path is source-tree only (not part of the published npm
package), so treat it as an optional cross-reference.

Shape: a top-level list of `{ name, description?, patterns? }` entries.

- `name` is required and must be unique across the file.
- `description` is optional, documentation only, not matched against.
- `patterns` is an optional list of regex strings, matched
  case-insensitively. A topic declared with no `patterns:` at all, whose
  one pattern fails to compile, or whose pattern is rejected by the ReDoS
  safety screen (see the README's [Trust Model](../README.md#trust-model))
  degrades to a keyword match on its own `name` rather than being dropped
  or crashing anything.

Both the Topic Gate and `memory-router lint --unknown-topics` load and
validate against whatever `topics.yml` resolves to:

- **Missing file:** the built-in 5-topic default, unchanged.
- **Present and valid:** the corpus vocabulary, corpus-wide, fully
  replacing the default: a memory tagged `security` under a custom
  vocabulary that doesn't declare a `security` entry will not match on
  that topic anymore.
- **Present and invalid** (YAML error, missing/duplicate `name`, wrong
  field shape): rejected with a clear error message. The Topic Gate never
  crashes over it, it degrades silently to the built-in default (the
  `UserPromptSubmit` hook must never block a prompt over a broken corpus
  file; set `MEMORY_ROUTER_DEBUG=1` to see the rejection reason on
  stderr). `memory-router lint --unknown-topics` also falls back to the
  built-in default for the scan itself, but prints the rejection reason at
  the top of its report instead of hiding it, and exits 1 for the
  rejection alone, even when the fallback scan itself finds zero
  unknown-topic hits.

`Topic` is a plain string at the type level; there is no compiled-in
closed set left to extend in source. What counts as a known topic is
resolved at load time against whichever vocabulary is active, not
enforced by TypeScript.

## `verify:` stale-marker on recall

A memory that names a concrete file, symbol, or flag is making a claim
about the current repo state. Memories don't self-update: a file renamed
or deleted leaves the memory silently wrong. When a matched memory has
`verify:` entries and any `kind: path` entry no longer exists on disk, the
router prefixes the memory's injected context with:

```
> ⚠️ **stale:** path '...' not found at ...
>
> This memory references something that no longer exists. Verify before acting.
```

The memory is **not** suppressed. The agent still sees the rule, just with
the warning that something underneath has changed.

- `kind: 'path'` is checked inline via `fs.statSync`. Relative values
  resolve against `repoRoot` (default `process.cwd()`) and must stay
  inside it.
- `kind: 'symbol' | 'flag'` is accepted in the shape but skipped inline
  (the hook stays zero-dep and sub-10 ms). Use the `verify_memory_reference`
  MCP tool from [agent-grounding/grounding-mcp](https://github.com/LanNguyenSi/agent-grounding/tree/master/packages/grounding-mcp)
  for those, or the proactive `memory-router stale` command (see
  [docs/commands.md](commands.md)).
