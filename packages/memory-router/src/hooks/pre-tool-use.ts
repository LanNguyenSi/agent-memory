#!/usr/bin/env node
const { loadMemoriesFromDir } = require('../memory/loader');
const { resolve } = require('../router');
const { toolGate } = require('../gates/tool');
const { readStdin, writeStdout } = require('./io');

interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  memory_dir?: string;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input: HookInput = raw ? (JSON.parse(raw) as HookInput) : {};

  const memoryDir = input.memory_dir ?? process.env.MEMORY_ROUTER_DIR;
  if (!memoryDir || !input.tool_name) {
    writeStdout({ hits: [], reason: 'missing memory_dir or tool_name' });
    return;
  }

  const memories = loadMemoriesFromDir(memoryDir);
  const ctx: RouterContext = {
    cwd: input.cwd,
    tool: { name: input.tool_name, args: input.tool_input ?? {} },
  };

  const hits: GateHit[] = resolve(ctx, memories, { gates: [toolGate] });
  writeStdout({
    hits: hits.map((h) => ({
      id: h.memory.id,
      path: h.memory.path,
      gate: h.gate,
      score: h.score,
      reason: h.reason,
    })),
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `memory-router pre-tool-use failed: ${String(err)}\n`,
  );
  process.exit(1);
});
