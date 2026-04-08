class CliError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "unexpected error.";
}

module.exports = {
  CliError,
  isCliError,
  formatErrorMessage
};
