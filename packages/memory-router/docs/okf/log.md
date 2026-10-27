# Bundle log

- 2026-10-27T20:45:30Z, release 0.9.0: `package.json` and `PACKAGE_VERSION` in `src/hooks/user-prompt-submit.ts` move from 0.8.0 to 0.9.0 on the same lines. `gate-composition-and-dedup.md`, `native-deps-and-ci-smoke.md` and `score-blend-resolver.md` cite neither the version nor the changed line; claims and citations unchanged. Re-stamped.

- 2026-10-27T20:11:46Z, `docs/scoring.md` review fixes: the retired examples use generic ids, and a sentence names the entry points that apply the demotion (`resolveBlended`: hook, MCP `memory_resolve`, `eval`) and those that do not (`test --semantic`, MCP `memory_search`); `score-blend-resolver.md` carries the same sentence. `score-blend-resolver.md` and `semantic-search-silent-noop.md` re-verified against `scoring.md` and re-stamped.
- 2026-10-27T20:05:11Z, `src/router.ts`, `src/gates/confidence.ts`, `src/memory/loader.ts`, `src/types.d.ts`, `src/eval/{golden,runner,format}.ts`: optional `status: retired` on project memories (a `retiredPenalty` weight, one `isRetiredProject` guard, a widened search and a demotion before the relevance floor in `resolveBlended`) and an optional `forbid` list per eval golden prompt. Lines moved in `router.ts`, `confidence.ts` and `eval/runner.ts`; every citation in `gate-composition-and-dedup.md`, `score-blend-resolver.md` and `semantic-search-silent-noop.md` was re-pointed and its cited text compared against the base tree. `semantic-search-silent-noop.md` cites the `semanticSearch` call inside `resolveBlended()`, re-pointed from `router.ts:228` to `router.ts:242`. `score-blend-resolver.md` gained a "Retired project memories" section and `loader.ts` as a source; its floor-filter citation now spans the demotion that precedes the filter. Claims re-verified: the three degraded-mode branches, the catch behaviour and the `minSemanticScoreSource` table are unchanged in meaning.
- 2026-10-27T19:42:24Z, `src/embed/indexer.ts`, `src/embed/index-store.ts`: the index stamps `CHUNKER_VERSION` (meta key `chunker_version`, schema stays v4) and `rebuildIndex` re-chunks every memory once when the stamp is missing or differs. `semantic-search-silent-noop.md` and `native-deps-and-ci-smoke.md`: citations into both files re-pointed after the inserted lines (primary and continuation citations, each checked against the cited code), no claim changed; both re-stamped.
- 2026-10-27T14:19:20Z, `src/embed/keyword.ts`: a whitespace token is also split at the id separators (`: / . # ? = '`, `-`, U+2019; not `_`) and every part that passes the unchanged `isIdToken` becomes its own keyword term; whole tokens and queried id phrases dedupe separately, so a stopword prefix cannot swallow an id part. `score-blend-resolver.md` (separator claim) and `semantic-search-silent-noop.md` (two FTS reads per id term, now per id part) re-verified claim by claim against the current tree, including every line citation; the `replaceChunks` range in `semantic-search-silent-noop.md` was tightened to end at the function's closing line. Re-stamped both.
- 2026-10-27T13:44:19Z, `src/render.ts`: a long `type: feedback` hit's excerpt appends its
  `**How to apply:**` paragraph (capped) when the picked chunks miss it;
  containment is compared on LF text without trailing whitespace. Lines
  moved: `renderHitsAsContext` 122 -> 134, `renderHitsBudgeted` 327 -> 399,
  the `chunkBody(raw)` call 225 -> 288, the offset guard 231 -> 294;
  citations in `gate-composition-and-dedup.md` and `score-blend-resolver.md`
  re-pointed and the renderer claim in `gate-composition-and-dedup.md`
  extended. `README.md` gained one bullet in the hook section; the README
  sections `native-deps-and-ci-smoke.md` and `score-blend-resolver.md` link
  to are unchanged. Re-verified and re-stamped all three.
