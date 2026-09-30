/** A user-facing error: the CLI prints `message` (and `hint`) without a stack trace. */
export class DflError extends Error {
  readonly hint: string | undefined;
  readonly code: string;

  constructor(message: string, options: { hint?: string; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DflError';
    this.hint = options.hint;
    this.code = options.code ?? 'DFL_ERROR';
  }
}

export function isDflError(error: unknown): error is DflError {
  return error instanceof DflError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
