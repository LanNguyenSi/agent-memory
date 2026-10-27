# CLI command reference

`memory-router --help` documents each verb's flags. This document adds
what `--help` does not: JSON schemas, the programmatic API, edge-case
behavior, and a few operational recipes. See the
[README](../README.md#usage) for the one-line summary of each verb.

## `memory-router tag`: migrating existing memories

Legacy memory files (`name`/`description`/`type` only) never fire through
the router; they're missing `topics:` and `triggers:`. `tag` proposes
those fields based on a scored keyword match: `name` counts 3x,
`description` 2x, and the body 1x per keyword hit; the top 2 topics by
score are proposed, with a minimum score of 3 to propose anything at all.

```bash
memory-router tag ~/.claude/projects/PROJECT/memory                    # dry-run, prints a diff per file
memory-router tag ~/.claude/projects/PROJECT/memory --apply            # commit the changes
memory-router tag ~/.claude/projects/PROJECT/memory --only feedback_stacked_pr_base
```

Idempotent: re-running is a no-op on files already tagged. Existing
frontmatter is preserved; only `topics` and `severity` are added when
missing. `triggers.command_pattern` is never auto-generated (too risky);
candidates are printed to stderr as a hint block for manual review.

## `memory-router stale`: limitations

Symbol checks are degraded ("skipped" with a stderr warning) only when
EVERY repo root passed via `--repo-root`/`--repo-roots` is a non-git
path; a single git root among several keeps symbol resolution honest.

The `--scan-body` flag additionally extracts refs from a memory's body
via a backtick + path-shape regex and a function-call regex (`myFn()`,
`Class.method()`). When a `verify:` block is present on a memory,
body-regex extraction is skipped for that memory even with `--scan-body`
on; the explicit contract always wins.

A malformed `verify:` entry (missing `value`, non-identifier symbol
shape, etc.) is reported as `malformed` so you fix the YAML rather than
chase a phantom missing file.

A date-staleness pass runs unconditionally as INFO: a memory whose
newest ISO 8601 date in the body is older than 90 days and whose
frontmatter has no newer `updatedAt:` is flagged `possibly-stale`; stamp
`updatedAt: 2026-04-23` when the underlying claim is still current.

- Symbol checks require a git repo root; a non-git directory degrades to
  "skipped" rather than reporting STALE.
- `git grep` is not AST-aware: a symbol that survives only in a comment or
  a generated file counts as found.
- `--check-urls` HEAD-requests every external URL extracted from a
  memory's body, with a 5-second timeout per request.

## Building the embedding index

The Confidence Gate's semantic match requires a one-time index build:

```bash
memory-router index ~/.claude/projects/PROJECT/memory
```

Unless `MEMORY_ROUTER_EMBED_PROVIDER` names a provider, the build uses
OpenAI embeddings when `OPENAI_API_KEY` is set and an Ollama endpoint
(default `http://localhost:11434`) otherwise; see
[docs/scoring.md](scoring.md#embedding-provider) for provider selection.

- Stores embeddings under `<dir>/.memory-router/index.sqlite` via
  sqlite-vec (cosine distance): one document vector per memory (name +
  description + body, cut at 8,000 characters) plus, since index schema
  v3, one vector per body chunk, so a long memory is also findable by text
  past that cut. The semantic score is the better of the two
  ([docs/scoring.md](scoring.md#signals-in-the-blend)); a memory still
  produces at most one hit.
- Chunks are split at markdown block boundaries (headings, top-level list
  items, blank-line paragraphs), merged up to about 1,500 characters, and
  a piece over about 3,000 is split at a line or sentence boundary; a
  fenced code block is never split unless the block alone exceeds the cap.
  A memory with an empty body gets no chunks. The sizes are fixed
  constants (`CHUNK_TARGET_CHARS`, `CHUNK_MAX_CHARS`), not env knobs.
- Re-runs are incremental: unchanged files (by mtime) are skipped,
  removed files are purged (their chunk rows go with them), and a changed
  file has its whole chunk set rewritten.
- The index records the chunker version (`CHUNKER_VERSION`, meta key
  `chunker_version`, no schema bump). When it is missing (an index built
  before the stamp) or differs from the running version, the next `index`
  run re-chunks every memory even though no file changed: chunk vectors and
  keyword rows are rewritten, document vectors are not re-embedded. The
  stamp is written only after the whole run succeeded, so an interrupted
  run redoes the pass.
- Since index schema v4 the same run also maintains an FTS5 keyword index
  (`chunks_fts`, the FTS5 module bundled with SQLite, no new native
  dependency): name, description and every chunk body, one row per
  chunk. It powers the keyword gate (identifier tokens like `4e7729ab`
  or `b11905`): only tokens passing the id rule (6+ characters, ASCII
  letters and digits, at least one of each, no separators) are queried,
  and one that appears in at most 12 memories admits its memory at the
  floor edge (`minSemanticScore + 0.01`, plus the usual topic, type and
  recency modifiers) when no embedding scored it above the floor; a
  below-floor cosine is never lifted or blended
  ([docs/scoring.md](scoring.md#the-keyword-gate-schema-v4)). Like the v3
  chunks, the keyword rows are back-filled by the next `index` run after
  a migration; until then the keyword path simply finds nothing.
- **After upgrading to index schema v3, run `memory-router index <dir>`
  once** (for example
  `memory-router index ~/.claude/projects/PROJECT/memory`) to build the
  chunks. The existing index keeps working until you do: the first
  writable open migrates the file in place (no chunk rows yet, so search
  behaves exactly as before on document vectors alone), and that first
  `index` run embeds chunks for every memory even though no file changed;
  the run reports it as `indexed 0 file(s) (N up-to-date, 0 removed,
  M chunk(s) embedded)`.
- **The v3 migration is one-way.** After a file has been migrated, older
  memory-router versions refuse to open it for writing
  (`on-disk schema_version 3 is newer than this code supports (2);
  upgrade memory-router`); older read-only opens keep working. So
  restart long-running memory-router processes (an MCP server you
  started earlier) right after upgrading: until they restart, every
  `memory_search` they serve fails. Downgrading to a version before v3
  means deleting `<dir>/.memory-router/index.sqlite` and running
  `memory-router index <dir>` to rebuild the index from scratch. The v4
  migration (adding `chunks_fts`) follows the same rules: one-way for
  writable opens (a v4 file reports `on-disk schema_version 4 is newer
  than this code supports` to pre-v4 code), read-only opens neither
  create nor migrate it, and downgrading means deleting and rebuilding
  the index file.
- Without an index, or with `MEMORY_ROUTER_EMBED_PROVIDER=openai` set but
  no `OPENAI_API_KEY`, the semantic match returns no hits; the Topic and
  Tool Gates still fire. A failed embedding call (provider unreachable,
  timeout) makes the hook write one stderr line and fall back to the
  topic-only result.

The hook never builds the index inline (cold-start latency would block
every prompt by seconds). Run `memory-router index` manually, or schedule
it (cron, launchd, a systemd timer), for example right after the periodic
agent-memory-sync job. See
[docs/scoring.md](scoring.md) for provider selection and timeout
configuration.

## Debugging rejected memories

The loader silently skips memory files with broken YAML frontmatter or
missing required fields (`name`, `type`). That is the right default for
production hooks (one bad memory must not kill the whole session), but it
means a memory author can't tell the file is dead weight without
dogfooding.

Set `MEMORY_ROUTER_DEBUG=1` to make the loader print one stderr line per
rejected memory, e.g.:

```
[memory-router] skipped /path/to/feedback_yaml_form_quoting.md: YAML parse error: ...
[memory-router] skipped /path/to/legacy.md: missing required field 'name'
```

Stdout (the hook contract) is never touched. Each warning is exactly one
`\n`-terminated line, even when the underlying YAML error spans multiple
lines, so `grep '^\[memory-router\]'` always works.

## `memory-router lint --drift`: keeping MEMORY.md clean

`MEMORY.md` is the canonical index Claude Code loads at session start. It
drifts: pointers to deleted files, memory files never added to the index,
duplicates, or a file that grows past the 200-line truncation cap (lines
after 200 are silently dropped from context). Checks:

- **Orphan pointer**: MEMORY.md lists `file.md` but the file no longer exists.
- **Missing pointer**: a memory file exists in the dir but is not listed in MEMORY.md.
- **Duplicate entry**: the same filename appears twice in MEMORY.md.
- **Duplicate name**: two memory files share a frontmatter `name` (case-insensitive).
- **Length warning**: MEMORY.md > 200 lines.
- **Invalid frontmatter**: missing `name`/`description`/`type`, unknown `type`, or YAML that fails to parse.
- **Description too long**: frontmatter `description` > 150 chars (the same text is used as the MEMORY.md hook, where it would blow the one-line budget).

`--fix` auto-applies safe fixes (append missing pointers, remove
duplicate entries); orphan pointers are never auto-deleted, might be
intentional while a file is temporarily absent.

Pre-commit hook snippet, rejects drift before it lands:

```bash
# .git/hooks/pre-commit (or a pre-commit framework config)
memory-router lint ~/.claude/projects/PROJECT/memory --drift --json \
  || { echo "memory-router drift check failed, run with --fix or resolve manually"; exit 1; }
```

## `memory-router lint --conflicts`

Finds pairs of `feedback` memories that share a topic and may contradict
each other. Two heuristics: topic overlap among `feedback` memories (INFO,
surface for human glance) and opposite-imperative pairs whose first body
lines share substantial subject vocabulary (HIGH, e.g. "ALWAYS amend
commits" vs "NEVER amend commits" both tagged `workflow`). Only HIGH
findings exit non-zero. Opt-in (off by default) because INFO-level overlap
is expected on a mature corpus.

Add `--semantic` to catch paraphrased pairs the regex pass misses (e.g.
"always squash before merge" vs "never squash, use fast-forward only"):
the linter embeds both memories' name+body and upgrades the pair to HIGH
when cosine similarity >= 0.85, reusing the embedding cache
`memory-router index` already maintains; pairs not yet in the index are
embedded on the fly without persisting. When `OPENAI_API_KEY` is unset the
semantic step prints a stderr warning and falls back to the regex-only
signal (fail-open: no provider configured). The lint only reads the index,
never modifying it or its recorded width; if the index cannot be opened
(unreadable file, legacy layout, inconsistent width) it prints one stderr
warning and embeds the pairs on the fly instead, exit code unchanged.

If an embed call for a missing pair actually errors (timeout, HTTP
failure, malformed response) the failure is enriched with the same
provider/model/base-URL context as `memory-router index`, for example
against a local Ollama daemon:

```
embedding call failed (provider=ollama baseUrl=http://localhost:11434 model=bge-m3): The operation was aborted due to timeout If this is a local Ollama daemon: run `ollama serve` (or start the app) and `ollama pull bge-m3` if the model isn't downloaded yet.
```

and propagates, exiting `lint` non-zero. This is deliberately
fail-closed, unlike the fail-open "no provider configured" case above,
because it signals a real failure in a provider the operator did
configure rather than one intentionally left unset.

The polarity vocabulary covers ALL-CAPS and lowercase forms of `always`,
`never`, `must`, `must not`, `do`, `do not`, `don't`, `prefer`, `require`,
`avoid`, `skip`, plus formal-register markers `mandatory`, `mandate`,
`compulsory`, `prohibit`, `forbid`, `disallow`, and `cannot`.

`--json` output: `{ scannedCount, feedbackCount, hits: [{ severity, topic,
reason, a: { path, memoryId, firstLine }, b: { ... } }] }`. When combined
with `--drift --json`, the drift JSON owns stdout and the conflicts JSON
is routed to stderr.

## `memory-router migrate` JSON schema

Frontmatter is re-serialized with `yaml`'s Document API, serialized with
`lineWidth: 0` so an existing scalar longer than 80 columns is never
silently re-wrapped. Bodies are never touched (byte-identical
before/after). A file with nothing to change is never rewritten at all,
which is what makes a second `migrate --apply` run a true no-op.

Each mapping-file entry (`--mapping <file>`) sets exactly one of `id`
(exact memory id) or `prefix` (filename-prefix match), plus `topics` (a
non-empty list of strings, used verbatim, not validated against the
loaded vocabulary).

```jsonc
{
  "dir": "/path/to/memory",
  "mapping": "mapping.yml",      // or null
  "apply": false,                // true only under --apply
  "vocabulary": "default",       // "default" | "custom"
  "vocabularyError": null,       // the rejection reason string when a present topics.yml is invalid, else null
  "files": [
    {
      "id": "feedback_example",
      "path": "/path/to/memory/feedback_example.md",
      "skipped": false,
      "reason": null,
      "changed": true,
      "type": { "action": "set", "value": "feedback", "source": "metadata.type" },
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

Each field's `action` is `"kept"` (already canonical, or, for `topics`, an
existing value of any shape, never overwritten either way), `"set"` (this
run derived/would derive a value), or `"missing"` (nothing mechanically
derivable). `source` names which state an `action: "set"`/`"kept"` result
landed in: for `topics`, `metadata.topics` (hoisted), `mapping` (mapped),
`vocabulary-pattern` (derived), or `invalid-shape`; `type`'s only source
is `metadata.type`; `created`'s only source is `mtime (approx)`.

## `memory-router consolidate` JSON schema

```jsonc
{
  "dir": "/path/to/memory",
  "scannedCount": 42,
  "exactDupes": {
    "normalization": "trim, collapse whitespace runs (spaces/tabs/newlines) to a single space, lowercase, then sha256 the result",
    "groups": [
      { "hash": "...", "ids": ["a", "b"], "paths": ["/path/to/memory/a.md", "/path/to/memory/b.md"] }
    ],
    "emptyBodies": [{ "id": "blank", "path": "/path/to/memory/blank.md" }]
  },
  "nearDupes": {
    "status": "ok",                 // "ok" | "skipped"
    "reason": null,
    "threshold": 0.95,
    "indexedCount": 40,             // memories that had a usable, same-model index vector
    "totalCount": 42,               // indexedCount < totalCount means the index is stale
    "pairs": [
      { "aId": "a", "aPath": "/path/to/memory/a.path", "bId": "c", "bPath": "/path/to/memory/c.md", "similarity": 0.97 }
    ]
    // "staleModelRows"/"staleModelReason" only appear on an "ok" result when
    // indexedCount < totalCount AND some of the missing rows exist in the
    // index but under a different embedding model than the one active now.
  },
  "stale": { "...": "verbatim StaleReport, see memory-router stale --json" },
  "schema": {
    "scannedCount": 42,
    "untaggedCount": 2, "untaggedIds": ["..."],
    "legacyFormatCount": 5, "legacyFormatRate": 0.119, "legacyFormatIds": ["..."],
    "invalidTopicsShapeCount": 1, "invalidTopicsShapeIds": ["..."],
    "loaderRejects": [{ "path": "/path/to/memory/broken.md", "reason": "no YAML frontmatter delimiter (`---`) found" }]
  }
}
```

## `memory-router eval` metric definitions and JSON schema

Your corpus's own `golden.yml` lives in the memory dir itself (synced
alongside the `.md` files by
[agent-memory-sync](../../agent-memory-sync)), not in this repo; curate
it from real prompts you've actually asked, labelled with the memory ids
you'd want to fire.

`"semantic path: configured"` means only that an index exists and a
provider resolved, not that the provider is actually reachable: this is
a config check, not a live reachability probe, so a configured-but-
unreachable provider still reports as configured until the first real
embed call fails. When the semantic path is configured, every prompt in
the golden set is sent to that provider, which costs money (OpenAI) or
local compute (Ollama) once per prompt, and the prompt text leaves the
machine to whichever endpoint is configured; size your golden set with
that in mind.

Golden ids that don't resolve against the corpus (a stale or mistyped
memory id) are reported, not silenced: the text report prints a
`WARNING:` line listing them, and `--json` carries the same list as the
top-level `unknownExpectIds` array (empty when every id resolves).

Stale-memory check: a golden entry may carry an optional `forbid:` list of
memory ids that must NOT appear among the returned hits (the top 5, the
hook's cap) for that prompt, for example the ids of memories marked
`status: retired` (see [scoring.md](scoring.md#retired-project-memories)):

```yaml
prompts:
  - prompt: "Restart the embedding server, search is empty"
    expect: ["reference_current_embedding_setup"]
    forbid: ["project_old_embedding_setup"]
```

`forbid` is optional and defaults to `[]`; an empty list means nothing is
forbidden, a negative control (`expect: []`) may carry one, duplicates
collapse, and a value that is not a list of strings, or an id listed in both
`expect` and `forbid`, is a setup error (exit 1, message prefixed with the
entry's index). The check is reported next to the metrics and never changes
precision, recall or MRR: the text report prints `forbid: ... ok` or
`forbid: ... FAIL (present: ...)` under the prompt and one
`forbid checks: N/M prompts clean` line in the aggregate; `--json` adds
`perPrompt[].forbid` and `perPrompt[].forbidViolations`, `aggregate.forbid`
(`{ total, violated }`: prompts with a non-empty list, and how many of them
had a forbidden id in the result) and the top-level `unknownForbidIds`
(forbid ids that match no memory, which would pass vacuously; the text
report prints a `WARNING:` line for them).

`eval` always scores against `--dir`'s (or `$MEMORY_ROUTER_DIR`'s) own
`topics.yml`, never a stray `MEMORY_ROUTER_DIR` left over in the
environment, so a run pointed at the wrong corpus, or hitting a broken
`topics.yml`, shows up here instead of silently scoring against the
wrong vocabulary.

Per prompt:

- **Precision** = `|expect ∩ got| / |got|` (`0` when nothing was returned).
- **Recall** = `|expect ∩ got| / |expect|`.
- **Reciprocal rank** = `1 / rank` of the first `got` id that's also in
  `expect` (1-indexed), or `0` if none of `expect` ever appears in `got`.
- **Negative control** (`expect: []`): precision = recall = `1.0` when
  `got` is empty, else `0.0`. Reciprocal rank is undefined (`null`) for
  negative controls (they carry no ranking signal), and negative controls
  are never blended into the aggregate precision/recall/MRR below.

Caveat: when two or more memories tie on score for the same prompt, the
tie is broken by corpus load order (deterministic, see
[docs/memory-schema.md](memory-schema.md)). Renaming a memory file can
still move it within its tie group and shift MRR without any gate-logic
change.

Aggregate, over the golden set: `precision`, `recall`, `mrr` are the mean
of the per-prompt values above, computed only over positive prompts
(non-empty `expect`); `negativeControls: { total, passed, failed, rate }`
reports the negative-control prompts separately.

```jsonc
{
  "goldenPath": "golden.yml",
  "dir": "/path/to/memory",
  "corpusSize": 42,
  "semanticPathActive": false,
  "vocabularySource": "built-in default",
  "unknownExpectIds": [],
  "unknownForbidIds": [],
  "semanticContributedCount": 0,
  "keywordContributedCount": 0,
  "injection": { "budgetBytes": 16384, "meanBytes": 1523.5, "maxBytes": 3012 },
  "perPrompt": [
    {
      "prompt": "merge this PR for the billing module",
      "expect": ["feedback_review_before_merge"],
      "got": ["feedback_review_before_merge"],
      "isNegativeControl": false,
      "precision": 1,
      "recall": 1,
      "reciprocalRank": 1,
      "forbid": [],
      "forbidViolations": [],
      "injectBytes": 1024
    }
  ],
  "aggregate": {
    "precision": 0.75,
    "recall": 0.625,
    "mrr": 0.75,
    "positiveCount": 4,
    "negativeControls": { "total": 2, "passed": 1, "failed": 1, "rate": 0.5 },
    "forbid": { "total": 0, "violated": 0 }
  }
}
```

`semanticContributedCount` counts how many golden-set prompts had at
least one hit actually won by the semantic/confidence gate (a semantic
score that cleared the relevance floor and beat out the other candidates
for a slot), distinct from `semanticPathActive` (which only proves an
index + provider are configured, not that the signal won anything).
`keywordContributedCount` (index schema v4) counts how many prompts had
at least one hit admitted by the keyword gate (a `gate: "keyword"` hit;
the small boost given to already-semantic id matches is not counted,
it never wins a slot on its own). The text report prints both as
`semantic contributed: N/M prompts` and `keyword contributed: N/M prompts`.
`vocabularySource` states which topic vocabulary the Topic Gate used for
the run (see [docs/memory-schema.md](memory-schema.md)).

`injectBytes` (per prompt) and `injection` (over the golden set) report the
size of the context the `UserPromptSubmit` hook would inject for the hits the
run resolved: the same renderer (`renderHitsBudgeted`) under the same budget,
`MEMORY_ROUTER_INJECT_BUDGET` or 16,384 bytes. `meanBytes` averages over ALL
prompts, a prompt with no hit counting as 0; `maxBytes` is the largest. The
text report prints one line, `injected context: mean=N bytes max=M bytes`.
The figure is the rendered markdown, not the hook's JSON-wrapped stdout, which
is a little larger (JSON escaping and the wrapper). Exits 1 only on
a real setup error (`golden.yml` missing or unparsable, or the corpus dir
missing); exits 0 on any error-free run regardless of the metric values.

## Injection size: `MEMORY_ROUTER_INJECT_BUDGET`, `test` and `eval`

The `UserPromptSubmit` hook holds what it injects to a byte budget; see the
README's "What the `UserPromptSubmit` hook injects" for the per-hit forms.

| Variable | Meaning | Default |
|---|---|---|
| `MEMORY_ROUTER_INJECT_BUDGET` | Largest injection, in UTF-8 bytes of the rendered markdown. A positive integer. Unset: the default. Empty, `0`, negative, fractional or non-numeric: the default, plus one note on stderr. | `16384` |

Each hit has a ladder of forms: its starting form, then description + chunk +
path, then description + path, each lower form only when it is smaller in
bytes than the form above it. The description + chunk + path form of a
`type: feedback` memory also ends with its `**How to apply:**` paragraph (at
most 1,000 characters, the overflow replaced by a ` [...]` marker) unless the
shown chunks already contain it, see the README. When every hit fits in its
starting form, nothing
changes. Otherwise, among the outputs that fit (the hits in rank order up to
some cut, each in a form of its ladder, and a note on how many were left out),
the best one wins in this order: the top hit's form (fuller wins), then the
number of hits kept (more wins), then the form of hit 2, of hit 3 and so on
(fuller wins). So the top hit keeps its fullest form whenever it fits alone, as
many lower hits are kept as fit next to it in their shortest forms and are
dropped only from the bottom, and the kept hits get the fullest forms that
fit, best-ranked first. The top hit is always kept: when nothing fits, it is
injected alone in its shortest form, even though that exceeds the budget. No
hit is ever injected larger than its starting form. The `PreToolUse` hook
ignores the variable and keeps injecting full bodies.

`memory-router test <prompt>` prints `rendered: N bytes (budget B bytes)`
after the matches, and `--json` carries `renderedBytes` and `budgetBytes`
(`0` for no match). `test` runs the pre-blend resolver, whose hits carry no
matched-chunk information, so a long memory shows as description + first
chunk + path there. `memory-router eval` reports `injectBytes` per prompt and
the `injection` summary, see
[the eval schema](#memory-router-eval-metric-definitions-and-json-schema).

## Coverage / regression suite

`tests/coverage/real-corpus.test.ts` runs the sync router against a
labelled prompt fixture and a synthetic memory corpus. It catches
matcher-recall regressions: a scoring-weight change, a typo in a memory's
`topics:`, or an overly-broad new memory all show up as failing
assertions naming the `(prompt, memory)` pair. It is part of `npm test`.
After every prompt is evaluated it emits one TAP-comment line
summarising aggregate stats:

```
# coverage: 93.3% (28/30 prompts matched >=1) | mean_hits=3.20 | FN=0/76 (0.0%) | FP=0/74 (0.0%)
```

`FN` counts labelled `expectedMatches` that did not fire, `FP` counts
labelled `expectedNoMatches` that did fire. Extras outside both labelled
sets are tolerated; the gate is recall, not minimality.

The fixture (`tests/coverage/prompts.fixture.json`) and the corpus
(`tests/coverage/corpus/`) are synthetic, never real user prompts or
real-corpus memory bodies. To dogfood against a real corpus locally, set
`MEMORY_ROUTER_COVERAGE_CORPUS_DIR`:

```bash
MEMORY_ROUTER_COVERAGE_CORPUS_DIR=~/.claude/projects/-home-<user>-git-<project-dir>/memory npm test
```

Companion verb for one-shot prompt checks: `memory-router test "<prompt>"`.

## Programmatic use

```typescript
import { loadMemoriesFromDir, resolve } from '@lannguyensi/memory-router';

const memories = loadMemoriesFromDir('/path/to/memory');
const hits = resolve({ prompt: 'merge PR 42' }, memories);
// -> [{ memory, gate: 'topic', score: 1.0, reason: 'topic match: workflow' }]
```

The package ships JavaScript only (no `.d.ts` yet); types for the public
API are tracked as a follow-up.
