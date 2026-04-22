// Resolve memory staleness by checking each `frontmatter.verify:` entry
// against the filesystem. Parallel to agent-grounding's
// runtime-reality-checker.verifyMemoryReference, but scoped to the
// minimum the memory-router hook needs: `kind: 'path'` support via a
// single fs.statSync. Symbol and flag kinds are accepted in the shape
// but treated as "skipped" — stale-ness is not claimed either way, and
// the hook logs a one-off stderr hint so authors know the inline check
// only covers paths today.
//
// Why the duplication with runtime-reality-checker?
// agent-grounding's reality-checker is not published to npm and the
// agent-memory repo does not vendor in a git-tarball dep for a ~10 LOC
// helper. This file is the honest "local copy" path from the task's
// decision matrix. Upgrade to the upstream when runtime-reality-checker
// ships on npm — tracked as a follow-up task.

const { statSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');

export interface MemoryStaleness {
  stale: boolean;
  /** Human-readable one-liner suitable for the `⚠️ stale: …` prefix. */
  reason?: string;
  /** Per-ref results — exposed for tests / future UIs. */
  checks: MemoryRefCheck[];
}

export interface MemoryRefCheck {
  ref: MemoryReference;
  /** `true` means the ref was verified as present; `false` means verifiably missing. */
  exists: boolean;
  /** `true` when the kind isn't supported here (symbol/flag in iteration 1). */
  skipped: boolean;
  detail: string;
}

function checkPath(ref: MemoryReference): MemoryRefCheck {
  const root = ref.repoRoot ?? process.cwd();
  const full = isAbsolute(ref.value) ? ref.value : join(root, ref.value);

  // Relative values must stay inside repoRoot. Traversal like
  // `../../../etc/passwd` is refused — a memory should not be checking
  // existence outside its declared scope.
  if (!isAbsolute(ref.value)) {
    const resolvedRoot = resolve(root);
    const resolvedFull = resolve(full);
    if (
      resolvedFull !== resolvedRoot &&
      !resolvedFull.startsWith(resolvedRoot + '/') &&
      !resolvedFull.startsWith(resolvedRoot + '\\')
    ) {
      return {
        ref,
        exists: false,
        skipped: false,
        detail: `path '${ref.value}' escapes repoRoot`,
      };
    }
  }

  try {
    statSync(full);
    return { ref, exists: true, skipped: false, detail: `path '${ref.value}' exists` };
  } catch {
    return {
      ref,
      exists: false,
      skipped: false,
      detail: `path '${ref.value}' not found at ${full}`,
    };
  }
}

function skippedCheck(ref: MemoryReference): MemoryRefCheck {
  return {
    ref,
    exists: true,
    skipped: true,
    detail: `kind '${ref.kind}' not checked inline (only 'path' is supported here; use the grounding-mcp verify_memory_reference tool for symbol/flag)`,
  };
}

export function checkMemoryReferences(
  refs: MemoryReference[] | undefined,
): MemoryStaleness {
  if (!Array.isArray(refs) || refs.length === 0) {
    return { stale: false, checks: [] };
  }

  const checks: MemoryRefCheck[] = refs.map((ref) => {
    if (!ref || typeof ref !== 'object') {
      // Malformed frontmatter — treat as skipped to stay additive.
      return {
        ref: { kind: 'path', value: String(ref) },
        exists: true,
        skipped: true,
        detail: 'malformed verify entry',
      };
    }
    if (ref.kind === 'path') return checkPath(ref);
    return skippedCheck(ref);
  });

  const missing = checks.filter((c) => !c.exists && !c.skipped);
  if (missing.length === 0) return { stale: false, checks };

  const reason =
    missing.length === 1
      ? missing[0].detail
      : `${missing.length} referenced item(s) missing: ${missing
          .map((m) => m.detail)
          .join('; ')}`;

  return { stale: true, reason, checks };
}

module.exports = { checkMemoryReferences };
