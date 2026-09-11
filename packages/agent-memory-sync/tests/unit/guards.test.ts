// Unit tests for the deletion guards (src/memory-sync/guards.ts), the two
// checks added after the 2026-09-11 memory-corpus wipe (agent-tasks
// cda5b12c). The integration suite
// (tests/integration/mass-delete-guard.test.ts) drives them through the CLI
// against a real bare repo; this file pins the threshold arithmetic itself,
// including the boundaries, which are expensive to cover one by one through
// a spawned process.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  DEFAULT_MASS_DELETE_GUARD,
  MIN_PROPORTIONAL_DELETIONS,
  assertNoMassDelete,
  assertReliableCheckout,
  findMassDelete,
  findUnreliableCheckout,
  resolveMassDeleteGuard
} = require("../../src/memory-sync/guards");

// resolveSyncPathEntries (src/memory-sync/config.ts) resolves an entry's
// kind by stat-ing the source when the config does not state one. Every
// config below states `kind` explicitly, so no path in this file needs to
// exist on disk; rootDir is still a real, empty directory so nothing can
// accidentally resolve against the repository itself.
const sandboxRoot = mkdtempSync(path.join(tmpdir(), "agent-memory-sync-guards-"));

function config(overrides: Record<string, unknown> = {}) {
  return {
    rootDir: sandboxRoot,
    repositorySubdir: "shared",
    syncPaths: [
      { source: "MEMORY.md", destination: "MEMORY.md", kind: "file" },
      { source: "memory", destination: "memory", kind: "directory" },
      { source: "logs", destination: "logs", kind: "directory" }
    ],
    ...overrides
  };
}

function tracked(destination: string, count: number, offset = 0): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (let index = offset; index < offset + count; index += 1) {
    map[`${destination}/file-${String(index).padStart(3, "0")}.md`] = `content ${index}\n`;
  }
  return map;
}

function paths(destination: string, count: number, offset = 0): string[] {
  const result: string[] = [];
  for (let index = offset; index < offset + count; index += 1) {
    result.push(`${destination}/file-${String(index).padStart(3, "0")}.md`);
  }
  return result;
}

// Three directory destinations, for the plan-wide total rule (D-007): the
// per-destination rules cannot see a plan that stays under the limit in each
// destination separately, so the case needs more than one of them.
function threeDestinationConfig() {
  return config({
    syncPaths: [
      { source: "memory", destination: "memory", kind: "directory" },
      { source: "logs", destination: "logs", kind: "directory" },
      { source: "archive", destination: "archive", kind: "directory" }
    ]
  });
}

test("defaults: 10 percent and 20 files, with a two-deletion floor on the proportional rule", () => {
  assert.deepEqual(DEFAULT_MASS_DELETE_GUARD, { maxRatio: 0.1, maxFiles: 20 });
  assert.equal(MIN_PROPORTIONAL_DELETIONS, 2);
});

test("resolveMassDeleteGuard: a partial override keeps the default for the other key", () => {
  assert.deepEqual(resolveMassDeleteGuard({ maxFiles: 3 }), { maxRatio: 0.1, maxFiles: 3 });
  assert.deepEqual(resolveMassDeleteGuard({ maxRatio: 0.5 }), { maxRatio: 0.5, maxFiles: 20 });
  assert.deepEqual(resolveMassDeleteGuard(null), { maxRatio: 0.1, maxFiles: 20 });
  assert.deepEqual(resolveMassDeleteGuard(undefined), { maxRatio: 0.1, maxFiles: 20 });
});

test("findMassDelete: an empty plan is never a mass delete", () => {
  assert.equal(
    findMassDelete(config(), tracked("memory", 400), [], DEFAULT_MASS_DELETE_GUARD),
    null
  );
});

test("findMassDelete: the absolute rule fires at 21 deletions, not at 20", () => {
  const baseMap = tracked("memory", 400);
  assert.equal(findMassDelete(config(), baseMap, paths("memory", 20), DEFAULT_MASS_DELETE_GUARD), null);

  const finding = findMassDelete(config(), baseMap, paths("memory", 21), DEFAULT_MASS_DELETE_GUARD);
  assert.deepEqual(finding, { destination: "memory", deleted: 21, tracked: 400, rule: "absolute" });
});

