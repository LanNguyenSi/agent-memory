// Unit coverage for src/commands/watch-arming.ts: the split of sync paths into
// existing and missing, the per-target tracker for the missing ones, and the
// re-read of a path that appeared.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSandbox, writeText } = require("../helpers/cli.ts");
const {
  ARM_PROBE_DIR_PREFIX,
  DEFAULT_ARM_TIMEOUT_MS,
  confirmWatchLive,
  listFilesUnder,
  parseArmTimeoutMs,
  partitionSyncPaths,
  trackMissingPaths
} = require("../../src/commands/watch-arming.ts");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    assert.ok(Date.now() - startedAt < timeoutMs, `timed out waiting for ${label}`);
    await sleep(2);
  }
}

// A stat that finds only the paths in `present`, which a test can grow.
function fakeStat(present: Set<string>) {
  return async (target: string) => {
    if (!present.has(target)) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return {};
  };
}

test("partitionSyncPaths splits existing from missing paths, keeps the order and drops a path configured twice", () => {
  const present = new Set(["/ws/MEMORY.md", "/ws/a"]);
  const exists = (candidate: string) => present.has(candidate);
  assert.deepEqual(
    partitionSyncPaths(["/ws/logs", "/ws/MEMORY.md", "/ws/a", "/ws/notes", "/ws/./logs/", "/ws/MEMORY.md"], exists),
    {
      existing: ["/ws/MEMORY.md", "/ws/a"],
      missing: ["/ws/logs", "/ws/notes"]
    }
  );
  assert.deepEqual(partitionSyncPaths([], exists), { existing: [], missing: [] });
  // A nested path whose parent is missing is simply missing: no ancestor is
  // looked up.
  assert.deepEqual(partitionSyncPaths(["/ws/logs/daily"], exists), { existing: [], missing: ["/ws/logs/daily"] });
});

test("trackMissingPaths reports each target once, when it exists, independently of the others", async () => {
  const present = new Set<string>();
  const appeared: string[] = [];
  const tracker = trackMissingPaths(
    ["/ws/logs", "/ws/notes", "/ws/logs/daily"],
    (target: string) => appeared.push(target),
    {
      pollMs: 2,
      stat: fakeStat(present)
    }
  );
  try {
    await sleep(30);
    assert.deepEqual(appeared, [], "nothing exists yet");
    assert.deepEqual(tracker.pending(), ["/ws/logs", "/ws/notes", "/ws/logs/daily"]);

    // The second target appears first; the others keep waiting.
    present.add("/ws/notes");
    await until(() => appeared.length === 1, "notes");
    assert.deepEqual(appeared, ["/ws/notes"]);
    assert.deepEqual(tracker.pending(), ["/ws/logs", "/ws/logs/daily"]);

    // A nested target is reported when it exists itself, not when its parent does.
    present.add("/ws/logs");
    await until(() => appeared.length === 2, "logs");
    await sleep(30);
    assert.deepEqual(appeared, ["/ws/notes", "/ws/logs"]);
    present.add("/ws/logs/daily");
    await until(() => appeared.length === 3, "logs/daily");

    // Once reported, a target is not reported again.
    await sleep(30);
    assert.deepEqual(appeared, ["/ws/notes", "/ws/logs", "/ws/logs/daily"]);
    assert.deepEqual(tracker.pending(), []);
  } finally {
    tracker.close();
  }
});

test("trackMissingPaths checks a target at once, before the first interval has passed", async () => {
  const appeared: string[] = [];
  const tracker = trackMissingPaths(["/ws/logs"], (target: string) => appeared.push(target), {
    pollMs: 60000,
    stat: fakeStat(new Set(["/ws/logs"]))
  });
  try {
    await until(() => appeared.length === 1, "an immediate first check");
  } finally {
    tracker.close();
  }
});

test("trackMissingPaths stops polling on close", async () => {
  const present = new Set<string>();
  let calls = 0;
  const stat = async (target: string) => {
    calls += 1;
    return fakeStat(present)(target);
  };
  const appeared: string[] = [];
  const tracker = trackMissingPaths(["/ws/logs"], (target: string) => appeared.push(target), { pollMs: 2, stat });
  await until(() => calls >= 3, "a few checks");
  tracker.close();
  tracker.close();
  const callsAtClose = calls;
  present.add("/ws/logs");
  await sleep(40);
  assert.ok(calls <= callsAtClose + 1, `kept polling after close (${callsAtClose} -> ${calls})`);
  assert.deepEqual(appeared, []);
});

