#!/usr/bin/env node
const { loadMemoriesFromDir } = require('../memory/loader');
const { resolve, resolveConfidence, dedupeAndRank } = require('../router');
const { renderHitsAsContext } = require('../render');
const { readStdin } = require('./io');

// Single source of truth for the version reported by the `--version` CLI
// short-circuit. Bump alongside package.json on release; the
// cli-version test asserts they stay in sync.
const PACKAGE_VERSION = '0.3.0';

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
  const ctx: RouterContext = { prompt: input.prompt, cwd: input.cwd };

  // Sync gates first (topic, tool) — cheap, deterministic.
  const syncHits: GateHit[] = resolve(ctx, memories);

  // Confidence gate is async (hits OpenAI embeddings API). Run only when
  // the sync gates didn't already cover the prompt, to keep latency low
  // and avoid redundant context when a deterministic gate already fired.
  let allHits: GateHit[] = syncHits;
  if (syncHits.length === 0) {
    try {
      const semHits: GateHit[] = await resolveConfidence(ctx, memories, memoryDir);
      allHits = dedupeAndRank([...syncHits, ...semHits], 5);
    } catch (err: unknown) {
      // Never let a semantic-search failure block the prompt — log and fall
      // back to the sync hits.
      process.stderr.write(
        `memory-router: semantic search failed, falling back: ${String(err)}\n`,
      );
    }
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
