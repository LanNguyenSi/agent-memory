// Unit tests for the AGENT_MEMORY_SYNC_REACHABILITY_CHECK_COMMAND env
// override's parsing.
//
// Incident (live, 2026-07-22, .ai/runs/2026-07-22-memory-sync-activation/
// 05-review-findings.md "Delta-Review" section): setting this env var to
// `false` was silently ignored — the value is valid JSON (the boolean
// `false`), so JSON.parse succeeds, but normalizeReachabilityCheckCommand's
// `if (!value) return null;` guard treats any falsy parse result as "not
// set" and returns null with no diagnostic. A syntactically invalid value
// (not valid JSON at all) is worse: it throws an uncaught SyntaxError out of
// readEnvConfig that takes down the whole CLI invocation, not just the
// probe override — for a value the config only *uses* if the remote turns
// out to be unreachable.
//
// The fix: any value that fails to parse into a valid non-empty argv array
// (invalid JSON syntax, or valid JSON of the wrong shape) prints one visible
// warning naming the offending value and the expected format (a JSON array
// of non-empty strings), and the override is treated as unset — falling
// back to the default reachability probe — instead of crashing the CLI or
// silently substituting the default with no explanation.
//
// Hermetic: exercises src/config/loader.ts's resolveRunConfig() directly
// (mirrors tests/unit/reachability.test.ts's style of testing the module
// directly rather than through the CLI), capturing process.stderr.write to
// assert on the warning without spawning a process.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, resolveRunConfig } = require("../../src/config/loader");

const ENV_KEY = "AGENT_MEMORY_SYNC_REACHABILITY_CHECK_COMMAND";

async function resolveWithEnvValue(rawValue: string): Promise<{
  reachabilityCheckCommand: string[] | null;
  stderr: string;
}> {
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = rawValue;

  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  try {
    const loaded = await loadConfig("/nonexistent/agent-memory-sync-config.json");
    const runConfig = resolveRunConfig(loaded, { remoteUrl: "/tmp/does-not-matter.git" });
    return { reachabilityCheckCommand: runConfig.reachabilityCheckCommand, stderr };
  } finally {
    process.stderr.write = originalWrite;
    if (typeof previous === "undefined") {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
  }
}

test(`${ENV_KEY}='false' warns visibly and falls back to the default probe instead of silently substituting it`, async () => {
  const { reachabilityCheckCommand, stderr } = await resolveWithEnvValue("false");

  assert.equal(reachabilityCheckCommand, null, "an unparsable override must not silently apply");
  assert.match(stderr, /warning/i);
  assert.match(stderr, new RegExp(ENV_KEY));
  assert.match(stderr, /false/);
  assert.match(stderr, /json array/i);
});

test(`${ENV_KEY}='not valid json' warns visibly instead of crashing the whole CLI invocation`, async () => {
  const { reachabilityCheckCommand, stderr } = await resolveWithEnvValue("not valid json");

  assert.equal(reachabilityCheckCommand, null);
  assert.match(stderr, /warning/i);
  assert.match(stderr, /json array/i);
});

test(`${ENV_KEY}='{"not":"an array"}' (valid JSON, but not an array at all) warns visibly`, async () => {
  const { reachabilityCheckCommand, stderr } = await resolveWithEnvValue('{"not":"an array"}');

  assert.equal(reachabilityCheckCommand, null);
  assert.match(stderr, /warning/i);
  assert.match(stderr, /json array/i);
});

// Distinct code path from the object-shaped case above: this value IS a
// JSON array, so it clears this module's own `Array.isArray` gate, and
// instead reaches normalizeReachabilityCheckCommand's own element-shape
// check (loader.ts: `value.some((entry) => typeof entry !== "string" ||
// !entry)`), which throws for a non-string / empty-string element. Both
// throw sites are caught by the same try/catch and produce the same
// warning, but exercising this one separately pins branch coverage on the
// element-shape guard specifically, not just the top-level type guard.
test(`${ENV_KEY}='["ssh",""]' (a JSON array, but with an empty-string element) warns visibly`, async () => {
  const { reachabilityCheckCommand, stderr } = await resolveWithEnvValue('["ssh",""]');

  assert.equal(reachabilityCheckCommand, null);
  assert.match(stderr, /warning/i);
  assert.match(stderr, /json array/i);
});

test(`${ENV_KEY}='[1,2]' (a JSON array, but of numbers, not strings) warns visibly`, async () => {
  const { reachabilityCheckCommand, stderr } = await resolveWithEnvValue("[1,2]");

  assert.equal(reachabilityCheckCommand, null);
  assert.match(stderr, /warning/i);
  assert.match(stderr, /json array/i);
});

test(`${ENV_KEY} with a valid JSON array of non-empty strings applies with no warning`, async () => {
  const { reachabilityCheckCommand, stderr } = await resolveWithEnvValue(
    '["ssh","-o","BatchMode=yes","host","true"]'
  );

  assert.deepEqual(reachabilityCheckCommand, ["ssh", "-o", "BatchMode=yes", "host", "true"]);
  assert.doesNotMatch(stderr, /warning/i);
});

test(`${ENV_KEY}='[]' (explicit empty array) applies as null with no warning`, async () => {
  const { reachabilityCheckCommand, stderr } = await resolveWithEnvValue("[]");

  assert.equal(reachabilityCheckCommand, null);
  assert.doesNotMatch(stderr, /warning/i);
});

// Deliberate, documented convention (README.md's Sync behavior section),
// pinned here so it stays a decision rather than an accident: readEnvConfig
// only even looks at this env var inside `if (env.AGENT_MEMORY_SYNC_
// REACHABILITY_CHECK_COMMAND)`, and an empty string is falsy in JS, so it
// is treated identically to the env var not being set at all — silently,
// with no warning. This is the same *shape* as the incident this file
// otherwise pins (a value that disables the override without saying so),
// but empty-string-as-unset is a common, intentional shell convention (an
// unset or cleared variable often round-trips as ""), unlike a stray
// `false`/`not valid json`/wrong-shaped value, which is far more likely a
// mistake. Hence: silent by design, not a warning candidate — if this ever
// changes, this test should change with it.
test(`${ENV_KEY}='' (empty string) is treated as unset — silent, no warning, no override applied`, async () => {
  const { reachabilityCheckCommand, stderr } = await resolveWithEnvValue("");

  assert.equal(reachabilityCheckCommand, null);
  assert.doesNotMatch(stderr, /warning/i);
});
