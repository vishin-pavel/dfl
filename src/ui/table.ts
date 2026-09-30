/**
 * Minimal aligned tables for terminal output. Widths are measured on the visible text (ANSI codes
 * ignored). The last column is never padded and can be truncated to fit `maxWidth`.
 */
import { c } from './colors.js';
import { truncate, width } from './output.js';

/** A cell: a (possibly coloured) string, or plain text plus a style applied after truncation. */
export type Cell = string | { text: string; style?: ((text: string) => string) | undefined };

export interface TableOptions {
  /** Header row (rendered dim + bold). */
  head?: readonly string[] | undefined;
  /** Spaces before every line. Default 2. */
  indent?: number | undefined;
  /** Spaces between columns. Default 2. */
  gap?: number | undefined;
  /** Per-column alignment. Default left. */
  align?: ReadonlyArray<'left' | 'right'> | undefined;
  /**
   * Maximum line width: last-column cells given as `{ text }` or uncoloured strings are truncated
   * with an ellipsis (never below 12 columns).
   */
  maxWidth?: number | undefined;
}

const ANSI_RE = /\u001B\[/;

export function table(rows: ReadonlyArray<readonly Cell[]>, options: TableOptions = {}): string[] {
  const indent = options.indent ?? 2;
  const gap = options.gap ?? 2;
  const head: Cell[][] = options.head ? [options.head.map((text) => ({ text, style: (s: string) => c.dim(c.bold(s)) }))] : [];
  const all: Cell[][] = [...head, ...rows.map((row) => [...row])];
  const columns = Math.max(0, ...all.map((row) => row.length));
  const last = columns - 1;

  if (options.maxWidth !== undefined && columns > 1) {
    const others = Array.from({ length: last }, (_, col) => Math.max(0, ...all.map((row) => width(textOf(row[col])))));
    const available = Math.max(12, options.maxWidth - indent - others.reduce((sum, w) => sum + w + gap, 0));
    for (const row of all) {
      const cell = row[last];
      if (cell === undefined) continue;
      if (typeof cell === 'string') {
        if (!ANSI_RE.test(cell)) row[last] = truncate(cell, available);
      } else {
        row[last] = { ...cell, text: truncate(cell.text, available) };
      }
    }
  }

  const widths = Array.from({ length: columns }, (_, col) => Math.max(0, ...all.map((row) => width(textOf(row[col])))));
  return all.map((row) => {
    const cells = Array.from({ length: columns }, (_, col) => {
      const cell = row[col] ?? '';
      const rendered = render(cell);
      if (col === last && options.align?.[col] !== 'right') return rendered;
      const pad = ' '.repeat(widths[col]! - width(textOf(cell)));
      return options.align?.[col] === 'right' ? pad + rendered : rendered + pad;
    });
    return (' '.repeat(indent) + cells.join(' '.repeat(gap))).trimEnd();
  });
}

function textOf(cell: Cell | undefined): string {
  if (cell === undefined) return '';
  return typeof cell === 'string' ? cell : cell.text;
}

function render(cell: Cell): string {
  if (typeof cell === 'string') return cell;
  return cell.style && cell.text !== '' ? cell.style(cell.text) : cell.text;
}
