import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { buildFlowModel } from '../src/core/flow.js';
import type { FlowDefinition } from '../src/core/types.js';
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
  type CanvasBox,
  type FlowGraph,
  type RenderedCanvas,
  type ZoomLevel,
} from '../src/tui/graph/index.js';
import { edgeLabelText } from '../src/tui/graph/measure.js';
import { layoutFlowGraph } from '../src/tui/graph/render.js';
import { sampleFlowDefinition } from './helpers/project.js';

const model = buildFlowModel(sampleFlowDefinition(), path.join(os.tmpdir(), 'dfl-graph-test'));
const graph = flowToGraph(model);
const ZOOMS: ZoomLevel[] = [0, 1, 2, 3];
const DIRECTIONS = ['TB', 'LR'] as const;
const ARROWS = '▼◄▲►';
const ASCII_ARROWS = 'v<^>';

type Machine = FlowDefinition['machine'];
const T1: Omit<Machine, 'id'> = {
  initial: 'a',
  states: { a: { on: { NEXT: 'b', CANCEL: 'done' } }, b: { on: { NEXT: 'c' } }, c: { on: { NEXT: 'd' } }, d: { on: { NEXT: 'done' } }, done: { type: 'final' } },
};
const T2: Omit<Machine, 'id'> = {
  initial: 'a',
  states: { a: { on: { NEXT: 'b', SKIP: 'd' } }, b: { on: { NEXT: 'c' } }, c: { on: { NEXT: 'd' } }, d: { on: { NEXT: 'done' } }, done: { type: 'final' } },
};

function flowDef(machine: Omit<Machine, 'id'>, name = 'f'): FlowDefinition {
  return { name, machine: { id: name, ...machine } } as FlowDefinition;
}

/** The flow templates dfl shipped before "dev" (feature, bugfix, quick), kept as test fixtures; `templates` adds the shipped "dev". */
const TEMPLATE_FLOWS = fileURLToPath(new URL('./fixtures/flows/', import.meta.url));
/** The flow dfl ships (templates/flows/dev). */
const DEV_FLOW = fileURLToPath(new URL('../templates/flows/dev/flow.json', import.meta.url));

function templateDef(name: string): FlowDefinition {
  return JSON.parse(fs.readFileSync(path.join(TEMPLATE_FLOWS, name, 'flow.json'), 'utf8')) as FlowDefinition;
}

const graphOf = (def: FlowDefinition): FlowGraph => flowToGraph(buildFlowModel(def, os.tmpdir()));

/** a→b→c→done with a c→b BACK loop and one-letter titles (the zoom-0 worst case). */
const m1: FlowGraph = {
  nodes: [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
    { id: 'c', title: 'C' },
    { id: 'done', title: 'Done', final: true },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'done' },
    { from: 'c', to: 'b', label: 'BACK' },
  ],
};

/** Cards whose B→C and D→C (RETRY) endpoints used to snap onto the same cell at zoom 2 LR. */
const m4 = graphOf(
  flowDef({
    initial: 'a',
    states: {
      a: { description: 'theta gamma lambda eta eta kappa', on: { NEXT: 'b' } },
      b: { description: 'alpha alpha zeta theta zeta zeta delta', on: { NEXT: 'c' } },
      c: { description: 'zeta delta beta', on: { NEXT: 'd' } },
      d: { description: 'delta epsilon beta kappa', on: { NEXT: 'done', RETRY: 'c' } },
      done: { type: 'final' },
    },
  }),
);

/** Three parallel a→b edges and two b→a loops: labels between parallel lines. */
const par = graphOf(
  flowDef({
    initial: 'a',
    states: { a: { on: { NEXT: 'b', RETRY: 'b', SKIP: 'b' } }, b: { on: { NEXT: 'done', BACK: 'a', UNDO: 'a' } }, done: { type: 'final' } },
  }),
);

