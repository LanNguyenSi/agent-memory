// Renders gate hits as a single markdown block that Claude Code injects as
// `hookSpecificOutput.additionalContext`. The model sees this as system
// context alongside the user's prompt (UserPromptSubmit) or just before
// executing a tool (PreToolUse), so the shape matters more than compactness:
// include the memory's full body, not just an id, so the rule is actionable
// without a follow-up read.

function renderHitsAsContext(hits: GateHit[]): string {
  if (hits.length === 0) return '';

  const header =
    hits.length === 1
      ? '**memory-router** — 1 relevant memory applies:'
      : `**memory-router** — ${hits.length} relevant memories apply:`;

  const blocks = hits.map((h) => {
    const name = h.memory.frontmatter.name;
    const gateLabel = `${h.gate} · ${h.score.toFixed(2)}`;
    const body = h.memory.body.trim();
    return `### ${name}  _(${gateLabel})_\n${body}`;
  });

  return [header, ...blocks].join('\n\n');
}

module.exports = { renderHitsAsContext };
