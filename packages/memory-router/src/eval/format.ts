// Text and JSON renderers for the `memory-router eval` report (src/eval/runner.ts).
//
// --json schema (stable, documented in docs/commands.md's eval section):
//   {
//     goldenPath, dir, corpusSize, semanticPathActive, vocabularySource,
//     unknownExpectIds, unknownForbidIds, semanticContributedCount, keywordContributedCount,
//     injection: { budgetBytes, meanBytes, maxBytes },
//     perPrompt: [{ prompt, expect, forbid, forbidViolations, got, isNegativeControl,
//                   precision, recall, reciprocalRank, injectBytes }],
//     aggregate: { precision, recall, mrr, positiveCount,
//                  negativeControls: { total, passed, failed, rate },
//                  forbid: { total, violated } }
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
        ? "configured (provider configured, unprobed) with index present, measuring sync+confidence blend"
        : "inactive (no index and/or no provider — measuring sync path only)"
    }`,
  );
  lines.push(`vocabulary: ${report.vocabularySource}`);
  lines.push(
    `semantic contributed: ${report.semanticContributedCount}/${report.perPrompt.length} prompts`,
  );
  lines.push(
    `keyword contributed: ${report.keywordContributedCount}/${report.perPrompt.length} prompts`,
  );
  if (report.unknownExpectIds.length > 0) {
    lines.push(
      `WARNING: golden file references ${report.unknownExpectIds.length} expect id(s) not found in the corpus (scoring is unaffected — this is a warning only): ${report.unknownExpectIds.join(", ")}`,
    );
  }
  if (report.unknownForbidIds && report.unknownForbidIds.length > 0) {
    lines.push(
      `WARNING: golden file references ${report.unknownForbidIds.length} forbid id(s) not found in the corpus (those checks pass vacuously): ${report.unknownForbidIds.join(", ")}`,
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
    if (p.forbid && p.forbid.length > 0) {
      const violations = p.forbidViolations ?? [];
      lines.push(
        violations.length > 0
          ? `  forbid: ${p.forbid.join(", ")}  FAIL (present: ${violations.join(", ")})`
          : `  forbid: ${p.forbid.join(", ")}  ok`,
      );
    }
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
  if (a.forbid && a.forbid.total > 0) {
    lines.push(
      `forbid checks: ${a.forbid.total - a.forbid.violated}/${a.forbid.total} prompts clean`,
    );
  }
  if (report.injection) {
    const inj = report.injection;
    lines.push(
      `injected context: mean=${Math.round(inj.meanBytes)} bytes max=${inj.maxBytes} bytes (hook renderer, budget ${inj.budgetBytes} bytes, over all ${report.perPrompt.length} prompts)`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatEvalReportJson(report: EvalReportLike): string {
  return JSON.stringify(report, null, 2) + "\n";
}

// Structural type kept local (not imported from runner.ts) so this module
// stays a pure formatter with no dependency on the runner's async/router
// wiring — easier to unit-test in isolation and to keep the "one function
// that changed for the score-blend rewrite" boundary in runner.ts clean.
interface EvalReportLike {
  goldenPath: string;
  dir: string;
  corpusSize: number;
  semanticPathActive: boolean;
  vocabularySource: string;
  unknownExpectIds: string[];
  /** Absent in reports built before `forbid` existed. */
  unknownForbidIds?: string[];
  semanticContributedCount: number;
  keywordContributedCount: number;
  /** Absent in reports built before the injection budget existed. */
  injection?: { budgetBytes: number; meanBytes: number; maxBytes: number };
  perPrompt: {
    prompt: string;
    expect: string[];
    got: string[];
    isNegativeControl: boolean;
    precision: number;
    recall: number;
    reciprocalRank: number | null;
    /** Absent in reports built before `forbid` existed. */
    forbid?: string[];
    forbidViolations?: string[];
    injectBytes?: number;
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
    /** Absent in reports built before `forbid` existed. */
    forbid?: { total: number; violated: number };
  };
}

module.exports = { formatEvalReportText, formatEvalReportJson };
