const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { homedir, hostname } = require("node:os");
const path = require("node:path");
const { CliError } = require("../errors");
const { DEFAULT_REACHABILITY_TIMEOUT_MS } = require("../memory-sync/reachability");

type OutputFormat = "text" | "json" | "yaml";
type RunMode = "sync" | "push" | "pull";
type ConflictStrategy = "inline-markers" | "local-wins" | "remote-wins";

interface SyncPathConfig {
  source: string;
  destination?: string;
  kind?: "file" | "directory";
  required?: boolean;
}

interface UserConfig {
  outputFormat?: OutputFormat;
  verbose?: boolean;
  quiet?: boolean;
  color?: boolean;
  profile?: string;
  rootDir?: string;
  remoteUrl?: string;
  branch?: string;
  repositorySubdir?: string;
  stateDir?: string;
  schedule?: string | null;
  conflictStrategy?: ConflictStrategy;
  syncPaths?: SyncPathConfig[];
  gitBinary?: string;
  reachabilityTimeoutMs?: number;
  reachabilityCheckCommand?: string[] | null;
}

interface LoadedConfig {
  path: string;
  settings: UserConfig;
}

interface RunConfig extends UserConfig {
  outputFormat: OutputFormat;
  verbose: boolean;
  quiet: boolean;
  color: boolean;
  profile: string;
  rootDir: string;
  remoteUrl: string;
  branch: string;
  repositorySubdir: string;
  stateDir: string;
  schedule: string | null;
  conflictStrategy: ConflictStrategy;
  syncPaths: SyncPathConfig[];
  gitBinary: string;
  mode: RunMode;
  reachabilityTimeoutMs: number;
  reachabilityCheckCommand: string[] | null;
}

interface RunConfigOverrides {
  outputFormat?: OutputFormat;
  verbose?: boolean;
  quiet?: boolean;
  color?: boolean;
  profile?: string;
  rootDir?: string;
  remoteUrl?: string;
  branch?: string;
  repositorySubdir?: string;
  stateDir?: string;
  schedule?: string | null;
  conflictStrategy?: ConflictStrategy;
  syncPaths?: SyncPathConfig[];
  gitBinary?: string;
  mode?: RunMode;
  reachabilityTimeoutMs?: number;
  reachabilityCheckCommand?: string[] | null;
}

const DEFAULT_SYNC_PATHS: SyncPathConfig[] = [
  { source: "MEMORY.md", destination: "MEMORY.md", kind: "file" },
  { source: "daily", destination: "daily", kind: "directory" },
  { source: "logs", destination: "logs", kind: "directory" }
];

const DEFAULTS: Omit<RunConfig, "repositorySubdir" | "stateDir" | "remoteUrl" | "mode"> = {
  outputFormat: "text",
  verbose: false,
  quiet: false,
  color: !process.env.NO_COLOR,
  profile: "default",
  rootDir: process.cwd(),
  branch: "main",
  schedule: null,
  conflictStrategy: "inline-markers",
  syncPaths: DEFAULT_SYNC_PATHS,
  gitBinary: "git",
  reachabilityTimeoutMs: DEFAULT_REACHABILITY_TIMEOUT_MS,
  reachabilityCheckCommand: null
};

function defaultConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const baseDir = xdgConfigHome || path.join(homedir(), ".config");
  return path.join(baseDir, "agent-memory-sync", "config.json");
}

async function loadConfig(overridePath?: string): Promise<LoadedConfig> {
  const configPath = resolveConfigPath(overridePath);
  if (!existsSync(configPath)) {
    return {
      path: configPath,
      settings: {}
    };
  }

  const raw = readFileSync(configPath, "utf8");
  return {
    path: configPath,
    settings: normalizeUserConfig(JSON.parse(raw) as Record<string, unknown>)
  };
}

