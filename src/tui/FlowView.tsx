/**
 * Full-screen flow viewer (Ink). The graph is rendered once per (zoom, direction) into a character
 * canvas; the viewport shows the part that fits between a 1-line header and a 1-line footer.
 */
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FlowModel } from '../core/types.js';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  centerOn,
  clampView,
  createCanvasCache,
  flowToGraph,
  nearestNode,
  pickZoom,
  splitCells,
  viewport,
  type CanvasCache,
  type Direction,
  type RenderedCanvas,
  type ZoomLevel,
} from './graph/index.js';
import { cellWidth, truncate } from './graph/measure.js';

export const FLOW_VIEW_HELP = 'w/a/s/d pan · W/A/S/D page · q zoom in · e zoom out · l layout · c center · x exit';
/** Footer for terminals narrower than the full help (82 cells). */
export const FLOW_VIEW_HELP_SHORT = 'wasd pan · WASD page · q/e zoom in/out · l layout · c center · x exit';

export interface FlowViewProps {
  model: FlowModel;
  /** Current step: drawn with a heavy border and coloured; `c` centres on it (default: the initial step). */
  current?: string | undefined;
  /** Initial zoom; default: the highest level whose canvas fits the viewport, min 1. */
  zoom?: ZoomLevel | undefined;
  direction?: Direction | undefined;
  ascii?: boolean | undefined;
  /** Canvas cache to reuse; must be built from the same model, `current` and `ascii`. */
  cache?: CanvasCache | undefined;
}

interface Shown {
  zoom: ZoomLevel;
  direction: Direction;
  canvas: RenderedCanvas;
}

/** `s` cut or padded to exactly `width` cells. */
function fit(s: string, width: number): string {
  const cut = truncate(s, width);
  return cut + ' '.repeat(Math.max(0, width - cellWidth(cut)));
}

export function FlowView({ model, current, zoom: initialZoom, direction: initialDirection, ascii, cache: givenCache }: FlowViewProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const viewW = Math.max(1, columns);
  const viewH = Math.max(1, rows - 2);
  const size = useRef({ w: viewW, h: viewH });
  size.current = { w: viewW, h: viewH };

  const cache = useMemo(
    () => givenCache ?? createCanvasCache(flowToGraph(model), { ascii, highlight: current }),
    [givenCache, model, ascii, current],
  );
  const [zoom, setZoom] = useState<ZoomLevel | undefined>(initialZoom);
  const [direction, setDirection] = useState<Direction>(initialDirection ?? 'TB');
  const [shown, setShown] = useState<Shown | undefined>();
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  /** Node to centre once the next canvas is shown (the current step at start, the focus on zoom/layout changes). */
  const focus = useRef<string | undefined>(current);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const { w, h } = size.current;
      const z = zoom ?? (await pickZoom(cache, direction, w, h));
      const canvas = await cache.get(z, direction);
      if (cancelled) return;
      const id = focus.current;
      focus.current = undefined;
      const centred = id === undefined ? undefined : centerOn(canvas, id, w, h);
      setZoom(z);
      setShown({ zoom: z, direction, canvas });
      setOrigin((o) => centred ?? clampView(canvas, o.x, o.y, w, h));
    };
    load().catch((error: unknown) => {
      if (!cancelled) exit(error instanceof Error ? error : new Error(String(error)));
    });
    return () => {
      cancelled = true;
    };
  }, [cache, zoom, direction, exit]);

  const ready = shown !== undefined && shown.zoom === zoom && shown.direction === direction ? shown : undefined;
  // While another zoom/layout is computed the previous drawing stays on screen (no blank flash).
  const view = shown ? clampView(shown.canvas, origin.x, origin.y, viewW, viewH) : origin;

  useInput((input, key) => {
    if (input === 'x' || input === 'X') {
      exit();
      return;
    }
    if (!ready || zoom === undefined) return;
    const { canvas } = ready;
    // Functional updates: several keys can arrive before the next render (key repeat).
    const pan = (dx: number, dy: number): void =>
      setOrigin((o) => {
        const from = clampView(canvas, o.x, o.y, viewW, viewH);
        return clampView(canvas, from.x + dx, from.y + dy, viewW, viewH);
      });
    const stepX = Math.max(1, Math.floor(viewW / 4));
    const stepY = Math.max(1, Math.floor(viewH / 4));
    const refocus = (): void => {
      focus.current = nearestNode(canvas, view.x, view.y, viewW, viewH);
    };
    if (input === 'w' || key.upArrow) pan(0, -stepY);
    else if (input === 's' || key.downArrow) pan(0, stepY);
    else if (input === 'a' || key.leftArrow) pan(-stepX, 0);
    else if (input === 'd' || key.rightArrow) pan(stepX, 0);
    else if (input === 'W' || key.pageUp) pan(0, -viewH);
    else if (input === 'S' || key.pageDown) pan(0, viewH);
    else if (input === 'A') pan(-viewW, 0);
    else if (input === 'D') pan(viewW, 0);
    else if (input === 'q' && zoom < MAX_ZOOM) {
      refocus();
      setZoom((z) => (z === undefined ? z : (Math.min(MAX_ZOOM, z + 1) as ZoomLevel)));
    } else if (input === 'e' && zoom > MIN_ZOOM) {
      refocus();
      setZoom((z) => (z === undefined ? z : (Math.max(MIN_ZOOM, z - 1) as ZoomLevel)));
    } else if (input === 'l') {
      refocus();
      setDirection((d) => (d === 'TB' ? 'LR' : 'TB'));
    } else if (input === 'c') {
      const centred = centerOn(canvas, current ?? model.initial, viewW, viewH);
      if (centred) setOrigin(centred);
    }
  });

  const step = current ? model.byId.get(current) : undefined;
  // Most important first: a narrow terminal cuts the header from the right.
  const header = [
    model.title,
    zoom === undefined ? 'zoom …' : `zoom ${zoom}/${MAX_ZOOM}`,
    direction,
    ready ? `pos ${Math.max(0, view.x)},${Math.max(0, view.y)} of ${ready.canvas.width}×${ready.canvas.height}` : 'Laying out…',
    step ? `step: ${step.title}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  let body: ReactNode;
  if (!shown) body = <Text>Laying out…</Text>;
  else {
    const box = current ? shown.canvas.boxes[current] : undefined;
    body = viewport(shown.canvas, view.x, view.y, viewW, viewH).map((line, i) => {
      const y = view.y + i;
      if (!box || y < box.y || y >= box.y + box.h) {
        return (
          <Text key={i} wrap="truncate-end">
            {line}
          </Text>
        );
      }
      // Colour the current step after the window was cut, so no ANSI ever enters the canvas.
      const [before, inside, after] = splitCells(line, box.x - view.x, box.x + box.w - view.x);
      return (
        <Text key={i} wrap="truncate-end">
          {before}
          <Text color="cyan" bold>
            {inside}
          </Text>
          {after}
        </Text>
      );
    });
  }

  return (
    <Box flexDirection="column" width={viewW} height={rows}>
      <Text inverse wrap="truncate-end">
        {fit(` ${header}`, viewW)}
      </Text>
      <Box flexDirection="column" height={viewH} overflow="hidden">
        {body}
      </Box>
      <Text dimColor wrap="truncate-end">
        {truncate(` ${cellWidth(FLOW_VIEW_HELP) < viewW ? FLOW_VIEW_HELP : FLOW_VIEW_HELP_SHORT}`, viewW)}
      </Text>
    </Box>
  );
}
