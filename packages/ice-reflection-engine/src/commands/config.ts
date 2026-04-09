import { Command } from "commander";
import * as path from "path";
import * as os from "os";

const DEFAULT_CONFIG = {
  dir: path.join(os.homedir(), ".openclaw", "workspace", "memory"),
  output: path.join(os.homedir(), ".openclaw", "workspace", "MEMORY.md"),
  threshold: 0.6,
};

export function createConfigCommand(): Command {
  return new Command("config")
    .description("Show configuration defaults")
    .action(() => {
      console.log("ice-reflection-engine — default configuration:");
      console.log();
      console.log("  dir:       ", DEFAULT_CONFIG.dir);
      console.log("  output:    ", DEFAULT_CONFIG.output);
      console.log("  threshold: ", DEFAULT_CONFIG.threshold);
      console.log();
      console.log("Override with CLI flags: --dir, --output, --threshold");
    });
}