function resolveRunConfig(loaded: LoadedConfig, overrides: RunConfigOverrides = {}): RunConfig {
  const normalizedOverrides = dropUndefined(overrides as Record<string, unknown>);
  const merged = {
    ...DEFAULTS,
    ...readEnvConfig(),
    ...loaded.settings,
    ...normalizedOverrides
  } as RunConfig;

  const profile = merged.profile || "default";
  const rootDir = path.resolve(merged.rootDir || process.cwd());
  const agentId = sanitizeSegment(process.env.AGENT_MEMORY_SYNC_AGENT_ID || hostname());
  const repositorySubdir = normalizeRelativePath(
    merged.repositorySubdir || path.posix.join("agents", agentId)
  );
  const stateDir = path.resolve(
    rootDir,
    merged.stateDir || path.join(".agent-memory-sync", profile)
  );

  return {
    ...merged,
    outputFormat: validateOutputFormat(merged.outputFormat),
    mode: validateMode(merged.mode || "sync"),
    profile,
    rootDir,
    remoteUrl: merged.remoteUrl || "",
    branch: merged.branch || "main",
    repositorySubdir,
    stateDir,
    schedule: merged.schedule || null,
    conflictStrategy: validateConflictStrategy(merged.conflictStrategy),
    syncPaths: normalizeSyncPathConfigList(merged.syncPaths),
    gitBinary: merged.gitBinary || "git",
    reachabilityTimeoutMs: validatePositiveInteger(
      merged.reachabilityTimeoutMs,
      "reachabilityTimeoutMs",
      DEFAULT_REACHABILITY_TIMEOUT_MS
    ),
    reachabilityCheckCommand: normalizeReachabilityCheckCommand(merged.reachabilityCheckCommand)
  };
}

function requireRemoteUrl(config: RunConfig): RunConfig {
  if (!config.remoteUrl) {
    throw new CliError(
      "remote URL is not configured. Set 'remoteUrl' in the config file or pass --remote.",
      3
    );
  }

  return config;
}

