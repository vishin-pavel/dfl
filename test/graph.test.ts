import os from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { buildFlowModel } from '../src/core/flow.js';
import {
  centerOn,
  clampView,
  createCanvasCache,
  flowToGraph,
  lineCells,
  nearestNode,
  pickZoom,
  renderGraph,
  splitCells,
  viewport,
  type FlowGraph,
  type RenderedCanvas,
  type ZoomLevel,
} from '../src/tui/graph/index.js';
import { sampleFlowDefinition } from './helpers/project.js';

const model = buildFlowModel(sampleFlowDefinition(), path.join(os.tmpdir(), 'dfl-graph-test'));
const graph = flowToGraph(model);
const ZOOMS: ZoomLevel[] = [0, 1, 2, 3];
const DIRECTIONS = ['TB', 'LR'] as const;

/** The cell at (x, y), treating wide glyphs as occupying two cells. */
function cellAt(canvas: RenderedCanvas, x: number, y: number): string | undefined {
  return lineCells(canvas.lines[y] ?? '')[x];
}

function expectWellFormed(canvas: RenderedCanvas): void {
  expect(canvas.lines).toHaveLength(canvas.height);
  for (const line of canvas.lines) expect(stringWidth(line)).toBe(canvas.width);
  for (const box of Object.values(canvas.boxes)) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w).toBeLessThanOrEqual(canvas.width);
    expect(box.y + box.h).toBeLessThanOrEqual(canvas.height);
  }
}

describe('flowToGraph', () => {
  it('maps steps in flow order and transitions to edges, leaving NEXT unlabelled', () => {
    expect(graph.nodes).toEqual([
      { id: 'plan', title: 'Plan', description: 'Plan the work', detail: '/plan', final: false },
      { id: 'build', title: 'Build', description: 'Build it', detail: '/build', final: false },
      { id: 'review', title: 'Review', description: 'Review it', detail: '/review', final: false },
      { id: 'done', title: 'Done', description: 'All done', detail: undefined, final: true },
    ]);
    expect(graph.edges).toEqual([
      { from: 'plan', to: 'build', label: undefined },
      { from: 'build', to: 'review', label: undefined },
      { from: 'build', to: 'plan', label: 'BACK' },
      { from: 'review', to: 'done', label: undefined },
      { from: 'review', to: 'build', label: 'CHANGES_REQUESTED' },
    ]);
  });

  it('labels NEXT on request and uses the skill prefix for the detail line', () => {
    const def = { ...sampleFlowDefinition(), skillPrefix: 'x-' };
    const prefixed = flowToGraph(buildFlowModel(def, os.tmpdir()), { labelNext: true });
    expect(prefixed.nodes[0]?.detail).toBe('/x-plan');
    expect(prefixed.edges[0]?.label).toBe('NEXT');
  });
});

describe('renderGraph', () => {
  for (const direction of DIRECTIONS) {
    for (const zoom of ZOOMS) {
      it(`draws every node at zoom ${zoom} ${direction}`, async () => {
        const canvas = await renderGraph(graph, { zoom, direction, highlight: 'build' });
        expectWellFormed(canvas);
        expect(Object.keys(canvas.boxes).sort()).toEqual(['build', 'done', 'plan', 'review']);
        const text = canvas.lines.join('\n');
        for (const title of ['Plan', 'Build', 'Review', 'Done']) expect(text).toContain(title);
        expect(text).toContain(direction === 'TB' ? '▼' : '►');
        expect(text).not.toContain('NEXT');
        expect(text).toContain(zoom === 0 ? 'CHANG…' : 'CHANGES_REQUESTED');
        expect(text).toContain('BACK');

        const build = canvas.boxes.build!;
        const done = canvas.boxes.done!;
        if (zoom === 0) {
          expect(text).toContain('[Plan]');
          expect(text).toContain('▐Build▌');
          expect(text).toContain('(Done)');
        } else {
          // Heavy border for the highlighted step, double border for the final state.
          expect(cellAt(canvas, build.x, build.y)).toBe('┏');
          expect(cellAt(canvas, build.x + build.w - 1, build.y + build.h - 1)).toBe('┛');
          expect(cellAt(canvas, done.x, done.y)).toBe('╔');
          const plan = canvas.boxes.plan!;
          expect(cellAt(canvas, plan.x, plan.y)).toBe('┌');
        }
        // Descriptions from zoom 2, slash commands only at zoom 3; final states stay small.
        expect(text.includes('Plan the work')).toBe(zoom >= 2);
        expect(text.includes('/plan')).toBe(zoom === 3);
        expect(text).not.toContain('All done');
        if (zoom > 0) expect(done.h).toBe(3);
      });
    }
  }

  it('grows cards with zoom', async () => {
    const heights = await Promise.all(ZOOMS.map(async (zoom) => (await renderGraph(graph, { zoom })).boxes.plan!.h));
    expect(heights).toEqual([1, 3, 5, 7]);
  });

  it('draws pure ASCII with --ascii', async () => {
    for (const zoom of ZOOMS) {
      const canvas = await renderGraph(graph, { zoom, ascii: true, highlight: 'build' });
      expectWellFormed(canvas);
      for (const line of canvas.lines) expect(line).toMatch(/^[\x20-\x7e]*$/);
      expect(canvas.lines.join('\n')).toContain('v');
      if (zoom > 0) {
        const done = canvas.boxes.done!;
        expect(cellAt(canvas, done.x, done.y)).toBe('/');
        expect(cellAt(canvas, canvas.boxes.build!.x, canvas.boxes.build!.y)).toBe('#');
      }
    }
  });

  it('handles self-loops, orphans, unknown targets and wide glyphs', async () => {
    const tricky: FlowGraph = {
      nodes: [
        { id: 'a', title: '計画 plan', description: '日本語の説明 with wide glyphs', detail: '/a' },
        { id: 'b', title: 'Build', description: 'Build it' },
        { id: 'orphan', title: 'Orphan' },
        { id: 'end', title: 'End', final: true },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'b', label: 'RETRY' },
        { from: 'b', to: 'end' },
        { from: 'b', to: 'ghost', label: 'LOST' },
      ],
    };
    for (const direction of DIRECTIONS) {
      for (const zoom of ZOOMS) {
        const canvas = await renderGraph(tricky, { zoom, direction });
        expectWellFormed(canvas);
        const text = canvas.lines.join('\n');
        expect(text).toContain('↻');
        expect(text).toContain('Orphan');
        expect(text).not.toContain('LOST');
        if (zoom >= 2) expect(text).toContain('↻ RETRY');
      }
    }
  });

  it('caps descriptions at 3 lines on zoom 2 and shows them in full on zoom 3', async () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const long: FlowGraph = { nodes: [{ id: 'a', title: 'Long', description: words, detail: '/long' }], edges: [] };
    const two = await renderGraph(long, { zoom: 2 });
    expect(two.boxes.a!.h).toBe(3 + 3 + 1); // borders, title, separator, 3 description lines
    expect(two.lines.join('\n')).toContain('…');
    expect(two.lines.join('\n')).not.toContain('word39');
    const three = await renderGraph(long, { zoom: 3 });
    expect(three.lines.join('\n')).toContain('word39');
    expect(three.lines.join('\n')).toContain('/long');
  });

  it('renders an empty graph as an empty canvas', async () => {
    expect(await renderGraph({ nodes: [], edges: [] }, { zoom: 1 })).toEqual({ lines: [], width: 0, height: 0, boxes: {} });
  });
});

