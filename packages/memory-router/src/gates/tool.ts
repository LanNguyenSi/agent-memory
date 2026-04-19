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

module.exports = { toolGate };
