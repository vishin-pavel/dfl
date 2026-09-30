import { cellWidth, graphemes, separatorRows, type NodeBox } from './measure.js';
import type { Pt, Rect, Side } from './types.js';

// Line connection bits per cell; junction glyphs fall out of OR-ing the masks.
const N = 1;
const E = 2;
const S = 4;
const W = 8;
const SIDE_BIT = [N, E, S, W] as const;
export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

/** What occupies a cell; decides what may be drawn over it. */
const K_EMPTY = 0;
const K_LINE = 1;
const K_BOX = 2;
const K_TEXT = 3;
const K_ARROW = 4;

const UNI: Record<number, string> = {
  [N]: '│', [S]: '│', [N | S]: '│', [E]: '─', [W]: '─', [E | W]: '─',
  [S | E]: '╭', [S | W]: '╮', [N | E]: '╰', [N | W]: '╯',
  [N | S | E]: '├', [N | S | W]: '┤', [E | W | S]: '┬', [E | W | N]: '┴', [N | E | S | W]: '┼',
};
const ASC: Record<number, string> = { [N]: '|', [S]: '|', [N | S]: '|', [E]: '-', [W]: '-', [E | W]: '-' };
/** Arrow pointing INTO a box whose side is N/E/S/W. */
const ARROW_UNI = ['▼', '◄', '▲', '►'] as const;
const ARROW_ASC = ['v', '<', '^', '>'] as const;

interface BoxGlyphs {
  tl: string; tr: string; bl: string; br: string; h: string; v: string;
  /** Separator row: left end, fill, right end. */
  ml: string; mh: string; mr: string;
  /** Border cell where an edge leaves through side N/E/S/W. */
  tee: readonly [string, string, string, string];
  /** Brackets of one-line (zoom 0) nodes. */
  open: string; close: string;
}
type BoxStyle = 'light' | 'heavy' | 'final';

const GLYPHS: Record<'uni' | 'ascii', Record<BoxStyle, BoxGlyphs>> = {
  uni: {
    light: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', ml: '├', mh: '─', mr: '┤', tee: ['┴', '├', '┬', '┤'], open: '[', close: ']' },
    heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃', ml: '┠', mh: '─', mr: '┨', tee: ['┷', '┠', '┯', '┨'], open: '▐', close: '▌' },
    final: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', ml: '╟', mh: '─', mr: '╢', tee: ['╧', '╟', '╤', '╢'], open: '(', close: ')' },
  },
  ascii: {
    light: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', ml: '+', mh: '-', mr: '+', tee: ['+', '+', '+', '+'], open: '[', close: ']' },
    heavy: { tl: '#', tr: '#', bl: '#', br: '#', h: '=', v: '#', ml: '#', mh: '-', mr: '#', tee: ['#', '#', '#', '#'], open: '#', close: '#' },
    final: { tl: '/', tr: '\\', bl: '\\', br: '/', h: '-', v: '|', ml: '+', mh: '-', mr: '+', tee: ['+', '+', '+', '+'], open: '(', close: ')' },
  },
};

/**
 * Character canvas. Line cells store which directions a line leaves them in, so corners and
 * junctions are resolved when the canvas is turned into text; boxes, labels and arrows are glyphs.
 */
export class Canvas {
  readonly w: number;
  readonly h: number;
  readonly ascii: boolean;
  private readonly ch: string[];
  private readonly kind: Uint8Array;
  private readonly mask: Uint8Array;

  constructor(w: number, h: number, ascii = false) {
    this.w = w;
    this.h = h;
    this.ascii = ascii;
    this.ch = new Array<string>(w * h).fill(' ');
    this.kind = new Uint8Array(w * h);
    this.mask = new Uint8Array(w * h);
  }

  private inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  private kindAt(x: number, y: number): number {
    return this.kind[y * this.w + x]!;
  }

  private glyphs(style: BoxStyle): BoxGlyphs {
    return GLYPHS[this.ascii ? 'ascii' : 'uni'][style];
  }

  private bits(x: number, y: number, b: number): void {
    if (!this.inside(x, y)) return;
    const i = y * this.w + x;
    if (this.kind[i] !== K_EMPTY && this.kind[i] !== K_LINE) return;
    this.kind[i] = K_LINE;
    this.mask[i]! |= b;
  }

  /** Orthogonal polyline; a diagonal step gets an elbow (horizontal first). */
  polyline(pts: Pt[]): void {
    if (pts.length === 1) {
      this.bits(pts[0]!.x, pts[0]!.y, N | S);
      return;
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      if (a.x !== b.x && a.y !== b.y) {
        const m = { x: b.x, y: a.y };
        this.segment(a, m);
        this.segment(m, b);
      } else this.segment(a, b);
    }
  }

  private segment(a: Pt, b: Pt): void {
    const dx = Math.sign(b.x - a.x);
    const dy = Math.sign(b.y - a.y);
    if (!dx && !dy) return;
    const fwd = dx > 0 ? E : dx < 0 ? W : dy > 0 ? S : N;
    const back = fwd === E ? W : fwd === W ? E : fwd === S ? N : S;
    let { x, y } = a;
    while (x !== b.x || y !== b.y) {
      this.bits(x, y, fwd);
      x += dx;
      y += dy;
      this.bits(x, y, back);
    }
  }

  /** Extends the end cell of an edge toward the box it touches (so `─` joins `┬` and `▼` sits flush). */
  stub(p: Pt, side: Side): void {
    this.bits(p.x, p.y, SIDE_BIT[(side + 2) % 4]!);
  }

  private put(x: number, y: number, c: string, k: number): void {
    if (!this.inside(x, y)) return;
    const i = y * this.w + x;
    this.ch[i] = c;
    this.kind[i] = k;
    this.mask[i] = 0;
  }