- 2026-10-27T11:06:16Z, release cut 0.8.0 bumped `package.json` and the `PACKAGE_VERSION`
  constant in the `UserPromptSubmit` hook source (one-line change, no line
  shift). Re-verified `gate-composition-and-dedup.md` and
  `score-blend-resolver.md` (hook lines 40, 54 and 64 unchanged) and
  `native-deps-and-ci-smoke.md` (`better-sqlite3` and `sqlite-vec` still
  declared dependencies); claims unchanged; re-stamped.
- 2026-10-27T10:46:38Z, `src/render.ts`: one comment line above `renderHitsBudgeted`
  reworded (drops are relative to the top hit's form); no line moved, no
  claim affected. Re-verified and re-stamped `gate-composition-and-dedup.md`
  and `score-blend-resolver.md`.
- 2026-10-27T10:26:36Z, injection budget rule: `renderHitsBudgeted` builds
  each hit's ladder strictly decreasing in bytes (a shorter form only when its
  block is smaller than the last rung kept, so a ladder can be just the whole
  body) and picks, among the outputs that fit, the best one by the top hit's
  rung, then the number of hits kept, then the rungs of hits 2 to n; lower
  hits that fit next to a shortened top hit are no longer dropped. No claim in
  the concept docs describes that rule. The `renderHitsBudgeted` citations in
  `gate-composition-and-dedup.md` and `score-blend-resolver.md` were
  re-pointed from `render.ts:326` to `render.ts:327`, and the `resolveBlended`
  range in `score-blend-resolver.md` from `router.ts:198-455` to
  `router.ts:198-462`, the line where the function closes; the other
  `render.ts` citations (`render.ts:122`, `render.ts:225`, `render.ts:231`)
  were checked to hold the same text as before.
- 2026-10-27T10:02:19Z, injection budget raise pass: `renderHitsBudgeted` now
  gives each hit a ladder of forms (a hit that starts whole skips the excerpt
  form when it is not smaller than the whole body) and the final raise lifts
  each kept hit, best first, to the fullest rung that still fits, passing over
  a hit that cannot be lifted instead of ending the pass. No claim in the
  concept docs describes that rule; `router.ts` and `render.ts` citations were
  re-pointed by the diff's line mapping (`ChunkRef` and `keywordChunkRef`
  moved next to `blendCandidateHit`, `render.ts` gained the ladder helpers)
  and each cited start and end line was checked to hold the same text as
  before.
- 2026-10-27T09:44:54Z, injection budget review fixes: `renderHitsBudgeted`
  now shortens hits 2 to n before dropping and shortens the top hit last,
  then raises kept hits again top-down; `GateHit` gains `chunkOffset`
  (semantic winner offset, or the FTS row's `char_offset` now returned by
  `ftsMatch`) and `excerptFor` falls back to the first chunk when the stored
  offset differs from the current body's chunk offset. `score-blend-resolver.md`
  claim "chunk `i` at render time is the text that was embedded as chunk `i`"
  now says it holds while the index is current, with the offset check as the
  guard; its router.ts and render.ts citations for the chunk path were
  re-read and re-pointed. Every `router.ts`, `indexer.ts`, `index-store.ts`
  and `render.ts` citation in the four concept docs was shifted by the
  diff's line mapping and spot-checked against the new lines (claims
  unchanged).
- 2026-10-27T09:06:50Z, UserPromptSubmit injection budget: `renderHitsBudgeted`
  (new, `src/render.ts`) injects description + matching chunk + path under a
  byte budget; `GateHit` gains `chunkIndex`, threaded by `resolveBlended`
  from the semantic winner chunk and the keyword hit's best-bm25 row;
  `PreToolUse` keeps `renderHitsAsContext`. `score-blend-resolver.md` gets a
  section on the chunk index and `gate-composition-and-dedup.md` a paragraph
  on the two renderers (both gain `src/render.ts` as a source). Every
  `router.ts`, `cli.ts`, `indexer.ts`, `eval/runner.ts` citation in
  `gate-composition-and-dedup.md`, `score-blend-resolver.md` and
  `semantic-search-silent-noop.md` re-pointed for the line shift and
  re-read against the new lines (claims unchanged);
  `native-deps-and-ci-smoke.md` only re-verified (its README anchor and
  claims are unaffected by the README addition under "Usage").
