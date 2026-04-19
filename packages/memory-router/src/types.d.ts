// Global ambient types for memory-router. Declared without import/export at
// the top level so TypeScript treats this as a script and makes every name
// globally available within the package — callers never `import type` from
// here, which keeps all runtime files free of ES-module syntax and safe to
// load under Node's `--experimental-strip-types`.

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
  globs?: string[];
  keywords?: string[];
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
  recentFiles?: string[];
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