test("findMassDelete: the proportional rule fires strictly above the ratio, not at it", () => {
  const baseMap = tracked("memory", 100);
  // Exactly 10 of 100 is 10 percent: at the threshold, not over it.
  assert.equal(findMassDelete(config(), baseMap, paths("memory", 10), DEFAULT_MASS_DELETE_GUARD), null);

  const finding = findMassDelete(config(), baseMap, paths("memory", 11), DEFAULT_MASS_DELETE_GUARD);
  assert.deepEqual(finding, { destination: "memory", deleted: 11, tracked: 100, rule: "proportional" });
});

test("findMassDelete: a single deletion never trips the proportional rule, however small the destination", () => {
  for (const count of [1, 2, 5, 9]) {
    assert.equal(
      findMassDelete(config(), tracked("logs", count), paths("logs", 1), DEFAULT_MASS_DELETE_GUARD),
      null,
      `a single deletion out of ${count} tracked file(s) must be allowed`
    );
  }
});

test("findMassDelete: two deletions out of two tracked files are refused", () => {
  const finding = findMassDelete(
    config(),
    tracked("logs", 2),
    paths("logs", 2),
    DEFAULT_MASS_DELETE_GUARD
  );
  assert.deepEqual(finding, { destination: "logs", deleted: 2, tracked: 2, rule: "proportional" });
});

test("findMassDelete: the whole incident shape (404 tracked, 406 deleted) is refused", () => {
  const baseMap = tracked("memory", 404);
  const finding = findMassDelete(
    config(),
    baseMap,
    paths("memory", 404),
    DEFAULT_MASS_DELETE_GUARD
  );
  assert.deepEqual(finding, { destination: "memory", deleted: 404, tracked: 404, rule: "absolute" });
});

test("findMassDelete: destinations are evaluated independently", () => {
  const baseMap = { ...tracked("memory", 400), ...tracked("logs", 4) };
  // 4 of 400 in memory is harmless; 3 of 4 in logs is not, and the finding
  // must name logs rather than the destination that happens to sort first.
  const finding = findMassDelete(
    config(),
    baseMap,
    [...paths("memory", 4), ...paths("logs", 3)],
    DEFAULT_MASS_DELETE_GUARD
  );
  assert.deepEqual(finding, { destination: "logs", deleted: 3, tracked: 4, rule: "proportional" });
});

test("findMassDelete: a tombstone in the base map is not a tracked file", () => {
  // A base snapshot records a deleted path as null (StateStore's
  // `.meta.json` marker). Counting those as tracked files would inflate the
  // denominator and make the proportional rule quietly permissive.
  const baseMap: Record<string, string | null> = { ...tracked("logs", 4) };
  for (const key of paths("logs", 40, 100)) {
    baseMap[key] = null;
  }

  const finding = findMassDelete(config(), baseMap, paths("logs", 3), DEFAULT_MASS_DELETE_GUARD);
  assert.deepEqual(finding, { destination: "logs", deleted: 3, tracked: 4, rule: "proportional" });
});

// D-007 (R1 medium): the absolute rule is per destination, so a plan that
// deletes 20 files in each of three destinations deletes 60 files while
// tripping nothing. AC-003's text is unqualified about the count.
test("findMassDelete: 20 deletions in each of three destinations trip the plan-wide total", () => {
  const guardConfig = threeDestinationConfig();
  const baseMap = {
    ...tracked("memory", 400),
    ...tracked("logs", 400),
    ...tracked("archive", 400)
  };
  const deleted = [...paths("memory", 20), ...paths("logs", 20), ...paths("archive", 20)];

  // Negative control for the reading: each destination on its own is
  // acceptable, so nothing but the total can be what refuses this plan.
  for (const destination of ["memory", "logs", "archive"]) {
    assert.equal(
      findMassDelete(guardConfig, baseMap, paths(destination, 20), DEFAULT_MASS_DELETE_GUARD),
      null,
      `20 of 400 in '${destination}' alone must stay acceptable`
    );
  }

  assert.deepEqual(findMassDelete(guardConfig, baseMap, deleted, DEFAULT_MASS_DELETE_GUARD), {
    destination: null,
    deleted: 60,
    tracked: 1200,
    rule: "total"
  });
});

