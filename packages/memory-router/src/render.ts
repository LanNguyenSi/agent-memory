// Renders gate hits as a single markdown block that Claude Code injects as
// `hookSpecificOutput.additionalContext`. The model sees this as system
// context alongside the user's prompt (UserPromptSubmit) or just before
// executing a tool (PreToolUse), so the shape matters more than compactness:
// include the memory's full body, not just an id, so the rule is actionable
// without a follow-up read.

const { checkMemoryReferences } = require('./verify-refs');

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

    // Consult frontmatter.verify: if any referenced path no longer
    // exists, flag the block so the model treats the memory with
    // skepticism. We never suppress — the agent should still see the
    // rule, just with a loud "this might be outdated" marker.
    const staleness = checkMemoryReferences(h.memory.frontmatter.verify);
    const stalePrefix = staleness.stale
      ? `> ⚠️ **stale:** ${staleness.reason}\n>\n> This memory references something that no longer exists. Verify before acting.\n\n`
      : '';

    return `### ${name}  _(${gateLabel})_\n${stalePrefix}${body}`;
  });

  return [header, ...blocks].join('\n\n');
}

module.exports = { renderHitsAsContext };
