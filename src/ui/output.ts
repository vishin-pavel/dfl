/**
 * Plain output helpers. Results go to stdout, warnings and errors to stderr so that `--json`
 * output stays parseable.
 */
import stringWidth from 'string-width';
import { c } from './colors.js';

export const sym = {
  ok: '✔',
  fail: '✖',
  current: '●',
  pending: '○',
  arrow: '→',
  warn: '▲',
  sync: '↻',
  dot: '·',
  added: '+',
  removed: '−',
  run: '»',
  halt: '■',
} as const;

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function printLines(lines: readonly string[]): void {
  if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
}

export function printErr(line = ''): void {
  process.stderr.write(`${line}\n`);
}

/** Pretty JSON on stdout (the only output of `--json` commands). */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function success(message: string): void {
  print(`${c.green(sym.ok)} ${message}`);
}

/** C0/C1 control characters except tab and line feed: terminal escapes (ESC, BEL, CSI, OSC …). */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * `text` with its control characters (except tab and line feed) replaced by `�`, so text from Jira
 * or a task record (titles, branch names, params, status names, error messages) cannot send escape
 * sequences to the terminal. Apply it before colouring: the colour codes are added afterwards.
 */
export function plain(text: string): string {
  return text.replace(CONTROL_RE, '\uFFFD');
}

/** `▲ message` on stderr (control characters replaced: warnings may quote Jira or a record). */
export function warning(message: string): void {
  printErr(`${c.yellow(sym.warn)} ${c.yellow(plain(message))}`);
}

/** `✖ message` plus a dimmed hint on the next line (stderr; control characters replaced). */
export function failure(message: string, hint?: string): void {
  printErr(`${c.red(sym.fail)} ${plain(message)}`);
  if (hint) printErr(c.dim(`  ${plain(hint)}`));
}

/** Visible width of a string (ANSI codes ignored, wide characters counted twice). */
export function width(text: string): number {
  return stringWidth(text);
}

/** Truncates plain (uncoloured) text to `max` columns with an ellipsis (whitespace collapsed, control characters replaced). */
export function truncate(text: string, max: number): string {
  const flat = plain(text.replace(/\s+/g, ' ').trim());
  if (max <= 0) return '';
  if (stringWidth(flat) <= max) return flat;
  let out = '';
  for (const char of flat) {
    if (stringWidth(out + char) > max - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

/** Terminal width for layout decisions: the terminal's columns, else `$COLUMNS`, else 120. */
export function terminalWidth(): number {
  const columns = process.stdout.columns;
  if (typeof columns === 'number' && columns > 20) return columns;
  const fromEnv = Number(process.env['COLUMNS']);
  return Number.isInteger(fromEnv) && fromEnv > 20 ? fromEnv : 120;
}

/**
 * Joins `items` with `separator`, wrapping onto new lines (prefixed with `indent`) so that no line
 * exceeds `max` visible columns. Items are never split.
 */
export function wrapItems(items: readonly string[], separator: string, max: number, indent = ''): string[] {
  const lines: string[] = [];
  let line = '';
  for (const item of items) {
    if (line === '') {
      line = indent + item;
      continue;
    }
    const candidate = line + separator + item;
    if (stringWidth(candidate) > max) {
      lines.push(line + separator.trimEnd());
      line = indent + item;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}
