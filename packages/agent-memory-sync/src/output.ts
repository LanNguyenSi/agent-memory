const YAML = require("yaml");

type OutputFormat = "text" | "json" | "yaml";

interface OutputOptions {
  color: boolean;
  quiet: boolean;
  verbose: boolean;
}

function writeResult(data: unknown, format: OutputFormat, renderText?: () => string): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  if (format === "yaml") {
    process.stdout.write(`${YAML.stringify(data)}`);
    return;
  }

  process.stdout.write(`${renderText ? renderText() : String(data)}\n`);
}

function writeInfo(message: string, options: OutputOptions): void {
  if (options.quiet || !options.verbose) {
    return;
  }

  process.stderr.write(`${applyColor(message, "cyan", options)}\n`);
}

function writeWarning(message: string, options: OutputOptions): void {
  if (options.quiet) {
    return;
  }

  process.stderr.write(`${applyColor(`warning: ${message}`, "yellow", options)}\n`);
}

function writeDryRun(message: string, options: OutputOptions): void {
  if (options.quiet) {
    return;
  }

  process.stderr.write(`${applyColor(`[dry-run] ${message}`, "cyan", options)}\n`);
}

// Color applies only when all three hold: the resolved config says color is
// on (CLI --no-color, config file or AGENT_MEMORY_SYNC_COLOR), the NO_COLOR
// environment variable is unset or empty, and stderr is an interactive
// terminal. Decision lives here, in one place, so every writer above honors
// it and a piped/redirected stderr never carries escape codes.
function applyColor(message: string, color: "red" | "yellow" | "green" | "cyan", options: OutputOptions): string {
  if (!options.color || process.env.NO_COLOR || !process.stderr.isTTY) {
    return message;
  }

  const prefix = {
    red: "\u001b[31m",
    yellow: "\u001b[33m",
    green: "\u001b[32m",
    cyan: "\u001b[36m"
  }[color];

  return `${prefix}${message}\u001b[0m`;
}

module.exports = {
  writeResult,
  writeInfo,
  writeWarning,
  writeDryRun
};
