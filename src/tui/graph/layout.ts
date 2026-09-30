/**
 * ELK `layered` layout with ORTHOGONAL edge routing, computed directly in terminal cells
 * (1 ELK unit = 1 cell), then snapped to whole cells.
 */
import type { ELK, ELKConstructorArguments, ElkExtendedEdge, ElkNode, ElkPoint } from 'elkjs/lib/elk-api.js';
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
 * the corners and off separator rows of cards.
 */
function snapEnd(r: Rect, p: ElkPoint, side: Side, seps: Set<number>): Pt {
  if (vertical(side)) return { x: clamp(R(p.x), r.x + 1, r.x + r.w - 2), y: side === 0 ? r.y - 1 : r.y + r.h };
  const y = r.h === 1 ? r.y : (freeRow(p.y, r.y + 1, r.y + r.h - 2, (row) => seps.has(row - r.y)) ?? clamp(R(p.y), r.y + 1, r.y + r.h - 2));
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
}

/** Replaces ELK's endpoints with the snapped cells and drags the adjacent bends along so segments stay orthogonal. */
function snapPath(raw: ElkPoint[], s: End, e: End): Pt[] {
  const mid = raw.slice(1, -1).map((p) => ({ x: R(p.x), y: R(p.y) }));
  if (mid.length === 0) {
    // Straight edge: pick one column/row valid for both boxes, else add a jog in the middle.
    if (vertical(s.side)) {
      const lo = Math.max(s.rect.x + 1, e.rect.x + 1);
      const hi = Math.min(s.rect.x + s.rect.w - 2, e.rect.x + e.rect.w - 2);
      if (lo <= hi) {
        const x = clamp(s.pt.x, lo, hi);
        return [{ ...s.pt, x }, { ...e.pt, x }];
      }
      const my = R((s.pt.y + e.pt.y) / 2);
      return [s.pt, { x: s.pt.x, y: my }, { x: e.pt.x, y: my }, e.pt];
    }
    const lo = Math.max(s.rect.y + 1, e.rect.y + 1);
    const hi = Math.min(s.rect.y + s.rect.h - 2, e.rect.y + e.rect.h - 2);
    const y = s.rect.h > 1 && e.rect.h > 1 ? freeRow(s.pt.y, lo, hi, (row) => s.seps.has(row - s.rect.y) || e.seps.has(row - e.rect.y)) : undefined;
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

export async function layoutGraph(boxes: NodeBox[], edges: LayoutEdgeInput[], direction: Direction, zoom: ZoomLevel): Promise<Layout> {
  const engine = await getElk();
  const sp = spacing(direction, zoom);
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
      // TB: "label │" with one blank; LR: label directly above/below the ─── line.
      'elk.spacing.edgeLabel': direction === 'TB' ? '1' : '0',
      'elk.edgeLabels.placement': 'CENTER',
      // Steps are passed in flow order: edges pointing to an earlier step are the loops.
      'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      // Route feedback (loop) edges around the nodes instead of through the layers.
      'elk.layered.feedbackEdges': 'true',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      // Keep orphan steps in the same drawing (the default packs components with big gaps).
      'elk.separateConnectedComponents': 'false',
    },
    children: boxes.map((b) => ({ id: b.id, width: b.w, height: b.h })),
    edges: edges.map(
      (e, i): ElkExtendedEdge => ({
        id: `e${i}`,
        sources: [e.from],
        targets: [e.to],
        labels: e.label ? [{ id: `l${i}`, text: e.label, width: cellWidth(e.label), height: 1 }] : [],
      }),
    ),
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

  const routed = new Map((res.edges ?? []).map((e) => [e.id, e]));
  const out: LaidOutEdge[] = [];
  edges.forEach(({ from, to, label }, i) => {
    const section = routed.get(`e${i}`)?.sections?.[0];
    const sr = nodes.get(from);
    const er = nodes.get(to);
    if (!section || !sr || !er) return; // ELK always routes; skip defensively rather than crash the viewer
    const srcSide = sideOnBorder(fnodes.get(from)!, section.startPoint);
    const dstSide = sideOnBorder(fnodes.get(to)!, section.endPoint);
    const sSeps = seps.get(from) ?? new Set<number>();
    const tSeps = seps.get(to) ?? new Set<number>();
    const s: End = { pt: snapEnd(sr, section.startPoint, srcSide, sSeps), side: srcSide, rect: sr, seps: sSeps };
    const t: End = { pt: snapEnd(er, section.endPoint, dstSide, tSeps), side: dstSide, rect: er, seps: tSeps };
    const lab = routed.get(`e${i}`)?.labels?.[0];
    out.push({
      from,
      to,
      label,
      points: snapPath([section.startPoint, ...(section.bendPoints ?? []), section.endPoint], s, t),
      srcSide,
      dstSide,
      labelHint: lab ? { x: (lab.x ?? 0) + (lab.width ?? 0) / 2, y: (lab.y ?? 0) + (lab.height ?? 0) / 2 } : undefined,
    });
  });
  return { width: Math.ceil(res.width ?? 0), height: Math.ceil(res.height ?? 0), nodes, edges: out };
}
