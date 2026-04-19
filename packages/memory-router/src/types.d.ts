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

  interface MemoryFrontmatter {
    name: string;
    description: string;
    type: MemoryType;
    topics?: Topic[];
    severity?: Severity;
    triggers?: MemoryTriggers;
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
