const VAGUE_VERB_RE =
  /\b(check|schau|look|see|mal|irgendwie|kannst\s+du|can\s+you|überprüf)/i;
const IMPERATIVE_VERB_RE =
  /\b(fix|add|remove|rename|refactor|update|delete|implement|write|create|bump|upgrade|migrate|extract|inline|move)\b/i;
const SPECIFIC_NOUN_RE =
  /\b(function|class|method|file|test|spec|module|config|component|route|endpoint|schema|migration|commit|branch|PR|hook|gate)\b/i;
const PATH_RE = /(?:[\w.-]+\/[\w./-]+|\b[\w-]+\.[a-z]{1,5}\b)/;

// Returns a [0, 1] score where 0 means "prompt is clear and actionable" and
// 1 means "too vague to dispatch without pulling extra context". Only proxy
// signals — no LLM self-report, no model call. Keep this function free of
// side effects; the confidence gate's threshold derives directly from it.
function computeAmbiguity(prompt: string): number {
  const trimmed = prompt.trim();
  if (!trimmed) return 1;

  const words = trimmed.split(/\s+/).filter(Boolean).length;
  let score = 0.5;
  if (PATH_RE.test(trimmed)) score -= 0.2;
  if (SPECIFIC_NOUN_RE.test(trimmed)) score -= 0.2;
  if (IMPERATIVE_VERB_RE.test(trimmed)) score -= 0.1;
  if (VAGUE_VERB_RE.test(trimmed)) score += 0.3;
  if (words < 5) score += 0.2;
  return Math.max(0, Math.min(1, score));
}

function confidenceThreshold(ambiguity: number): number {
  return Math.max(0, 0.85 - ambiguity * 0.35);
}

module.exports = {
  computeAmbiguity,
  confidenceThreshold,
};