function readPersistedConfig(overridePath?: string): { path: string; settings: UserConfig } {
  const configPath = resolveConfigPath(overridePath);
  if (!existsSync(configPath)) {
    return { path: configPath, settings: {} };
  }

  return {
    path: configPath,
    settings: normalizeUserConfig(JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
  };
}

function writePersistedConfig(settings: UserConfig, overridePath?: string): string {
  const configPath = resolveConfigPath(overridePath);
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return configPath;
}

function resetPersistedConfig(overridePath?: string): string {
  const configPath = resolveConfigPath(overridePath);
  if (existsSync(configPath)) {
    rmSync(configPath);
  }
  return configPath;
}

function getConfigValue(settings: UserConfig, key: string): unknown {
  validateConfigKey(key);
  return (settings as Record<string, unknown>)[key];
}

function setConfigValue(settings: UserConfig, key: string, value: string): UserConfig {
  validateConfigKey(key);

  const next = { ...settings };
  (next as Record<string, unknown>)[key] = parseConfigValue(key, value);
  return next;
}

function listConfigKeys(): string[] {
  return [
    "outputFormat",
    "verbose",
    "quiet",
    "color",
    "profile",
    "rootDir",
    "remoteUrl",
    "branch",
    "repositorySubdir",
    "stateDir",
    "schedule",
    "conflictStrategy",
    "syncPaths",
    "gitBinary",
    "reachabilityTimeoutMs",
    "reachabilityCheckCommand"
  ];
}

function resolveConfigPath(overridePath?: string): string {
  const candidate =
    overridePath ||
    process.env.AGENT_MEMORY_SYNC_CONFIG ||
    defaultConfigPath();

  return path.resolve(candidate);
}

function readEnvConfig(): UserConfig {
  const env = process.env;
  const config: UserConfig = {};

  if (env.AGENT_MEMORY_SYNC_OUTPUT_FORMAT) {
    config.outputFormat = validateOutputFormat(env.AGENT_MEMORY_SYNC_OUTPUT_FORMAT as OutputFormat);
  }
  if (env.AGENT_MEMORY_SYNC_VERBOSE) {
    config.verbose = parseBoolean(env.AGENT_MEMORY_SYNC_VERBOSE);
  }
  if (env.AGENT_MEMORY_SYNC_QUIET) {
    config.quiet = parseBoolean(env.AGENT_MEMORY_SYNC_QUIET);
  }
  if (env.AGENT_MEMORY_SYNC_COLOR) {
    config.color = parseBoolean(env.AGENT_MEMORY_SYNC_COLOR);
  }
  if (env.AGENT_MEMORY_SYNC_PROFILE) {
    config.profile = env.AGENT_MEMORY_SYNC_PROFILE;
  }
  if (env.AGENT_MEMORY_SYNC_ROOT_DIR) {
    config.rootDir = env.AGENT_MEMORY_SYNC_ROOT_DIR;
  }
  if (env.AGENT_MEMORY_SYNC_REMOTE_URL) {
    config.remoteUrl = env.AGENT_MEMORY_SYNC_REMOTE_URL;
  }
  if (env.AGENT_MEMORY_SYNC_BRANCH) {
    config.branch = env.AGENT_MEMORY_SYNC_BRANCH;
  }
  if (env.AGENT_MEMORY_SYNC_REPOSITORY_SUBDIR) {
    config.repositorySubdir = env.AGENT_MEMORY_SYNC_REPOSITORY_SUBDIR;
  }
  if (env.AGENT_MEMORY_SYNC_STATE_DIR) {
    config.stateDir = env.AGENT_MEMORY_SYNC_STATE_DIR;
  }
  if (env.AGENT_MEMORY_SYNC_SCHEDULE) {
    config.schedule = env.AGENT_MEMORY_SYNC_SCHEDULE;
  }
  if (env.AGENT_MEMORY_SYNC_CONFLICT_STRATEGY) {
    config.conflictStrategy = validateConflictStrategy(
      env.AGENT_MEMORY_SYNC_CONFLICT_STRATEGY as ConflictStrategy
    );
  }
  if (env.AGENT_MEMORY_SYNC_SYNC_PATHS) {
    config.syncPaths = normalizeSyncPathConfigList(
      JSON.parse(env.AGENT_MEMORY_SYNC_SYNC_PATHS) as SyncPathConfig[]
    );
  }
  if (env.AGENT_MEMORY_SYNC_GIT_BINARY) {
    config.gitBinary = env.AGENT_MEMORY_SYNC_GIT_BINARY;
  }
  if (env.AGENT_MEMORY_SYNC_REACHABILITY_TIMEOUT_MS) {
    config.reachabilityTimeoutMs = validatePositiveInteger(
      Number(env.AGENT_MEMORY_SYNC_REACHABILITY_TIMEOUT_MS),
      "AGENT_MEMORY_SYNC_REACHABILITY_TIMEOUT_MS",
      DEFAULT_REACHABILITY_TIMEOUT_MS
    );
  }
  if (env.AGENT_MEMORY_SYNC_REACHABILITY_CHECK_COMMAND) {
    // Both failure modes below (invalid JSON syntax, and valid JSON of the
    // wrong shape — including a falsy JSON value like `false`, which would
    // otherwise slip past normalizeReachabilityCheckCommand's `if (!value)`
    // guard silently) are caught here and turned into one visible warning
    // instead of either a silent no-op (the live incident: `=false` quietly
    // ran the default ssh probe with no explanation) or an uncaught
    // exception that would crash the whole CLI invocation over a value only
    // ever consulted if the remote turns out unreachable. The override is
    // left unset on failure, so config.reachabilityCheckCommand keeps
    // falling through to the config file / default below, same as if the
    // env var had not been set at all.
    try {
      const parsedValue = JSON.parse(env.AGENT_MEMORY_SYNC_REACHABILITY_CHECK_COMMAND);
      // JSON.parse alone would happily accept any JSON value (a bare
      // `false`, a number, a plain object, ...), and normalizeReachability
      // CheckCommand's `if (!value) return null;` guard would then silently
      // treat any *falsy* one of those (false, 0, "") as "not set" without
      // ever reaching its own shape check below — this is exactly how the
      // live incident's `=false` slipped through unnoticed. Requiring the
      // parsed value to already be `null` or an array here, before handing
      // off to the shared normalizer, closes that gap without changing
      // normalizeReachabilityCheckCommand's behavior for its other callers
      // (config file, `config set`), which is unrelated to this env-only fix.
      if (parsedValue !== null && !Array.isArray(parsedValue)) {
        throw new CliError(
          `must be a JSON array of non-empty strings (argv form) or JSON null, got ${typeof parsedValue}.`,
          3
        );
      }
      config.reachabilityCheckCommand = normalizeReachabilityCheckCommand(parsedValue as string[] | null);
    } catch (error) {
      warnUnparsableReachabilityCheckCommandEnv(
        env.AGENT_MEMORY_SYNC_REACHABILITY_CHECK_COMMAND,
        error
      );
    }
  }

  return config;
}

// Always printed (not gated by --quiet/--verbose, which are not resolved
// yet at this point in config loading anyway): a misconfigured reachability
// probe override silently substituting the default is exactly the failure
// mode this warning exists to surface, so it must not itself be silenceable.
function warnUnparsableReachabilityCheckCommandEnv(rawValue: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `warning: ignoring env AGENT_MEMORY_SYNC_REACHABILITY_CHECK_COMMAND='${rawValue}' ` +
      `(${reason}). Expected a JSON array of non-empty strings (argv form), e.g. ` +
      `'["ssh","-o","BatchMode=yes","-o","ConnectTimeout=4","host","true"]'. Falling back to ` +
      `the default reachability probe.\n`
  );
}

