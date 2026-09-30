/**
 * @clack/prompts wrappers. Prompts are only shown when `isInteractive()` is true; every wrapper
 * turns a cancelled prompt into `CancelledError` (exit code 130) after printing "Cancelled".
 */
import * as p from '@clack/prompts';
import { CancelledError } from './exit.js';

export interface PromptOption<T extends string> {
  value: T;
  label?: string | undefined;
  hint?: string | undefined;
}

/** True when both stdin and stdout are terminals, `--yes` was not given and `CI` is not set. */
export function isInteractive(options: { yes?: boolean | undefined } = {}): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true && options.yes !== true && !process.env['CI'];
}

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel('Cancelled');
    throw new CancelledError();
  }
  return value as Exclude<T, symbol>;
}

export async function select<T extends string>(options: {
  message: string;
  options: ReadonlyArray<PromptOption<T>>;
  initialValue?: T | undefined;
}): Promise<T> {
  return unwrap(
    await p.select<T>({
      message: options.message,
      options: options.options.map(toClackOption) as Parameters<typeof p.select<T>>[0]['options'],
      ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
    }),
  );
}

export async function multiselect<T extends string>(options: {
  message: string;
  options: ReadonlyArray<PromptOption<T>>;
  initialValues?: readonly T[] | undefined;
  required?: boolean | undefined;
}): Promise<T[]> {
  return unwrap(
    await p.multiselect<T>({
      message: options.message,
      options: options.options.map(toClackOption) as Parameters<typeof p.multiselect<T>>[0]['options'],
      initialValues: [...(options.initialValues ?? [])],
      required: options.required ?? true,
    }),
  );
}

export async function confirm(options: { message: string; initialValue?: boolean | undefined }): Promise<boolean> {
  return unwrap(await p.confirm({ message: options.message, initialValue: options.initialValue ?? true }));
}

export async function text(options: {
  message: string;
  placeholder?: string | undefined;
  defaultValue?: string | undefined;
  validate?: ((value: string) => string | undefined) | undefined;
}): Promise<string> {
  const validate = options.validate;
  return unwrap(
    await p.text({
      message: options.message,
      ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
      ...(options.defaultValue !== undefined ? { defaultValue: options.defaultValue } : {}),
      ...(validate ? { validate: (value: string | undefined) => validate(value ?? '') } : {}),
    }),
  );
}

export interface Spinner {
  start(message: string): void;
  message(message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

export function spinner(): Spinner {
  const s = p.spinner();
  return {
    start: (message) => s.start(message),
    message: (message) => s.message(message),
    stop: (message) => s.stop(message),
    error: (message) => s.error(message),
  };
}

export function intro(title: string): void {
  p.intro(title);
}

export function outro(message: string): void {
  p.outro(message);
}

/** Multi-line message inside the clack guide (interactive mode only). */
export function logMessage(lines: readonly string[]): void {
  if (lines.length > 0) p.log.message(lines.join('\n'));
}

export function logWarning(message: string): void {
  p.log.warn(message);
}

function toClackOption<T extends string>(option: PromptOption<T>): { value: T; label?: string; hint?: string } {
  return {
    value: option.value,
    ...(option.label !== undefined ? { label: option.label } : {}),
    ...(option.hint !== undefined ? { hint: option.hint } : {}),
  };
}
