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
// hook's worst-case prompt latency — the hook must never block a prompt for
// long, so this stays deliberately tight. See INDEX_DEFAULT_TIMEOUT_MS below
// for why the index-rebuild path needs a much larger budget instead of
// reusing this one.
const DEFAULT_TIMEOUT_MS = 5000;

// Index rebuilds have no prompt to block, so they can afford to wait: a real
// 64-input batch against Ollama measured roughly 3.5-10 s warm and 11-17 s
// for the first batch after a cold model load (reliably the slowest) on the
// mm-v1-T008 reference corpus, so this budget must clear that cold worst
// case with margin, not just the typical case.
const INDEX_DEFAULT_TIMEOUT_MS = 60_000;

// Shared guard for every timeout env var below. Mirrors
// src/gates/confidence.ts's recencyHalfLifeDays guard (a duration-shaped
// value must be strictly positive to mean anything) rather than that
// file's envFloat (which allows 0 for a weight/boost, a shape where 0 is a
// meaningful "off"). Unset, empty, non-numeric, zero, and negative all
// resolve to `undefined` (caller decides the fallback). The value must
// also be an integer no larger than 2147483647: AbortSignal.timeout throws
// RangeError on fractional or > uint32 delays, and Node's 32-bit timer
// silently overflows anything above 2^31-1 to an effective 1 ms budget, so
// those values would defeat the guard's whole purpose on the hook path.
function parseTimeoutOverride(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647
    ? parsed
    : undefined;
}

// Env override for both DEFAULT_TIMEOUT_MS and INDEX_DEFAULT_TIMEOUT_MS.
function resolveEmbedTimeoutMs(fallback: number): number {
  return parseTimeoutOverride(process.env.MEMORY_ROUTER_EMBED_TIMEOUT_MS) ?? fallback;
}

// Hook-only env override, precedence over the shared
// MEMORY_ROUTER_EMBED_TIMEOUT_MS knob above. b1bbbf68: a persistent
// MEMORY_ROUTER_EMBED_TIMEOUT_MS export (shell profile) meant to give
// `memory-router index` more headroom otherwise also raised the hook's
// per-prompt budget by the same amount, and the hook (UserPromptSubmit)
// must never block a prompt for long — see README "Timeout budgets" for
// the coupling this decouples. Only src/embed/indexer.ts's semanticSearch
// consults this; rebuildIndex (the index-rebuild path) never reads it.
function resolveHookEmbedTimeoutMs(): number {
  // Precedence: hook-specific override, then the shared override, then the
  // 5s hook default.
  return (
    parseTimeoutOverride(process.env.MEMORY_ROUTER_HOOK_EMBED_TIMEOUT_MS) ??
    resolveEmbedTimeoutMs(DEFAULT_TIMEOUT_MS)
  );
}

async function embedBatch(opts: EmbedOptions): Promise<number[][]> {
  const base = (opts.baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? resolveEmbedTimeoutMs(DEFAULT_TIMEOUT_MS);
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

// `explicit`: the caller asked for Ollama by name
// (MEMORY_ROUTER_EMBED_PROVIDER=ollama), a deliberate choice, so the
// generic MEMORY_ROUTER_EMBED_MODEL override keeps applying exactly as it
// always has. `auto-detect`: nothing was asked for explicitly, this is a
// fallback the caller opted into via autoDetectOllama, and a
// MEMORY_ROUTER_EMBED_MODEL left over in the environment was almost
// certainly set for OpenAI (the far more common case) and would silently
// misroute the auto-detected Ollama call to a model name Ollama doesn't
// have, so the generic var is deliberately NOT consulted on this path.
// MEMORY_ROUTER_OLLAMA_EMBED_MODEL is the Ollama-specific override for
// exactly this path; see README "Embedding provider" for the precedence
// table.
function buildOllamaConfig(source: 'explicit' | 'auto-detect'): ProviderConfig {
  const model =
    source === 'explicit'
      ? (process.env.MEMORY_ROUTER_EMBED_MODEL ?? OLLAMA_DEFAULT_MODEL)
      : (process.env.MEMORY_ROUTER_OLLAMA_EMBED_MODEL ?? OLLAMA_DEFAULT_MODEL);
  return {
    provider: 'ollama',
    apiKey: '',
    model,
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
    return buildOllamaConfig('explicit');
  }

  // No explicit (or an unrecognized) provider: auto-detect.
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) return buildOpenAIConfig(apiKey);
  if (opts.autoDetectOllama) return buildOllamaConfig('auto-detect');
  return null;
}

module.exports = {
  embedBatch,
  resolveProviderConfig,
  resolveEmbedTimeoutMs,
  resolveHookEmbedTimeoutMs,
  DEFAULT_TIMEOUT_MS,
  INDEX_DEFAULT_TIMEOUT_MS,
};