- 2026-10-27T08:33:57Z, `src/eval/runner.ts`: whitespace-only re-indent of the
  `keywordContributedCount` doc comment; no line moved, no claim affected.
  Re-verified and re-stamped `gate-composition-and-dedup.md` and
  `score-blend-resolver.md`.
- 2026-10-27T08:26:46Z, review fixes on the keyword path (no design
  change): `ftsField` in `indexer.ts` normalizes a non-string frontmatter
  `name` (e.g. `name: 2026`) and a missing `description` before `replaceFts`
  so a rebuild no longer throws on ordinary memories; `resolveBlended` now
  boosts an id match only on an above-floor semantic hit (`else if
  hasSemanticHit`), never on a beyond-the-cap topic-only candidate; the
  `df > KEYWORD_MAX_DF` bound and the FTS orphan purge on rebuild gained
  regression tests; and the store's `ftsDocCount`/`ftsMatch` FTS reads now
  emit one stderr line per process (`warnFtsFailed`) instead of swallowing
  silently. Docs `docs/scoring.md`, `docs/commands.md`, `README.md` and
  `CHANGELOG.md` reworded to one statement: an admitted memory enters at
  the floor edge plus the usual topic, type and recency modifiers, and a
  below-floor cosine is never lifted or blended. `semantic-search-silent-noop.md`
  keyword paragraph updated for the store-level warning and its
  `indexer.ts`/`index-store.ts`/`router.ts` citations re-pointed for the
  added lines; `gate-composition-and-dedup.md`, `native-deps-and-ci-smoke.md`
  and `score-blend-resolver.md` citations re-pointed for the router and
  index-store line shift (claims unchanged).
- 2026-10-27T07:15:20Z, keyword gate narrowed to identifier tokens only:
  the shape rule and the plain-word admission routes (cosine
  corroboration, the 2-term route, `MEMORY_ROUTER_KEYWORD_CORROBORATION`)
  are gone; `isIdToken` in `keyword.ts` (ASCII alnum run, 6+ chars, one
  letter and one digit) is the only way a prompt token reaches the FTS
  query, and the store's `cosinesForIds` batch was removed with them.
  Rewrote `score-blend-resolver.md` (admissions/boost section now states
  the id rule, corroboration removed; router citations re-pointed) and
  `semantic-search-silent-noop.md` (keyword paragraph: id-only query
  sentence, wrapper passes `keywordEnabled: false`; `router.ts`,
  `indexer.ts` and `index-store.ts` citations re-pointed for the removed
  lines); re-verified `gate-composition-and-dedup.md` and
  `native-deps-and-ci-smoke.md` (claims unchanged, their `router.ts` and
  `index-store.ts` citations re-pointed for the line shift).
- 2026-10-27T06:27:22Z, FTS5 keyword path (index schema v4):
  `semanticSearch` is now a wrapper over the shared `runBlendedSearch`
  engine, `blendedSearch` adds the keyword pass, `resolveBlended` admits
  at most 2 keyword-only memories (gate `keyword`, floor-edge score) and
  boosts above-floor strong matches, and the degraded branch puts keyword
  admissions first. Rewrote and re-pointed `semantic-search-silent-noop.md`
  (new keyword silent-no-op paragraph, `indexer.ts`/`index-store.ts`/
  `router.ts` citations), `score-blend-resolver.md` (new admissions/boost
  section, degraded-branch and router citations),
  `gate-composition-and-dedup.md` and `native-deps-and-ci-smoke.md`
  (router/index-store citations re-pointed, FTS5-is-bundled note added);
  claims updated where behavior changed, anchors re-verified against the
  checked-out source.
- 2026-10-26T22:27:05Z, `remove()` lost its dead `chunks`-table probe (every writable open
  runs the migrations) and the table probe is prepared on first use; every
  `index-store.ts` line from `remove()` on moved down by three. Re-pointed
  those citations in `semantic-search-silent-noop.md` (claims unchanged)
  and re-verified `native-deps-and-ci-smoke.md` (its cited lines sit above
  the change); re-stamped both.
- 2026-10-26T22:20:09Z, review fixes on the chunked embeddings (final heading section kept,
  stale chunks dropped with a re-embedded document, k cut, remove() chunk
  cleanup) shifted lines in `indexer.ts` and `index-store.ts`.
  Re-pointed the citations in `semantic-search-silent-noop.md` (claims
  unchanged) and re-verified `native-deps-and-ci-smoke.md` (the
  `require` pair and the `new Database(...)` / `sqliteVec.load(db)` lines
  still sit on the cited lines); re-stamped both.
