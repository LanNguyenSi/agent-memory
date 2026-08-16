const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeAmbiguity,
  confidenceThreshold,
  resolveDefaultMinSemanticScore,
  loadBlendWeights,
} = require('../src/gates/confidence');

test('low ambiguity: specific prompt with path + noun', () => {
  const a = computeAmbiguity('fix Tippfehler in foo.ts:12');
  assert.ok(a <= 0.4, `expected low ambiguity, got ${a}`);
  const t = confidenceThreshold(a);
  assert.ok(t >= 0.7, `expected high threshold, got ${t}`);
});

test('high ambiguity: vague verb, no path, no noun', () => {
  const a = computeAmbiguity('kannst du mal schauen');
  assert.ok(a >= 0.8, `expected high ambiguity, got ${a}`);
  const t = confidenceThreshold(a);
  assert.ok(t <= 0.6, `expected low threshold, got ${t}`);
});

test('confidenceThreshold is clamped to [0, 0.85]', () => {
  assert.equal(confidenceThreshold(0), 0.85);
  assert.equal(confidenceThreshold(1), 0.5);
  assert.equal(confidenceThreshold(10), 0);
});

// --- Model-conditional relevance floor default (agent-tasks 3ef3ded3) -----
//
// resolveDefaultMinSemanticScore() / loadBlendWeights().minSemanticScore's
// un-overridden value depends on the resolved embedding provider/model
// (operator decision: map {bge-m3: 0.78} + provider fallback, openai
// unchanged at 0.5; see README "Calibration" and
// src/gates/confidence.ts). Every test below saves and restores the full
// set of env vars resolveProviderConfig() consults (mirrors
// tests/embed-multi-provider.test.ts's ENV_KEYS/withEnv pattern) so this
// file stays hermetic against whatever embedding-provider env happens to
// be ambient on the host running `npm test`.

const FLOOR_ENV_KEYS = [
  'OPENAI_API_KEY',
  'MEMORY_ROUTER_EMBED_PROVIDER',
  'MEMORY_ROUTER_EMBED_MODEL',
  'MEMORY_ROUTER_OLLAMA_EMBED_MODEL',
  'MEMORY_ROUTER_BLEND_MIN_SEMANTIC',
] as const;

function withFloorEnv(
  vars: Partial<Record<(typeof FLOOR_ENV_KEYS)[number], string>>,
  fn: () => void,
): void {
  const prev: Partial<Record<(typeof FLOOR_ENV_KEYS)[number], string | undefined>> = {};
  for (const key of FLOOR_ENV_KEYS) prev[key] = process.env[key];
  for (const key of FLOOR_ENV_KEYS) {
    if (key in vars && vars[key] !== undefined) process.env[key] = vars[key];
    else delete process.env[key];
  }
  try {
    fn();
  } finally {
    for (const key of FLOOR_ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test('resolveDefaultMinSemanticScore: explicit ollama, bge-m3 -> 0.78 (calibrated, mm-v1-T008 reference corpus)', () => {
  withFloorEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'ollama', MEMORY_ROUTER_EMBED_MODEL: 'bge-m3' },
    () => {
      assert.equal(resolveDefaultMinSemanticScore(), 0.78);
    },
  );
});

test('resolveDefaultMinSemanticScore: model-name normalization — bge-m3:latest matches the bare bge-m3 entry', () => {
  withFloorEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'ollama', MEMORY_ROUTER_EMBED_MODEL: 'bge-m3:latest' },
    () => {
      assert.equal(resolveDefaultMinSemanticScore(), 0.78);
    },
  );
});

test('resolveDefaultMinSemanticScore: model-name normalization — a quantization/size tag (bge-m3:567m) still matches the bge-m3 entry', () => {
  withFloorEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'ollama', MEMORY_ROUTER_EMBED_MODEL: 'bge-m3:567m' },
    () => {
      assert.equal(resolveDefaultMinSemanticScore(), 0.78);
    },
  );
});

