/**
 * ELK `layered` layout with ORTHOGONAL edge routing, computed directly in terminal cells
 * (1 ELK unit = 1 cell), then snapped to whole cells.
 */
import type { ELK, ELKConstructorArguments, ElkExtendedEdge, ElkNode, ElkPoint, ElkPort } from 'elkjs/lib/elk-api.js';
import { cellWidth, separatorRows, spacing, type NodeBox } from './measure.js';
import type { Direction, LaidOutEdge, Layout, Pt, Rect, Side, ZoomLevel } from './types.js';

let elk: ELK | undefined;

/**
 * Loads elkjs lazily: parsing the 1.6 MB bundle costs ~100 ms, which only `dfl flow view` should pay.
 * The bundle is CJS (`module.exports = ELK`, `ELK.default = ELK`) and TypeScript (nodenext) types the
 * default import as the module namespace, so the constructor is resolved defensively.
 */
async function getElk(): Promise<ELK> {
  if (!elk) {
    const mod = (await import('elkjs/lib/elk.bundled.js')) as unknown as { default: { default?: unknown } };
    const Ctor = (mod.default.default ?? mod.default) as new (args?: ELKConstructorArguments) => ELK;
    elk = new Ctor();
  }
  return elk;
}

/** ELK's fractional node rectangle. */
interface FRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One rounding rule for nodes, ports and bends, so straight lines stay straight. */
const R = (v: number): number => Math.round(v + 1e-6);
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));
const vertical = (side: Side): boolean => side === 0 || side === 2;

/** Which side of the (fractional) ELK node an endpoint lies on. */
function sideOnBorder(n: FRect, p: ElkPoint): Side {
  const d = [Math.abs(p.y - n.y), Math.abs(p.x - (n.x + n.w)), Math.abs(p.y - (n.y + n.h)), Math.abs(p.x - n.x)];
  return d.indexOf(Math.min(...d)) as Side;
}

/** The row in `lo..hi` nearest to the (fractional) `want` that is not `bad`; undefined if there is none. */
function freeRow(want: number, lo: number, hi: number, bad: (y: number) => boolean): number | undefined {
  let best: number | undefined;
  for (let y = lo; y <= hi; y++) {
    if (!bad(y) && (best === undefined || Math.abs(y - want) < Math.abs(best - want))) best = y;
  }
  return best;
}

/**
 * Maps an ELK endpoint (on the fractional border) to the first cell OUTSIDE the snapped box, kept off
 * the corners and off separator rows of cards. `taken` holds the rows (E/W) or columns (N/S) other
 * edges already use on this side; the nearest free one is picked so no two edges share an end cell
 * (and an arrowhead). Only when the side is full does an edge share a cell.
 */
function snapEnd(r: Rect, p: ElkPoint, side: Side, seps: Set<number>, taken: ReadonlySet<number>): Pt {
  if (vertical(side)) {
    const want = clamp(R(p.x), r.x + 1, r.x + r.w - 2);
    const x = freeRow(want, r.x + 1, r.x + r.w - 2, (col) => taken.has(col)) ?? want;
    return { x, y: side === 0 ? r.y - 1 : r.y + r.h };
  }
  const sep = (row: number): boolean => seps.has(row - r.y);
  const y =
    r.h === 1
      ? r.y
      : (freeRow(p.y, r.y + 1, r.y + r.h - 2, (row) => sep(row) || taken.has(row)) ??
        freeRow(p.y, r.y + 1, r.y + r.h - 2, sep) ??
        clamp(R(p.y), r.y + 1, r.y + r.h - 2));
  return { x: side === 3 ? r.x - 1 : r.x + r.w, y };
}