test("trackMissingPaths reports a failing appearance handler through onError and keeps the other targets", async () => {
  const present = new Set(["/ws/logs"]);
  const errors: Array<[string, string]> = [];
  const appeared: string[] = [];
  const tracker = trackMissingPaths(
    ["/ws/logs", "/ws/notes"],
    (target: string) => {
      if (target === "/ws/logs") {
        throw new Error("boom");
      }
      appeared.push(target);
    },
    {
      pollMs: 2,
      stat: fakeStat(present),
      onError: (target: string, error: Error) => errors.push([target, error.message])
    }
  );
  try {
    await until(() => errors.length === 1, "the handler error");
    present.add("/ws/notes");
    await until(() => appeared.length === 1, "notes");
    assert.deepEqual(errors, [["/ws/logs", "boom"]]);
  } finally {
    tracker.close();
  }
});

test("trackMissingPaths waits for a target again when its handler returns false, and reports it when the handler accepts it", async () => {
  const present = new Set(["/ws/logs"]);
  const calls: string[] = [];
  const answers = [false, undefined];
  const tracker = trackMissingPaths(
    ["/ws/logs"],
    (target: string) => {
      calls.push(target);
      return answers.shift() as false | undefined;
    },
    { pollMs: 2, stat: fakeStat(present) }
  );
  try {
    await until(() => calls.length === 2, "the second report of the target");
    assert.deepEqual(calls, ["/ws/logs", "/ws/logs"]);
    await sleep(30);
    assert.equal(calls.length, 2, "a target the handler accepted is not reported again");
    assert.deepEqual(tracker.pending(), []);
  } finally {
    tracker.close();
  }
});

test("trackMissingPaths keeps a target pending while its handler keeps returning false, and stops on close", async () => {
  const present = new Set(["/ws/logs"]);
  let calls = 0;
  const tracker = trackMissingPaths(
    ["/ws/logs"],
    () => {
      calls += 1;
      return false;
    },
    { pollMs: 2, stat: fakeStat(present) }
  );
  await until(() => calls >= 3, "repeated reports");
  assert.deepEqual(tracker.pending(), ["/ws/logs"]);
  tracker.close();
  const callsAtClose = calls;
  await sleep(40);
  assert.ok(calls <= callsAtClose + 1, `kept polling after close (${callsAtClose} -> ${calls})`);
});

test("trackMissingPaths reports a path created on disk, including one under a parent that is created later", async () => {
  const root = createSandbox("watch-arming-track-real");
  const appeared: string[] = [];
  const target = path.join(root, "logs", "daily");
  const tracker = trackMissingPaths([target], (found: string) => appeared.push(found), { pollMs: 5 });
  try {
    fs.mkdirSync(path.join(root, "logs"));
    await sleep(40);
    assert.deepEqual(appeared, []);
    fs.mkdirSync(target);
    await until(() => appeared.length === 1, "logs/daily");
    assert.deepEqual(appeared, [target]);
  } finally {
    tracker.close();
  }
});

test("listFilesUnder lists the files of a directory tree, a file target itself, and nothing for a missing path", async () => {
  const root = createSandbox("watch-arming-list");
  writeText(path.join(root, "logs", "a.md"), "a\n");
  writeText(path.join(root, "logs", "sub", "b.md"), "b\n");
  writeText(path.join(root, "logs", "sub", "deeper", "c.md"), "c\n");
  fs.mkdirSync(path.join(root, "logs", "empty"));
  writeText(path.join(root, "single.md"), "single\n");

  const listed = await listFilesUnder(path.join(root, "logs"));
  assert.deepEqual(
    [...listed].sort(),
    [
      path.join(root, "logs", "a.md"),
      path.join(root, "logs", "sub", "b.md"),
      path.join(root, "logs", "sub", "deeper", "c.md")
    ].sort()
  );
  assert.deepEqual(await listFilesUnder(path.join(root, "single.md")), [path.join(root, "single.md")]);
  assert.deepEqual(await listFilesUnder(path.join(root, "logs", "empty")), []);
  assert.deepEqual(await listFilesUnder(path.join(root, "nope")), []);
});

