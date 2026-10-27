// Smoke test for the `memory-router eval <golden.yml>` CLI verb: confirms
// the verb is registered and wired to the fixture --dir / $MEMORY_ROUTER_DIR
// resolution, --json emits parseable output, and error paths (missing
// golden file, missing corpus dir, missing golden positional, missing
// --dir/env) exit non-zero with a clear stderr message while an
// error-free run exits 0 regardless of the metric values (report, not a
// gate — see acceptance criteria). Mirrors the style of cli-test.test.ts
// (the `test` verb's own CLI smoke test).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BIN = path.join(__dirname, "..", "dist", "cli.js");
const CORPUS_DIR = path.join(__dirname, "fixtures", "eval", "corpus");
const GOLDEN_PATH = path.join(__dirname, "fixtures", "eval", "golden.yml");

function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 8_000,
    env: { ...process.env, ...env },
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("eval: exits 0 on an error-free run and prints the aggregate summary", () => {
  const { status, stdout } = run(["eval", GOLDEN_PATH, "--dir", CORPUS_DIR]);
  assert.equal(status, 0, `expected exit 0; stdout was:\n${stdout}`);
  assert.match(stdout, /golden: /);
  assert.match(stdout, /corpus: .*\(4 memories\)/);
  assert.match(stdout, /semantic path: inactive/);
  assert.match(stdout, /vocabulary: built-in default/);
  // No index is built for the fixture corpus, so the semantic gate cannot
  // have won a slot for any of the 6 prompts.
  assert.match(stdout, /semantic contributed: 0\/6 prompts/);
  assert.match(stdout, /keyword contributed: 0\/6 prompts/);
  assert.match(stdout, /precision=0\.750 recall=0\.625 mrr=0\.750\s+\(n=4\)/);
  assert.match(stdout, /negative controls: 1\/2 passed/);
  // Fixture golden.yml deliberately labels one prompt with a phantom id
  // (feedback_never_fires_phantom, negative-control for recall<1) that
  // never resolves against the fixture corpus — it must surface here.
  assert.match(
    stdout,
    /WARNING: golden file references 1 expect id\(s\) not found in the corpus.*feedback_never_fires_phantom/,
  );
});

