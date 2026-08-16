#!/usr/bin/env node
const { loadMemoriesFromDir } = require('../memory/loader');
const { resolveBlended } = require('../router');
const { renderHitsAsContext } = require('../render');
const { readStdin } = require('./io');

// Single source of truth for the version reported by the `--version` CLI
// short-circuit. Bump alongside package.json on release; the
// cli-version test asserts they stay in sync.
const PACKAGE_VERSION = '0.7.0';

// Claude Code UserPromptSubmit hook input. The full schema also carries
// session_id / transcript_path / permission_mode — we only need prompt + cwd.
// See: https://code.claude.com/docs/en/hooks.md
interface HookInput {
  prompt?: string;
  cwd?: string;
}

async function main(): Promise<void> {
  // CLI short-circuit: print the version and exit before touching stdin.
  // Tooling that probes installed binaries with `<bin> --version` (e.g.
  // `harness doctor`'s memory.router.min_version check) otherwise hangs
  // on `readStdin()` until the 5s probe budget expires.
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  const raw = await readStdin();
  const input: HookInput = raw ? (JSON.parse(raw) as HookInput) : {};

  const memoryDir = process.env.MEMORY_ROUTER_DIR;
  if (!memoryDir) {
    // Silent no-op: an unconfigured router must never add context noise.
    return;
  }

  const memories = loadMemoriesFromDir(memoryDir);
  const ctx: RouterContext = { prompt: input.prompt, cwd: input.cwd, memoryDir };

  // mm-v1-T004: resolveBlended runs the semantic search unconditionally
  // (whenever an index + provider are available) and blends it with the
  // Topic Gate as a boost rather than gating the semantic path behind
  // "sync gates were silent" — that shadowing was the reason the semantic
  // path almost never ran in practice (a Topic Gate hit's flat 1.0 score
  // pre-empted it on nearly every real prompt). resolveBlended already
  // degrades internally to topic/recency/type-only scoring on a
  // semantic-search failure (see src/router.ts) and never throws for that
  // case; this try/catch is the outer defensive layer so the hook can
  // never block the prompt over ANY unexpected resolution failure.
  let allHits: GateHit[] = [];
  try {
    allHits = await resolveBlended(ctx, memories, memoryDir);
  } catch (err: unknown) {
    process.stderr.write(
      `memory-router: memory resolution failed, no context injected: ${String(err)}\n`,
    );
  }

  const additionalContext = renderHitsAsContext(allHits);
  if (!additionalContext) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    })}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `memory-router user-prompt-submit failed: ${String(err)}\n`,
  );
  process.exit(1);
});
