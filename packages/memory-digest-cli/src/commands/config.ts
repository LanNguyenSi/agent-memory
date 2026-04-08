import { Command } from "commander";
import { defaultConfigPath, loadConfig } from "../config/loader.js";

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("Inspect resolved configuration");

  config
    .command("show")
    .description("Print the resolved configuration")
    .option("--config <path>", "Override config file path")
    .action(async (options: { config?: string }) => {
      const resolved = await loadConfig(options.config);
      process.stdout.write(
        `${JSON.stringify(
          {
            path: resolved.path,
            defaultPath: defaultConfigPath(),
            settings: resolved.settings,
          },
          null,
          2,
        )}\n`,
      );
    });
}
