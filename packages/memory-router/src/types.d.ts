// Global ambient types for memory-router. Declared inside `declare global`
// so they remain visible from both script files (runtime .ts with
// module.exports) and module files (test files under moduleDetection:force).
// The trailing `export {}` marks this file as a module, which is required
// for `declare global` to be legal.

declare global {
  type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
  type Severity = 'critical' | 'normal' | 'low';
  type Topic =
    | 'deployment'
    | 'workflow'
    | 'destructive_ops'
    | 'security'
    | 'testing';
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

  interface MemoryFrontmatter {
    name: string;
    description: string;
    type: MemoryType;
    topics?: Topic[];
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

  interface ToolCall {
    name: string;
    args: Record<string, unknown>;
  }

  interface RouterContext {
    prompt?: string;
    cwd?: string;
    tool?: ToolCall;
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
