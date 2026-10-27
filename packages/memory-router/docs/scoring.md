# Score-blend resolver: measurements and embedding provider reference

Deep-dive reference for the score-blend resolver's calibration history,
the model-conditional relevance floor, and the embedding provider
options. See the README's [How it works](../README.md#how-it-works) for
the resolver's core mechanics and [Calibration](../README.md#calibration)
for the headline defaults this document backs.

## Signals in the blend

| Signal | What it is | Role in the blend |
|------|--------|---------------|
| **Semantic score** | sqlite-vec cosine similarity between the prompt and the memory's vectors: `max(document vector, best body chunk)` (see below) | The dominant signal, when an embedding index + provider are available. A score below the relevance floor (`MEMORY_ROUTER_BLEND_MIN_SEMANTIC`, model/provider-conditional default, see [Calibration](../README.md#calibration)) is dropped before it can enter the blend at all |
| **Topic boost** | Keyword dictionary mapped to memory `topics:` | A boost added on top of whatever else fires for that memory, not a standalone full-score hit |
| **Recency modifier** | Exponential decay on the memory file's mtime | A small tie-breaker: a more recently touched memory ranks slightly higher, all else equal |
| **Type modifier** | Memory `type` (`feedback` weighted highest) | A small tie-breaker |
| **Retired marker** (`status: retired`, project memories only) | The memory's own frontmatter, set by the operator | Subtracts `MEMORY_ROUTER_BLEND_RETIRED_PENALTY` (default `0.05`) from the semantic score before the relevance floor, so a retired memory needs a stronger match to appear and ranks lower when it does. See [Retired project memories](#retired-project-memories) |
| **Keyword evidence** (schema v4) | SQLite FTS5 match of IDENTIFIER tokens from the prompt (task ids like `4e7729ab`, build tags like `b11905`) against name/description/chunk text; only tokens passing the id rule are queried at all | Two roles, both bounded: it can admit a keyword-only memory at the floor edge (gate `keyword`), and it can lift an above-floor memory by a flat `+0.02`; a below-floor cosine is never lifted or blended. See [The keyword gate](#the-keyword-gate-schema-v4) |

The semantic score is one number per memory: the better of the memory's
document vector (`name` + `description` + body, cut at 8,000 characters)
and the best-matching CHUNK of its body (schema v3 index,
`memory-router index` builds both). Chunking exists because the document
vector cannot see text past that cut; a long memory is now findable by a
rule written at character 12,000 of its body. Because the chunk pass can
only ever raise a memory's score to its best match, a memory still yields
at most one hit, `maxHits` still means memories (not chunks), and the
relevance floor below applies unchanged. Indexes built before the v3
schema simply have no chunk rows and score on the document vector alone
until `memory-router index <dir>` is run once against them (see
[commands.md](commands.md#building-the-embedding-index)).

A memory with neither a semantic score (once the relevance floor is
applied) nor a topic match contributes nothing and is excluded. Blend
weights are overridable via the `MEMORY_ROUTER_BLEND_*` env namespace
(`MEMORY_ROUTER_BLEND_TOPIC_BOOST`, `MEMORY_ROUTER_BLEND_RECENCY_WEIGHT`,
`MEMORY_ROUTER_BLEND_RECENCY_HALFLIFE_DAYS`,
`MEMORY_ROUTER_BLEND_TYPE_WEIGHT`, `MEMORY_ROUTER_BLEND_MIN_SEMANTIC`,
`MEMORY_ROUTER_BLEND_CANDIDATE_K`, `MEMORY_ROUTER_BLEND_RETIRED_PENALTY`).
A negative override for any of these is invalid and falls back to the
built-in default rather than being accepted.

## Retired project memories

A `type: project` memory describes a setup or state that can be removed or
replaced (an install deleted, a service switched off). Its text keeps
matching prompts about that topic, so it kept filling ranks 3 to 5 next to
the current memories. Age is a poor signal for this (most synced files
share one restore mtime), so the operator marks such a memory explicitly:

```yaml
---
name: project_old_embedding_setup
type: project
status: retired
---
```

Only `resolveBlended` honours the marker: the UserPromptSubmit hook, the MCP
`memory_resolve` tool and `eval` apply the demotion, while `memory-router test
--semantic` and the MCP `memory_search` tool still rank a retired memory at
its full score. Verify a marking with `eval` (a `forbid:` list) or through
the hook, not with `test`.

Only `status: retired` on a `type: project` memory has an effect (compared
trimmed and case-insensitively; the field may also sit under `metadata.`,
top-level wins). The same value on a `feedback`, `user` or `reference`
memory is ignored: those types do not go stale that way, and a stray marker
must not hide a live rule. Nothing marks a memory automatically.

What a retired memory costs, step by step in `resolveBlended`:

1. The search asks for one extra candidate per retired memory in the corpus
   (at the default pool of 5 with two retired memories it asks for 7), so a
   demotion can free a slot that a next-best candidate then takes.
2. `MEMORY_ROUTER_BLEND_RETIRED_PENALTY` (default `0.05`) is subtracted from
   the retired memory's raw semantic score, before the relevance floor. A
   retired memory therefore needs `floor + penalty` (0.83 at the bge-m3 floor
   of 0.78) to remain a semantic hit, and ranks `penalty` lower when it does.
3. The floor filter runs, then the pool is sorted by the demoted scores and
   cut back to the normal width. With no retired memory in the corpus none of
   this runs: same search width, same hits, same order.

Which input wins:

- **Topic match.** The penalty comes off the semantic score and the topic
  boost is added afterwards, as for any memory. At the defaults the penalty
  (0.05) and the topic boost (0.05) are equal, so a retired memory with a
  topic match ranks where it would without the marker, unless its semantic
  match fell under `floor + penalty`: then only the topic match is left and
  it is a topic-only candidate (a small score, after every semantic hit).
  The topic gate itself is not changed by the marker.
- **Keyword admission.** A memory admitted by an exact id token (gate
  `keyword`) is not demoted: typing the id of a retired memory still finds
  it.
- **Degraded mode** (no index, no provider, search error, nothing above the
  floor) runs the topic/tool-only `resolve()` path with no scoring, so the
  marker does nothing there.
- **Env.** `MEMORY_ROUTER_BLEND_RETIRED_PENALTY` unset, empty or whitespace
  uses the default; a valid number wins, including `0` (demotion off, the
  search is not widened either); a non-numeric, negative or non-finite value
  falls back to the default. A value above the largest cosine (1) removes
  retired memories from the semantic path altogether.

### Measurement behind the default

Replay on a copy of the 589-memory production corpus (never the original),
index schema v4 rebuilt once and shared by every run, bge-m3 via llama.cpp
at the 0.78 floor, golden set of 45 prompts (32 positive, 13 negative
controls) with a `forbid:` list added to the three stale cases (see
[commands.md](commands.md#memory-router-eval-metric-definitions-and-json-schema)).
Three memories were marked `status: retired` in the copy, with their file
mtimes preserved so the index stayed valid:

| penalty | forbidden ids in the top 5 (3 stale prompts) | MRR | negative controls | precision |
|---|---|---|---|---|
| no marker (baseline) | 3 of 3 prompts violated | 0.698 | 11/13 | 0.378 |
| 0 | 3 of 3 | 0.698 | 11/13 | 0.378 |
| 0.02 | 2 of 3 | 0.698 | 11/13 | 0.406 |
| 0.03 | 1 of 3 | 0.698 | 11/13 | 0.406 |
| 0.035 to 1 | 0 of 3 | 0.698 | 11/13 | 0.406 |

The raw cosines of the retired memories on the stale prompts were 0.756 to
0.813, against the 0.78 floor (the largest, 0.813, exceeds it by 0.033), so any penalty above
about 0.033 removes them;
the golden set cannot tell apart anything between 0.035 and 1. The default
is the low end of that plateau with a margin (0.05, about 1.5 times the
smallest value that cleans every stale prompt) because the smaller the
penalty, the more a deliberate question about a retired setup still finds
it: on three explicit history questions (raw cosines 0.820 to 0.838) the floor rule leaves two of
them above 0.78 at a 0.05 penalty and none at 0.10 (arithmetic on the
measured cosines, not an eval run). The measurement is bge-m3 cosine; another model has
another band, so recalibrate with `MEMORY_ROUTER_BLEND_RETIRED_PENALTY` and a
`forbid:` golden set before relying on the default there. MRR, recall and the
negative-control result did not move at any penalty, and the mean injected
size fell from 5,485 to 5,316 bytes.

Marking a file by editing it bumps its mtime, and the recency modifier
(up to 0.05 for a fresh file) is added after the floor, so it can offset the
penalty in the ranking among memories that survive the floor, but it cannot
bring back one the floor dropped. Replaying with the three marked files
touched (index refreshed for them) gave the same result at penalties 0.05,
0.1 and 0.15: 0 of 3 stale prompts violating, MRR 0.698, negative controls
11/13.

## The keyword gate (schema v4)

Embeddings blur exact identifiers: a task id like `4e7729ab` or a build
tag like `b11905` is one rare token among thousands and often scores below
the relevance floor. The keyword gate adds an exact-token path over the
FTS5 index (`chunks_fts`, built by `memory-router index`; see
[commands.md](commands.md#building-the-embedding-index)) without touching
the calibrated blend: a keyword hit never lifts or blends a below-floor
cosine, and the strongest thing it does to an above-floor memory is a flat
`+0.02`.

Plain words are deliberately excluded from the keyword path: rare German
and English words and product names (`strata`, `rein`, `bringen`,
`JavaScript`, `WLAN`, `IPv6`) are exactly as rare in a corpus as real
ids, and cosine cannot separate them on bge-m3 (unrelated memories score
0.69 to 0.78), so admitting anything but ids trades one recall win for
many precision losses.

How a prompt token qualifies:

- The prompt is split on whitespace and the ORIGINAL token (edge punctuation
  trimmed) is checked against the **id rule**: a single run of ASCII letters
  and digits only, at least `KEYWORD_MIN_ID_LENGTH` (6) characters long, with
  at least one letter and at least one digit. `4e7729ab`, `b11905`, `a1b2c3`,
  `base64` pass.
- A token whose id hides inside a larger word is ALSO split at the **id
  separators** `:` `/` `.` `#` `?` `=` `'` `-` and the typographic apostrophe
  U+2019 (the smart-quote form of `'`, so `4e7729ab’s` splits too; the
  underscore is NOT a separator, so `snake_a1b2c3` stays whole) and every
  part that passes the same id rule becomes a queryable id on its own. This
  is what lets `task:4e7729ab`, `4e7729ab's`, a URL `https://x/t/4e7729ab`
  and a path `src/a1b2c3.ts` reach the keyword path; a whole token that is
  already an id yields one term, never a duplicate, and an id part is never
  deduped away by a non-id whole token whose phrase happens to equal it
  (`the:a1b2c3` still yields the id `a1b2c3`).
- Anything that fails the id rule, whole or in part, is inert: `IPv6`,
  `arm64`, `S12` (too short), `UTF-8`, `v0.7.4`, `studio-tb`, `foo:bar`,
  `snake_a1b2c3` (no id part), `JavaScript`, `MTPLX`, `abcdef` (no digit) and
  `123456` (no letter) do not qualify, and `finish_reason` stays one non-id
  token (underscore is not a separator).
- A non-id token is never FTS-queried, never counted, and can never admit
  or boost; per prompt the keyword pass costs exactly two FTS reads per
  id token.
- An id token only counts when it is **rare**: it appears in at most 12
  distinct memories (`KEYWORD_MAX_DF`). An id copy-pasted through 13+
  memories carries no locating signal and is skipped.

Admission (`src/embed/keyword.ts`), for memories with **no** above-floor
semantic hit:

- An id-token match is admitted on its own: nobody pastes a task id into
  a prompt by accident. This is the only admission route there is.
- At most **2** keyword-only admissions per prompt, best bm25 first.

Scoring: an admitted memory enters at the floor edge
(`minSemanticScore + 0.01`) plus the usual topic, type and recency
modifiers, with gate `keyword` and reason `keyword match (id: X)`; the
below-floor cosine that kept it out of the blend is never lifted or
blended. A memory that already has an above-floor semantic hit and also
matches an id token keeps gate `confidence` and gains `keywordBoost`
(`MEMORY_ROUTER_KEYWORD_BOOST`, default `0.02`) plus the keyword reason.
In the degraded case (no semantic hits at all) admitted keyword memories
take the first slots ahead of the topic-only output, which is otherwise
unchanged.

Env knobs (separate from the `MEMORY_ROUTER_BLEND_*` namespace; invalid
values fall back to defaults): `MEMORY_ROUTER_KEYWORD=off` disables the
whole path (the hook behaves byte-identically to the pre-keyword
resolver) and `MEMORY_ROUTER_KEYWORD_BOOST` adjusts the boost above. The
keyword pass never turns a working search into a failed one: any FTS
error degrades to "no keyword matches" and writes one stderr line per
process (`docs/okf/semantic-search-silent-noop.md`).

## Degradation and the Tool Gate

Without an embedding index or a resolvable embedding provider, on a
semantic-search failure, or when every semantic-search hit for a prompt
falls below the relevance floor, the blend degrades to exactly the same
output the old topic-only resolver (`resolve()`) would produce: the same
memories, in the same order, at the same flat `1.0` score. Since schema
v4 there is one exception on top of that output: keyword admissions for
the prompt (see [The keyword gate](#the-keyword-gate-schema-v4)) take the
first slots, and the topic-only output follows, deduplicated and still
capped at `--max-hits`. With no admissions (or `MEMORY_ROUTER_KEYWORD=off`)
the degraded output is byte-identical to the pre-keyword behavior.

Separately, the **Tool Gate** (`PreToolUse` hook, against memory
`triggers.command_pattern` and `triggers.tools`) stays a deterministic,
unblended full-score (1.0) match; before `Bash(git push --force)`, `Bash(docker
compose up)`, etc. It is not part of the semantic blend (there is no
prompt to embed at that point in the tool-call lifecycle), but
`memory_resolve` still consults it when a `tool` argument is passed.

## Why a blend, not gates

Earlier versions ran the sync gates (topic, tool) first and only fell
through to an async semantic "Confidence Gate" when they stayed silent.
In practice the Topic Gate's flat 1.0 score pre-empted the semantic path
almost every real prompt; three different prompts sharing a topic keyword
produced an identical top-5 regardless of what each prompt actually
meant, and a golden-set baseline measured before this change confirmed
the semantic path essentially never ran. The blend replaces that
shadowing: the semantic score always contributes when it can, and the
deterministic Topic Gate becomes a boost rather than an override.

## Calibration measurements

The default `topicBoost` (0.05) and `candidateK` (5) come from a
2026-08-14 calibration run on the reference corpus (289 memories,
German/English mixed, golden set of 16 positive prompts + 4 negative
controls, expanded 2026-08-14 from the 6-prompt seed; Ollama embeddings,
relevance floor swept per model). Aggregate precision/recall/MRR over the
positive prompts, negative controls (NK) reported separately. All figures
below use this expanded golden set; older documents quote the 4-positive-
prompt seed baseline (P=0.100 R=0.167 MRR=0.375), which is not comparable.

| Configuration | P | R | MRR | NK |
|---|---|---|---|---|
| Topic-only baseline (default 5-topic vocabulary) | 0.083 | 0.156 | 0.193 | 4/4 |
| Blend, `nomic-embed-text`, best NK-clean floor (0.85) | 0.075 | 0.146 | 0.263 | 4/4 |
| Blend, `bge-m3`, floor 0.77, pre-calibration (K=10, boost 0.15) | 0.238 | 0.453 | 0.648 | 4/4 |
| Blend, `bge-m3`, floor 0.77, calibrated (K=5, boost 0.05) | 0.288 | 0.547 | 0.710 | 4/4 |
| Blend, `bge-m3`, floor 0.78, calibrated (K=5, boost 0.05) | 0.250 | 0.484 | 0.710 | 4/4 |

The calibration deltas quoted in the CHANGELOG (P 0.238 -> 0.288, R 0.453
-> 0.547, MRR 0.648 -> 0.710) compare the two floor-0.77 rows. The
recommended operating floor for this corpus is nevertheless **0.78**: 0.77
maximizes the positives but sits one hundredth above a failing negative
control (0.76 -> NK 3/4), so 0.78 trades a little P/R for NK margin at
identical MRR.

These results held on this corpus; they are not validated elsewhere
(single run, one corpus, one embedding model per row, 16 positive
prompts; a P move of 0.05 is roughly one prompt's worth). On this corpus:
a small `topicBoost` let the semantic signal dominate the ranking; a
small `candidateK` kept weak semantic candidates from flooding the final
cap. Note the flip side: at the default cap the pool now equals the cap,
so a memory outside the raw semantic top-`maxHits` can no longer be
lifted into the result by a topic boost unless
`MEMORY_ROUTER_BLEND_CANDIDATE_K` is raised; `recencyWeight`/`typeWeight`
showed no golden-set effect beyond single-tie noise (re-confirmed at the
calibrated boost) and keep their shaped values. What is explicitly
corpus-coupled: the relevance floor. Cosine ranges differ per provider and
model (`bge-m3` separates relevance from junk around 0.77-0.79 on this
corpus; `nomic-embed-text` cannot separate German junk prompts from the
corpus at any floor without collapsing the positives; OpenAI embeddings
score far lower overall). On a multilingual corpus prefer a multilingual
embedding model (`MEMORY_ROUTER_OLLAMA_EMBED_MODEL=bge-m3`); switching
models requires an index rebuild (`rm -rf <dir>/.memory-router &&
memory-router index <dir>`).

## Model-conditional relevance floor default

Because the floor is corpus/provider/model-coupled and the flat legacy
default (0.5) left every Ollama path effectively unfiltered, a follow-up
eval on the (grown, 295-memory) reference corpus measured, at the flat
0.5 default: precision 0.300, recall 0.578, MRR 0.7313,
`semanticContributedCount` 20/20 (every positive prompt's winning hit
came from the semantic signal), and **0/4 negative controls blocked**
(junk prompts were injecting memories). `MEMORY_ROUTER_BLEND_MIN_SEMANTIC`'s
un-overridden default is now resolved per provider/model instead of being
one flat number:

| Provider | Model | Un-overridden default |
|---|---|---|
| Ollama | `bge-m3` (any tag: `bge-m3`, `bge-m3:latest`, `bge-m3:567m`, ...) | `0.78` (calibrated, table above) |
| Ollama | any other model (including the Ollama default, `nomic-embed-text`) | `0.78` (provider-level fallback, deliberately conservative, **not** a per-model calibration; `nomic-embed-text` specifically was measured to NOT cleanly separate relevance from German junk prompts at any floor, cosine scores cluster 0.80-0.85 regardless of relevance) |
| OpenAI | any | `0.5` (unchanged from the original flat default) |

Model names are normalized before the lookup (trimmed, lowercased, `:tag`
suffix stripped), so an explicit Ollama tag or quantization variant
(`bge-m3:567m`) still matches the `bge-m3` row rather than silently
falling through to the generic fallback. An explicit
`MEMORY_ROUTER_BLEND_MIN_SEMANTIC` **always wins** over this table, on
every provider/model path, set it to `0.5` to reproduce the pre-upgrade
flat-default behavior exactly, on every provider (not just OpenAI), or to
any other value for further per-corpus tuning.

A model on the generic Ollama fallback row (any Ollama model besides
`bge-m3`) can have a cosine band systematically lower than `bge-m3`'s,
and the 0.78 fallback was only ever calibrated against `bge-m3`'s own
band; if that model's real scores cluster below it, the semantic path
silently contributes nothing on every run. To make that visible,
`resolveBlended` prints one stderr line, once per process, the first time
a run's semantic candidates all fell below an un-calibrated **Ollama**
fallback floor: never for the calibrated `bge-m3` row above, never once
an explicit `MEMORY_ROUTER_BLEND_MIN_SEMANTIC` override is set, and never
for OpenAI's `0.5` default, since that value is OpenAI's own deliberate,
documented default. Calibrate a floor for the affected Ollama model (see
the reproduction recipe below) or set `MEMORY_ROUTER_BLEND_MIN_SEMANTIC`
explicitly to move past the generic default.

Because the guard is once-per-process, not once-per-corpus: the
`UserPromptSubmit` hook is a fresh, short-lived process per prompt, so an
affected corpus sees this line on every single prompt until the model is
calibrated or the floor is overridden. The MCP server and the eval runner
are longer-lived processes, so each emits the line at most once for its
whole process lifetime.

**Upgrade impact.** Re-running the same eval with no override, after this
change (same 295-memory corpus, no other settings changed): precision
0.250, recall 0.484, MRR 0.7104, `semanticContributedCount` 14/20, and
**4/4 negative controls blocked**. Read against the flat 0.5 baseline
above, this is the upgrade's actual cost, not a free win: the floor now
also screens out some genuine borderline matches along with the junk it
was added to catch, trading roughly a fifth of precision and recall for
going from zero to full negative-control coverage, at essentially
unchanged MRR (0.7313 -> 0.7104). This is an independent measurement from
the calibration table above (295 memories and a
differently-sized golden set here vs. 289 memories/16 positive prompts
there); its post-upgrade P/R/MRR land close to that table's floor-0.78
row by coincidence of the underlying cosine distribution on this corpus,
not because it is the same run.

Reproduction (requires the reference corpus, which lives in the
operator's memory dir, not this repo, see
[docs/commands.md](commands.md#memory-router-eval-metric-definitions-and-json-schema)):

```bash
memory-router index <dir>
MEMORY_ROUTER_OLLAMA_EMBED_MODEL=bge-m3 memory-router eval <dir>/golden.yml --dir <dir> --json
```

No `MEMORY_ROUTER_BLEND_MIN_SEMANTIC` is needed to hit the calibrated
floor on an Ollama `bge-m3` corpus; add it explicitly to try a different
floor.

## Embedding provider

Once an embedding index exists and a provider resolves, the score-blend
resolver queries it on every prompt sent through the `UserPromptSubmit`
hook (not only when the deterministic gates stay silent): this is an
ongoing per-prompt cost (OpenAI API calls) or local load (Ollama), and
the prompt text itself leaves the machine to whichever endpoint is
configured. Delete the index (`rm -rf <dir>/.memory-router`) to fall back
to the topic-only sync path.

The embedder is configurable, so the semantic path works on a machine
with no OpenAI key:

| Selection | How | Model default | Auth |
| --- | --- | --- | --- |
| Explicit OpenAI | `MEMORY_ROUTER_EMBED_PROVIDER=openai` | `text-embedding-3-small` | `OPENAI_API_KEY` |
| Explicit Ollama | `MEMORY_ROUTER_EMBED_PROVIDER=ollama` | `nomic-embed-text` | none |
| Auto-detect | unset | `OPENAI_API_KEY` present -> OpenAI; otherwise -> Ollama | as above |

`MEMORY_ROUTER_EMBED_PROVIDER` is case-insensitive and tolerates
surrounding whitespace; an unrecognized value is treated as unset (falls
through to auto-detect). An explicit `openai` selection with no
`OPENAI_API_KEY` fails open, it never silently substitutes Ollama.

Privacy note: under auto-detect with no `OPENAI_API_KEY`, prompt text and
memory bodies are sent as-is to whichever endpoint
`MEMORY_ROUTER_OLLAMA_BASE_URL` resolves to (default
`http://localhost:11434`), with no check that the endpoint is actually
who it claims to be.

Overrides:

- `MEMORY_ROUTER_EMBED_MODEL`: model name override. Applies to OpenAI
  always, and to Ollama when the provider was chosen *explicitly*
  (`MEMORY_ROUTER_EMBED_PROVIDER=ollama`). Deliberately NOT consulted on
  the *auto-detected* Ollama path: a value left over in the environment
  was almost certainly set for OpenAI.
- `MEMORY_ROUTER_OLLAMA_EMBED_MODEL`: model name override for the
  auto-detected Ollama path specifically; not consulted anywhere else.
- `OPENAI_BASE_URL`: OpenAI-compatible proxy base URL (OpenAI path only).
- `MEMORY_ROUTER_OLLAMA_BASE_URL`: Ollama base URL, default
  `http://localhost:11434`, queried through its OpenAI-compatible
  `/v1/embeddings` endpoint, unauthenticated.
- `MEMORY_ROUTER_EMBED_TIMEOUT_MS`: per-request timeout override,
  applies to both the hook's confidence-gate path (default `5000`) and
  `memory-router index`'s rebuild path (default `60000`), and `memory-router
  lint --semantic`'s missing-pair embed call (also `60000`); an unset,
  empty, non-numeric, zero, negative, fractional, or larger-than-`2147483647`
  value falls back to that path's own default (the upper bound is Node's
  32-bit timer limit).
- `MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS`: timeout override for every
  `semanticSearch` query-embedding call (the hook, the MCP `memory_search`
  tool, the eval runner, and the public `semanticSearch` export),
  precedence over `MEMORY_ROUTER_EMBED_TIMEOUT_MS`. `memory-router
  index`'s rebuild path never reads this knob.

Model-variable precedence:

| Path | Model resolution |
| --- | --- |
| Explicit OpenAI, or auto-detected OpenAI (`OPENAI_API_KEY` present) | `MEMORY_ROUTER_EMBED_MODEL`, else `text-embedding-3-small` |
| Explicit Ollama (`MEMORY_ROUTER_EMBED_PROVIDER=ollama`) | `MEMORY_ROUTER_EMBED_MODEL`, else `nomic-embed-text` |
| Auto-detected Ollama (no `OPENAI_API_KEY`, no explicit provider) | `MEMORY_ROUTER_OLLAMA_EMBED_MODEL`, else `nomic-embed-text` (`MEMORY_ROUTER_EMBED_MODEL` not consulted) |

Embedding dimensionality is never hardcoded: it's read off the first real
embed response and recorded in the index alongside the provider and
model. An index opened under a different provider refuses at open time to
silently compare incompatible vector spaces. A same-provider
dimensionality change isn't checked at open time; it's caught the moment
it's actually written or queried. Either way `memory-router index`/the
Confidence Gate raise an error naming the exact rebuild command (`rm -rf
'<dir>/.memory-router' && memory-router index '<dir>'`).

Local Ollama setup: `ollama pull nomic-embed-text`, then run `ollama
serve` (or use the app) before `memory-router index`/normal hook usage.

**Timeout budgets.** Every `semanticSearch` query-embedding call (the
hook's confidence-gate path, the MCP `memory_search` tool, the eval
runner) defaults to a tight 5s (it must never block a prompt for long)
while `memory-router index`'s rebuild defaults to a much more generous
60s per batch, because a real 64-input Ollama batch on the calibration
reference corpus measured roughly 3.5-10s warm and 11-17s for the first
batch after a cold model load, which used to blow past the old shared 5s
budget. `MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS` decouples the two: it
resolves with precedence `MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS` (wins if
set and valid) > `MEMORY_ROUTER_EMBED_TIMEOUT_MS` (still applies when the
hook knob is unset or invalid) > `5000` (the hook default). A persistent
`MEMORY_ROUTER_EMBED_TIMEOUT_MS=120000` export for `index` headroom,
combined with `MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS=5000` to pin every
`semanticSearch` caller back to its tight default, is the safe way to
widen `index`'s budget in a shell profile without also widening theirs.

## Query-embedding cache

Repeated vague prompts re-pay one OpenAI embedding call (roughly
150-300ms + $0.00002) every time the Confidence Gate fires. The router
memoizes prompt to embedding in the same `index.sqlite` file under a
`query_cache` table:

- **Key:** the full sha256 hex digest of the prompt (not truncated, so
  a shared prefix cannot map two prompts to one entry).
- **Eviction:** LRU by `accessed_at`, hard cap of 1000 entries. Switching
  `MEMORY_ROUTER_EMBED_MODEL` lazily evicts entries stored under the
  previous model on the next put.
- **Persistence:** survives hook process restarts (the file is the only
  state).
- **Observability:** set `MEMORY_ROUTER_DEBUG=1` to see stderr lines
  starting with `[memory-router] query cache hit` or
  `[memory-router] query cache miss`, each ending in `(size=N)`.

No flag turns the cache off, it's always on when the Confidence Gate is.
`memory-router index` does not touch the cache; only switching embed
models does.