function normalizeUserConfig(raw: Record<string, unknown>): UserConfig {
  const normalized: UserConfig = {};
  const aliasMap: Record<string, keyof UserConfig> = {
    output_format: "outputFormat",
    outputFormat: "outputFormat",
    verbose: "verbose",
    quiet: "quiet",
    color: "color",
    profile: "profile",
    root_dir: "rootDir",
    rootDir: "rootDir",
    remote_url: "remoteUrl",
    remoteUrl: "remoteUrl",
    branch: "branch",
    repository_subdir: "repositorySubdir",
    repositorySubdir: "repositorySubdir",
    state_dir: "stateDir",
    stateDir: "stateDir",
    schedule: "schedule",
    conflict_strategy: "conflictStrategy",
    conflictStrategy: "conflictStrategy",
    sync_paths: "syncPaths",
    syncPaths: "syncPaths",
    files: "syncPaths",
    git_binary: "gitBinary",
    gitBinary: "gitBinary",
    reachability_timeout_ms: "reachabilityTimeoutMs",
    reachabilityTimeoutMs: "reachabilityTimeoutMs",
    reachability_check_command: "reachabilityCheckCommand",
    reachabilityCheckCommand: "reachabilityCheckCommand"
  };

  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = aliasMap[key];
    if (!normalizedKey) {
      continue;
    }

    if (normalizedKey === "reachabilityCheckCommand") {
      normalized.reachabilityCheckCommand = normalizeReachabilityCheckCommand(value as string[] | null);
      continue;
    }

    if (normalizedKey === "syncPaths") {
      normalized.syncPaths = normalizeSyncPathConfigList(value as SyncPathConfig[]);
      continue;
    }

    if (normalizedKey === "outputFormat") {
      normalized.outputFormat = validateOutputFormat(value as OutputFormat);
      continue;
    }

    if (normalizedKey === "conflictStrategy") {
      normalized.conflictStrategy = validateConflictStrategy(value as ConflictStrategy);
      continue;
    }

    (normalized as Record<string, unknown>)[normalizedKey] = value;
  }

  return normalized;
}

