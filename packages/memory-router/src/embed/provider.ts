// Minimal embeddings client for the two providers this package supports.
// We deliberately skip LangChain — this package only needs a single
// endpoint with no streaming or batching beyond what the APIs natively
// accept, and both providers speak the same OpenAI-shaped
// `/v1/embeddings` request/response contract (Ollama serves it directly,
// no translation layer needed).

interface OpenAIEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
}

interface EmbedOptions {
  // Empty string (or omitted) for Ollama: its `/v1/embeddings` endpoint
  // takes no auth. embedBatch only sends an Authorization header when this
  // is truthy.
  apiKey?: string;
  model: string;
  baseUrl?: string;
  inputs: string[];
  timeoutMs?: number;
}

// 5 s is plenty for a single embed call on healthy networks and bounds the
// hook's worst-case prompt latency. Index rebuilds use the same timeout per
// batch (64 inputs) which is the larger call.
const DEFAULT_TIMEOUT_MS = 5000;

async function embedBatch(opts: EmbedOptions): Promise<number[][]> {
  const base = (opts.baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: opts.model, input: opts.inputs }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(
      `embedding request failed: ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as OpenAIEmbeddingResponse;
  // Both providers return `data[]` in the same order as `input[]` but we
  // sort by index defensively so a future spec change can't silently
  // misalign either provider's response.
  return json.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

type ProviderName = 'openai' | 'ollama';

interface ProviderConfig {
  provider: ProviderName;
  // '' for ollama (no auth on its /v1/embeddings endpoint).
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const OPENAI_DEFAULT_MODEL = 'text-embedding-3-small';
const OLLAMA_DEFAULT_MODEL = 'nomic-embed-text';
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

function normalizeProviderName(
  raw: string | undefined,
): ProviderName | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === 'openai' || v === 'ollama') return v;
  // Unset or an unrecognized value (typo, etc.) is treated the same as
  // "no explicit choice" rather than throwing — resolveProviderConfig()
  // must stay a plain sync function with no I/O side effects (its two
  // callsites outside embed/, src/lint/conflicts.ts and src/eval/runner.ts,
  // call it unconditionally on every invocation and don't expect it to
  // throw), so a typo silently falls through to auto-detect instead of
  // taking down those paths.
  return undefined;
}

function buildOpenAIConfig(apiKey: string): ProviderConfig {
  return {
    provider: 'openai',
    apiKey,
    model: process.env.MEMORY_ROUTER_EMBED_MODEL ?? OPENAI_DEFAULT_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL,
  };
}

function buildOllamaConfig(): ProviderConfig {
  return {
    provider: 'ollama',
    apiKey: '',
    model: process.env.MEMORY_ROUTER_EMBED_MODEL ?? OLLAMA_DEFAULT_MODEL,
    baseUrl:
      process.env.MEMORY_ROUTER_OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL,
  };
}

interface ResolveProviderConfigOptions {
  // When true, a fully-implicit resolution (no MEMORY_ROUTER_EMBED_PROVIDER,
  // no OPENAI_API_KEY) falls back to an optimistic, unprobed local Ollama
  // config instead of returning null.
  //
  // Defaults to false. This function has two pre-existing SYNCHRONOUS
  // callsites outside embed/ — src/lint/conflicts.ts:439 and
  // src/eval/runner.ts:106 — both call `resolveProviderConfig()` with no
  // arguments and treat `!== null` as an availability signal. A real
  // reachability probe for Ollama would require an async fetch, which this
  // function's sync contract can't accommodate; defaulting the fallback to
  // off instead means those two callsites see byte-identical behavior to
  // before this change (their own test suites, tests/lint-conflicts.test.ts
  // and tests/eval-runner.test.ts, prove it by running unmodified).
  //
  // Only src/embed/indexer.ts (rebuildIndex, semanticSearch) opts in via
  // `resolveProviderConfig({ autoDetectOllama: true })`, since letting the
  // semantic path live on a machine with no OpenAI key is this feature's
  // whole point. An Ollama daemon that turns out not to be running degrades
  // at the actual embed call (embedBatch's fetch throws), exactly like an
  // unreachable OpenAI endpoint already does today — the hook and `test
  // --semantic` CLI paths already wrap that call in try/catch and fail
  // open; `index` and `lint --semantic` already surface a fetch failure as
  // a hard error today when OPENAI_API_KEY is set but unreachable, so nothing
  // about that failure *shape* is new, only which provider can trigger it.
  autoDetectOllama?: boolean;
}

function resolveProviderConfig(
  opts: ResolveProviderConfigOptions = {},
): ProviderConfig | null {
  const explicit = normalizeProviderName(
    process.env.MEMORY_ROUTER_EMBED_PROVIDER,
  );

  if (explicit === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    // Explicit choice wins, but there's nothing to authenticate with — this
    // is a misconfiguration to fix, not a cue to silently substitute
    // Ollama. Same shape as today's "no key -> null" fail-open contract.
    if (!apiKey) return null;
    return buildOpenAIConfig(apiKey);
  }
  if (explicit === 'ollama') {
    return buildOllamaConfig();
  }

  // No explicit (or an unrecognized) provider: auto-detect.
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) return buildOpenAIConfig(apiKey);
  if (opts.autoDetectOllama) return buildOllamaConfig();
  return null;
}

module.exports = { embedBatch, resolveProviderConfig };