  /** Writes text; returns false (and writes nothing) if a target cell has a kind not in `over`. */
  text(x: number, y: number, s: string, k = K_TEXT, over: readonly number[] = [K_EMPTY, K_LINE, K_TEXT]): boolean {
    let cx = x;
    for (const g of graphemes(s)) {
      const gw = cellWidth(g);
      for (let j = 0; j < gw; j++) if (!this.inside(cx + j, y) || !over.includes(this.kindAt(cx + j, y))) return false;
      cx += gw;
    }
    cx = x;
    for (const g of graphemes(s)) {
      const gw = cellWidth(g);
      if (gw === 0) continue;
      this.put(cx, y, g, k);
      for (let j = 1; j < gw; j++) this.put(cx + j, y, '', k); // continuation cell of a wide glyph
      cx += gw;
    }
    return true;
  }

  isEmpty(x: number, y: number, len: number): boolean {
    for (let j = 0; j < len; j++) if (!this.inside(x + j, y) || this.kindAt(x + j, y) !== K_EMPTY) return false;
    return true;
  }

  /**
   * Free cells from (x, y) stepping by (dx, dy), up to `max`: how far the nearest line, arrow or label
   * is. A box border or the canvas edge ends the scan as fully clear (`max`), since only another
   * edge (or its label) could be mistaken for the owner of a label placed here.
   */
  clearance(x: number, y: number, dx: number, dy: number, max: number): number {
    for (let n = 0; n < max; n++) {
      const cx = x + n * dx;
      const cy = y + n * dy;
      if (!this.inside(cx, cy)) return max;
      const k = this.kindAt(cx, cy);
      if (k === K_BOX) return max;
      if (k !== K_EMPTY) return n;
    }
    return max;
  }

  /** True if a run of cells holds part of an edge (line, arrow) or a label; boxes and blanks do not count. */
  hasEdgeCells(x: number, y: number, len: number): boolean {
    for (let j = 0; j < len; j++) {
      if (!this.inside(x + j, y)) continue;
      const k = this.kindAt(x + j, y);
      if (k === K_LINE || k === K_ARROW || k === K_TEXT) return true;
    }
    return false;
  }

  /** A run of plain horizontal line cells (no junctions): safe to overwrite with an inline label. */
  isPlainHLine(x: number, y: number, len: number): boolean {
    for (let j = 0; j < len; j++) {
      if (!this.inside(x + j, y)) return false;
      const i = y * this.w + x + j;
      if (this.kind[i] !== K_LINE || this.mask[i] !== (E | W)) return false;
    }
    return true;
  }

  box(r: Rect, node: NodeBox, heavy: boolean): void {
    const g = this.glyphs(heavy ? 'heavy' : node.final ? 'final' : 'light');
    const first = node.rows[0];
    if (node.kind === 'tiny') {
      // Widened for its edges (one column each): the title is centred between the brackets.
      this.put(r.x, r.y, g.open, K_BOX);
      for (let x = r.x + 1; x < r.x + r.w - 1; x++) this.put(x, r.y, ' ', K_BOX);
      if (first && first !== 'sep') this.text(r.x + 1 + Math.floor((r.w - 2 - cellWidth(first.text)) / 2), r.y, first.text, K_BOX, [K_BOX]);
      this.put(r.x + r.w - 1, r.y, g.close, K_BOX);
      return;
    }
    const seps = separatorRows(node);
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const top = y === r.y;
        const bottom = y === r.y + r.h - 1;
        const left = x === r.x;
        const right = x === r.x + r.w - 1;
        let c = ' ';
        if (top) c = left ? g.tl : right ? g.tr : g.h;
        else if (bottom) c = left ? g.bl : right ? g.br : g.h;
        else if (seps.has(y - r.y)) c = left ? g.ml : right ? g.mr : g.mh;
        else if (left || right) c = g.v;
        this.put(x, y, c, K_BOX);
      }
    }
    const inner = r.w - 4;
    // A plain box may be taller than 3 rows (LR layout with many edges): centre its title vertically.
    const y0 = node.kind === 'box' ? r.y + Math.floor((r.h - 1) / 2) : r.y + 1;
    node.rows.forEach((row, i) => {
      if (row === 'sep') return;
      const offset = row.center ? Math.floor((inner - cellWidth(row.text)) / 2) : 0;
      this.text(r.x + 2 + offset, y0 + i, row.text, K_BOX, [K_BOX]);
    });
  }

  /** Replaces the border cell next to `p` with a tee where an edge leaves the box. */
  tee(r: Rect, p: Pt, side: Side, node: NodeBox, heavy: boolean): void {
    if (node.kind === 'tiny' || r.h < 3) return; // one-line nodes have no border
    const bx = p.x - DX[side];
    const by = p.y - DY[side];
    if (!this.inside(bx, by) || this.kindAt(bx, by) !== K_BOX) return;
    this.put(bx, by, this.glyphs(heavy ? 'heavy' : node.final ? 'final' : 'light').tee[side], K_BOX);
  }

  arrow(p: Pt, dstSide: Side): void {
    this.put(p.x, p.y, (this.ascii ? ARROW_ASC : ARROW_UNI)[dstSide], K_ARROW);
  }

  /** Cells row by row; `''` marks the second cell of a wide glyph. */
  toCells(): string[][] {
    const rows: string[][] = [];
    for (let y = 0; y < this.h; y++) {
      const row: string[] = [];
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        if (this.kind[i] === K_LINE) {
          const m = this.mask[i]!;
          row.push(this.ascii ? (ASC[m] ?? '+') : (UNI[m] ?? '┼'));
        } else row.push(this.ch[i]!);
      }
      rows.push(row);
    }
    return rows;
  }
}
