// Text and JSON renderers for `memory-router migrate` (src/migrate/transform.ts).
//
// --json schema (stable):
//   {
//     dir, mapping, apply,
//     vocabulary,       // "default" | "custom" — which topic vocabulary this
//                        // run resolved against (topics.yml absent/invalid
//                        // vs. present and valid)
//     vocabularyError,  // string | null — the rejection reason when a
//                        // present topics.yml failed to load (vocabulary
//                        // still falls back to "default" in that case);
//                        // null when there was nothing to reject
//     files: [{ id, path, skipped, reason, changed,
//               type: { action, value?, source? },
//               topics: { action, value?, source? },
//               created: { action, value?, source? } }],
//     summary: { total, changed, unchanged, skipped,
//                untaggedTopics: [id...], missingType: [id...],
//                invalidTopicsShape: [id...],
//                applied: number|null, errored: [string...] }
//   }
//
// `applied` is null in a dry run (no writes attempted) and the count of
// files actually written under --apply. `errored` carries per-file write
// failures (only possible under --apply); a non-empty `errored` list makes
// the CLI exit 1 (see cli.ts's runMigrate), since it means a real write
// failed. A dry-run report, or an untagged/missing/invalid-shape finding on
// its own, never does: that stays exit 0, same "report, not a gate"
// contract as `eval`.
//
// `topics.action`/`topics.source` together spell out which of the six
// precedence states a file landed in (see transform.ts's resolveTopics):
// kept (action "kept", top-level topics already present), kept but flagged
// (action "kept", source "invalid-shape": a non-empty top-level topics in a
// shape other than a list of strings, never overwritten but surfaced for
// manual review), hoisted (action "set", source "metadata.topics"), mapped
// (action "set", source "mapping"), derived (action "set", source
// "vocabulary-pattern"), or untagged (action "missing", none of the above
// matched).

interface FieldResultLike {
  action: 'kept' | 'set' | 'missing';
  value?: unknown;
  source?: string;
}

interface FilePlanLike {
  id: string;
  path: string;
  skipped: boolean;
  reason?: string;
  changed: boolean;
  type: FieldResultLike;
  topics: FieldResultLike;
  created: FieldResultLike;
}

interface MigrationPlanLike {
  dir: string;
  mappingPath: string | null;
  vocabularySource?: 'default' | 'custom';
  vocabularyError?: string | null;
  files: FilePlanLike[];
}

interface ApplyResultLike {
  applied: number;
  unchanged: number;
  skipped: number;
  errored: string[];
}

function buildSummary(
  plan: MigrationPlanLike,
  applyResult: ApplyResultLike | null,
) {
  const untaggedTopics = plan.files
    .filter((f) => !f.skipped && f.topics.action === 'missing')
    .map((f) => f.id);
  const missingType = plan.files
    .filter((f) => !f.skipped && f.type.action === 'missing')
    .map((f) => f.id);
  const invalidTopicsShape = plan.files
    .filter(
      (f) => !f.skipped && f.topics.action === 'kept' && f.topics.source === 'invalid-shape',
    )
    .map((f) => f.id);
  const changed = plan.files.filter((f) => f.changed).length;
  const skipped = plan.files.filter((f) => f.skipped).length;
  const unchanged = plan.files.length - changed - skipped;

  return {
    total: plan.files.length,
    changed,
    unchanged,
    skipped,
    untaggedTopics,
    missingType,
    invalidTopicsShape,
    applied: applyResult ? applyResult.applied : null,
    errored: applyResult ? applyResult.errored : [],
  };
}

// Human-readable disclosure of which topic vocabulary this run resolved
// against, printed unconditionally in the text header (not just on
// failure) so a corpus operator always knows whether a topics.yml was
// consulted at all. Falls back to the "no topics.yml" phrasing when the
// plan doesn't carry vocabulary info (e.g. a hand-built plan in a test
// that predates this field) rather than printing "undefined".
function formatVocabularyLine(plan: MigrationPlanLike): string {
  if (plan.vocabularyError) {
    return `vocabulary: default (topics.yml rejected: ${plan.vocabularyError})`;
  }
  if (plan.vocabularySource === 'custom') {
    return 'vocabulary: custom (topics.yml)';
  }
  return 'vocabulary: default (no topics.yml)';
}