- 2026-10-26T21:32:26Z, chunked embeddings (index schema v3): `semanticSearch` now also
  runs a chunk KNN and scores a memory as max(document, best chunk);
  `remove()` drops chunk rows; readonly opens create no chunk tables.
  Re-verified and updated `semantic-search-silent-noop.md`; re-pointed the
  drifted `cli.ts` and `index-store.ts` citations in
  `gate-composition-and-dedup.md` and `native-deps-and-ci-smoke.md`
  (claims unchanged); re-verified `score-blend-resolver.md` against the
  changed `docs/scoring.md` (no content change). The earlier source
  changes these docs were stale against (hook version bump, `package.json`
  release cut, `mcp/server.ts` help text) were re-checked in the same pass;
  re-stamped all four.
- 2026-10-25T08:12:28Z, release cut 0.7.4 bumped `package.json` and the `PACKAGE_VERSION`
  constant in the `UserPromptSubmit` hook source (one-line change, no line
  shift). Re-verified `gate-composition-and-dedup.md` (`ctx` built without
  `tool`, still on line 40 of the hook), `score-blend-resolver.md`
  (`resolveBlended` call, still on line 54 of the hook) and
  `native-deps-and-ci-smoke.md` (`better-sqlite3` and `sqlite-vec` are
  declared dependencies in `package.json`); claims unchanged; re-stamped.

- 2026-10-13T19:31:28Z, re-pointed the `cli.ts` citations that the earlier re-point had
  left nine lines short: `gate-composition-and-dedup.md` (`:765-778`,
  `:765`, `:770`) and `semantic-search-silent-noop.md` (`:769-778`,
  `:776`, `:582-583`, `:1145-1148`), each now starting on a content
  line. Claims unchanged. `score-blend-resolver.md` re-verified (the
  `server.ts` line it cites did not move) and re-stamped with the other two.

- 2026-10-13T16:28:37Z, `cli.ts` gained six lines in the `index` and `test` help text and the
  `memory_search` MCP tool description and the README's documentation list
  changed. Re-pointed the `cli.ts` citations in
  `gate-composition-and-dedup.md` (`test --semantic` at `:762-775`, `:762`,
  `:767`) and `semantic-search-silent-noop.md` (`:766-775`, `:773`,
  `:579-580`, `:1142-1145`); claims unchanged, the help and tool
  descriptions now match the provider/Ollama behaviour the doc already
  states. Re-verified `score-blend-resolver.md` and
  `native-deps-and-ci-smoke.md` (no cited line moved); re-stamped all four.
  `okf-kit check --json --require-anchors packages/memory-router/docs/okf`:
  0 errors, 100 warnings, all anchor-required (the same count as before this
  change).

- 2026-10-11T12:43:59Z, docs pass over the package README and `docs/scoring.md`: the
  README's `memory_search` row, Non-Goals, Trust Model wording and a new
  source layout under Development; `scoring.md`'s `memory_search` spelling
  and query-cache key and debug-line text. Re-verified
  `native-deps-and-ci-smoke.md` (the README Development section still
  summarizes the CI steps; `ci.yml` changed only by the agent-memory-sync
  Format step, and the matrix `ci.yml:24-27`, smoke step `:47-53`, probe
  command `:52`, requires `index-store.ts:81-82` and open-and-load
  `index-store.ts:481-483` anchors hold), `score-blend-resolver.md` and
  `semantic-search-silent-noop.md` (their README and `scoring.md` links
  point at sections this pass did not change); claims unchanged;
  re-stamped. `okf-kit check --json packages/memory-router/docs/okf`
  before: 0 errors, 1 warning (sources-fresh on
  `native-deps-and-ci-smoke.md`).

- 2026-10-04T12:55:59Z, release cut 0.7.3 bumped `package.json` and the `PACKAGE_VERSION`
  constant in `src/hooks/user-prompt-submit.ts` (one-line change, no line
  shift). Re-verified `gate-composition-and-dedup.md` (`ctx` built without
  `tool` at `user-prompt-submit.ts:40`), `score-blend-resolver.md`
  (`resolveBlended` call at `user-prompt-submit.ts:54`) and
  `native-deps-and-ci-smoke.md` (`better-sqlite3` and `sqlite-vec` are
  declared dependencies in `package.json`); claims unchanged; re-stamped.