/** The retired fixtures and the shipped "dev" (back edges, skips and two final states). */
const templates: Record<string, FlowGraph> = {
  ...Object.fromEntries(['feature', 'bugfix', 'quick'].map((name) => [name, graphOf(templateDef(name))])),
  dev: graphOf(JSON.parse(fs.readFileSync(DEV_FLOW, 'utf8')) as FlowDefinition),
};

/** Cells of the canvas (one entry per cell). */
const cellsOf = (canvas: RenderedCanvas): string[][] => canvas.lines.map(lineCells);

const inBox = (boxes: Record<string, CanvasBox>, x: number, y: number): boolean =>
  Object.values(boxes).some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);

function arrowCells(canvas: RenderedCanvas, glyphs: string): string[] {
  const out: string[] = [];
  cellsOf(canvas).forEach((row, y) =>
    row.forEach((c, x) => {
      if (glyphs.includes(c) && c !== '' && !inBox(canvas.boxes, x, y)) out.push(`${x},${y}`);
    }),
  );
  return out;
}

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

  it('shows the skill invocation of the selected agents as the detail line', () => {
    const detail = (agents?: Parameters<typeof flowToGraph>[1]) => flowToGraph(model, agents).nodes[0]?.detail;
    expect(detail()).toBe('/plan');
    expect(detail({ agents: [] })).toBe('/plan');
    expect(detail({ agents: ['claude'] })).toBe('/plan');
    expect(detail({ agents: ['codex'] })).toBe('$plan');
    expect(detail({ agents: ['claude', 'codex'] })).toBe('/plan $plan');
    expect(flowToGraph(model, { agents: ['codex'] }).nodes.at(-1)?.detail).toBeUndefined(); // final state
  });

  it('orders nodes by declaration with the initial state first and final states last', () => {
    // BFS from the initial state would give a, b, d, c, done (the SKIP target d comes early).
    const t2 = buildFlowModel(flowDef(T2), os.tmpdir());
    expect(flowToGraph(t2).nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd', 'done']);
    const shuffled = buildFlowModel(
      flowDef({
        initial: 'a',
        states: { done: { type: 'final' }, b: { on: { NEXT: 'done' } }, cancelled: { type: 'final' }, a: { on: { NEXT: 'b', CANCEL: 'cancelled' } } },
      }),
      os.tmpdir(),
    );
    expect(flowToGraph(shuffled).nodes.map((n) => n.id)).toEqual(['a', 'b', 'done', 'cancelled']);
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

describe('edge ends', () => {
  const cases: Array<[string, FlowGraph]> = [['m1', m1], ['m4', m4], ['par', par], ['sample', graph], ...Object.entries(templates)];

  for (const [name, g] of cases) {
    it(`gives every edge of ${name} its own end cells and arrowhead at every zoom and direction`, async () => {
      const edges = g.edges.filter((e) => e.from !== e.to).length;
      for (const direction of DIRECTIONS) {
        for (const zoom of ZOOMS) {
          const where = `${name} zoom ${zoom} ${direction}`;
          const laid = (await layoutFlowGraph(g, { zoom, direction }))!;
          expect(laid.layout.edges, where).toHaveLength(edges);
          // No two edges start or end on the same cell (no merged lines, no shared arrowhead).
          const ends = laid.layout.edges.flatMap((e) => [e.points[0]!, e.points.at(-1)!].map((p) => `${p.x},${p.y}`));
          expect(new Set(ends).size, where).toBe(ends.length);

          const uni = await renderGraph(g, { zoom, direction });
          const arrows = arrowCells(uni, ARROWS);
          expect(arrows, where).toHaveLength(edges);
          // --ascii draws the same geometry with v<^> arrowheads.
          const ascii = await renderGraph(g, { zoom, direction, ascii: true });
          expect(arrowCells(ascii, ASCII_ARROWS), `${where} ascii`).toEqual(arrows);
        }
      }
    });
  }

  it('keeps zoom-0 nodes on one line and routes extra edges above/below them in LR', async () => {
    const canvas = await renderGraph(m1, { zoom: 0, direction: 'LR' });
    expect(canvas.lines.map((l) => l.trimEnd())).toMatchInlineSnapshot(`
      [
        "[A]───►[B]───────────►[C]───►(Done)",
        "        ▲              │",
        "        │              │",
        "        │              │",
        "        ╰──────────────╯",
        "              BACK",
      ]
    `);
    expect(Object.values(canvas.boxes).every((b) => b.h === 1)).toBe(true);
  });

  it('widens zoom-0 nodes so edges do not share a column in TB', async () => {
    const canvas = await renderGraph(m1, { zoom: 0, direction: 'TB' });
    expect(canvas.lines.map((l) => l.trimEnd())).toMatchInlineSnapshot(`
      [
        "  [A]",
        "   │",
        "   │",
        "   │╭────────╮",
        "   ▼▼        │",
        " [ B ]       │",
        "    │        │",
        "    │        │",
        "    │   BACK │",
        "    │        │",
        "    ▼        │",
        " [ C ]       │",
        "   ││        │",
        "   ││        │",
        "   │╰────────╯",
        "   ▼",
        "(Done)",
      ]
    `);
    expect(canvas.lines.join('\n')).toContain('[ B ]');
  });

  it('moves a loop off a cell a straight edge already uses (m4, zoom 2 LR)', async () => {
    const laid = (await layoutFlowGraph(m4, { zoom: 2, direction: 'LR' }))!;
    const intoC = laid.layout.edges.filter((e) => e.to === 'c').map((e) => e.points.at(-1)!);
    expect(intoC).toHaveLength(2);
    expect(intoC[0]).not.toEqual(intoC[1]);
    const canvas = await renderGraph(m4, { zoom: 2, direction: 'LR' });
    const c = canvas.boxes.c!;
    const column = cellsOf(canvas).map((row) => row[c.x - 1]);
    expect(column.filter((cell) => cell === '►')).toHaveLength(2);
  });
});

describe('layout order', () => {
  /** Box of each node on the rendered canvas; `along` is y (TB) or x (LR). */
  async function positions(g: FlowGraph, zoom: ZoomLevel, direction: 'TB' | 'LR') {
    const canvas = await renderGraph(g, { zoom, direction });
    const along = (id: string): number => (direction === 'TB' ? canvas.boxes[id]!.y : canvas.boxes[id]!.x);
    return { canvas, along };
  }

  for (const [name, machine] of [
    ['CANCEL a→done', T1],
    ['SKIP a→d', T2],
  ] as const) {
    it(`draws an acyclic flow with ${name} as forward edges only, Done last`, async () => {
      const g = graphOf(flowDef(machine));
      for (const direction of DIRECTIONS) {
        for (const zoom of ZOOMS) {
          const { canvas, along } = await positions(g, zoom, direction);
          for (const e of g.edges) expect(along(e.to), `${e.from}→${e.to} zoom ${zoom} ${direction}`).toBeGreaterThan(along(e.from));
          const last = Math.max(...Object.keys(canvas.boxes).map(along));
          expect(along('done')).toBe(last);
        }
      }
    });
  }

  it('keeps the NEXT chain in order when a cyclic flow gets a skip (feature + TRIVIAL spec→ship)', async () => {
    const def = templateDef('feature');
    const spec = def.machine.states['spec-feature']!;
    spec.on = { ...spec.on, TRIVIAL: 'ship-feature' };
    const g = graphOf(def);
    const chain = ['spec-feature', 'plan-feature', 'implement-feature', 'verify-feature', 'review-feature', 'ship-feature', 'done'];
    for (const zoom of ZOOMS) {
      const { along } = await positions(g, zoom, 'TB');
      for (let i = 1; i < chain.length; i++) expect(along(chain[i]!), `${chain[i]} zoom ${zoom}`).toBeGreaterThan(along(chain[i - 1]!));
      for (const e of g.edges) {
        const upward = along(e.to) < along(e.from);
        expect(upward, `${e.from} ${e.label ?? 'NEXT'} ${e.to}`).toBe(['BACK', 'FAILED', 'CHANGES_REQUESTED'].includes(e.label ?? ''));
      }
    }
  });
});

describe('edge labels', () => {
  const LINE = new Set([...'│─├┤┬┴┼╭╮╰╯▼◄▲►']);

  /**
   * Every label must read as belonging to exactly one line: inline on a `───` run, touching a
   * horizontal run with no other line in the row beyond it, or beside a vertical run at least 2 cells
   * closer to it than to any line on its other side.
   */
  function expectAttached(canvas: RenderedCanvas, labels: string[], where: string): void {
    const cells = cellsOf(canvas);
    const isLine = (x: number, y: number): boolean => LINE.has(cells[y]?.[x] ?? ' ') && !inBox(canvas.boxes, x, y);
    const gap = (x: number, y: number, dx: number): number => {
      for (let n = 0; ; n++) {
        const c = cells[y]?.[x + n * dx];
        if (c === undefined) return Infinity;
        if (c !== ' ') return isLine(x + n * dx, y) ? n : Infinity;
      }
    };
    const rowHasLine = (y: number, x0: number, x1: number): boolean => {
      for (let x = x0; x <= x1; x++) if (isLine(x, y)) return true;
      return false;
    };
    let found = 0;
    cells.forEach((row, y) => {
      const line = row.join('');
      for (const label of new Set(labels)) {
        for (let x = line.indexOf(label); x >= 0; x = line.indexOf(label, x + 1)) {
          if (inBox(canvas.boxes, x, y)) continue;
          found++;
          const w = label.length;
          const what = `${where}: "${label}" at ${x},${y}`;
          if (row[x - 1] === '─' && row[x + w] === '─') continue; // inline
          const above = rowHasLine(y - 1, x, x + w - 1);
          const below = rowHasLine(y + 1, x, x + w - 1);
          if (above !== below) {
            const far = above ? y + 1 : y - 1;
            expect(rowHasLine(far, x - 1, x + w), `${what} sits between two horizontal runs`).toBe(false);
            continue;
          }
          const left = gap(x - 1, y, -1);
          const right = gap(x + w, y, 1);
          const near = Math.min(left, right);
          const far = Math.max(left, right);
          expect(near, `${what} is not next to a line`).toBeLessThanOrEqual(1);
          expect(far - near, `${what} is as close to another line (${left} left, ${right} right)`).toBeGreaterThanOrEqual(2);
        }
      }
    });
    expect(found, `${where}: labels drawn`).toBe(labels.length);
  }

  const cases: Array<[string, FlowGraph]> = [['par', par], ['sample', graph], ...Object.entries(templates)];
  for (const [name, g] of cases) {
    it(`attaches every label of ${name} to its own line`, async () => {
      for (const direction of DIRECTIONS) {
        for (const zoom of ZOOMS) {
          const canvas = await renderGraph(g, { zoom, direction });
          const labels = g.edges.filter((e) => e.label && e.from !== e.to).map((e) => edgeLabelText(e.label, zoom)!);
          expectAttached(canvas, labels, `${name} zoom ${zoom} ${direction}`);
        }
      }
    });
  }

  it('puts labels on the same side of vertical lines (left) in TB', async () => {
    const canvas = await renderGraph(templates.feature!, { zoom: 1, direction: 'TB' });
    const cells = cellsOf(canvas);
    for (const [y, row] of cells.entries()) {
      const line = row.join('');
      for (const label of ['BACK', 'FAILED']) {
        const x = line.indexOf(label);
        if (x >= 0) expect(`${row[x + label.length]}${row[x + label.length + 1]}`, `${label} at row ${y}`).toBe(' │');
      }
    }
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
