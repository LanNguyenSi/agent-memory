#!/usr/bin/env node
const { loadMemoriesFromDir } = require('../memory/loader');
const { resolve } = require('../router');
const { renderHitsAsContext } = require('../render');
const { readStdin } = require('./io');

// Claude Code UserPromptSubmit hook input. The full schema also carries
// session_id / transcript_path / permission_mode — we only need prompt + cwd.
// See: https://code.claude.com/docs/en/hooks.md
interface HookInput {
  prompt?: string;
  cwd?: string;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input: HookInput = raw ? (JSON.parse(raw) as HookInput) : {};

  const memoryDir = process.env.MEMORY_ROUTER_DIR;
  if (!memoryDir) {
    // Silent no-op: an unconfigured router must never add context noise.
    return;
  }

  const memories = loadMemoriesFromDir(memoryDir);
  const ctx: RouterContext = { prompt: input.prompt, cwd: input.cwd };
  const hits: GateHit[] = resolve(ctx, memories);

  const additionalContext = renderHitsAsContext(hits);
  if (!additionalContext) return;

  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { additionalContext } })}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `memory-router user-prompt-submit failed: ${String(err)}\n`,
  );
  process.exit(1);
});
