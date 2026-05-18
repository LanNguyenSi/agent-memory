const { Command } = require("commander");
const { formatErrorMessage, isCliError } = require("./errors");
const { registerConfigCommand } = require("./commands/config");
const { registerRestoreCommand } = require("./commands/restore");
const { registerRunCommand } = require("./commands/run");
const { registerWatchCommand } = require("./commands/watch");

const program = new Command();

program
  .name("agent-memory-sync")
  .description(
    "A CLI tool that syncs agent memory files across multiple OpenClaw instances via a central Git repository."
  )
  .version("0.1.0");

registerRunCommand(program);
registerConfigCommand(program);
registerWatchCommand(program);
registerRestoreCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`error: ${formatErrorMessage(error)}\n`);
  process.exitCode =
    typeof (error as { exitCode?: unknown }).exitCode === "number"
      ? (error as { exitCode: number }).exitCode
      : 1;
});
