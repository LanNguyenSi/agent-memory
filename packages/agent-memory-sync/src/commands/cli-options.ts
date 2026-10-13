/** The value of --no-color only when the user typed it; commander always
 * sets `color` (true by default), so a default must not override the
 * config file or the environment. */
function colorFromCli(
  command: { getOptionValueSource(name: string): string | undefined },
  options: { color?: boolean }
): boolean | undefined {
  return command.getOptionValueSource("color") === "cli" ? options.color : undefined;
}

/** The output overrides every sync command hands to resolveRunConfig: only
 * the flags the user typed, so the config file and the environment apply
 * otherwise. */
function outputOverrides(
  command: { getOptionValueSource(name: string): string | undefined },
  options: { output?: string; verbose?: boolean; quiet?: boolean; color?: boolean }
): { outputFormat?: string; verbose?: boolean; quiet?: boolean; color?: boolean } {
  return {
    outputFormat: options.output,
    verbose: options.verbose,
    quiet: options.quiet,
    color: colorFromCli(command, options)
  };
}

module.exports = { colorFromCli, outputOverrides };
