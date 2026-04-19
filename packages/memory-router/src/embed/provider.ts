// Minimal OpenAI embeddings client. We deliberately skip LangChain — this
// package only needs a single endpoint with no streaming, batching beyond
// what the OpenAI API natively accepts, or multi-provider adapters. If an
// Ollama path is ever needed, it's ~20 LOC to swap the URL + auth.

interface OpenAIEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
}

interface EmbedOptions {
  apiKey: string;
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
  const res = await fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
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
  // OpenAI returns `data[]` in the same order as `input[]` but we sort by
  // index defensively so a future spec change can't silently misalign.
  return json.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

function resolveProviderConfig(): ProviderConfig | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    model: process.env.MEMORY_ROUTER_EMBED_MODEL ?? 'text-embedding-3-small',
    baseUrl: process.env.OPENAI_BASE_URL,
  };
}

module.exports = { embedBatch, resolveProviderConfig };
