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
    unknownExpectIds: string[];
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
  assert.deepEqual(parsed.unknownExpectIds, ["feedback_never_fires_phantom"]);
  assert.equal(parsed.perPrompt.length, 6);
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

test("--help lists the eval verb", () => {
  const { status, stdout } = run(["--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /eval <golden\.yml>/);
});