- 2026-10-03T13:13:22Z, merged master into the staleness-template branch: master's
  `ci.yml` now passes `matrix.package` to the native-dep smoke step through
  `env: PACKAGE`, two lines longer. Re-pointed `native-deps-and-ci-smoke.md`
  (`ci.yml:47-53` for the step, `:52` for the smoke command); claims
  unchanged; re-stamped.
- 2026-10-03T12:12:29Z, okf-staleness workflow re-synced from the okf-kit
  workflow template (fleet convergence ticket fdc01728): the workflow header
  now names the template as its source instead of calling the file a pattern
  to keep in sync, the pin stays okf-kit@0.16.0, `--require-anchors` joined
  the invocation, and the job stays warn-only. Measured on the tree before the
  change with `okf-kit check --json <bundle>`: at okf-kit@0.16.0, 0 errors, 3
  warnings, 0 notices (exit 0) plain and 0 errors, 103 warnings, 0 notices
  (exit 0) with `--require-anchors`; at okf-kit@0.16.0, 0 errors, 3 warnings,
  0 notices (exit 0) plain and 0 errors, 103 warnings, 0 notices (exit 0) with
  `--require-anchors`. Of the anchored-run warnings, 100 are anchor-required
  findings (full citations without an anchor); anchoring them is separate work
  and none of them blocks anything.

- 2026-10-01T15:03:27Z, `semantic-search-silent-noop.md`:
  re-verified the semantic lint open-failure warning against the changed
  `conflicts.ts` condition. It preserves the width and newer-schema repair
  advice and appends one rebuild hint to a raw reason even when its path
  contains `rebuild`; the fallback to fresh embedding is unchanged.

- 2026-09-30T11:14:55Z, `semantic-search-silent-noop.md`:
  the `lint --conflicts --semantic` open-failure warning now appends the
  `memory-router index <dir>` rebuild hint unless the reason already says
  to rebuild; the `conflicts.ts` citation range was moved. Re-verified
  against the changed code and re-stamped.

- 2026-09-30T07:24:20Z, `semantic-search-silent-noop.md` and `native-deps-and-ci-smoke.md`
  re-verified after the comment-only change to `index-store.ts` and
  `indexer.ts` (line counts unchanged) and after merging the model-filter
  and once-per-process warning changes; the `getEmbedding` citation was
  moved to its current line. Re-stamped.

- 2026-09-30T07:01:07Z, `semantic-search-silent-noop.md`:
  on an `openIndex()` failure `lint --conflicts --semantic` now warns once
  and embeds fresh without reusing the index instead of skipping the
  semantic step; the `cli.ts` line citations in this doc and in
  `gate-composition-and-dedup.md` were moved for the three help-text lines
  added to `src/cli.ts`. Re-stamped.

- 2026-09-30T06:51:55Z, `semantic-search-silent-noop.md`:
  `lint --conflicts --semantic` now opens the index read-only without a width hint, so it no longer
  records a width on an index that has none, and an `openIndex()` throw
  there skips the semantic step with one stderr warning instead of
  failing the command; the "Other `openIndex()` callers" entry and its
  line reference were rewritten to match. Re-stamped.

- 2026-09-30T07:06:26Z, `semantic-search-silent-noop.md` row 5 now states that a `k` above the
  4096-row KNN ceiling with a model filter returns at most 4096 hits instead
  of throwing, and that the widening costs up to one extra full-table KNN
  scan per x4 step; `native-deps-and-ci-smoke.md` re-verified and
  re-stamped. Re-stamped.

- 2026-09-30T06:54:06Z, `semantic-search-silent-noop.md` row 5 and the
  crowding-out paragraph describe the model filter running inside a
  widening KNN window instead of after a single `LIMIT k`, and the
  `index-store.ts` line citations after the changed search path are
  re-pointed; `native-deps-and-ci-smoke.md` re-verified against the changed
  file and re-stamped. Re-stamped.

