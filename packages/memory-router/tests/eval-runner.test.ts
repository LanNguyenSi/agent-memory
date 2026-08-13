// Deterministic unit test for the golden-set eval runner (src/eval/*.ts).
//
// Fixture: tests/fixtures/eval/corpus/ (4 memories, one per topic:
// destructive_ops, workflow, deployment, security) + tests/fixtures/eval/golden.yml
// (6 prompts). No embedding index is built for the fixture corpus, so the
// confidence gate is provably unreachable here (semanticSearch bails out on
// existsSync(indexPath) before ever calling the OpenAI API — see
// src/embed/indexer.ts) — the eval measures the sync (topic/tool) path only,
// deterministically, with no live network calls.
//
// Every expected P/R/RR value below is hand-computed against the actual
// TOPIC_PATTERNS regexes (verified once against src/topic-patterns.ts before
// writing these fixtures — see the task's implementer notes) rather than
// eyeballed, precisely so this test can catch a real regression instead of
// asserting whatever the code happens to currently produce.
//
// Prompt-by-prompt derivation (topics matched via src/topic-patterns.ts,
// each of the 4 fixture memories owns exactly one topic 1:1):
//
//  1. "git push --force to master"
//     topics matched: {destructive_ops} only.
//     -> got = [feedback_force_push]  (single hit, no tie)
//     expect = [feedback_force_push]
//     precision = 1/1 = 1.0, recall = 1/1 = 1.0, rr = 1/1 = 1.0
//
//  2. "review before merge and deploy to prod"
//     topics matched: {workflow, deployment} (both single-hit topics).
//     -> got = {feedback_review_before_merge, feedback_deploy_checklist}
//        (2 tied hits, order not guaranteed — see note below)
//     expect = both ids -> got is an exact set match regardless of order
//     precision = 2/2 = 1.0, recall = 2/2 = 1.0
//     rr = 1.0: whichever of the two tied hits ranks first, it is in
//       expect either way, so rr is order-independent by construction.
//
//  3. "rotate the leaked token"
//     topics matched: {security} only.
//     -> got = [feedback_token_rotation]  (single hit, no tie)
//     expect includes a phantom id that never fires, to exercise recall < 1:
//     expect = [feedback_token_rotation, feedback_never_fires_phantom]
//     precision = 1/1 = 1.0, recall = 1/2 = 0.5, rr = 1/1 = 1.0
//
//  4. "rm -rf the build directory to start fresh"
//     topics matched: {destructive_ops} only -> got = [feedback_force_push].
//     expect is deliberately wrong (a different, non-firing id), to
//     exercise precision = 0 / recall = 0 / rr = 0:
//     expect = [feedback_deploy_checklist]
//     precision = 0/1 = 0.0, recall = 0/1 = 0.0, rr = 0.0
//
//  5. "what's the weather in Berlin today"  (negative control)
//     no topic matches -> got = [].  expect = [] -> PASSES.
//     precision = recall = 1.0 (by the negative-control convention),
//     reciprocalRank = null (never defined for negative controls).
//
//  6. "please deploy this release to prod"  (negative control)
//     topics matched: {deployment} -> got = [feedback_deploy_checklist]
//     (non-empty). expect = [] -> FAILS.
//     precision = recall = 0.0, reciprocalRank = null.
//
// Aggregate (mean over the 4 POSITIVE prompts only; negative controls are
// reported separately and never enter this mean):
//   precision = (1.0 + 1.0 + 1.0 + 0.0) / 4 = 0.75
//   recall    = (1.0 + 1.0 + 0.5 + 0.0) / 4 = 0.625
//   mrr       = (1.0 + 1.0 + 1.0 + 0.0) / 4 = 0.75
// negativeControls: total=2, passed=1 (#5), failed=1 (#6), rate=0.5

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  runGoldenEval,
  scorePrompt,
  aggregateMetrics,
  semanticPathAvailable,
  promptToHits,
  findUnknownExpectIds,
} = require("../src/eval/runner");
const { loadGoldenFile } = require("../src/eval/golden");

const CORPUS_DIR = path.join(__dirname, "fixtures", "eval", "corpus");
const GOLDEN_PATH = path.join(__dirname, "fixtures", "eval", "golden.yml");

test("semanticPathAvailable: false for the fixture corpus (no index built)", () => {
  assert.equal(semanticPathAvailable(CORPUS_DIR), false);
});

test("loadGoldenFile: parses the fixture golden set", () => {
  const golden = loadGoldenFile(GOLDEN_PATH);
  assert.equal(golden.prompts.length, 6);
  assert.equal(golden.prompts[0].prompt, "git push --force to master");
  assert.deepEqual(golden.prompts[0].expect, ["feedback_force_push"]);
  assert.deepEqual(
    golden.prompts[4].expect,
    [],
    "negative control has empty expect",
  );
});