test("findMassDelete: 15 plus 10 deletions across two destinations trip the plan-wide total", () => {
  const guardConfig = threeDestinationConfig();
  const baseMap = { ...tracked("memory", 400), ...tracked("logs", 400) };

  assert.deepEqual(
    findMassDelete(
      guardConfig,
      baseMap,
      [...paths("memory", 15), ...paths("logs", 10)],
      DEFAULT_MASS_DELETE_GUARD
    ),
    { destination: null, deleted: 25, tracked: 800, rule: "total" }
  );
});

test("findMassDelete: the plan-wide total fires strictly above maxFiles, not at it", () => {
  const guardConfig = threeDestinationConfig();
  const baseMap = { ...tracked("memory", 400), ...tracked("logs", 400) };

  // Exactly 20 in total is at the limit, not over it.
  assert.equal(
    findMassDelete(
      guardConfig,
      baseMap,
      [...paths("memory", 10), ...paths("logs", 10)],
      DEFAULT_MASS_DELETE_GUARD
    ),
    null
  );

  assert.deepEqual(
    findMassDelete(
      guardConfig,
      baseMap,
      [...paths("memory", 11), ...paths("logs", 10)],
      DEFAULT_MASS_DELETE_GUARD
    ),
    { destination: null, deleted: 21, tracked: 800, rule: "total" }
  );
});

test("assertNoMassDelete: the plan-wide total names the count and all destinations", () => {
  const guardConfig = threeDestinationConfig();
  const baseMap = {
    ...tracked("memory", 400),
    ...tracked("logs", 400),
    ...tracked("archive", 400)
  };

  assert.throws(
    () =>
      assertNoMassDelete({
        config: guardConfig,
        baseMap,
        deletedPaths: [...paths("memory", 20), ...paths("logs", 20), ...paths("archive", 20)]
      }),
    (error: Error & { exitCode?: number }) => {
      assert.equal(error.name, "MassDeleteRefusedError");
      assert.equal(error.exitCode, 5);
      assert.match(error.message, /60 file\(s\) across all sync destinations/);
      assert.match(error.message, /60 of 1200 tracked/);
      return true;
    }
  );
});

test("assertNoMassDelete: throws with the counts, the destination and the flag", () => {
  assert.throws(
    () =>
      assertNoMassDelete({
        config: config(),
        baseMap: tracked("memory", 404),
        deletedPaths: paths("memory", 404)
      }),
    (error: Error & { exitCode?: number }) => {
      assert.equal(error.name, "MassDeleteRefusedError");
      assert.equal(error.exitCode, 5);
      assert.match(error.message, /404 file\(s\) under 'memory'/);
      assert.match(error.message, /--allow-mass-delete/);
      assert.match(error.message, /Nothing was pushed/);
      return true;
    }
  );
});

test("assertNoMassDelete: allowMassDelete skips the check entirely", () => {
  assertNoMassDelete({
    config: config(),
    baseMap: tracked("memory", 404),
    deletedPaths: paths("memory", 404),
    allowMassDelete: true
  });
});

test("assertNoMassDelete: profile thresholds replace the defaults", () => {
  const tightened = config({ massDeleteGuard: { maxFiles: 2, maxRatio: 1 } });
  assert.throws(
    () =>
      assertNoMassDelete({
        config: tightened,
        baseMap: tracked("memory", 400),
        deletedPaths: paths("memory", 3)
      }),
    /limit of 2 file\(s\)/
  );

  const loosened = config({ massDeleteGuard: { maxFiles: 500, maxRatio: 1 } });
  assertNoMassDelete({
    config: loosened,
    baseMap: tracked("memory", 404),
    deletedPaths: paths("memory", 404)
  });
});

test("findUnreliableCheckout: an empty destination the base snapshot knows is an anomaly", () => {
  const finding = findUnreliableCheckout(config(), tracked("memory", 404), {}, "c6be19d");
  assert.deepEqual(finding, {
    destination: "memory",
    tracked: 404,
    present: 0,
    lost: 404,
    rule: "absolute"
  });
});

test("findUnreliableCheckout: a remote with no commits is never an anomaly", () => {
  assert.equal(findUnreliableCheckout(config(), tracked("memory", 404), {}, null), null);
});

test("findUnreliableCheckout: a destination that tracked a single file is an ordinary deletion", () => {
  assert.equal(
    findUnreliableCheckout(config(), tracked("logs", 1), {}, "c6be19d"),
    null
  );
});

