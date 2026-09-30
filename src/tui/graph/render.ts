import { Canvas } from './canvas.js';
import { layoutGraph } from './layout.js';
import { cellWidth, edgeLabelText, measureNode } from './measure.js';
import { rememberCells } from './viewport.js';
import type { CanvasBox, FlowGraph, GraphNode, Pt, Rect, RenderGraphOptions, RenderedCanvas } from './types.js';

/** Lays out `graph` with ELK and draws it on a character canvas cropped to the drawing. */
export async function renderGraph(graph: FlowGraph, options: RenderGraphOptions): Promise<RenderedCanvas> {
  const { zoom } = options;
  const direction = options.direction ?? 'TB';
  const ascii = options.ascii ?? false;
  const ids = new Set<string>();
  const nodes: GraphNode[] = [];
  for (const n of graph.nodes) {
    if (ids.has(n.id)) continue;
    ids.add(n.id);
    nodes.push(n);
  }
  // Edges to unknown nodes are dropped silently: `dfl flow validate` reports them.
  const valid = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const edges = valid.filter((e) => e.from !== e.to).map((e) => ({ from: e.from, to: e.to, label: edgeLabelText(e.label, zoom, ascii) }));
  const selfLoops = (id: string): string[] => valid.filter((e) => e.from === id && e.to === id).map((e) => e.label ?? '');
  const boxes = nodes.map((n) => measureNode(n, zoom, selfLoops(n.id), ascii));
  if (boxes.length === 0) return finish([], new Map());

  // Leave room for one port per edge on a side (2 cells apart), else ports collapse onto one cell.
  const degree = new Map(boxes.map((b) => [b.id, { in: 0, out: 0 }]));
  for (const e of edges) {
    degree.get(e.from)!.out++;
    degree.get(e.to)!.in++;
  }
  for (const b of boxes) {
    if (b.kind === 'tiny') continue;
    const k = Math.max(degree.get(b.id)!.in, degree.get(b.id)!.out);
    if (direction === 'LR') b.h = Math.max(b.h, 2 * k + 1);
    else b.w = Math.max(b.w, 2 * k + 3);
  }

  const layout = await layoutGraph(boxes, edges, direction, zoom);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const canvas = new Canvas(layout.width + 2, layout.height + 2, ascii);
  for (const e of layout.edges) {
    canvas.polyline(e.points);
    canvas.stub(e.points[0]!, e.srcSide);
    canvas.stub(e.points.at(-1)!, e.dstSide);
  }
  for (const b of boxes) canvas.box(layout.nodes.get(b.id)!, b, b.id === options.highlight);
  for (const e of layout.edges) {
    canvas.tee(layout.nodes.get(e.from)!, e.points[0]!, e.srcSide, byId.get(e.from)!, e.from === options.highlight);
    canvas.arrow(e.points.at(-1)!, e.dstSide);
  }
  for (const e of layout.edges) if (e.label) placeLabel(canvas, e.points, e.label, e.labelHint);
  return finish(canvas.toCells(), layout.nodes);
}

/**
 * Picks a free spot for an edge label next to (or inline on) one of the edge's segments: inline on a
 * plain `───` run, above/below a horizontal run, or right/left of a vertical run. Candidates are scored
 * by distance to `hint` (where ELK reserved room) or to the middle of the longest segment.
 */
function placeLabel(canvas: Canvas, pts: Pt[], text: string, hint: Pt | undefined): void {
  const w = cellWidth(text);
  const segments = pts.slice(0, -1).map((a, i) => [a, pts[i + 1]!] as const);
  const length = (s: readonly [Pt, Pt]): number => Math.abs(s[1].x - s[0].x) + Math.abs(s[1].y - s[0].y);
  const longest = [...segments].sort((s, t) => length(t) - length(s))[0];
  const target = hint ?? (longest ? { x: (longest[0].x + longest[1].x) / 2, y: (longest[0].y + longest[1].y) / 2 } : pts[0]!);
  let best: { x: number; y: number; score: number } | undefined;
  const offer = (x: number, y: number, penalty: number): void => {
    const score = Math.abs(x + w / 2 - target.x) + 2 * Math.abs(y - target.y) + penalty;
    if (!best || score < best.score) best = { x, y, score };
  };
  for (const [a, b] of segments) {
    if (a.y === b.y) {
      const lo = Math.min(a.x, b.x) + 1; // skip corners and the arrow cell
      const hi = Math.max(a.x, b.x) - 1;
      for (let x = lo + 1; x + w <= hi; x++) if (canvas.isPlainHLine(x - 1, a.y, w + 2)) offer(x, a.y, 0);
      for (let x = lo; x + w - 1 <= hi; x++) {
        for (const dy of [-1, 1]) if (canvas.isEmpty(x - 1, a.y + dy, w + 2)) offer(x, a.y + dy, 1);
      }
    } else {
      const lo = Math.min(a.y, b.y) + 1;
      const hi = Math.max(a.y, b.y) - 1;
      for (let y = lo; y <= hi; y++) {
        if (canvas.isEmpty(a.x + 1, y, w + 2)) offer(a.x + 2, y, 0); // │ label
        if (canvas.isEmpty(a.x - w - 2, y, w + 2)) offer(a.x - w - 1, y, 0); // label │
      }
    }
  }
  const chosen = best as { x: number; y: number } | undefined;
  if (chosen) {
    canvas.text(chosen.x, chosen.y, text);
    return;
  }
  // Fallback: the nearest free run of cells around the target (rings of growing radius).
  const tx = Math.round(target.x - w / 2);
  const ty = Math.round(target.y);
  for (let rad = 1; rad < 12; rad++) {
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -2 * rad; dx <= 2 * rad; dx++) {
        if (Math.max(Math.abs(dy), Math.ceil(Math.abs(dx) / 2)) !== rad) continue;
        if (canvas.isEmpty(tx + dx - 1, ty + dy, w + 2)) {
          canvas.text(tx + dx, ty + dy, text);
          return;
        }
      }
    }
  }
}

/** Crops the cells to the drawing, shifts the node boxes accordingly and builds the text lines. */
function finish(cells: string[][], nodes: Map<string, Rect>): RenderedCanvas {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  cells.forEach((row, y) =>
    row.forEach((c, x) => {
      // '' (second half of a wide glyph) counts as drawn so a line never ends inside a glyph.
      if (c === ' ') return;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }),
  );
  if (x1 < 0) {
    const empty: RenderedCanvas = { lines: [], width: 0, height: 0, boxes: {} };
    rememberCells(empty, []);
    return empty;
  }
  const out = cells.slice(y0, y1 + 1).map((row) => row.slice(x0, x1 + 1));
  for (const row of out) if (row[0] === '') row[0] = ' '; // never start inside a wide glyph
  const boxes: Record<string, CanvasBox> = {};
  for (const [id, r] of nodes) boxes[id] = { x: r.x - x0, y: r.y - y0, w: r.w, h: r.h };
  const canvas: RenderedCanvas = { lines: out.map((row) => row.join('')), width: x1 - x0 + 1, height: y1 - y0 + 1, boxes };
  rememberCells(canvas, out);
  return canvas;
}