/** Drops repeated and collinear points. */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) if (out.length === 0 || out.at(-1)!.x !== p.x || out.at(-1)!.y !== p.y) out.push(p);
  return out.filter((p, i) => {
    if (i === 0 || i === out.length - 1) return true;
    const a = out[i - 1]!;
    const b = out[i + 1]!;
    return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}

interface End {
  pt: Pt;
  side: Side;
  rect: Rect;
  seps: Set<number>;
  /** Rows (E/W) or columns (N/S) of this side already used by other edges. */
  taken: ReadonlySet<number>;
}

/** Replaces ELK's endpoints with the snapped cells and drags the adjacent bends along so segments stay orthogonal. */
function snapPath(raw: ElkPoint[], s: End, e: End): Pt[] {
  const mid = raw.slice(1, -1).map((p) => ({ x: R(p.x), y: R(p.y) }));
  if (mid.length === 0) {
    // Straight edge: pick one free column/row valid for both boxes, else add a jog in the middle.
    if (vertical(s.side)) {
      const lo = Math.max(s.rect.x + 1, e.rect.x + 1);
      const hi = Math.min(s.rect.x + s.rect.w - 2, e.rect.x + e.rect.w - 2);
      const x = lo <= hi ? freeRow(clamp(s.pt.x, lo, hi), lo, hi, (col) => s.taken.has(col) || e.taken.has(col)) : undefined;
      if (x !== undefined) return [{ ...s.pt, x }, { ...e.pt, x }];
      if (s.pt.x === e.pt.x) return [s.pt, e.pt];
      const my = R((s.pt.y + e.pt.y) / 2);
      return [s.pt, { x: s.pt.x, y: my }, { x: e.pt.x, y: my }, e.pt];
    }
    const lo = Math.max(s.rect.y + 1, e.rect.y + 1);
    const hi = Math.min(s.rect.y + s.rect.h - 2, e.rect.y + e.rect.h - 2);
    const bad = (row: number): boolean =>
      s.seps.has(row - s.rect.y) || e.seps.has(row - e.rect.y) || s.taken.has(row) || e.taken.has(row);
    const y = s.rect.h > 1 && e.rect.h > 1 ? freeRow(s.pt.y, lo, hi, bad) : undefined;
    if (y !== undefined) return [{ ...s.pt, y }, { ...e.pt, y }];
    if (s.pt.y === e.pt.y) return [s.pt, e.pt];
    const mx = R((s.pt.x + e.pt.x) / 2);
    return [s.pt, { x: mx, y: s.pt.y }, { x: mx, y: e.pt.y }, e.pt];
  }
  const first = mid[0]!;
  if (vertical(s.side)) first.x = s.pt.x;
  else first.y = s.pt.y;
  const last = mid.at(-1)!;
  if (vertical(e.side)) last.x = e.pt.x;
  else last.y = e.pt.y;
  return simplify([s.pt, ...mid, e.pt]);
}

export interface LayoutEdgeInput {
  from: string;
  to: string;
  label?: string | undefined;
}

/** Sides an edge must leave its source / enter its target through; undefined lets ELK choose. */
export interface EdgePorts {
  src?: Side | undefined;
  dst?: Side | undefined;
}

/**
 * Port sides for one-row (zoom 0) nodes laid out left to right. Such a node has a single cell on its
 * left and right side, so only one edge can use each: the node's main forward out-edge (an unlabelled
 * `NEXT` first) leaves on the right, its main forward in-edge enters on the left. Other forward edges
 * (skips, early exits) use the top of both nodes and loops (edges to an earlier node in `boxes` order)
 * the bottom, where the node is widened to give every edge its own column (see `layoutFlowGraph`).
 * Every other case returns no constraints.
 */
export function planPorts(boxes: readonly NodeBox[], edges: readonly LayoutEdgeInput[], direction: Direction): EdgePorts[] {
  const plan: EdgePorts[] = edges.map(() => ({}));
  if (direction !== 'LR') return plan;
  const index = new Map(boxes.map((b, i) => [b.id, i]));
  const tiny = new Set(boxes.filter((b) => b.kind === 'tiny').map((b) => b.id));
  if (tiny.size === 0) return plan;
  const forward = (i: number): boolean => index.get(edges[i]!.to)! > index.get(edges[i]!.from)!;
  const ranked = edges
    .map((_, i) => i)
    .filter(forward)
    .sort((a, b) => Number(Boolean(edges[a]!.label)) - Number(Boolean(edges[b]!.label)) || a - b);
  const mainOut = new Map<string, number>();
  const mainIn = new Map<string, number>();
  for (const i of ranked) {
    if (!mainOut.has(edges[i]!.from)) mainOut.set(edges[i]!.from, i);
    if (!mainIn.has(edges[i]!.to)) mainIn.set(edges[i]!.to, i);
  }
  edges.forEach((e, i) => {
    const off: Side = forward(i) ? 0 : 2;
    if (tiny.has(e.from)) plan[i]!.src = mainOut.get(e.from) === i ? 1 : off;
    if (tiny.has(e.to)) plan[i]!.dst = mainIn.get(e.to) === i ? 3 : off;
  });
  return plan;
}

const ELK_SIDE = ['NORTH', 'EAST', 'SOUTH', 'WEST'] as const;

export async function layoutGraph(
  boxes: NodeBox[],
  edges: LayoutEdgeInput[],
  direction: Direction,
  zoom: ZoomLevel,
  ports: readonly EdgePorts[] = [],
): Promise<Layout> {
  const engine = await getElk();
  const sp = spacing(direction, zoom);
  // Fixed-side ports (planPorts): one port per edge end, attached to its node.
  const nodePorts = new Map<string, ElkPort[]>();
  const end = (node: string, side: Side | undefined, id: string): string => {
    if (side === undefined) return node;
    const list = nodePorts.get(node) ?? [];
    list.push({ id, width: 0, height: 0, layoutOptions: { 'elk.port.side': ELK_SIDE[side] } });
    nodePorts.set(node, list);
    return id;
  };
  const elkEdges = edges.map(
    (e, i): ElkExtendedEdge => ({
      id: `e${i}`,
      sources: [end(e.from, ports[i]?.src, `e${i}s`)],
      targets: [end(e.to, ports[i]?.dst, `e${i}t`)],
      labels: e.label ? [{ id: `l${i}`, text: e.label, width: labelWidth(e.label, direction), height: 1 }] : [],
    }),
  );
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction === 'TB' ? 'DOWN' : 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=1,left=1,bottom=1,right=1]',
      'elk.spacing.nodeNode': String(sp.nodeNode),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(sp.layer),
      'elk.spacing.edgeNode': '2',
      'elk.spacing.edgeEdge': '2',
      // >= 2 so a bend never lands on the arrow cell right above/left of a box.
      'elk.layered.spacing.edgeNodeBetweenLayers': '2',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '1',
      // TB: "label │" with one blank (labels are reserved 1 cell wider, see labelWidth, so the next
      // line is at least 3 cells away); LR: label directly below the ─── line. Always the same side
      // (left in TB, below in LR), so a reader can tell which line a label belongs to.
      'elk.spacing.edgeLabel': direction === 'TB' ? '1' : '0',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.layered.edgeLabels.sideSelection': 'ALWAYS_DOWN',
      // Steps arrive in flow order (declaration order, initial first, finals last): edges pointing
      // to an earlier step are the loops, everything else (skips, early exits) flows forward.
      'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      // Route feedback (loop) edges around the nodes instead of through the layers.
      'elk.layered.feedbackEdges': 'true',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      // Keep orphan steps in the same drawing (the default packs components with big gaps).
      'elk.separateConnectedComponents': 'false',
    },
    children: boxes.map((b) => {
      const list = nodePorts.get(b.id);
      if (!list) return { id: b.id, width: b.w, height: b.h };
      return { id: b.id, width: b.w, height: b.h, ports: list, layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE', 'elk.spacing.portPort': '2' } };
    }),
    edges: elkEdges,
  };
  const res = await engine.layout(graph);
  const seps = new Map(boxes.map((b) => [b.id, separatorRows(b)]));

  const fnodes = new Map<string, FRect>();
  const nodes = new Map<string, Rect>();
  for (const c of res.children ?? []) {
    const f = { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 };
    fnodes.set(c.id, f);
    nodes.set(c.id, { x: R(f.x), y: R(f.y), w: f.w, h: f.h });
  }

  // End cells in use per node side (rows for E/W, columns for N/S), so no two edges share one.
  const used = new Map<string, Set<number>>();
  const taken = (id: string, side: Side): Set<number> => {
    const key = `${id}:${side}`;
    let set = used.get(key);
    if (!set) used.set(key, (set = new Set()));
    return set;
  };
  const mark = (id: string, side: Side, p: Pt): void => {
    taken(id, side).add(vertical(side) ? p.x : p.y);
  };

  const routed = new Map((res.edges ?? []).map((e) => [e.id, e]));
  const jobs = edges.flatMap(({ from, to, label }, i) => {
    const section = routed.get(`e${i}`)?.sections?.[0];
    const sr = nodes.get(from);
    const er = nodes.get(to);
    if (!section || !sr || !er) return []; // ELK always routes; skip defensively rather than crash the viewer
    return [{ i, from, to, label, section, sr, er }];
  });
  // Straight edges first: they need one row/column valid for both boxes, so they get first pick and
  // a loop that would land on the same cell moves aside (crossing the line instead of merging into it).
  jobs.sort((a, b) => Number((a.section.bendPoints?.length ?? 0) > 0) - Number((b.section.bendPoints?.length ?? 0) > 0) || a.i - b.i);
  const out: Array<LaidOutEdge | undefined> = [];
  for (const { i, from, to, label, section, sr, er } of jobs) {
    const srcSide = ports[i]?.src ?? sideOnBorder(fnodes.get(from)!, section.startPoint);
    const dstSide = ports[i]?.dst ?? sideOnBorder(fnodes.get(to)!, section.endPoint);
    const sSeps = seps.get(from) ?? new Set<number>();
    const tSeps = seps.get(to) ?? new Set<number>();
    const sTaken = taken(from, srcSide);
    const tTaken = taken(to, dstSide);
    const s: End = { pt: snapEnd(sr, section.startPoint, srcSide, sSeps, sTaken), side: srcSide, rect: sr, seps: sSeps, taken: sTaken };
    const t: End = { pt: snapEnd(er, section.endPoint, dstSide, tSeps, tTaken), side: dstSide, rect: er, seps: tSeps, taken: tTaken };
    const points = snapPath([section.startPoint, ...(section.bendPoints ?? []), section.endPoint], s, t);
    mark(from, srcSide, points[0]!);
    mark(to, dstSide, points.at(-1)!);
    const lab = routed.get(`e${i}`)?.labels?.[0];
    out[i] = {
      from,
      to,
      label,
      points,
      srcSide,
      dstSide,
      labelHint: lab ? { x: (lab.x ?? 0) + (lab.width ?? 0) / 2, y: (lab.y ?? 0) + (lab.height ?? 0) / 2 } : undefined,
    };
  }
  return { width: Math.ceil(res.width ?? 0), height: Math.ceil(res.height ?? 0), nodes, edges: out.filter((e) => e !== undefined) };
}

/**
 * Room ELK reserves for a label. In TB the label sits beside a vertical line ("label │"); one extra
 * cell keeps the next parallel line at least 3 cells from the label, so the 1-cell gap to its own
 * line is clearly the closer one.
 */
function labelWidth(label: string, direction: Direction): number {
  return cellWidth(label) + (direction === 'TB' ? 1 : 0);
}
