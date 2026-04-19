#!/usr/bin/env node
const { loadMemoriesFromDir } = require('../memory/loader');
const { resolve } = require('../router');
const { readStdin, writeStdout } = require('./io');

interface HookInput {
  prompt?: string;
  cwd?: string;
  recent_files?: string[];
  memory_dir?: string;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input: HookInput = raw ? (JSON.parse(raw) as HookInput) : {};

  const memoryDir = input.memory_dir ?? process.env.MEMORY_ROUTER_DIR;
  if (!memoryDir) {
    writeStdout({ hits: [], reason: 'no memory_dir configured' });
    return;
  }

  const memories = loadMemoriesFromDir(memoryDir);
  const ctx: RouterContext = {
    prompt: input.prompt,
    cwd: input.cwd,
    recentFiles: input.recent_files,
  };

  const hits: GateHit[] = resolve(ctx, memories);
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
    `memory-router user-prompt-submit failed: ${String(err)}\n`,
  );
  process.exit(1);
});