test("findUnreliableCheckout: one destination still present does not excuse another that vanished", () => {
  const baseMap = { ...tracked("memory", 12), ...tracked("logs", 3) };
  const remoteMap = tracked("memory", 12);
  assert.deepEqual(findUnreliableCheckout(config(), baseMap, remoteMap, "c6be19d"), {
    destination: "logs",
    tracked: 3,
    present: 0,
    lost: 3,
    rule: "proportional"
  });
});

test("findUnreliableCheckout: a fully present checkout passes", () => {
  const baseMap = { ...tracked("memory", 12), ...tracked("logs", 3) };
  assert.equal(findUnreliableCheckout(config(), baseMap, { ...baseMap }, "c6be19d"), null);
});

// R1 critical (D-006): the original check fired only on a destination that
// came back with EXACTLY zero files, so a working copy that kept a single
// file walked past it and its deletion plan was published. A partial wipe is
// not a milder failure than a total one, and the same thresholds that decide
// whether a deletion PLAN is plausible decide whether a checkout is.
test("findUnreliableCheckout: a destination that kept one of twelve files is an anomaly", () => {
  const baseMap = tracked("memory", 12);
  assert.deepEqual(findUnreliableCheckout(config(), baseMap, tracked("memory", 1), "c6be19d"), {
    destination: "memory",
    tracked: 12,
    present: 1,
    lost: 11,
    rule: "proportional"
  });
});

test("findUnreliableCheckout: the partial-wipe shape at 50 and at 400 tracked files is an anomaly", () => {
  for (const count of [50, 400]) {
    assert.deepEqual(
      findUnreliableCheckout(config(), tracked("memory", count), tracked("memory", 1), "c6be19d"),
      {
        destination: "memory",
        tracked: count,
        present: 1,
        lost: count - 1,
        rule: "absolute"
      },
      `a checkout keeping 1 of ${count} files must be refused`
    );
  }
});

test("findUnreliableCheckout: a loss inside both thresholds is still an ordinary remote change", () => {
  // 10 of 100 lost is exactly the ratio and well under the absolute limit:
  // at the threshold, not over it. This is the boundary that keeps a
  // genuine, gradual remote deletion applying instead of being refused as an
  // unreliable checkout.
  const baseMap = tracked("memory", 100);
  const remoteMap = tracked("memory", 100);
  for (const key of paths("memory", 10)) {
    delete remoteMap[key];
  }
  assert.equal(findUnreliableCheckout(config(), baseMap, remoteMap, "c6be19d"), null);
});

test("findUnreliableCheckout: files the checkout gained do not mask the ones it lost", () => {
  // Counting tracked-minus-present instead of the lost paths themselves
  // would report zero here: 12 tracked, 12 present, but none of them the
  // same file.
  const baseMap = tracked("memory", 12);
  const remoteMap = tracked("memory", 12, 100);
  assert.deepEqual(findUnreliableCheckout(config(), baseMap, remoteMap, "c6be19d"), {
    destination: "memory",
    tracked: 12,
    present: 12,
    lost: 12,
    rule: "proportional"
  });
});

test("findUnreliableCheckout: profile thresholds apply to the checkout check too", () => {
  const loosened = config({ massDeleteGuard: { maxFiles: 500, maxRatio: 1 } });
  assert.equal(
    findUnreliableCheckout(loosened, tracked("memory", 404), tracked("memory", 1), "c6be19d"),
    null,
    "a profile that accepts a 100 percent deletion plan also accepts the checkout that produces it"
  );
});

test("assertReliableCheckout: throws with the destination, the count and the remote head", () => {
  assert.throws(
    () =>
      assertReliableCheckout({
        config: config(),
        baseMap: tracked("memory", 404),
        remoteMap: {},
        remoteHead: "c6be19d"
      }),
    (error: Error & { exitCode?: number }) => {
      assert.equal(error.name, "UnreliableCheckoutError");
      assert.equal(error.exitCode, 7);
      assert.match(error.message, /no files under 'memory'/);
      assert.match(error.message, /404 file\(s\)/);
      assert.match(error.message, /c6be19d/);
      assert.match(error.message, /Nothing was deleted locally/);
      return true;
    }
  );
});

