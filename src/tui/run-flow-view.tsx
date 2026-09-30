/**
 * `dfl flow view` entry. Loaded lazily via dynamic import; Ink/React are only loaded for the
 * interactive viewer, not for `--print` / piped output.
 */
import { DflError } from '../core/errors.js';
import type { AgentId, FlowModel } from '../core/types.js';
import { MAX_ZOOM, MIN_ZOOM, createCanvasCache, flowToGraph, isZoomLevel, renderGraph, type ZoomLevel } from './graph/index.js';

export interface FlowViewOptions {
  /** Current step to highlight. */
  current?: string | undefined;
  zoom?: number | undefined;
  direction?: 'TB' | 'LR' | undefined;
  ascii?: boolean | undefined;
  /**
   * Selected agents (`getSelectedAgents`): zoom-3 cards show how they invoke each step's skill
   * (`/plan`, or `$plan` for Codex). Default: `/plan`.
   */
  agents?: readonly AgentId[] | undefined;
  /** Print the whole canvas and exit (also used automatically when stdin/stdout is not a TTY). */
  print?: boolean | undefined;
}

/** Zoom used for printed output when none is given. */
export const PRINT_ZOOM: ZoomLevel = 2;

function toZoom(value: number | undefined): ZoomLevel | undefined {
  if (value === undefined) return undefined;
  if (!isZoomLevel(value)) {
    throw new DflError(`Invalid zoom level "${value}".`, { hint: `Use a whole number from ${MIN_ZOOM} to ${MAX_ZOOM}.`, code: 'INVALID_ZOOM' });
  }
  return value;
}

export async function runFlowView(model: FlowModel, options: FlowViewOptions = {}): Promise<void> {
  const zoom = toZoom(options.zoom);
  const direction = options.direction ?? 'TB';
  const current = options.current !== undefined && model.byId.has(options.current) ? options.current : undefined;
  const graph = flowToGraph(model, { agents: options.agents });

  if (options.print || !process.stdin.isTTY || !process.stdout.isTTY) {
    const canvas = await renderGraph(graph, { zoom: zoom ?? PRINT_ZOOM, direction, ascii: options.ascii, highlight: current });
    if (canvas.lines.length > 0) process.stdout.write(`${canvas.lines.map((line) => line.trimEnd()).join('\n')}\n`);
    return;
  }

  const [{ render }, { createElement }, { FlowView }] = await Promise.all([import('ink'), import('react'), import('./FlowView.js')]);
  const cache = createCanvasCache(graph, { ascii: options.ascii, highlight: current });
  const app = render(createElement(FlowView, { model, current, zoom, direction, ascii: options.ascii, agents: options.agents, cache }), {
    alternateScreen: true,
    exitOnCtrlC: true,
  });
  await app.waitUntilExit();
}
