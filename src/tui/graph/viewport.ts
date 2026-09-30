/** Cell-accurate windows over a rendered canvas, plus the viewer's pan/centre arithmetic. */
import { cellWidth, graphemes } from './measure.js';
import type { RenderedCanvas } from './types.js';

export interface ViewOrigin {
  x: number;
  y: number;
}

/** Cells per canvas (`''` marks the second cell of a wide glyph), computed once per canvas. */
const cellCache = new WeakMap<RenderedCanvas, string[][]>();

export function rememberCells(canvas: RenderedCanvas, cells: string[][]): void {
  cellCache.set(canvas, cells);
}

/** Splits a text line into cells; a wide glyph is followed by a `''` continuation cell. */
export function lineCells(line: string): string[] {
  const out: string[] = [];
  for (const g of graphemes(line)) {
    const w = cellWidth(g);
    if (w === 0) {
      if (out.length > 0) out[out.length - 1] += g;
      continue;
    }
    out.push(g);
    for (let j = 1; j < w; j++) out.push('');
  }
  return out;
}

function cellsOf(canvas: RenderedCanvas): string[][] {
  let cells = cellCache.get(canvas);
  if (!cells) {
    cells = canvas.lines.map(lineCells);
    cellCache.set(canvas, cells);
  }
  return cells;
}

/**
 * Cuts a `w`×`h` window at (`x`,`y`) out of the canvas, padding with spaces (the origin may be
 * negative or past the end). Every row is exactly `w` cells; wide glyphs cut by an edge become spaces.
 */
export function viewport(canvas: RenderedCanvas, x: number, y: number, w: number, h: number): string[] {
  const cells = cellsOf(canvas);
  const width = Math.max(0, w);
  const out: string[] = [];
  for (let row = 0; row < h; row++) {
    const rowCells = y + row >= 0 ? cells[y + row] : undefined;
    if (!rowCells) {
      out.push(' '.repeat(width));
      continue;
    }
    let line = '';
    for (let col = 0; col < width; col++) {
      const cx = x + col;
      const c = cx >= 0 && cx < rowCells.length ? rowCells[cx]! : ' ';
      if (c === '') {
        if (col === 0) line += ' '; // second half of a glyph that starts left of the window
        continue;
      }
      if (col === width - 1 && cx >= 0 && rowCells[cx + 1] === '') {
        line += ' '; // wide glyph cut by the right edge
        continue;
      }
      line += c;
    }
    out.push(line);
  }
  return out;
}

/**
 * Splits a line at cell columns into `[before, inside, after]` (`from` inclusive, `to` exclusive).
 * Used to colour a node after the viewport was cut; a wide glyph goes to the part it starts in.
 */
export function splitCells(line: string, from: number, to: number): [string, string, string] {
  const parts: [string, string, string] = ['', '', ''];
  let col = 0;
  for (const g of graphemes(line)) {
    parts[col < from ? 0 : col < to ? 1 : 2] += g;
    col += cellWidth(g);
  }
  return parts;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Clamps a view origin so the `w`×`h` view never scrolls past the drawing. A drawing narrower than
 * the view is centred horizontally; one shorter than the view sticks to the top.
 */
export function clampView(canvas: RenderedCanvas, x: number, y: number, w: number, h: number): ViewOrigin {
  return {
    x: canvas.width <= w ? -Math.floor((w - canvas.width) / 2) : clamp(x, 0, canvas.width - w),
    y: clamp(y, 0, canvas.height - h),
  };
}

/** View origin centred on a node; a node larger than the view is aligned to its top/left edge. */
export function centerOn(canvas: RenderedCanvas, id: string, w: number, h: number): ViewOrigin | undefined {
  const b = canvas.boxes[id];
  if (!b) return undefined;
  const x = b.w > w ? b.x : Math.round(b.x + b.w / 2 - w / 2);
  const y = b.h > h ? b.y : Math.round(b.y + b.h / 2 - h / 2);
  return clampView(canvas, x, y, w, h);
}

/** Id of the node whose centre is nearest the centre of the view (rows count double: cells are ~2:1). */
export function nearestNode(canvas: RenderedCanvas, x: number, y: number, w: number, h: number): string | undefined {
  const cx = x + w / 2;
  const cy = y + h / 2;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const [id, b] of Object.entries(canvas.boxes)) {
    const d = Math.hypot(b.x + b.w / 2 - cx, (b.y + b.h / 2 - cy) * 2);
    if (d < bestDistance) {
      bestDistance = d;
      best = id;
    }
  }
  return best;
}

export function fitsIn(canvas: RenderedCanvas, w: number, h: number): boolean {
  return canvas.width <= w && canvas.height <= h;
}
