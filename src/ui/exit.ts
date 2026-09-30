/**
 * Control-flow errors for the CLI: `runCli` turns them into exit codes without printing anything
 * (the command has already reported what happened).
 */

/** Ends the command with `exitCode` (e.g. `flow validate` with errors → 1). */
export class CliExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message = `exit ${exitCode}`) {
    super(message);
    this.name = 'CliExit';
    this.exitCode = exitCode;
  }
}

/** The user cancelled a prompt (Esc / Ctrl+C): exit code 130. */
export class CancelledError extends CliExit {
  constructor() {
    super(130, 'Cancelled');
    this.name = 'CancelledError';
  }
}

export function isCliExit(error: unknown): error is CliExit {
  return error instanceof CliExit;
}
