/**
 * Types of the flow graph renderer. The public ones are re-exported from `./index.js`;
 * the geometry types are internal to `src/tui/graph/`.
 */

export type ZoomLevel = 0 | 1 | 2 | 3;
export type Direction = 'TB' | 'LR';

export interface GraphNode {
  id: string;
  title: string;
  description?: string | undefined;
  /** Secondary line at zoom 3: how the selected agents invoke the step skill (`/plan`, `$plan`). */
  detail?: string | undefined;
  final?: boolean | undefined;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string | undefined;
}

export interface FlowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface CanvasBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderedCanvas {
  /** Plain text rows (no ANSI), each exactly `width` cells wide. */
  lines: string[];
  width: number;
  height: number;
  /** Node boxes by id (for highlighting/centering). */
  boxes: Record<string, CanvasBox>;
}

export interface RenderGraphOptions {
  zoom: ZoomLevel;
  direction?: Direction | undefined;
  /** Use `+-|` ASCII instead of box-drawing characters. */
  ascii?: boolean | undefined;
  /** Node id drawn with a heavy border. */
  highlight?: string | undefined;
}

// ---------------------------------------------------------------------------
// Internal geometry (all in terminal cells)
// ---------------------------------------------------------------------------

/** Side of a box, also used as the outward normal index: N=0 E=1 S=2 W=3. */
export type Side = 0 | 1 | 2 | 3;

export interface Pt {
  x: number;
  y: number;
}

/** Covers columns x..x+w-1 and rows y..y+h-1. */
export type Rect = CanvasBox;

export interface LaidOutEdge {
  from: string;
  to: string;
  /** Orthogonal polyline from the first cell outside the source box to the arrow cell outside the target box. */
  points: Pt[];
  srcSide: Side;
  dstSide: Side;
  label?: string | undefined;
  /** Where the layout engine reserved room for the label (the label placer searches near it). */
  labelHint?: Pt | undefined;
}

export interface Layout {
  width: number;
  height: number;
  nodes: Map<string, Rect>;
  edges: LaidOutEdge[];
}