test("listFilesUnder follows a symlink to a file, skips a dangling one and does not follow a symlinked directory", async () => {
  const root = createSandbox("watch-arming-list-links");
  writeText(path.join(root, "outside", "o.md"), "o\n");
  writeText(path.join(root, "logs", "real.md"), "r\n");
  fs.symlinkSync(path.join(root, "outside", "o.md"), path.join(root, "logs", "link.md"));
  fs.symlinkSync(path.join(root, "gone.md"), path.join(root, "logs", "dangling.md"));
  fs.symlinkSync(path.join(root, "outside"), path.join(root, "logs", "linked-dir"));

  assert.deepEqual(
    [...(await listFilesUnder(path.join(root, "logs")))].sort(),
    [path.join(root, "logs", "link.md"), path.join(root, "logs", "real.md")].sort()
  );
});

function leftoverProbeDirs(scratchRoot: string): string[] {
  return fs.readdirSync(scratchRoot).filter((name: string) => name.startsWith(ARM_PROBE_DIR_PREFIX));
}

test("confirmWatchLive resolves true once a watch opened now delivers an event, and leaves no scratch directory behind", async () => {
  const scratchRoot = createSandbox("watch-arming-live");
  assert.equal(await confirmWatchLive({ timeoutMs: 20000, scratchRoot }), true);
  assert.deepEqual(leftoverProbeDirs(scratchRoot), []);
});

test("confirmWatchLive gives up at its bound with false, without waiting for an event, and cleans up", async () => {
  const scratchRoot = createSandbox("watch-arming-live-bound");
  const startedAt = Date.now();
  // A zero bound ends at the first check, before any event can have arrived.
  assert.equal(await confirmWatchLive({ timeoutMs: 0, scratchRoot }), false);
  assert.ok(Date.now() - startedAt < 1000);
  assert.deepEqual(leftoverProbeDirs(scratchRoot), []);
});

test("confirmWatchLive ends at once when its signal is already aborted", async () => {
  const scratchRoot = createSandbox("watch-arming-live-abort");
  const stop = new AbortController();
  stop.abort();
  assert.equal(await confirmWatchLive({ timeoutMs: 60000, signal: stop.signal, scratchRoot }), false);
  assert.deepEqual(leftoverProbeDirs(scratchRoot), []);
});

test("confirmWatchLive resolves false, and does not throw, when the scratch directory cannot be created", async () => {
  const scratchRoot = path.join(createSandbox("watch-arming-live-missing"), "does-not-exist");
  assert.equal(await confirmWatchLive({ timeoutMs: 1000, scratchRoot }), false);
});

test("confirmWatchLive reports the cause through onError when the probe cannot be set up, and not on a plain timeout", async () => {
  const errors: unknown[] = [];
  const scratchRoot = path.join(createSandbox("watch-arming-live-onerror"), "does-not-exist");
  assert.equal(
    await confirmWatchLive({ timeoutMs: 1000, scratchRoot, onError: (error: unknown) => errors.push(error) }),
    false
  );
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Error).message, /ENOENT/);

  const timedOut: unknown[] = [];
  const ok = createSandbox("watch-arming-live-onerror-timeout");
  assert.equal(
    await confirmWatchLive({ timeoutMs: 0, scratchRoot: ok, onError: (error: unknown) => timedOut.push(error) }),
    false
  );
  assert.deepEqual(timedOut, []);
});

test("parseArmTimeoutMs takes a non-negative number and falls back to the default otherwise", () => {
  assert.equal(parseArmTimeoutMs(undefined), DEFAULT_ARM_TIMEOUT_MS);
  assert.equal(parseArmTimeoutMs(""), DEFAULT_ARM_TIMEOUT_MS);
  assert.equal(parseArmTimeoutMs("250"), 250);
  assert.equal(parseArmTimeoutMs("0"), 0);
  assert.equal(parseArmTimeoutMs("-5"), DEFAULT_ARM_TIMEOUT_MS);
  assert.equal(parseArmTimeoutMs("soon"), DEFAULT_ARM_TIMEOUT_MS);
});
