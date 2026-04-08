const {
  defaultConfigPath,
  getConfigValue,
  listConfigKeys,
  loadConfig,
  readPersistedConfig,
  resetPersistedConfig,
  setConfigValue,
  writePersistedConfig
} = require("../config/loader");
const { CliError } = require("../errors");
const { writeResult } = require("../output");

function registerConfigCommand(program: import("commander").Command): void {
  const config = program.command("config").description("Inspect and modify local configuration");

  config
    .command("show")
    .description("Print the resolved configuration")
    .option("--config <path>", "Override config file path")
    .option("-o, --output <format>", "Output format: text, json, yaml", "json")
    .action(async (options: { config?: string; output: "text" | "json" | "yaml" }) => {
      const resolved = await loadConfig(options.config);
      const payload = {
        path: resolved.path,
        defaultPath: defaultConfigPath(),
        settings: resolved.settings
      };

      writeResult(payload, options.output, () => JSON.stringify(payload, null, 2));
    });

  config
    .command("get")
    .description("Read a persisted config value")
    .argument("<key>", `Config key (${listConfigKeys().join(", ")})`)
    .option("--config <path>", "Override config file path")
    .action((key: string, options: { config?: string }) => {
      const persisted = readPersistedConfig(options.config);
      const value = getConfigValue(persisted.settings, key);

      if (typeof value === "undefined") {
        throw new CliError(`config key '${key}' is not set in ${persisted.path}.`, 5);
      }

      process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
    });

  config
    .command("set")
    .description("Write a persisted config value")
    .argument("<key>", `Config key (${listConfigKeys().join(", ")})`)
    .argument("<value>", "Value to persist")
    .option("--config <path>", "Override config file path")
    .action((key: string, value: string, options: { config?: string }) => {
      const persisted = readPersistedConfig(options.config);
      const updated = setConfigValue(persisted.settings, key, value);
      const targetPath = writePersistedConfig(updated, options.config);
      process.stdout.write(`${targetPath}\n`);
    });

  config
    .command("reset")
    .description("Remove the persisted config file")
    .option("--config <path>", "Override config file path")
    .action((options: { config?: string }) => {
      const targetPath = resetPersistedConfig(options.config);
      process.stdout.write(`${targetPath}\n`);
    });
}

module.exports = { registerConfigCommand };