describe('viewport', () => {
  const canvas: RenderedCanvas = { lines: ['abcd', 'efgh', 'ijkl'], width: 4, height: 3, boxes: { n: { x: 1, y: 1, w: 2, h: 1 } } };

  it('cuts windows and pads outside the canvas with spaces', () => {
    expect(viewport(canvas, 1, 1, 2, 2)).toEqual(['fg', 'jk']);
    expect(viewport(canvas, -2, -1, 4, 3)).toEqual(['    ', '  ab', '  ef']);
    expect(viewport(canvas, 3, 2, 3, 2)).toEqual(['l  ', '   ']);
  });

  it('keeps rows exactly w cells wide around wide glyphs', () => {
    const wide: RenderedCanvas = { lines: ['a日本b'], width: 6, height: 1, boxes: {} };
    expect(viewport(wide, 0, 0, 6, 1)).toEqual(['a日本b']);
    expect(viewport(wide, 2, 0, 3, 1)).toEqual([' 本']); // starts inside 日
    expect(viewport(wide, 0, 0, 2, 1)).toEqual(['a ']); // 日 cut by the right edge
    for (let x = -1; x < 7; x++) for (const line of viewport(wide, x, 0, 3, 1)) expect(stringWidth(line)).toBe(3);
  });

  it('splits a cut row at cell columns for colouring', () => {
    expect(splitCells('abcdef', 2, 4)).toEqual(['ab', 'cd', 'ef']);
    expect(splitCells('a日b', 1, 3)).toEqual(['a', '日', 'b']);
    expect(splitCells('abc', -5, 99)).toEqual(['', 'abc', '']);
  });

  it('clamps panning to the canvas and centres narrow canvases', () => {
    const big: RenderedCanvas = { lines: Array(20).fill(' '.repeat(50)), width: 50, height: 20, boxes: {} };
    expect(clampView(big, -5, -5, 10, 5)).toEqual({ x: 0, y: 0 });
    expect(clampView(big, 99, 99, 10, 5)).toEqual({ x: 40, y: 15 });
    expect(clampView(big, 7, 3, 10, 5)).toEqual({ x: 7, y: 3 });
    expect(clampView(canvas, 3, 3, 10, 5)).toEqual({ x: -3, y: 0 });
  });

  it('centres on nodes and finds the node nearest the view centre', async () => {
    const tall = await renderGraph(graph, { zoom: 2, direction: 'TB' });
    const review = tall.boxes.review!;
    const origin = centerOn(tall, 'review', 20, 8)!;
    expect(origin.y).toBeLessThanOrEqual(review.y);
    expect(origin.y + 8).toBeGreaterThanOrEqual(review.y + review.h);
    expect(nearestNode(tall, origin.x, origin.y, 20, 8)).toBe('review');
    expect(centerOn(tall, 'missing', 20, 8)).toBeUndefined();
  });
});

describe('createCanvasCache / pickZoom', () => {
  it('renders each zoom and direction once', async () => {
    const cache = createCanvasCache(graph, { highlight: 'plan' });
    const [first, second] = await Promise.all([cache.get(1, 'TB'), cache.get(1, 'TB')]);
    expect(first).toBe(second);
    expect(cache.peek(1, 'TB')).toBe(first);
    expect(cache.peek(1, 'LR')).toBeUndefined();
    expect(await cache.get(1, 'LR')).not.toBe(first);
  });

  it('picks the highest zoom that fits, else 1', async () => {
    const cache = createCanvasCache(graph);
    const z3 = await cache.get(3, 'TB');
    expect(await pickZoom(cache, 'TB', z3.width, z3.height)).toBe(3);
    expect(await pickZoom(cache, 'TB', z3.width, z3.height - 1)).toBeLessThan(3);
    expect(await pickZoom(cache, 'TB', 5, 5)).toBe(1);
  });
});
