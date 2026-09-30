/**
 * Flow graph → character canvas (OWNER: tui agent). Ported from the elkjs prototype.
 */
import type { FlowModel } from '../../core/types.js';

export type ZoomLevel = 0 | 1 | 2 | 3;
export const MIN_ZOOM: ZoomLevel = 0;
export const MAX_ZOOM: ZoomLevel = 3;

export interface GraphNode {
  id: string;
  title: string;
  description?: string | undefined;
  /** Secondary line at zoom 3, e.g. the slash command. */
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
  direction?: 'TB' | 'LR' | undefined;
  /** Use `+-|` ASCII instead of box-drawing characters. */
  ascii?: boolean | undefined;
  /** Node id drawn with a heavy border. */
  highlight?: string | undefined;
}

export function flowToGraph(model: FlowModel): FlowGraph {
  throw new Error('not implemented');
}

export async function renderGraph(graph: FlowGraph, options: RenderGraphOptions): Promise<RenderedCanvas> {
  throw new Error('not implemented');
}

/** Cuts a `w`×`h` window at (`x`,`y`) out of the canvas, padding with spaces. */
export function viewport(canvas: RenderedCanvas, x: number, y: number, w: number, h: number): string[] {
  throw new Error('not implemented');
}