- 2026-09-30T06:51:44Z, `semantic-search-silent-noop.md` now says the stale-model stderr
  line is written once per process (a `staleModelWarned` flag mirroring
  `missingIndexWarned`), not on every call, and that a call finding no
  stale rows does not use up the warning. Its `indexer.ts` line citations
  were re-pointed to the shifted source. Re-stamped.

- 2026-09-27T15:18:36Z, `semantic-search-silent-noop.md` notes that
  `lint --conflicts --semantic` opens the index writable with the fixed
  1536 width hint, which records that width on an index that has none yet,
  so the never-embedded row holds only while no width is recorded;
  `gate-composition-and-dedup.md` shows the `resolveBlended` call without
  an options argument, as all three call sites make it. Re-stamped.

- 2026-09-27T15:09:05Z: second fact-check pass on the concept docs
  and `index.md`, re-verified against the checked-out source at head.
  Replaced counted and exclusive claims about paths, throws, and callers
  with lists that name the `rg` command they were enumerated from.
  `semantic-search-silent-noop.md`: the loud-counterpart section now lists
  the errors that can propagate out of `semanticSearch()` (provenance and
  other open-time integrity errors, `putCachedQuery`'s fresh-query
  dimension check, `search()`'s dimension check on a cache hit, the
  wrapped embed failure), states that the `resolveBlended` and
  `test --semantic` catches return the same hits as the unconfigured case
  but write the full error text to stderr, adds the silent path for an
  index whose entries were all removed, and separates the `semanticSearch` callers
  from the other `openIndex()` callers. This corrects the previous entry's
  "all five silent-`[]` paths" wording, which was not complete.
  `score-blend-resolver.md`: degraded-output and hint-exclusion prose
  replaced by pointers into `docs/scoring.md` and the pinning tests.
  `gate-composition-and-dedup.md`: call-site count dropped, the
  gate-override and tool-privilege wording tightened. `native-deps-and-ci-smoke.md`:
  probe-to-runtime wording corrected (the probe's `require` order differs).
  Sources lists pruned to the files each doc cites and extended where a
  doc now cites more.
- 2026-09-27T14:48:54Z: fact-check pass on `score-blend-resolver.md`,
  `semantic-search-silent-noop.md`, and `gate-composition-and-dedup.md`,
  re-verified against the checked-out source at head. Corrected the
  semantic-search fail posture (the router/CLI degrade catches swallow any
  `semanticSearch` throw, not only a network/API error, and only MCP
  `memory_search` and the `index` rebuild let a provenance/dimension
  mismatch propagate), listed all five silent-`[]` paths instead of two,
  fixed the null-provider rationale (it is the explicit openai-without-key
  misconfiguration, not an unconfigured machine), corrected `DEFAULT_GATES`'s
  actual scope (also reached by `test --semantic` and `resolveBlended`'s
  degraded fallback), fixed which `resolveBlended` caller can pass
  `ctx.tool` (only MCP `memory_resolve`, not the `UserPromptSubmit` hook),
  named `resolveDefaultMinSemanticScoreDetail` instead of the wrapper it
  calls, removed a stale/misattributed cross-reference into
  `docs/scoring.md`, and completed each doc's `sources:` list for files now
  cited inline (`src/embed/provider.ts`, `src/eval/runner.ts`,
  `docs/scoring.md`, `tests/index-store.test.ts`).
- 2026-09-27T14:23:45Z: bundle created (`index.md`, this log, and four
  concept docs: `score-blend-resolver.md`, `semantic-search-silent-noop.md`,
  `gate-composition-and-dedup.md`, `native-deps-and-ci-smoke.md`). Every
  inline citation was verified against the checked-out source at the base
  commit before writing. Two of the originally scoped candidate topics
  (the score-blend resolver's degraded-mode fallback, and the
  model-conditional relevance-floor/confidence-floor-provenance table)
  were merged into one doc (`score-blend-resolver.md`) rather than kept
  separate: both run through the same `resolveBlended` function in
  `packages/memory-router/src/router.ts`, and the floor's own value table
  is already fully covered by `README.md` "Calibration" and
  `docs/scoring.md`, so a separate doc for it would have mostly duplicated
  those. The warn-only `okf-staleness` GitHub Actions workflow was added
  in the same change, pointed at this bundle.
