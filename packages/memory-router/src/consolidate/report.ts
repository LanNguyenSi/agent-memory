// Text and JSON renderers for `memory-router consolidate` (src/consolidate/analyze.ts).
//
// --json schema (stable):
//   {
//     dir, scannedCount,
//     exactDupes: { normalization, groups: [{ hash, ids, paths }] },
//     nearDupes: { status: "ok"|"skipped", reason?, threshold,
//                  indexedCount, totalCount, pairs: [{ aId, aPath, bId, bPath, similarity }] },
//     stale: <StaleReport, verbatim from src/lint/stale.ts>,
//     schema: { scannedCount, untaggedCount, untaggedIds,
//               legacyFormatCount, legacyFormatRate, legacyFormatIds,
//               loaderRejects: [{ path, reason }] }
//   }
//
// A report, not a gate: `memory-router consolidate` never writes anything
// and always exits 0 on an error-free run, regardless of how many findings
// it surfaces (same "report, not a gate" contract as `eval`/`migrate`).

const { formatStaleReportText } = require('../lint/stale');

interface ExactDupeGroupLike {
  hash: string;
  ids: string[];
  paths: string[];
}

interface NearDupePairLike {
  aId: string;
  aPath: string;
  bId: string;
  bPath: string;
  similarity: number;
}

interface NearDupeResultLike {
  status: 'ok' | 'skipped';
  reason?: string;
  threshold: number;
  indexedCount: number;
  totalCount: number;
  pairs: NearDupePairLike[];
}

interface SchemaMetricsLike {
  scannedCount: number;
  untaggedCount: number;
  untaggedIds: string[];
  legacyFormatCount: number;
  legacyFormatRate: number;
  legacyFormatIds: string[];
  loaderRejects: { path: string; reason: string }[];
}

interface ConsolidateReportLike {
  dir: string;
  scannedCount: number;
  exactDupes: { normalization: string; groups: ExactDupeGroupLike[] };
  nearDupes: NearDupeResultLike;
  // Loosely typed here (only the fields this formatter touches are named)
  // since the real StaleReport type lives in src/lint/stale.ts and this
  // module treats it as an opaque pass-through value.
  stale: {
    hits: { status: string }[];
    scannedCount: number;
    refsChecked: number;
  };
  schema: SchemaMetricsLike;
}

function formatConsolidateReportText(report: ConsolidateReportLike): string {
  const lines: string[] = [];
  lines.push(
    `dir: ${report.dir} (${report.scannedCount} memory file${report.scannedCount === 1 ? '' : 's'} loaded)`,
  );
  lines.push('');

  lines.push('--- exact duplicates (normalized body hash) ---');
  lines.push(`normalization: ${report.exactDupes.normalization}`);
  if (report.exactDupes.groups.length === 0) {
    lines.push('none found');
  } else {
    for (const g of report.exactDupes.groups) {
      lines.push(`  group (${g.ids.length}): ${g.ids.join(', ')}`);
      for (const p of g.paths) lines.push(`    ${p}`);
    }
  }
  lines.push('');

  lines.push(`--- near duplicates (cosine >= ${report.nearDupes.threshold}) ---`);
  if (report.nearDupes.status === 'skipped') {
    lines.push(`skipped: ${report.nearDupes.reason}`);
  } else {
    lines.push(
      `coverage: ${report.nearDupes.indexedCount}/${report.nearDupes.totalCount} memories had a usable index vector`,
    );
    if (report.nearDupes.pairs.length === 0) {
      lines.push('none found');
    } else {
      for (const p of report.nearDupes.pairs) {
        lines.push(`  ${p.similarity.toFixed(4)}  ${p.aId} <-> ${p.bId}`);
        lines.push(`    ${p.aPath}`);
        lines.push(`    ${p.bPath}`);
      }
    }
  }
  lines.push('');

  lines.push('--- stale references (memory-router stale) ---');
  lines.push(formatStaleReportText(report.stale).trimEnd());
  lines.push('');

  lines.push('--- schema metrics ---');
  lines.push(`untagged: ${report.schema.untaggedCount}/${report.schema.scannedCount}`);
  if (report.schema.untaggedIds.length > 0) {
    lines.push(`  ${report.schema.untaggedIds.join(', ')}`);
  }
  lines.push(
    `legacy format (metadata.type without top-level type): ${report.schema.legacyFormatCount}/${report.schema.scannedCount} (${(report.schema.legacyFormatRate * 100).toFixed(1)}%)`,
  );
  if (report.schema.legacyFormatIds.length > 0) {
    lines.push(`  ${report.schema.legacyFormatIds.join(', ')}`);
  }
  lines.push(`loader rejects: ${report.schema.loaderRejects.length}`);
  for (const r of report.schema.loaderRejects) {
    lines.push(`  ${r.path}: ${r.reason}`);
  }
  lines.push('');

  lines.push('memory-router consolidate: report only, nothing was written.');
  return lines.join('\n') + '\n';
}

function formatConsolidateReportJson(report: ConsolidateReportLike): string {
  return JSON.stringify(report, null, 2) + '\n';
}

module.exports = { formatConsolidateReportText, formatConsolidateReportJson };