test("loadGoldenFile: missing file throws a clear error", () => {
  assert.throws(
    () => loadGoldenFile(path.join(__dirname, "fixtures", "eval", "nope.yml")),
    /cannot read golden file/,
  );
});

test("loadGoldenFile: malformed YAML (no prompts key) throws a clear error", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-router-golden-"));
  const badPath = path.join(tmp, "bad.yml");
  fs.writeFileSync(badPath, "not_prompts: []\n");
  try {
    assert.throws(
      () => loadGoldenFile(badPath),
      /must be a YAML object with a top-level 'prompts' key|'prompts' must be an array/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadGoldenFile: empty prompts array throws a clear error", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-router-golden-"));
  const badPath = path.join(tmp, "empty.yml");
  fs.writeFileSync(badPath, "prompts: []\n");
  try {
    assert.throws(() => loadGoldenFile(badPath), /'prompts' array is empty/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadGoldenFile: non-object prompt entry throws a clear error", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-router-golden-"));
  const badPath = path.join(tmp, "bad-entry.yml");
  fs.writeFileSync(badPath, 'prompts:\n  - "just a string, not an object"\n');
  try {
    assert.throws(
      () => loadGoldenFile(badPath),
      /prompts\[0\] must be an object/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadGoldenFile: omitted expect: defaults to [] (negative control)", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-router-golden-"));
  const p = path.join(tmp, "omitted-expect.yml");
  fs.writeFileSync(p, 'prompts:\n  - prompt: "no expect key at all"\n');
  try {
    const golden = loadGoldenFile(p);
    assert.deepEqual(golden.prompts, [
      { prompt: "no expect key at all", expect: [] },
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadGoldenFile: non-string expect entries throw a clear error", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-router-golden-"));
  const p = path.join(tmp, "bad-expect.yml");
  fs.writeFileSync(p, 'prompts:\n  - prompt: "x"\n    expect: [1, 2]\n');
  try {
    assert.throws(
      () => loadGoldenFile(p),
      /prompts\[0\]\.expect must be an array of memory-id strings/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadGoldenFile: missing prompt field throws a clear error", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-router-golden-"));
  const p = path.join(tmp, "no-prompt.yml");
  fs.writeFileSync(p, "prompts:\n  - expect: []\n");
  try {
    assert.throws(
      () => loadGoldenFile(p),
      /prompts\[0\]\.prompt must be a non-empty string/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scorePrompt: positive prompt, exact match", () => {
  const m = scorePrompt(["a"], ["a"]);
  assert.equal(m.isNegativeControl, false);
  assert.equal(m.precision, 1);
  assert.equal(m.recall, 1);
  assert.equal(m.reciprocalRank, 1);
});

test("scorePrompt: negative control pass vs. fail", () => {
  const pass = scorePrompt([], []);
  assert.equal(pass.isNegativeControl, true);
  assert.equal(pass.precision, 1);
  assert.equal(pass.recall, 1);
  assert.equal(pass.reciprocalRank, null);

  const fail = scorePrompt([], ["unexpected_id"]);
  assert.equal(fail.isNegativeControl, true);
  assert.equal(fail.precision, 0);
  assert.equal(fail.recall, 0);
  assert.equal(fail.reciprocalRank, null);
});

test("scorePrompt: reciprocal rank reflects position of the first expected hit", () => {
  const m = scorePrompt(["b"], ["a", "b", "c"]);
  assert.equal(m.reciprocalRank, 0.5); // rank 2 -> 1/2
  const none = scorePrompt(["z"], ["a", "b"]);
  assert.equal(none.reciprocalRank, 0); // expected id never appears
});

test("aggregateMetrics: hand-verified aggregate over the fixture perPrompt set", () => {
  // Same 6-prompt scenario as the full runGoldenEval test below, built
  // directly from scorePrompt so this test also pins the aggregation math
  // in isolation from the router/loader wiring.
  const perPrompt = [
    { prompt: "p1", expect: ["a"], got: ["a"], ...scorePrompt(["a"], ["a"]) },
    {
      prompt: "p2",
      expect: ["a", "b"],
      got: ["b", "a"],
      ...scorePrompt(["a", "b"], ["b", "a"]),
    },
    {
      prompt: "p3",
      expect: ["a", "phantom"],
      got: ["a"],
      ...scorePrompt(["a", "phantom"], ["a"]),
    },
    { prompt: "p4", expect: ["b"], got: ["a"], ...scorePrompt(["b"], ["a"]) },
    { prompt: "p5", expect: [], got: [], ...scorePrompt([], []) },
    { prompt: "p6", expect: [], got: ["a"], ...scorePrompt([], ["a"]) },
  ];
  const agg = aggregateMetrics(perPrompt);
  assert.equal(agg.precision, 0.75);
  assert.equal(agg.recall, 0.625);
  assert.equal(agg.mrr, 0.75);
  assert.equal(agg.positiveCount, 4);
  assert.deepEqual(agg.negativeControls, {
    total: 2,
    passed: 1,
    failed: 1,
    rate: 0.5,
  });
});

interface PromptMetricLike {
  prompt: string;
  expect: string[];
  got: string[];
  isNegativeControl: boolean;
  precision: number;
  recall: number;
  reciprocalRank: number | null;
}

test("runGoldenEval: full run against the fixture corpus + golden set matches the hand-verified metrics", async () => {
  const report = await runGoldenEval(GOLDEN_PATH, CORPUS_DIR);

  assert.equal(report.corpusSize, 4);
  assert.equal(
    report.semanticPathActive,
    false,
    "no index built for the fixture corpus",
  );
  assert.equal(report.perPrompt.length, 6);
  // The fixture golden.yml deliberately labels "rotate the leaked token"
  // with a phantom id (feedback_never_fires_phantom) as a negative-control
  // for the recall<1 case — it never matches any fixture corpus memory, so
  // it must surface here as an unknown expect id. This is expected
  // behavior, not a bug: it exercises the same warning a real stale/typo'd
  // golden id would trigger.
  assert.deepEqual(report.unknownExpectIds, ["feedback_never_fires_phantom"]);

  const byPrompt = new Map<string, PromptMetricLike>(
    report.perPrompt.map((p: PromptMetricLike) => [p.prompt, p]),
  );

  const mustGet = (prompt: string): PromptMetricLike => {
    const p = byPrompt.get(prompt);
    if (!p)
      throw new Error(`fixture golden set missing expected prompt: ${prompt}`);
    return p;
  };

  const p1 = mustGet("git push --force to master");
  assert.deepEqual(p1.got, ["feedback_force_push"]);
  assert.equal(p1.precision, 1);
  assert.equal(p1.recall, 1);
  assert.equal(p1.reciprocalRank, 1);

  const p2 = mustGet("review before merge and deploy to prod");
  assert.deepEqual(
    new Set(p2.got),
    new Set(["feedback_review_before_merge", "feedback_deploy_checklist"]),
    "both single-topic memories fire (order not asserted: tied score)",
  );
  assert.equal(p2.precision, 1);
  assert.equal(p2.recall, 1);
  assert.equal(p2.reciprocalRank, 1);

  const p3 = mustGet("rotate the leaked token");
  assert.deepEqual(p3.got, ["feedback_token_rotation"]);
  assert.equal(p3.precision, 1);
  assert.equal(p3.recall, 0.5);
  assert.equal(p3.reciprocalRank, 1);

  const p4 = mustGet("rm -rf the build directory to start fresh");
  assert.deepEqual(p4.got, ["feedback_force_push"]);
  assert.equal(p4.precision, 0);
  assert.equal(p4.recall, 0);
  assert.equal(p4.reciprocalRank, 0);

  const p5 = mustGet("what's the weather in Berlin today");
  assert.equal(p5.isNegativeControl, true);
  assert.deepEqual(p5.got, []);
  assert.equal(p5.precision, 1);
  assert.equal(p5.reciprocalRank, null);

  const p6 = mustGet("please deploy this release to prod");
  assert.equal(p6.isNegativeControl, true);
  assert.deepEqual(p6.got, ["feedback_deploy_checklist"]);
  assert.equal(p6.precision, 0);
  assert.equal(p6.reciprocalRank, null);

  assert.equal(report.aggregate.precision, 0.75);
  assert.equal(report.aggregate.recall, 0.625);
  assert.equal(report.aggregate.mrr, 0.75);
  assert.equal(report.aggregate.positiveCount, 4);
  assert.deepEqual(report.aggregate.negativeControls, {
    total: 2,
    passed: 1,
    failed: 1,
    rate: 0.5,
  });
});

test("runGoldenEval: missing golden file throws (caller maps this to exit 1)", async () => {
  await assert.rejects(
    () =>
      runGoldenEval(
        path.join(__dirname, "fixtures", "eval", "nope.yml"),
        CORPUS_DIR,
      ),
    /cannot read golden file/,
  );
});

// --- promptToHits dependency-pinning tests -------------------------------
//
// These call promptToHits with the `deps` test seam (its 4th, test-only
// parameter — see src/eval/runner.ts) so they exercise the real
// promptToHits control flow without touching the real router or the
// embedding stack. They exist specifically to pin the HIGH hook-fidelity
// fix: resolveConfidence must be called with exactly the hook's argument
// list (ctx, memories, dir) and no opts object, and only when the sync
// gates were silent.

function fakeMemory(id: string): Memory {
  return {
    id,
    path: `${id}.md`,
    frontmatter: { name: id, description: `desc for ${id}`, type: "feedback" },
    body: "",
  };
}

test("promptToHits: does not call resolveConfidence when sync gates already return hits", async () => {
  const ctx: RouterContext = { prompt: "irrelevant" };
  const memories: Memory[] = [];
  const dir = "/fake/dir";
  const syncHit: GateHit = {
    memory: fakeMemory("m1"),
    gate: "topic",
    score: 1,
    reason: "topic match",
  };
  let resolveConfidenceCalled = false;
  const hits = await promptToHits(ctx, memories, dir, {
    resolve: (): GateHit[] => [syncHit],
    resolveConfidence: async (): Promise<GateHit[]> => {
      resolveConfidenceCalled = true;
      return [];
    },
    dedupeAndRank: (h: GateHit[]): GateHit[] => h,
  });
  assert.equal(
    resolveConfidenceCalled,
    false,
    "the confidence gate must stay silent once sync gates already produced hits",
  );
  assert.deepEqual(hits, [syncHit]);
});

test("promptToHits: calls resolveConfidence with exactly the hook's argument list (ctx, memories, dir) — no opts object", async () => {
  const ctx: RouterContext = { prompt: "an ambiguous prompt" };
  const memories: Memory[] = [fakeMemory("m1")];
  const dir = "/fake/dir";
  let capturedArgs: unknown[] | undefined;
  await promptToHits(ctx, memories, dir, {
    resolve: (): GateHit[] => [],
    resolveConfidence: async (...args: unknown[]): Promise<GateHit[]> => {
      capturedArgs = args;
      return [];
    },
    dedupeAndRank: (h: GateHit[]): GateHit[] => h,
  });
  // Mutating the resolveConfidence call back to
  // `resolveConfidence(ctx, memories, dir, { maxHits: MAX_HITS })` must
  // turn this assertion red: length would become 4, not 3.
  assert.equal(
    capturedArgs?.length,
    3,
    "resolveConfidence must receive exactly 3 positional args (ctx, memories, dir), no opts object, so the router's own default maxHits applies exactly as the hook does",
  );
  assert.deepEqual(capturedArgs, [ctx, memories, dir]);
});

test("promptToHits: falls back to the (empty) sync hits, does not propagate, when resolveConfidence throws", async () => {
  const ctx: RouterContext = { prompt: "an ambiguous prompt" };
  const memories: Memory[] = [fakeMemory("m1")];
  const dir = "/fake/dir";
  const hits = await promptToHits(ctx, memories, dir, {
    resolve: (): GateHit[] => [],
    resolveConfidence: async (): Promise<GateHit[]> => {
      throw new Error("simulated semantic search failure");
    },
    dedupeAndRank: (h: GateHit[]): GateHit[] => h,
  });
  assert.deepEqual(hits, []);
});

// --- loadGoldenFile expect-dedupe (MEDIUM fix) ---------------------------

test("loadGoldenFile: deduplicates a prompt's expect ids so reported expect === scored expect", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-router-golden-"));
  const p = path.join(tmp, "dup-expect.yml");
  fs.writeFileSync(
    p,
    'prompts:\n  - prompt: "x"\n    expect: ["a", "b", "a"]\n',
  );
  try {
    const golden = loadGoldenFile(p);
    assert.deepEqual(
      golden.prompts[0].expect,
      ["a", "b"],
      "duplicate id must be collapsed at load time",
    );
    // Recall must not be deflated by the duplicate: with the raw
    // (undeduped) 3-entry expect this would score 2/3; deduped it is 2/2.
    const scored = scorePrompt(golden.prompts[0].expect, ["a", "b"]);
    assert.equal(scored.recall, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- findUnknownExpectIds (MEDIUM fix) -----------------------------------

test("findUnknownExpectIds: flags golden expect ids absent from the corpus, deduped across prompts", () => {
  const memories: Memory[] = [fakeMemory("real_a"), fakeMemory("real_b")];
  const prompts = [
    { expect: ["real_a", "phantom_x"] },
    { expect: ["real_b"] },
    { expect: ["phantom_x", "phantom_y"] },
    { expect: [] },
  ];
  const unknown = findUnknownExpectIds(prompts, memories);
  assert.deepEqual(new Set(unknown), new Set(["phantom_x", "phantom_y"]));
  assert.equal(unknown.length, 2, "phantom_x reported once despite appearing twice");
});

test("findUnknownExpectIds: empty when every expect id resolves against the corpus", () => {
  const memories: Memory[] = [fakeMemory("real_a")];
  const prompts = [{ expect: ["real_a"] }, { expect: [] }];
  assert.deepEqual(findUnknownExpectIds(prompts, memories), []);
});
