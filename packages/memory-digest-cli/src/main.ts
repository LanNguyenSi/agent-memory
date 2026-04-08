import { Command } from "commander";
import { registerConfigCommand } from "./commands/config.js";
import { registerRunCommand } from "./commands/run.js";
import { registerGenerateCommand } from "./commands/generate.js";

const program = new Command();

program
  .name("memory-digest-cli")
  .description(
    "A CLI tool to generate daily memory digests from markdown files, extracting key insights and creating summaries for AI consciousness continuity",
  )
  .version("0.1.0");

registerGenerateCommand(program);
registerRunCommand(program);
registerConfigCommand(program);

program.parseAsync(process.argv).catch((error: Error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
