const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const INDEXER_PATH = require.resolve("../src/embed/indexer");
const FIXTURES_DIR = path.join(__dirname, "fixtures", "memories");
const DIMS = 1536;
const MODEL_OLD = "text-embedding-3-small";
const MODEL_NEW = "text-embedding-3-large";

// indexer.ts keeps its once-per-process warning flags at module level. Each
// case loads a fresh copy of the module so no case depends on which ran
// before it (or on another case having already set a flag).
function freshIndexer(): {
  rebuildIndex: (dir: string) => Promise<unknown>;
  semanticSearch: (
    prompt: string,
    memories: unknown[],
    dir: string,
    k: number,
  ) => Promise<unknown[]>;
} {
  delete require.cache[INDEXER_PATH];
  return require("../src/embed/indexer");
}

function tmpMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-router-stale-"));
  for (const f of fs.readdirSync(FIXTURES_DIR)) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(dir, f));
  }
  return dir;
}

function stubFetch(): () => void {
  const orig = (globalThis as { fetch?: typeof fetch }).fetch;
  let seed = 1;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { body?: string },
  ) => {
    const body = JSON.parse(init?.body ?? "{}") as { input: string[] };
    const data = body.input.map((_t, idx) => ({
      embedding: Array.from(
        { length: DIMS },
        (_v, i) => ((seed + idx + i) % 7) / 7,
      ),
      index: idx,
    }));
    seed += body.input.length;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ data }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => {
    if (orig) (globalThis as { fetch: typeof fetch }).fetch = orig;
  };
}

async function withEnvAndStderr(
  fn: (setModel: (m: string) => void, stderr: () => string) => Promise<void>,
): Promise<void> {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevModel = process.env.MEMORY_ROUTER_EMBED_MODEL;
  const prevProvider = process.env.MEMORY_ROUTER_EMBED_PROVIDER;
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.MEMORY_ROUTER_EMBED_PROVIDER = "openai";
  process.env.MEMORY_ROUTER_EMBED_MODEL = MODEL_OLD;
  const restoreFetch = stubFetch();
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as unknown as { write: typeof origWrite }).write = ((
    chunk: string | Uint8Array,
  ) => {
    captured += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof origWrite;
  try {
    await fn(
      (m) => {
        process.env.MEMORY_ROUTER_EMBED_MODEL = m;
      },
      () => captured,
    );
  } finally {
    process.stderr.write = origWrite;
    restoreFetch();
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("OPENAI_API_KEY", prevKey);
    restore("MEMORY_ROUTER_EMBED_MODEL", prevModel);
    restore("MEMORY_ROUTER_EMBED_PROVIDER", prevProvider);
  }
}

function count(haystack: string, re: RegExp): number {
  return (haystack.match(re) ?? []).length;
}

const STALE_RE =
  /embedding index has \d+ entr\(y\/ies\) under a different model than/g;
const MISSING_RE = /embedding index missing/g;

test("stale-model warning is written once per process across repeated semanticSearch calls", async () => {
  const dir = tmpMemoryDir();
  try {
    await withEnvAndStderr(async (setModel, stderr) => {
      const { rebuildIndex, semanticSearch } = freshIndexer();
      await rebuildIndex(dir);
      setModel(MODEL_NEW);
      await semanticSearch("first query", [], dir, 5);
      await semanticSearch("second query", [], dir, 5);
      await semanticSearch("third query", [], dir, 5);
      assert.equal(count(stderr(), STALE_RE), 1);
      assert.match(
        stderr(),
        new RegExp(
          `under a different model than '${MODEL_NEW}'; run .memory-router index <dir>. to rebuild\\.`,
        ),
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a search over a clean index never sets the stale flag: a later stale call still warns, once", async () => {
  const dir = tmpMemoryDir();
  try {
    await withEnvAndStderr(async (setModel, stderr) => {
      const { rebuildIndex, semanticSearch } = freshIndexer();
      await rebuildIndex(dir);
      await semanticSearch("clean query one", [], dir, 5);
      await semanticSearch("clean query two", [], dir, 5);
      assert.equal(count(stderr(), STALE_RE), 0, "no stale rows, no warning");
      setModel(MODEL_NEW);
      await semanticSearch("stale query one", [], dir, 5);
      await semanticSearch("stale query two", [], dir, 5);
      assert.equal(count(stderr(), STALE_RE), 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing-index warning is unchanged: once per process, and never mixed with the stale warning", async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "memory-router-stale-missing-"),
  );
  try {
    await withEnvAndStderr(async (_setModel, stderr) => {
      const { semanticSearch } = freshIndexer();
      await semanticSearch("q1", [], dir, 5);
      await semanticSearch("q2", [], dir, 5);
      assert.equal(count(stderr(), MISSING_RE), 1);
      assert.equal(count(stderr(), STALE_RE), 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the stale and missing-index flags are independent: each warning appears once in the same process, in either order", async () => {
  const indexed = tmpMemoryDir();
  const empty = fs.mkdtempSync(
    path.join(os.tmpdir(), "memory-router-stale-missing-"),
  );
  try {
    for (const staleFirst of [true, false]) {
      await withEnvAndStderr(async (setModel, stderr) => {
        const { rebuildIndex, semanticSearch } = freshIndexer();
        setModel(MODEL_OLD);
        await rebuildIndex(indexed);
        setModel(MODEL_NEW);
        const stale = () => semanticSearch("stale query", [], indexed, 5);
        const missing = () => semanticSearch("missing query", [], empty, 5);
        if (staleFirst) {
          await stale();
          await missing();
        } else {
          await missing();
          await stale();
        }
        await stale();
        await missing();
        assert.equal(count(stderr(), STALE_RE), 1, `staleFirst=${staleFirst}`);
        assert.equal(
          count(stderr(), MISSING_RE),
          1,
          `staleFirst=${staleFirst}`,
        );
      });
    }
  } finally {
    fs.rmSync(indexed, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
