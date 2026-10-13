/** The value of --no-color only when the user typed it; commander always
 * sets `color` (true by default), so a default must not override the
 * config file or the environment. */
function colorFromCli(
  command: { getOptionValueSource(name: string): string | undefined },
  options: { color?: boolean }
): boolean | undefined {
  return command.getOptionValueSource("color") === "cli" ? options.color : undefined;
}

module.exports = { colorFromCli };
