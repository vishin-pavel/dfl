import stringWidth from 'string-width';
import type { Direction, GraphNode, ZoomLevel } from './types.js';

/** Display width in terminal cells (ambiguous-width glyphs count as 1). */
export const cellWidth = (s: string): number => stringWidth(s);

const segmenter = new Intl.Segmenter();
export const graphemes = (s: string): string[] => Array.from(segmenter.segment(s), (x) => x.segment);

/** Cuts `s` to at most `max` cells, ending with `ellipsis` (1 cell) when something was cut. */
export function truncate(s: string, max: number, ellipsis = '…'): string {
  if (cellWidth(s) <= max) return s;
  let out = '';
  for (const g of graphemes(s)) {
    if (cellWidth(out + g) > max - 1) break;
    out += g;
  }
  return out + ellipsis;
}

/** Greedy word wrap to `width` cells; words longer than a line are truncated. */
export function wrap(text: string, width: number, ellipsis = '…'): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const word = truncate(raw, width, ellipsis);
    if (!cur) cur = word;
    else if (cellWidth(cur) + 1 + cellWidth(word) <= width) cur += ` ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Marks cut text; `~` in ASCII mode. */
export const ellipsisFor = (ascii: boolean): string => (ascii ? '~' : '…');

/** One row inside a box border: text (left-aligned unless `center`) or a `├───┤` separator. */
export type NodeRow = { text: string; center?: boolean } | 'sep';

export interface NodeBox {
  id: string;
  w: number;
  h: number;
  /** `tiny`: one-line `[Title]`; `box`: bordered title; `card`: bordered rows with separators. */
  kind: 'tiny' | 'box' | 'card';
  final: boolean;
  /** Content rows between the top and bottom border (tiny: the label only). */
  rows: NodeRow[];
}

/** Row offsets (from the box top) of `├───┤` separators; edges never attach there. */
export function separatorRows(box: NodeBox): Set<number> {
  const out = new Set<number>();
  if (box.kind !== 'card') return out;
  box.rows.forEach((row, i) => {
    if (row === 'sep') out.add(i + 1);
  });
  return out;
}

/** Description wrap width and line cap per zoom level. */
const DESC = { 2: { width: 28, lines: 3 }, 3: { width: 36, lines: 12 } } as const;

/**
 * Size and content of a node per zoom level, in cells. Self-loops are not routed; they become a
 * `↻` badge on the title and, on cards, a `↻ label` line. Final nodes stay small at every zoom.
 */
export function measureNode(node: GraphNode, zoom: ZoomLevel, selfLoops: string[] = [], ascii = false): NodeBox {
  const final = node.final === true;
  const badge = selfLoops.length > 0 ? (ascii ? '@' : '↻') : '';
  const dots = ellipsisFor(ascii);
  if (zoom === 0) {
    const text = truncate(node.title, 10, dots) + badge;
    return { id: node.id, w: cellWidth(text) + 2, h: 1, kind: 'tiny', final, rows: [{ text }] };
  }
  const title = truncate(node.title, zoom === 1 ? 32 : 48, dots) + (badge ? ` ${badge}` : '');
  const box = (): NodeBox => ({ id: node.id, w: cellWidth(title) + 4, h: 3, kind: 'box', final, rows: [{ text: title, center: true }] });
  if (zoom === 1 || final) return box();

  const { width, lines } = DESC[zoom];
  const descWidth = Math.max(width, cellWidth(title));
  let body = node.description ? wrap(node.description, descWidth, dots) : [];
  if (body.length > lines) body = [...body.slice(0, lines - 1), truncate(body[lines - 1] + dots, descWidth, dots)];
  body.push(...selfLoops.map((label) => `${badge} ${label}`.trimEnd()));
  const detail = zoom === 3 && node.detail ? truncate(node.detail, descWidth, dots) : undefined;
  if (body.length === 0 && !detail) return box();

  const rows: NodeRow[] = [{ text: title, center: true }];
  if (body.length > 0) rows.push('sep', ...body.map((text) => ({ text })));
  if (detail) rows.push('sep', { text: detail });
  const inner = Math.max(...rows.map((row) => (row === 'sep' ? 0 : cellWidth(row.text))));
  return { id: node.id, w: inner + 4, h: rows.length + 2, kind: 'card', final, rows };
}

export function edgeLabelText(label: string | undefined, zoom: ZoomLevel, ascii = false): string | undefined {
  if (!label) return undefined;
  return truncate(label, zoom === 0 ? 6 : 24, ellipsisFor(ascii));
}

/** Spacing in cells. Terminal cells are ~2:1 (tall), so vertical gaps are smaller than horizontal ones. */
export function spacing(direction: Direction, zoom: ZoomLevel): { nodeNode: number; layer: number } {
  if (direction === 'TB') return { nodeNode: zoom === 0 ? 3 : 4, layer: 2 };
  return { nodeNode: 1, layer: zoom === 0 ? 4 : 6 };
}
