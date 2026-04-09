const { existsSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");
const TOML = require("toml");
const YAML = require("yaml");

export interface CliConfig {
  outputFormat: "text" | "json" | "yaml";
  verbose: boolean;
}

export interface LoadedConfig {
  path: string | null;
  settings: CliConfig;
}

const DEFAULT_CONFIG: CliConfig = {
  outputFormat: "text",
  verbose: false
};

export function defaultConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const baseDir = xdgConfigHome || path.join(homedir(), ".config");
  return path.join(baseDir, "ice-reflection-engine", "config.json");
}

export async function loadConfig(overridePath?: string): Promise<LoadedConfig> {
  const candidatePath = overridePath || defaultConfigPath();
  if (!existsSync(candidatePath)) {
    return {
      path: null,
      settings: DEFAULT_CONFIG
    };
  }

  const raw = readFileSync(candidatePath, "utf8");
  const parsed = parseConfig(raw);

  return {
    path: candidatePath,
    settings: {
      ...DEFAULT_CONFIG,
      ...parsed
    }
  };
}

function parseConfig(raw: string): Partial<CliConfig> {
  return JSON.parse(raw) as Partial<CliConfig>;
}

module.exports = {
  defaultConfigPath,
  loadConfig
};
