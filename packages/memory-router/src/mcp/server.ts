#!/usr/bin/env node
/**
 * MCP stdio server for memory-router.
 *
 * The UserPromptSubmit hook already auto-injects matching memories on every
 * prompt; this server exposes the same machinery as explicit tools so an
 * agent can *query* imperatively:
 *   - memory_search: raw semantic hits for a query string
 *   - memory_resolve: full router (topic + tool + confidence) on a prompt/context
 *   - memory_apply: fetch a single memory's full body by id
 *
 * Transport is stdio — register as a Claude Code MCP server in `.mcp.json`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Runtime sources (loader, router, indexer) use CJS `module.exports`;
// `require()` keeps call sites identical to the hooks at src/hooks/*.
const { loadMemoriesFromDir } = require('../memory/loader');
const { resolve, resolveConfidence, dedupeAndRank } = require('../router');
const { semanticSearch } = require('../embed/indexer');

const SERVER_NAME = 'memory-router';
const SERVER_VERSION = '0.1.0';

function requireMemoryDir(): string {
  const dir = process.env.MEMORY_ROUTER_DIR;
  if (!dir) {
    throw new Error(
      'MEMORY_ROUTER_DIR env var must be set to the memory directory path (e.g. ~/.claude/projects/<slug>/memory)',
    );
  }
  return dir;
}

function hitSummary(memory: Memory): {
  id: string;
  name: string;
  description: string;
  path: string;
} {
  return {
    id: memory.id,
    name: memory.frontmatter.name,
    description: memory.frontmatter.description ?? '',
    path: memory.path,
  };
}

function textResult(payload: unknown): {
  content: { type: 'text'; text: string }[];
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

server.registerTool(
  'memory_search',
  {
    description:
      'Raw semantic search over memories in MEMORY_ROUTER_DIR. Returns top-k hits from the sqlite-vec index as JSON. Returns an empty list if the index is missing or OPENAI_API_KEY is not set — call `memory-router index <dir>` to build the index. Use this when you want to check "is there a memory about X" without firing the full gate stack.',
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe('Natural-language query; embedded and matched against the index'),
      k: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Max hits to return (default 5)'),
    },
  },
  async ({ query, k }) => {
    const memoryDir = requireMemoryDir();
    const memories: Memory[] = loadMemoriesFromDir(memoryDir);
    const maxHits = k ?? 5;
    const matches: { memory: Memory; score: number }[] = await semanticSearch(
      query,
      memories,
      memoryDir,
      maxHits,
    );
    const hits = matches.map((m) => ({ ...hitSummary(m.memory), score: m.score }));
    return textResult({ hits });
  },
);

server.registerTool(
  'memory_resolve',
  {
    description:
      'Run the full router (topic gate + tool gate + confidence gate) and return the memories that would have been auto-injected for this prompt/context. Same hit shape as the UserPromptSubmit hook. Confidence gate is only invoked when the deterministic gates return no hits, matching the hook behavior.',
    inputSchema: {
      prompt: z.string().describe('The user prompt to resolve memories against'),
      cwd: z.string().optional().describe('Working directory, for gates that need it'),
      tool: z
        .object({
          name: z.string(),
          args: z.record(z.string(), z.unknown()).optional(),
        })
        .optional()
        .describe(
          'Optional tool-call context for the tool gate. For Bash, pass args={command:"..."} — the tool gate matches on command_pattern regexes. For other tools, pass the raw Claude-Code tool input; the tool gate reads `tools` (tool-name list) from the memory frontmatter and matches `name` directly.',
        ),
    },
  },
  async ({ prompt, cwd, tool }) => {
    const memoryDir = requireMemoryDir();
    const memories: Memory[] = loadMemoriesFromDir(memoryDir);
    const ctx: RouterContext = {
      prompt,
      cwd,
      tool: tool
        ? { name: tool.name, args: (tool.args ?? {}) as Record<string, unknown> }
        : undefined,
    };

    const syncHits: GateHit[] = resolve(ctx, memories);
    let all: GateHit[] = syncHits;
    if (syncHits.length === 0) {
      try {
        // Matches the hook: resolveConfidence itself no-ops on empty prompt.
        const semHits: GateHit[] = await resolveConfidence(ctx, memories, memoryDir);
        all = dedupeAndRank([...syncHits, ...semHits], 5);
      } catch (err: unknown) {
        // Never fail the call on a semantic-search error; fall back to sync hits.
        // Log so operators can see index/API failures.
        process.stderr.write(
          `memory-router MCP: semantic search failed, falling back: ${String(err)}\n`,
        );
      }
    }

    const hits = all.map((h) => ({
      ...hitSummary(h.memory),
      gate: h.gate,
      score: h.score,
      reason: h.reason,
    }));
    return textResult({ hits });
  },
);

server.registerTool(
  'memory_apply',
  {
    description:
      'Fetch the full body of a single memory by id. Id is the filename without extension (e.g. "feedback_review_briefing"). Use after memory_search / memory_resolve to read a memory that looked relevant in the metadata.',
    inputSchema: {
      id: z.string().min(1).describe('Memory id — filename without extension'),
    },
  },
  async ({ id }) => {
    const memoryDir = requireMemoryDir();
    const memories: Memory[] = loadMemoriesFromDir(memoryDir);
    // Lenient: accept `foo.md` alongside the canonical `foo`.
    const normalized = id.replace(/\.md$/i, '');
    const memory = memories.find((m: Memory) => m.id === normalized);
    if (!memory) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: 'not_found', id: normalized }) },
        ],
        isError: true,
      };
    }
    return textResult({
      id: memory.id,
      path: memory.path,
      frontmatter: memory.frontmatter,
      body: memory.body,
    });
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`memory-router MCP server failed: ${String(err)}\n`);
  process.exit(1);
});