test("assertReliableCheckout: a partial loss names how many files are missing", () => {
  assert.throws(
    () =>
      assertReliableCheckout({
        config: config(),
        baseMap: tracked("memory", 400),
        remoteMap: tracked("memory", 1),
        remoteHead: "c6be19d"
      }),
    (error: Error & { exitCode?: number }) => {
      assert.equal(error.name, "UnreliableCheckoutError");
      assert.equal(error.exitCode, 7);
      assert.match(error.message, /missing 399 of the 400 file\(s\)/);
      assert.match(error.message, /1 still present/);
      return true;
    }
  );
});

// D-008: the refusal used to end with "re-run with --allow-mass-delete",
// which is a blanket bypass of both guards on both the pull and the push
// side, i.e. the one instruction that turns a wiped working copy into a
// published wipe. D-004: the flag is an override of the PLAN guard only, so
// it must not reach this check at all.
test("assertReliableCheckout: the refusal never recommends --allow-mass-delete", () => {
  assert.throws(
    () =>
      assertReliableCheckout({
        config: config(),
        baseMap: tracked("memory", 404),
        remoteMap: {},
        remoteHead: "c6be19d"
      }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /allow-mass-delete/);
      assert.match(error.message, /re-run the command/);
      assert.match(error.message, /restore/);
      return true;
    }
  );
});

test("assertReliableCheckout: allowMassDelete does not skip the check", () => {
  assert.throws(
    () =>
      assertReliableCheckout({
        config: config(),
        baseMap: tracked("memory", 404),
        remoteMap: {},
        remoteHead: "c6be19d",
        allowMassDelete: true
      }),
    (error: Error & { exitCode?: number }) => {
      assert.equal(error.name, "UnreliableCheckoutError");
      assert.equal(error.exitCode, 7);
      return true;
    }
  );
});

// A staged deletion that no configured destination claims (a path outside
// repositorySubdir in the same remote repository) has no base denominator,
// so neither per-destination rule can see it, while `git add -A` publishes
// it exactly like any other. Only the absolute plan-wide rule applies to it.
function outsidePaths(count: number): string[] {
  const result: string[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push(`other/file-${String(index).padStart(3, "0")}.md`);
  }
  return result;
}

test("findMassDelete: deletions no destination claims count toward the plan-wide total", () => {
  const guardConfig = config();
  const baseMap = tracked("memory", 400);

  // Nothing inside a configured destination is deleted at all, so the
  // plan-wide total is the only rule that can fire here.
  assert.deepEqual(findMassDelete(guardConfig, baseMap, [], DEFAULT_MASS_DELETE_GUARD, outsidePaths(50)), {
    destination: null,
    deleted: 50,
    tracked: 400,
    rule: "total"
  });

  // Negative control: exactly 20 is at the limit, not over it.
  assert.equal(
    findMassDelete(guardConfig, baseMap, [], DEFAULT_MASS_DELETE_GUARD, outsidePaths(20)),
    null
  );

  // They add to the mapped deletions rather than replacing them: 15 inside
  // 'memory' is acceptable on its own (under both per-destination rules) and
  // 6 outside is acceptable on its own, 21 together is not.
  assert.equal(
    findMassDelete(guardConfig, baseMap, paths("memory", 15), DEFAULT_MASS_DELETE_GUARD),
    null
  );
  assert.deepEqual(
    findMassDelete(guardConfig, baseMap, paths("memory", 15), DEFAULT_MASS_DELETE_GUARD, outsidePaths(6)),
    { destination: null, deleted: 21, tracked: 400, rule: "total" }
  );
});

test("assertNoMassDelete: a refusal driven by unclaimed paths names them and where they are", () => {
  assert.throws(
    () =>
      assertNoMassDelete({
        config: config(),
        baseMap: tracked("memory", 400),
        deletedPaths: [],
        unmappedDeletedPaths: outsidePaths(50)
      }),
    (error: Error & { exitCode?: number }) => {
      assert.equal(error.name, "MassDeleteRefusedError");
      assert.equal(error.exitCode, 5);
      assert.match(error.message, /50 file\(s\)/);
      assert.match(error.message, /50 outside 'shared\/'/);
      return true;
    }
  );
});

test("assertNoMassDelete: allowMassDelete also covers unclaimed paths", () => {
  assertNoMassDelete({
    config: config(),
    baseMap: tracked("memory", 400),
    deletedPaths: [],
    unmappedDeletedPaths: outsidePaths(50),
    allowMassDelete: true
  });
});
