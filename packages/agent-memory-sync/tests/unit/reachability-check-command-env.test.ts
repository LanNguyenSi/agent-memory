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

test(`${ENV_KEY}='["true","5","x"]' with non-array-of-strings shape (a JSON object) warns visibly`, async () => {
  const { reachabilityCheckCommand, stderr } = await resolveWithEnvValue('{"not":"an array"}');

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
