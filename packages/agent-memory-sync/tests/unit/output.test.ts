// Unit tests for src/output.ts's writer functions. Nothing in the existing
// suite exercised this module directly (every CLI invocation in the
// integration tests passes `--output json`, and even the `json`/`yaml`
// branches of writeResult were only reached implicitly through those
// process spawns without ever pinning the default `text` branch or the
// quiet/verbose/color gating on writeInfo/writeWarning/writeDryRun).
//
// Captures process.stdout.write / process.stderr.write in place, mirroring
// tests/unit/reachability-check-command-env.test.ts's pattern, so real
// output can be asserted without spawning a subprocess.

const test = require("node:test");
const assert = require("node:assert/strict");
const YAML = require("yaml");
const { writeResult, writeInfo, writeWarning, writeDryRun } = require("../../src/output");

function captureStdout(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  try {
    fn();
    return out;
  } finally {
    process.stdout.write = original;
  }
}

function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  try {
    fn();
    return out;
  } finally {
    process.stderr.write = original;
  }
}

// ─── writeResult ─────────────────────────────────────────────────────────────

test("writeResult: 'json' format writes pretty-printed JSON, ignoring renderText", () => {
  const data = { a: 1, b: [true, false] };
  const out = captureStdout(() => writeResult(data, "json", () => "SHOULD NOT BE USED"));
  assert.equal(out, `${JSON.stringify(data, null, 2)}\n`);
});

test("writeResult: 'yaml' format writes YAML.stringify output, ignoring renderText", () => {
  const data = { a: 1, nested: { b: "x" } };
  const out = captureStdout(() => writeResult(data, "yaml", () => "SHOULD NOT BE USED"));
  assert.equal(out, YAML.stringify(data));
});

test("writeResult: 'text' format with a renderText callback uses its return value", () => {
  const out = captureStdout(() => writeResult({ ignored: true }, "text", () => "custom rendered line"));
  assert.equal(out, "custom rendered line\n");
});

test("writeResult: 'text' format without a renderText callback falls back to String(data)", () => {
  const out = captureStdout(() => writeResult({ a: 1 }, "text"));
  assert.equal(out, `${String({ a: 1 })}\n`);
});

// ─── writeInfo ────────────────────────────────────────────────────────────────

test("writeInfo: quiet suppresses output even when verbose is true", () => {
  const out = captureStderr(() => writeInfo("hello", { color: false, quiet: true, verbose: true }));
  assert.equal(out, "");
});

test("writeInfo: non-verbose suppresses output even when quiet is false", () => {
  const out = captureStderr(() => writeInfo("hello", { color: false, quiet: false, verbose: false }));
  assert.equal(out, "");
});

test("writeInfo: quiet=false, verbose=true, color=false writes the plain message", () => {
  const out = captureStderr(() => writeInfo("hello", { color: false, quiet: false, verbose: true }));
  assert.equal(out, "hello\n");
});

test("writeInfo: quiet=false, verbose=true, color=true wraps the message in cyan ANSI codes", () => {
  const out = captureStderr(() => writeInfo("hello", { color: true, quiet: false, verbose: true }));
  assert.equal(out, "[36mhello[0m\n");
});

// ─── writeWarning ─────────────────────────────────────────────────────────────

test("writeWarning: quiet suppresses output", () => {
  const out = captureStderr(() => writeWarning("careful", { color: false, quiet: true, verbose: false }));
  assert.equal(out, "");
});

test("writeWarning: quiet=false, color=false writes a plain 'warning: ' prefixed message", () => {
  const out = captureStderr(() => writeWarning("careful", { color: false, quiet: false, verbose: false }));
  assert.equal(out, "warning: careful\n");
});

test("writeWarning: quiet=false, color=true wraps the prefixed message in yellow ANSI codes", () => {
  const out = captureStderr(() => writeWarning("careful", { color: true, quiet: false, verbose: false }));
  assert.equal(out, "[33mwarning: careful[0m\n");
});

// ─── writeDryRun ───────────────────────────────────────────────────────────────

test("writeDryRun: quiet suppresses output", () => {
  const out = captureStderr(() => writeDryRun("would do X", { color: false, quiet: true, verbose: false }));
  assert.equal(out, "");
});

test("writeDryRun: quiet=false, color=false writes a plain '[dry-run] ' prefixed message", () => {
  const out = captureStderr(() => writeDryRun("would do X", { color: false, quiet: false, verbose: false }));
  assert.equal(out, "[dry-run] would do X\n");
});

test("writeDryRun: quiet=false, color=true wraps the prefixed message in cyan ANSI codes", () => {
  const out = captureStderr(() => writeDryRun("would do X", { color: true, quiet: false, verbose: false }));
  assert.equal(out, "[36m[dry-run] would do X[0m\n");
});