function normalizeSyncPathConfigList(value?: SyncPathConfig[]): SyncPathConfig[] {
  const list = Array.isArray(value) && value.length > 0 ? value : DEFAULT_SYNC_PATHS;
  return list.map((entry) => {
    if (!entry || typeof entry.source !== "string" || !entry.source) {
      throw new CliError("syncPaths entries must contain a non-empty 'source' field.", 3);
    }

    return {
      source: entry.source,
      destination: entry.destination || entry.source,
      kind: entry.kind,
      required: Boolean(entry.required)
    };
  });
}

function validateOutputFormat(value: OutputFormat): OutputFormat {
  if (value === "text" || value === "json" || value === "yaml") {
    return value;
  }

  throw new CliError(
    `config key 'outputFormat' has invalid value '${String(value)}'. Allowed values: text, json, yaml.`,
    3
  );
}

function validateMode(value: RunMode): RunMode {
  if (value === "sync" || value === "push" || value === "pull") {
    return value;
  }

  throw new CliError(`invalid mode '${String(value)}'. Allowed values: sync, push, pull.`, 2);
}

function validateConflictStrategy(value?: ConflictStrategy): ConflictStrategy {
  if (!value || value === "inline-markers" || value === "local-wins" || value === "remote-wins") {
    return value || "inline-markers";
  }

  throw new CliError(
    `config key 'conflictStrategy' has invalid value '${String(value)}'. Allowed values: inline-markers, local-wins, remote-wins.`,
    3
  );
}

function validatePositiveInteger(value: number | undefined, key: string, fallback: number): number {
  if (typeof value === "undefined") {
    return fallback;
  }

  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new CliError(`config key '${key}' must be a positive integer (milliseconds).`, 3);
  }

  return value;
}

function normalizeReachabilityCheckCommand(value?: string[] | null): string[] | null {
  if (!value) {
    return null;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new CliError(
      "config key 'reachabilityCheckCommand' must be a non-empty array of non-empty strings (argv form).",
      3
    );
  }

  return value.length > 0 ? value : null;
}

function validateConfigKey(key: string): void {
  if (!listConfigKeys().includes(key)) {
    throw new CliError(
      `config key '${key}' is not supported. Supported keys: ${listConfigKeys().join(", ")}.`,
      3
    );
  }
}

function parseConfigValue(key: string, value: string): unknown {
  switch (key) {
    case "verbose":
    case "quiet":
    case "color":
      return parseBoolean(value);
    case "syncPaths":
      return normalizeSyncPathConfigList(JSON.parse(value) as SyncPathConfig[]);
    case "schedule":
      return value === "null" ? null : value;
    case "outputFormat":
      return validateOutputFormat(value as OutputFormat);
    case "conflictStrategy":
      return validateConflictStrategy(value as ConflictStrategy);
    case "reachabilityTimeoutMs":
      return validatePositiveInteger(Number(value), "reachabilityTimeoutMs", DEFAULT_REACHABILITY_TIMEOUT_MS);
    case "reachabilityCheckCommand":
      return value === "null"
        ? null
        : normalizeReachabilityCheckCommand(JSON.parse(value) as string[]);
    default:
      return value;
  }
}

function parseBoolean(value: string): boolean {
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }

  throw new CliError(`could not parse boolean value '${value}'. Use true/false.`, 3);
}

function dropUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => typeof entryValue !== "undefined")
  ) as Partial<T>;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("..")) {
    throw new CliError(`repository subdir '${value}' is invalid.`, 3);
  }
  return normalized;
}

module.exports = {
  DEFAULT_SYNC_PATHS,
  defaultConfigPath,
  loadConfig,
  resolveRunConfig,
  requireRemoteUrl,
  readPersistedConfig,
  writePersistedConfig,
  resetPersistedConfig,
  getConfigValue,
  setConfigValue,
  listConfigKeys
};