function describeField(label: string, field: FieldResultLike, applied: boolean): string | null {
  if (field.action === 'kept') {
    if (label === 'topics' && field.source === 'invalid-shape') {
      return `  ${label}: kept (invalid shape, needs manual review)`;
    }
    return null; // already canonical, nothing to show
  }
  if (field.action === 'missing') {
    return `  ${label}: ${label === 'topics' ? 'untagged' : 'missing'} — no ${
      label === 'type'
        ? 'metadata.type to hoist'
        : 'metadata.topics/mapping/vocabulary match'
    } (needs manual review)`;
  }
  // action === 'set'
  const verb = applied ? '+' : '+ (would set)';
  const valueStr = Array.isArray(field.value)
    ? `[${(field.value as unknown[]).join(', ')}]`
    : JSON.stringify(field.value);
  const src = field.source ? `  (from ${field.source})` : '';
  return `  ${verb} ${label}: ${valueStr}${src}`;
}

function formatMigrationReportText(
  plan: MigrationPlanLike,
  applyResult: ApplyResultLike | null,
): string {
  const applied = applyResult !== null;
  const lines: string[] = [];
  lines.push(
    `dir: ${plan.dir} (${plan.files.length} memory file${plan.files.length === 1 ? '' : 's'})`,
  );
  lines.push(`mapping: ${plan.mappingPath ?? 'none'}`);
  lines.push(formatVocabularyLine(plan));
  lines.push('');

  for (const file of plan.files) {
    if (file.skipped) continue; // listed separately below
    lines.push(file.id);
    if (!file.changed) {
      lines.push('  (already canonical, no changes)');
      lines.push('');
      continue;
    }
    for (const [label, field] of [
      ['type', file.type],
      ['topics', file.topics],
      ['created', file.created],
    ] as [string, FieldResultLike][]) {
      const line = describeField(label, field, applied);
      if (line) lines.push(line);
    }
    lines.push('');
  }

  const skippedFiles = plan.files.filter((f) => f.skipped);
  if (skippedFiles.length > 0) {
    lines.push('--- skipped (not a valid memory file) ---');
    for (const f of skippedFiles) lines.push(`${f.id}: ${f.reason}`);
    lines.push('');
  }

  const summary = buildSummary(plan, applyResult);
  lines.push(
    `${applied ? 'applied' : 'would apply'} to ${summary.changed} file(s), ${summary.unchanged} unchanged, ${summary.skipped} skipped`,
  );
  if (summary.untaggedTopics.length > 0) {
    lines.push(
      `untagged topics (${summary.untaggedTopics.length}): ${summary.untaggedTopics.join(', ')}`,
    );
  }
  if (summary.missingType.length > 0) {
    lines.push(
      `missing type (${summary.missingType.length}): ${summary.missingType.join(', ')}`,
    );
  }
  if (summary.invalidTopicsShape.length > 0) {
    lines.push(
      `invalid topics shape (${summary.invalidTopicsShape.length}): ${summary.invalidTopicsShape.join(', ')}`,
    );
  }
  if (summary.errored.length > 0) {
    lines.push(`errors (${summary.errored.length}):`);
    for (const e of summary.errored) lines.push(`  ${e}`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatMigrationReportJson(
  plan: MigrationPlanLike,
  applyResult: ApplyResultLike | null,
): string {
  const payload = {
    dir: plan.dir,
    mapping: plan.mappingPath,
    apply: applyResult !== null,
    vocabulary: plan.vocabularySource ?? 'default',
    vocabularyError: plan.vocabularyError ?? null,
    files: plan.files.map((f) => ({
      id: f.id,
      path: f.path,
      skipped: f.skipped,
      reason: f.reason ?? null,
      changed: f.changed,
      type: f.type,
      topics: f.topics,
      created: f.created,
    })),
    summary: buildSummary(plan, applyResult),
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

module.exports = { formatMigrationReportText, formatMigrationReportJson };
