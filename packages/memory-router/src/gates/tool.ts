const MAX_PATTERN_LEN = 200;
// Detects the most common catastrophic-backtracking shapes: nested
// quantifiers like (a+)+, (a*)+, (a|b)+ followed by another quantifier.
// Not a full safe-regex audit — a pragmatic guard for author mistakes in
// trusted memory files.
const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)[+*?]/;

function isSafePattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LEN) return false;
  if (NESTED_QUANTIFIER_RE.test(pattern)) return false;
  return true;
}

function commandString(ctx: RouterContext): string | undefined {
  if (!ctx.tool) return undefined;
  if (ctx.tool.name !== 'Bash') return undefined;
  const cmd = ctx.tool.args?.command;
  return typeof cmd === 'string' ? cmd : undefined;
}

const toolGate: Gate = {
  name: 'tool',
  evaluate(ctx: RouterContext, memories: Memory[]): GateHit[] {
    if (!ctx.tool) return [];

    const cmd = commandString(ctx);
    const hits: GateHit[] = [];

    for (const memory of memories) {
      const t = memory.frontmatter.triggers;
      if (!t) continue;

      if (t.tools?.includes(ctx.tool.name)) {
        hits.push({
          memory,
          gate: 'tool',
          score: 1.0,
          reason: `tool match: ${ctx.tool.name}`,
        });
        continue;
      }

      if (cmd && t.command_pattern) {
        if (!isSafePattern(t.command_pattern)) {
          process.stderr.write(
            `memory-router: rejected unsafe command_pattern in ${memory.path}\n`,
          );
          continue;
        }
        let re: RegExp;
        try {
          re = new RegExp(t.command_pattern);
        } catch {
          continue;
        }
        if (re.test(cmd)) {
          hits.push({
            memory,
            gate: 'tool',
            score: 1.0,
            reason: `command match: ${t.command_pattern}`,
          });
        }
      }
    }
    return hits;
  },
};

module.exports = { toolGate, isSafePattern };
