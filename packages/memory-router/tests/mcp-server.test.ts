const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const fixturesDir = path.join(__dirname, 'fixtures', 'memories');
const serverBin = path.join(__dirname, '..', 'dist', 'mcp', 'server.js');

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

/**
 * Spin up the compiled MCP stdio server, run a short JSON-RPC exchange,
 * then shut it down. Returns every response keyed by request id.
 *
 * Matches the handshake every MCP client does: initialize → initialized
 * notification → tool calls.
 */
const SESSION_TIMEOUT_MS = process.env.CI ? 15_000 : 5_000;

async function runRpcSession(
  requests: JsonRpcRequest[],
  env: Record<string, string> = {},
): Promise<{ responses: Map<number | string, unknown>; stderr: string }> {
  const proc = spawn('node', [serverBin], {
    env: { ...process.env, MEMORY_ROUTER_DIR: fixturesDir, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = new Map<number | string, unknown>();
  let stdoutBuf = '';
  let stderrBuf = '';

  function parseStdout(raw: string): void {
    stdoutBuf += raw;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    }
  }

  proc.stdout.on('data', (chunk: Buffer) => parseStdout(chunk.toString('utf8')));
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  const exchange = new Promise<void>((resolvePromise) => {
    proc.on('exit', () => resolvePromise());
  });

  for (const req of requests) {
    proc.stdin.write(`${JSON.stringify(req)}\n`);
    // Small yield so the server orders responses deterministically.
    await new Promise((r) => setTimeout(r, 30));
  }

  proc.stdin.end();
  await Promise.race([
    exchange,
    new Promise<void>((r) => setTimeout(r, SESSION_TIMEOUT_MS)),
  ]);
  // Flush any trailing line without a newline before killing.
  if (stdoutBuf.trim()) parseStdout('\n');
  proc.kill();
  return { responses, stderr: stderrBuf };
}

function expectResponse<T>(
  session: { responses: Map<number | string, unknown>; stderr: string },
  id: number | string,
): T {
  const res = session.responses.get(id);
  if (res === undefined) {
    throw new Error(
      `no response for id=${id}; stderr was:\n${session.stderr || '(empty)'}`,
    );
  }
  return res as T;
}

const initialize: JsonRpcRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-server-test', version: '1.0' },
  },
};

const initialized: JsonRpcRequest = {
  jsonrpc: '2.0',
  method: 'notifications/initialized',
  params: {},
};

test('lists all three tools', async () => {
  const session = await runRpcSession([
    initialize,
    initialized,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  const list = expectResponse<{ result: { tools: { name: string }[] } }>(session, 2);
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['memory_apply', 'memory_resolve', 'memory_search']);
});

test('memory_apply returns the full body for a known id', async () => {
  const session = await runRpcSession([
    initialize,
    initialized,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'memory_apply',
        arguments: { id: 'feedback_force_push' },
      },
    },
  ]);
  const call = expectResponse<{
    result: { content: { type: string; text: string }[] };
  }>(session, 2);
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.id, 'feedback_force_push');
  assert.equal(payload.frontmatter.type, 'feedback');
  assert.ok(payload.body.length > 0, 'body should not be empty');
});

test('memory_apply accepts a filename with .md suffix', async () => {
  const session = await runRpcSession([
    initialize,
    initialized,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'memory_apply',
        arguments: { id: 'feedback_force_push.md' },
      },
    },
  ]);
  const call = expectResponse<{
    result: { content: { text: string }[] };
  }>(session, 2);
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.id, 'feedback_force_push');
});

test('memory_apply returns isError for a missing id', async () => {
  const session = await runRpcSession([
    initialize,
    initialized,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'memory_apply',
        arguments: { id: 'does_not_exist' },
      },
    },
  ]);
  const call = expectResponse<{
    result: { content: unknown[]; isError?: boolean };
  }>(session, 2);
  assert.equal(call.result.isError, true);
});

test('memory_resolve hits the topic gate for a "force push" prompt', async () => {
  const session = await runRpcSession([
    initialize,
    initialized,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'memory_resolve',
        arguments: { prompt: 'merge PR 42' },
      },
    },
  ]);
  const call = expectResponse<{ result: { content: { text: string }[] } }>(session, 2);
  const payload = JSON.parse(call.result.content[0].text);
  const ids = (payload.hits as { id: string }[]).map((h) => h.id);
  assert.ok(
    ids.includes('feedback_stacked_pr'),
    `expected feedback_stacked_pr in hits, got ${ids.join(', ')}`,
  );
});

test('memory_search returns an empty list when OPENAI_API_KEY is missing', async () => {
  const session = await runRpcSession(
    [
      initialize,
      initialized,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'memory_search',
          arguments: { query: 'anything' },
        },
      },
    ],
    { OPENAI_API_KEY: '' },
  );
  const call = expectResponse<{ result: { content: { text: string }[] } }>(session, 2);
  const payload = JSON.parse(call.result.content[0].text);
  assert.deepEqual(payload, { hits: [] });
});