test('resolveDefaultMinSemanticScore: model-name normalization is case-insensitive and trims whitespace', () => {
  withFloorEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'ollama', MEMORY_ROUTER_EMBED_MODEL: '  BGE-M3:LATEST  ' },
    () => {
      assert.equal(resolveDefaultMinSemanticScore(), 0.78);
    },
  );
});

test('resolveDefaultMinSemanticScore: an unknown Ollama model falls back to the provider default (0.78), not the openai default', () => {
  withFloorEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'ollama', MEMORY_ROUTER_EMBED_MODEL: 'llama3' },
    () => {
      assert.equal(resolveDefaultMinSemanticScore(), 0.78);
    },
  );
});

test("resolveDefaultMinSemanticScore: Ollama's own default model (nomic-embed-text, no override) also falls back to the provider default (0.78) — a deliberately conservative choice, not a specific calibration (see README)", () => {
  withFloorEnv({ MEMORY_ROUTER_EMBED_PROVIDER: 'ollama' }, () => {
    assert.equal(resolveDefaultMinSemanticScore(), 0.78);
  });
});

test('resolveDefaultMinSemanticScore: explicit openai with an API key -> 0.5, unchanged from the pre-existing flat default', () => {
  withFloorEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-not-real' },
    () => {
      assert.equal(resolveDefaultMinSemanticScore(), 0.5);
    },
  );
});

test('resolveDefaultMinSemanticScore: explicit openai without an API key (misconfigured, resolveProviderConfig -> null) -> 0.5, not the ollama fallback', () => {
  withFloorEnv({ MEMORY_ROUTER_EMBED_PROVIDER: 'openai' }, () => {
    assert.equal(resolveDefaultMinSemanticScore(), 0.5);
  });
});

test('resolveDefaultMinSemanticScore: no explicit provider, OPENAI_API_KEY present (auto-detect openai) -> 0.5', () => {
  withFloorEnv({ OPENAI_API_KEY: 'sk-test-not-real' }, () => {
    assert.equal(resolveDefaultMinSemanticScore(), 0.5);
  });
});

test('resolveDefaultMinSemanticScore: no explicit provider, no OPENAI_API_KEY (auto-detect ollama, the real hook default on a machine with no OpenAI key) -> 0.78', () => {
  withFloorEnv({ MEMORY_ROUTER_OLLAMA_EMBED_MODEL: 'bge-m3' }, () => {
    assert.equal(resolveDefaultMinSemanticScore(), 0.78);
  });
});

test('loadBlendWeights: an explicit MEMORY_ROUTER_BLEND_MIN_SEMANTIC override always wins over the ollama/bge-m3 conditional default', () => {
  withFloorEnv(
    {
      MEMORY_ROUTER_EMBED_PROVIDER: 'ollama',
      MEMORY_ROUTER_EMBED_MODEL: 'bge-m3',
      MEMORY_ROUTER_BLEND_MIN_SEMANTIC: '0.33',
    },
    () => {
      assert.equal(loadBlendWeights().minSemanticScore, 0.33);
    },
  );
});

test('loadBlendWeights: an explicit MEMORY_ROUTER_BLEND_MIN_SEMANTIC override always wins over the openai conditional default', () => {
  withFloorEnv(
    {
      MEMORY_ROUTER_EMBED_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test-not-real',
      MEMORY_ROUTER_BLEND_MIN_SEMANTIC: '0.91',
    },
    () => {
      assert.equal(loadBlendWeights().minSemanticScore, 0.91);
    },
  );
});

test('loadBlendWeights: with no override, minSemanticScore resolves through the same conditional default (ollama/bge-m3 -> 0.78)', () => {
  withFloorEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'ollama', MEMORY_ROUTER_EMBED_MODEL: 'bge-m3' },
    () => {
      assert.equal(loadBlendWeights().minSemanticScore, 0.78);
    },
  );
});

test('loadBlendWeights: with no override, minSemanticScore resolves through the same conditional default (openai -> 0.5)', () => {
  withFloorEnv(
    { MEMORY_ROUTER_EMBED_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-not-real' },
    () => {
      assert.equal(loadBlendWeights().minSemanticScore, 0.5);
    },
  );
});
