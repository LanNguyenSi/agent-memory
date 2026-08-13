// Direct unit test for the eval report formatters (src/eval/format.ts).
//
// eval-cli.test.ts already exercises these indirectly through a spawned
// `dist/cli.js` subprocess, but a subprocess is invisible to Node's
// --experimental-test-coverage instrumentation (it only tracks in-process
// `require`s) and the CLI test only substring-matches a few lines. This
// file requires format.ts directly against a small hand-built report so
// the formatter logic itself is pinned and measured, matching the existing
// house convention of direct tests for the other lint/stale formatters
// (formatDriftReportText, formatStaleReportText, formatReportText, ...).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatEvalReportText,
  formatEvalReportJson,
} = require("../src/eval/format");

interface EvalReportLike {
  goldenPath: string;
  dir: string;
  corpusSize: number;
  semanticPathActive: boolean;
  vocabularySource: string;
  unknownExpectIds: string[];
  semanticContributedCount: number;
  perPrompt: {
    prompt: string;
    expect: string[];
    got: string[];
    isNegativeControl: boolean;
    precision: number;
    recall: number;
    reciprocalRank: number | null;
  }[];
  aggregate: {
    precision: number;
    recall: number;
    mrr: number;
    positiveCount: number;
    negativeControls: {
      total: number;
      passed: number;
      failed: number;
      rate: number | null;
    };
  };
}

function buildReport(): EvalReportLike {
  return {
    goldenPath: "golden.yml",
    dir: "/tmp/corpus",
    corpusSize: 2,
    semanticPathActive: false,
    vocabularySource: "built-in default",
    unknownExpectIds: [],
    semanticContributedCount: 1,
    perPrompt: [
      {
        prompt: "positive prompt",
        expect: ["mem_a"],
        got: ["mem_a"],
        isNegativeControl: false,
        precision: 1,
        recall: 1,
        reciprocalRank: 1,
      },
      {
        prompt: "unrelated prompt",
        expect: [],
        got: [],
        isNegativeControl: true,
        precision: 1,
        recall: 1,
        reciprocalRank: null,
      },
      {
        prompt: "noisy prompt",
        expect: [],
        got: ["mem_b"],
        isNegativeControl: true,
        precision: 0,
        recall: 0,
        reciprocalRank: null,
      },
    ],
    aggregate: {
      precision: 1,
      recall: 1,
      mrr: 1,
      positiveCount: 1,
      negativeControls: { total: 2, passed: 1, failed: 1, rate: 0.5 },
    },
  };
}

test("formatEvalReportText: header lines report golden path, corpus size, semantic path state, vocabulary source", () => {
  const text = formatEvalReportText(buildReport());
  assert.match(text, /golden: golden\.yml/);
  assert.match(text, /corpus: \/tmp\/corpus \(2 memories\)/);
  assert.match(text, /semantic path: inactive/);
  assert.match(text, /vocabulary: built-in default/);
});

test("formatEvalReportText: reports how many prompts the semantic gate actually contributed to, out of the total (mm-v1-T004 fix-round 2 LOW #8)", () => {
  const report = buildReport();
  report.semanticContributedCount = 1;
  const text = formatEvalReportText(report);
  assert.match(text, /semantic contributed: 1\/3 prompts/);
});

test("formatEvalReportText: semantic-contributed count of 0 out of N still renders (no semantic hits anywhere in the run)", () => {
  const report = buildReport();
  report.semanticContributedCount = 0;
  const text = formatEvalReportText(report);
  assert.match(text, /semantic contributed: 0\/3 prompts/);
});

test("formatEvalReportText: vocabulary line reflects a custom source verbatim", () => {
  const report = buildReport();
  report.vocabularySource = "custom (/tmp/corpus/topics.yml)";
  const text = formatEvalReportText(report);
  assert.match(text, /vocabulary: custom \(\/tmp\/corpus\/topics\.yml\)/);
});

test("formatEvalReportText: semantic path active renders a configured-not-probed message (mm-v1-T003 fix-round HIGH #1)", () => {
  const report = buildReport();
  report.semanticPathActive = true;
  const text = formatEvalReportText(report);
  assert.match(
    text,
    /semantic path: configured \(provider configured, unprobed\) with index present, measuring sync\+confidence blend/,
  );
});

test("formatEvalReportText: unknown expect ids render a WARNING line naming them; no ids means no warning", () => {
  const clean = formatEvalReportText(buildReport());
  assert.doesNotMatch(clean, /WARNING/);

  const withUnknown = buildReport();
  withUnknown.unknownExpectIds = ["feedback_never_fires_phantom", "typo_id"];
  const text = formatEvalReportText(withUnknown);
  assert.match(
    text,
    /WARNING: golden file references 2 expect id\(s\) not found in the corpus.*feedback_never_fires_phantom, typo_id/,
  );
});

test("formatEvalReportText: positive prompt prints precision/recall/rr, not a pass\\/fail line", () => {
  const text = formatEvalReportText(buildReport());
  assert.match(text, /prompt: positive prompt(?!.*\[negative control\])/);
  assert.match(text, /precision=1\.00 recall=1\.00 rr=1\.00/);
});

test("formatEvalReportText: negative control prompts are tagged and show pass\\/FAIL, not P\\/R\\/rr", () => {
  const text = formatEvalReportText(buildReport());
  assert.match(
    text,
    /prompt: unrelated prompt {2}\[negative control\]\n {2}expect: \(none\)\n {2}got: {4}\(none\)\n {2}pass/,
  );
  assert.match(
    text,
    /prompt: noisy prompt {2}\[negative control\][\s\S]*?FAIL \(expected an empty result\)/,
  );
});

test("formatEvalReportText: aggregate summary reports P\\/R\\/MRR and negative-control pass rate separately", () => {
  const text = formatEvalReportText(buildReport());
  assert.match(text, /precision=1\.000 recall=1\.000 mrr=1\.000 {2}\(n=1\)/);
  assert.match(text, /negative controls: 1\/2 passed \(50\.0%\)/);
});

test("formatEvalReportText: zero negative controls omits the rate percentage (null rate)", () => {
  const report = buildReport();
  report.perPrompt = [report.perPrompt[0]];
  report.aggregate = {
    precision: 1,
    recall: 1,
    mrr: 1,
    positiveCount: 1,
    negativeControls: { total: 0, passed: 0, failed: 0, rate: null },
  };
  const text = formatEvalReportText(report);
  assert.match(text, /negative controls: 0\/0 passed$/m);
});

test("formatEvalReportJson: round-trips the report unchanged, newline-terminated", () => {
  const report = buildReport();
  const json = formatEvalReportJson(report);
  assert.ok(json.endsWith("\n"), "JSON output is newline-terminated");
  assert.deepEqual(JSON.parse(json), report);
});
