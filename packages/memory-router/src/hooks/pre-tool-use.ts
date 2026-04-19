#!/usr/bin/env node
const { loadMemoriesFromDir } = require('../memory/loader');
const { resolve } = require('../router');
const { toolGate } = require('../gates/tool');
const { renderHitsAsContext } = require('../render');
const { readStdin } = require('./io');

// Claude Code PreToolUse hook input. We only consume tool_name / tool_input /
// cwd; the full schema also carries session_id / transcript_path.
// See: https://code.claude.com/docs/en/hooks.md
interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input: HookInput = raw ? (JSON.parse(raw) as HookInput) : {};

  const memoryDir = process.env.MEMORY_ROUTER_DIR;
  if (!memoryDir || !input.tool_name) return;

  const memories = loadMemoriesFromDir(memoryDir);
  const ctx: RouterContext = {
    cwd: input.cwd,
    tool: { name: input.tool_name, args: input.tool_input ?? {} },
  };

  const hits: GateHit[] = resolve(ctx, memories, { gates: [toolGate] });
  const additionalContext = renderHitsAsContext(hits);
  if (!additionalContext) return;

  // TODO(15ca7a24): consider setting permissionDecision="ask" when any
  // hit's memory has severity="critical" so the user explicitly confirms
  // destructive ops. Deferred until we have a real critical-severity
  // corpus to calibrate against.
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { additionalContext } })}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `memory-router pre-tool-use failed: ${String(err)}\n`,
  );
  process.exit(1);
});