test("eval --json emits valid, parseable JSON matching the documented schema", () => {
  const { status, stdout } = run([
    "eval",
    GOLDEN_PATH,
    "--dir",
    CORPUS_DIR,
    "--json",
  ]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as {
    goldenPath: string;
    dir: string;
    corpusSize: number;
    semanticPathActive: boolean;
    vocabularySource: string;
    unknownExpectIds: string[];
    semanticContributedCount: number;
    keywordContributedCount: number;
    perPrompt: Array<{ prompt: string; expect: string[]; got: string[] }>;
    aggregate: {
      precision: number;
      recall: number;
      mrr: number;
      positiveCount: number;
      negativeControls: {
        total: number;
        passed: number;
        failed: number;
        rate: number | null;
      };
    };
  };
  assert.equal(parsed.corpusSize, 4);
  assert.equal(parsed.semanticPathActive, false);
  assert.equal(parsed.vocabularySource, "built-in default");
  assert.deepEqual(parsed.unknownExpectIds, ["feedback_never_fires_phantom"]);
  assert.equal(parsed.perPrompt.length, 6);
  assert.equal(parsed.semanticContributedCount, 0);
  assert.equal(parsed.keywordContributedCount, 0);
  assert.equal(parsed.aggregate.precision, 0.75);
  assert.equal(parsed.aggregate.recall, 0.625);
  assert.equal(parsed.aggregate.mrr, 0.75);
  assert.equal(parsed.aggregate.positiveCount, 4);
  assert.deepEqual(parsed.aggregate.negativeControls, {
    total: 2,
    passed: 1,
    failed: 1,
    rate: 0.5,
  });
});

test("eval: $MEMORY_ROUTER_DIR env resolves the corpus when --dir is omitted", () => {
  const { status, stdout } = run(["eval", GOLDEN_PATH, "--json"], {
    MEMORY_ROUTER_DIR: CORPUS_DIR,
  });
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as { corpusSize: number };
  assert.equal(parsed.corpusSize, 4);
});

test("eval: missing golden.yml positional exits 1 with a clear message", () => {
  const { status, stderr } = run(["eval", "--dir", CORPUS_DIR]);
  assert.equal(status, 1);
  assert.match(stderr, /eval <golden\.yml> is required/);
});

test("eval: missing --dir / $MEMORY_ROUTER_DIR exits 1 with a clear message", () => {
  const { status, stderr } = run(["eval", GOLDEN_PATH], {
    MEMORY_ROUTER_DIR: "",
  });
  assert.equal(status, 1);
  assert.match(stderr, /--dir <path> or \$MEMORY_ROUTER_DIR is required/);
});

test("eval: nonexistent golden file exits 1 with a clear message (not a silent gap)", () => {
  const { status, stderr } = run([
    "eval",
    path.join(__dirname, "fixtures", "eval", "does-not-exist.yml"),
    "--dir",
    CORPUS_DIR,
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /cannot read golden file/);
});

test("eval: nonexistent corpus dir exits 1 with a clear message", () => {
  const { status, stderr } = run([
    "eval",
    GOLDEN_PATH,
    "--dir",
    path.join(__dirname, "fixtures", "eval", "does-not-exist"),
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /error: cannot read/);
});

test("eval --max-hits: warns loudly that it is a no-op (eval pins the cap to the hook default)", () => {
  const { status, stderr } = run([
    "eval",
    GOLDEN_PATH,
    "--dir",
    CORPUS_DIR,
    "--max-hits",
    "3",
  ]);
  assert.equal(status, 0);
  assert.match(stderr, /warning: --max-hits is a no-op with eval/);
});

test("eval --semantic: warns loudly that it is a no-op (eval always attempts the confidence gate automatically)", () => {
  const { status, stderr } = run([
    "eval",
    GOLDEN_PATH,
    "--dir",
    CORPUS_DIR,
    "--semantic",
  ]);
  assert.equal(status, 0);
  assert.match(stderr, /warning: --semantic is a no-op with eval/);
});

// --- dir-threading, not the $MEMORY_ROUTER_DIR env global -----

test("eval: custom topics.yml at --dir applies even without $MEMORY_ROUTER_DIR set (ctx.memoryDir threading, not the env global)", () => {
  // tests/fixtures/vocab/{topics.yml,golden.yml,feedback_incident.md}:
  // a corpus whose topics.yml declares `incident_response`, not part of the
  // built-in default vocabulary. This only scores 1.0 across the board if
  // --dir's own topics.yml is actually consulted by the Topic Gate (via
  // ctx.memoryDir), not a stray $MEMORY_ROUTER_DIR or the built-in default.
  // Spawned with an explicitly minimal env (PATH only, same pattern as the
  // "neither --dir nor env" test above) so $MEMORY_ROUTER_DIR is genuinely
  // absent.
  const VOCAB_CORPUS = path.join(__dirname, "fixtures", "vocab");
  const VOCAB_GOLDEN = path.join(VOCAB_CORPUS, "golden.yml");
  const cleanEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  const res = spawnSync(
    process.execPath,
    [BIN, "eval", VOCAB_GOLDEN, "--dir", VOCAB_CORPUS],
    { encoding: "utf8", timeout: 8_000, env: cleanEnv },
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const stdout = res.stdout ?? "";
  assert.match(stdout, /vocabulary: custom \(/);
  assert.match(stdout, /precision=1\.000 recall=1\.000 mrr=1\.000/);
});

test("--help lists the eval verb", () => {
  const { status, stdout } = run(["--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /eval <golden\.yml>/);
});

test("--help points the eval --json schema pointer at docs/commands.md, not README.md", () => {
  const { status, stdout } = run(["--help"]);
  assert.equal(status, 0);
  // The pointer must be the schema line itself, not any docs/commands.md
  // substring elsewhere in --help.
  assert.match(
    stdout,
    /--json emits a machine-readable report on stdout; schema:\s+https:\/\/github\.com\/LanNguyenSi\/agent-memory\/blob\/master\/packages\/memory-router\/docs\/commands\.md#memory-router-eval-metric-definitions-and-json-schema\n/,
  );
  assert.doesNotMatch(stdout, /README\.md/);
});

// --- injected-context size over the golden set ------------------------------

test("eval --json reports per-prompt injectBytes and the mean/max injection summary", () => {
  const { loadMemoriesFromDir } = require("../src/memory/loader");
  const { resolveBlended } = require("../src/router");
  const { renderHitsBudgeted } = require("../src/render");

  const { status, stdout } = run(["eval", GOLDEN_PATH, "--dir", CORPUS_DIR, "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as {
    injection: { budgetBytes: number; meanBytes: number; maxBytes: number };
    perPrompt: Array<{ prompt: string; injectBytes: number }>;
  };
  assert.equal(parsed.injection.budgetBytes, 16384);
  const sizes = parsed.perPrompt.map((p) => p.injectBytes);
  assert.equal(sizes.length, 6);
  assert.ok(sizes.every((n) => Number.isInteger(n) && n >= 0));
  assert.equal(parsed.injection.maxBytes, Math.max(...sizes));
  assert.equal(
    parsed.injection.meanBytes,
    sizes.reduce((a, b) => a + b, 0) / sizes.length,
    "mean is over ALL prompts, an empty injection counts as 0 bytes",
  );
  assert.ok(sizes.some((n) => n === 0), "fixture: at least one prompt injects nothing");
  assert.ok(parsed.injection.maxBytes > 0);

  // Same renderer as the hook: re-resolve every golden prompt in-process.
  const memories = loadMemoriesFromDir(CORPUS_DIR);
  return (async () => {
    for (const p of parsed.perPrompt) {
      const hits = await resolveBlended({ prompt: p.prompt, memoryDir: CORPUS_DIR }, memories, CORPUS_DIR);
      assert.equal(
        p.injectBytes,
        Buffer.byteLength(renderHitsBudgeted(hits, { budgetBytes: 16384 }), "utf8"),
        `prompt: ${p.prompt}`,
      );
    }
  })();
});

test("eval text output states the mean and max injected bytes", () => {
  const { status, stdout } = run(["eval", GOLDEN_PATH, "--dir", CORPUS_DIR]);
  assert.equal(status, 0);
  assert.match(
    stdout,
    /injected context: mean=\d+ bytes max=\d+ bytes \(hook renderer, budget 16384 bytes, over all 6 prompts\)/,
  );
});

test("eval honors MEMORY_ROUTER_INJECT_BUDGET, and an invalid value notes itself once, not once per prompt", () => {
  const ok = run(["eval", GOLDEN_PATH, "--dir", CORPUS_DIR, "--json"], {
    MEMORY_ROUTER_INJECT_BUDGET: "1",
  });
  assert.equal((JSON.parse(ok.stdout) as { injection: { budgetBytes: number } }).injection.budgetBytes, 1);

  const bad = run(["eval", GOLDEN_PATH, "--dir", CORPUS_DIR, "--json"], {
    MEMORY_ROUTER_INJECT_BUDGET: "-5",
  });
  assert.equal(bad.status, 0);
  assert.equal((JSON.parse(bad.stdout) as { injection: { budgetBytes: number } }).injection.budgetBytes, 16384);
  assert.equal(bad.stderr.split("MEMORY_ROUTER_INJECT_BUDGET").length - 1, 1);
});

test("eval: a golden file with forbid ids reports the check in --json and in the text output; a malformed forbid exits 1 with the path-prefixed message", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-router-eval-forbid-"));
  try {
    const good = path.join(tmp, "good.yml");
    fs.writeFileSync(
      good,
      [
        "prompts:",
        '  - prompt: "rm -rf the build directory to start fresh"',
        '    expect: ["feedback_deploy_checklist"]',
        '    forbid: ["feedback_force_push"]',
        "",
      ].join("\n"),
    );
    const json = run(["eval", good, "--dir", CORPUS_DIR, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.deepEqual(parsed.perPrompt[0].forbid, ["feedback_force_push"]);
    assert.deepEqual(parsed.perPrompt[0].forbidViolations, ["feedback_force_push"]);
    assert.deepEqual(parsed.aggregate.forbid, { total: 1, violated: 1 });
    assert.deepEqual(parsed.unknownForbidIds, []);

    const text = run(["eval", good, "--dir", CORPUS_DIR]);
    assert.match(text.stdout, /forbid: feedback_force_push {2}FAIL \(present: feedback_force_push\)/);
    assert.match(text.stdout, /forbid checks: 0\/1 prompts clean/);

    const bad = path.join(tmp, "bad.yml");
    fs.writeFileSync(bad, 'prompts:\n  - prompt: "x"\n    forbid: "feedback_force_push"\n');
    const res = run(["eval", bad, "--dir", CORPUS_DIR]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /prompts\[0\]\.forbid must be an array of memory-id strings/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
