# Score-blend resolver: measurements and embedding provider reference

Deep-dive reference for the score-blend resolver's calibration history,
the model-conditional relevance floor, and the embedding provider
options. See the README's [How it works](../README.md#how-it-works) for
the resolver's core mechanics and [Calibration](../README.md#calibration-mm-v1-t008)
for the headline defaults this document backs.

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

## Calibration measurements (mm-v1-T008)

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
the mm-v1-T008 calibration table above (295 memories and a
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
  `semanticSearch` query-embedding call (the hook, the MCP `memory-search`
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
hook's confidence-gate path, the MCP `memory-search` tool, the eval
runner) defaults to a tight 5s (it must never block a prompt for long)
while `memory-router index`'s rebuild defaults to a much more generous
60s per batch, because a real 64-input Ollama batch on the mm-v1-T008
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

- **Key:** sha256(prompt) prefix (8 bytes, plenty for the LRU cap).
- **Eviction:** LRU by `accessed_at`, hard cap of 1000 entries. Switching
  `MEMORY_ROUTER_EMBED_MODEL` lazily evicts entries stored under the
  previous model on the next put.
- **Persistence:** survives hook process restarts (the file is the only
  state).
- **Observability:** set `MEMORY_ROUTER_DEBUG=1` to see `[memory-router]
  query cache hit (size=N)` / `[memory-router] query cache miss;
  embedding (size=N)` lines on stderr.

No flag turns the cache off, it's always on when the Confidence Gate is.
`memory-router index` does not touch the cache; only switching embed
models does.
