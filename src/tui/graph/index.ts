/**
 * Flow graph → character canvas. elkjs `layered` + orthogonal routing laid out in terminal cells,
 * drawn on a canvas with per-cell line directions (ported from the research prototype).
 *
 * Zoom levels: 0 one-line `[Title…]` nodes, 1 boxed titles, 2 cards with a wrapped description
 * (max 3 lines), 3 cards with the full description and the node `detail` (the skill command).
 * Final nodes are drawn small at every zoom: `(Done)` at zoom 0, a double-bordered box above.
 * The highlighted node gets a heavy border.
 */
import { NEXT_EVENT } from '../../core/flow.js';
import type { FlowModel } from '../../core/types.js';
import { renderGraph } from './render.js';
import { fitsIn } from './viewport.js';
import type { Direction, FlowGraph, RenderGraphOptions, RenderedCanvas, ZoomLevel } from './types.js';

export type {
  CanvasBox,
  Direction,
  FlowGraph,
  GraphEdge,
  GraphNode,
  RenderGraphOptions,
  RenderedCanvas,
  ZoomLevel,
} from './types.js';
export { renderGraph } from './render.js';
export { centerOn, clampView, fitsIn, lineCells, nearestNode, splitCells, viewport, type ViewOrigin } from './viewport.js';

export const MIN_ZOOM: ZoomLevel = 0;
export const MAX_ZOOM: ZoomLevel = 3;

export function isZoomLevel(value: unknown): value is ZoomLevel {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

export interface FlowToGraphOptions {
  /**
   * Label `NEXT` edges too. Default false: `NEXT` is the conventional forward event, so an
   * unlabelled edge reads as `NEXT` and only the other events (loops, branches) carry labels.
   */
  labelNext?: boolean | undefined;
}

/** Nodes in flow order (non-final steps carry their slash command as `detail`), edges per transition. */
export function flowToGraph(model: FlowModel, options: FlowToGraphOptions = {}): FlowGraph {
  return {
    nodes: model.steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description || undefined,
      detail: step.final ? undefined : `/${step.skillName}`,
      final: step.final,
    })),
    edges: model.transitions
      .filter((t) => model.byId.has(t.source) && model.byId.has(t.target))
      .map((t) => ({
        from: t.source,
        to: t.target,
        label: t.event === NEXT_EVENT && !options.labelNext ? undefined : t.event,
      })),
  };
}

/** Renders each (zoom, direction) of one graph once; concurrent requests share the pending layout. */
export interface CanvasCache {
  get(zoom: ZoomLevel, direction: Direction): Promise<RenderedCanvas>;
  /** The canvas if it is already rendered. */
  peek(zoom: ZoomLevel, direction: Direction): RenderedCanvas | undefined;
}

export function createCanvasCache(graph: FlowGraph, options: Omit<RenderGraphOptions, 'zoom' | 'direction'> = {}): CanvasCache {
  const done = new Map<string, RenderedCanvas>();
  const pending = new Map<string, Promise<RenderedCanvas>>();
  return {
    peek: (zoom, direction) => done.get(`${zoom}:${direction}`),
    get(zoom, direction) {
      const key = `${zoom}:${direction}`;
      const hit = done.get(key);
      if (hit) return Promise.resolve(hit);
      let job = pending.get(key);
      if (!job) {
        job = renderGraph(graph, { ...options, zoom, direction }).then(
          (canvas) => {
            done.set(key, canvas);
            pending.delete(key);
            return canvas;
          },
          (error: unknown) => {
            pending.delete(key);
            throw error;
          },
        );
        pending.set(key, job);
      }
      return job;
    },
  };
}

/** The highest zoom (≤ 3) whose canvas fits a `w`×`h` view, else 1. */
export async function pickZoom(cache: CanvasCache, direction: Direction, w: number, h: number): Promise<ZoomLevel> {
  for (const zoom of [3, 2, 1] as const) {
    if (fitsIn(await cache.get(zoom, direction), w, h)) return zoom;
  }
  return 1;
}
