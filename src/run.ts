/**
 * CLI runner: parses argv with buildProgram(), prints DflError messages
 * (+ hint) to stderr without stack traces, returns the exit code.
 */
import { CommanderError } from '@commander-js/extra-typings';
import { isDflError } from './core/errors.js';
import { buildProgram } from './program.js';
import { c, setColorEnabled } from './ui/colors.js';
import { isCliExit } from './ui/exit.js';
import { failure, printErr } from './ui/output.js';

/** Commander codes that end a successful run (help/version were printed on request). */
const OK_CODES = new Set(['commander.helpDisplayed', 'commander.version']);

let pipeGuard = false;

export async function runCli(argv: string[]): Promise<number> {
  // picocolors only looks at process.argv; honour --no-color in the argv we were given.
  setColorEnabled(argv.slice(2).includes('--no-color') ? false : undefined);
  if (!pipeGuard) {
    pipeGuard = true;
    // `dfl agents | head`: the reader went away, which is not an error.
    process.stdout.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
      throw error;
    });
  }
  try {
    await buildProgram().parseAsync(argv);
    return 0;
  } catch (error) {
    return handleError(error);
  }
}

function handleError(error: unknown): number {
  if (error instanceof CommanderError) {
    // Commander already printed its message (and help) to stderr.
    return OK_CODES.has(error.code) ? 0 : error.exitCode;
  }
  if (isCliExit(error)) return error.exitCode;
  if (isDflError(error)) {
    failure(error.message, error.hint);
    if (process.env['DFL_DEBUG'] === '1' && error.stack) printErr(c.dim(error.stack));
    return 1;
  }
  const message = error instanceof Error ? error.message : String(error);
  failure(`Unexpected error: ${message}`, process.env['DFL_DEBUG'] === '1' ? undefined : 'Set DFL_DEBUG=1 to see the stack trace.');
  if (process.env['DFL_DEBUG'] === '1' && error instanceof Error && error.stack) printErr(c.dim(error.stack));
  return 1;
}
