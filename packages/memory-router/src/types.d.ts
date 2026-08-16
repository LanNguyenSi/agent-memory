// Global ambient types for memory-router. Declared inside `declare global`
// so they remain visible from both script files (runtime .ts with
// module.exports) and module files (test files under moduleDetection:force).
// The trailing `export {}` marks this file as a module, which is required
// for `declare global` to be legal.

declare global {
  type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
  type Severity = 'critical' | 'normal' | 'low';
  /**
   * No longer a closed union. The valid set of topics is corpus-controlled
   * at runtime: the built-in 5-topic default in `topic-patterns.ts`, unless
   * `<memoryDir>/topics.yml` overrides it (see `src/vocab/loader.ts`). A
   * memory's `topics:` values are validated against the loaded vocabulary
   * at match/lint time, not by the type system.
   */
  type Topic = string;
  type GateName = 'topic' | 'tool' | 'confidence';

  interface MemoryTriggers {
    tools?: string[];
    command_pattern?: string;
  }

  type MemoryReferenceKind = 'path' | 'symbol' | 'flag';

  interface MemoryReference {
    kind: MemoryReferenceKind;
    value: string;
    /** Directory to resolve `value` against. Defaults to process.cwd(). */
    repoRoot?: string;
  }

  /**
   * Claude Code auto-memory nests `type`/`topics` under `metadata.`.
   * The loader resolves both locations (top-level wins) and returns a
   * normalized frontmatter, so consumers never read `metadata` themselves.
   */
  interface MemoryMetadata {
    type?: MemoryType;
    topics?: Topic[];
    [key: string]: unknown;
  }

  interface MemoryFrontmatter {
    name: string;
    description: string;
    type: MemoryType;
    topics?: Topic[];
    metadata?: MemoryMetadata;
    severity?: Severity;
    triggers?: MemoryTriggers;
    /**
     * Optional sanity-check claims. When any entry's `value` resolves
     * to something that no longer exists, the router prefixes this
     * memory's injected context with "⚠️ stale:" so the model knows
     * to treat it with skepticism (the memory is NOT suppressed).
     */
    verify?: MemoryReference[];
  }

  interface Memory {
    id: string;
    path: string;
    frontmatter: MemoryFrontmatter;
    body: string;
  }

  /**
   * One directory-walk entry from src/memory/loader.ts's
   * loadMemoriesFromDirWithRejects (the read-only sibling walk documented
   * in the comment above loadMemoriesFromDir): every file the walk visits,
   * accepted or rejected. Declared globally and independently of loader.ts's
   * own (narrower) internal ParseResult type, deliberately NOT derived
   * from it via `Omit`/`Extract`, so a producer-side field rename in
   * loader.ts must satisfy this contract directly instead of silently
   * drifting in step with it. `ok` is a real discriminant: consumers
   * (consolidate/schema-metrics.ts) narrow on `if (!entry.ok)` instead of
   * asserting `entry.memory!`.
   */
  type MemoryScanEntry =
    | {
        path: string;
        id: string;
        ok: true;
        memory: Memory;
        hasTopLevelType: boolean;
        hasMetadataType: boolean;
      }
    | { path: string; id: string; ok: false; reason: string };

  interface ToolCall {
    name: string;
    args: Record<string, unknown>;
  }

  interface RouterContext {
    prompt?: string;
    cwd?: string;
    tool?: ToolCall;
    /**
     * The memory dir this ctx's prompt/tool call is being resolved against.
     * The Topic Gate (src/gates/topic.ts) prefers this over the
     * `MEMORY_ROUTER_DIR` env var when loading `<memoryDir>/topics.yml` —
     * the env var stays as a fallback for callers that still can't thread a
     * dir (only the hooks/** binaries today, which set the env var before
     * invoking the router and are out of scope here). Optional and unset
     * by every caller that doesn't (yet) know its own dir.
     */
    memoryDir?: string;
  }

  interface GateHit {
    memory: Memory;
    gate: GateName;
    score: number;
    reason: string;
  }

  interface Gate {
    readonly name: GateName;
    evaluate(ctx: RouterContext, memories: Memory[]): GateHit[];
  }

  interface ResolveOptions {
    gates?: Gate[];
    maxHits?: number;
  }
}

export {};
