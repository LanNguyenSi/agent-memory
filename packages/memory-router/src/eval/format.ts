// Text and JSON renderers for the `memory-router eval` report (src/eval/runner.ts).
//
// --json schema (stable, documented in README.md "Golden-set eval"):
//   {
//     goldenPath, dir, corpusSize, semanticPathActive, vocabularySource,
//     unknownExpectIds,
//     perPrompt: [{ prompt, expect, got, isNegativeControl, precision, recall, reciprocalRank }],
//     aggregate: { precision, recall, mrr, positiveCount,
//                  negativeControls: { total, passed, failed, rate } }
//   }

function formatEvalReportText(report: EvalReportLike): string {
  const lines: string[] = [];
  lines.push(`golden: ${report.goldenPath}`);
  lines.push(
    `corpus: ${report.dir} (${report.corpusSize} memorie${report.corpusSize === 1 ? "" : "s"})`,
  );
  lines.push(
    `semantic path: ${
      report.semanticPathActive
        ? "ACTIVE (index + provider configured — measuring sync+confidence blend)"
        : "inactive (no index and/or no provider — measuring sync path only)"
    }`,
  );
  lines.push(`vocabulary: ${report.vocabularySource}`);
  if (report.unknownExpectIds.length > 0) {
    lines.push(
      `WARNING: golden file references ${report.unknownExpectIds.length} expect id(s) not found in the corpus (scoring is unaffected — this is a warning only): ${report.unknownExpectIds.join(", ")}`,
    );
  }
  lines.push("");

  for (const p of report.perPrompt) {
    lines.push(
      `prompt: ${p.prompt}${p.isNegativeControl ? "  [negative control]" : ""}`,
    );
    lines.push(
      `  expect: ${p.expect.length > 0 ? p.expect.join(", ") : "(none)"}`,
    );
    lines.push(`  got:    ${p.got.length > 0 ? p.got.join(", ") : "(none)"}`);
    if (p.isNegativeControl) {
      lines.push(
        `  ${p.precision === 1 ? "pass" : "FAIL (expected an empty result)"}`,
      );
    } else {
      lines.push(
        `  precision=${p.precision.toFixed(2)} recall=${p.recall.toFixed(2)} rr=${(p.reciprocalRank ?? 0).toFixed(2)}`,
      );
    }
    lines.push("");
  }

  const a = report.aggregate;
  lines.push(
    "--- aggregate (positive prompts only; negative controls reported separately) ---",
  );
  lines.push(
    `precision=${a.precision.toFixed(3)} recall=${a.recall.toFixed(3)} mrr=${a.mrr.toFixed(3)}  (n=${a.positiveCount})`,
  );
  const nc = a.negativeControls;
  lines.push(
    `negative controls: ${nc.passed}/${nc.total} passed` +
      (nc.rate === null ? "" : ` (${(nc.rate * 100).toFixed(1)}%)`),
  );
  lines.push("");
  return lines.join("\n");
}

function formatEvalReportJson(report: EvalReportLike): string {
  return JSON.stringify(report, null, 2) + "\n";
}

// Structural type kept local (not imported from runner.ts) so this module
// stays a pure formatter with no dependency on the runner's async/router
// wiring — easier to unit-test in isolation and to keep the "one function
// that changes for T004" boundary in runner.ts clean.
interface EvalReportLike {
  goldenPath: string;
  dir: string;
  corpusSize: number;
  semanticPathActive: boolean;
  vocabularySource: string;
  unknownExpectIds: string[];
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

module.exports = { formatEvalReportText, formatEvalReportJson };
