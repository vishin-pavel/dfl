import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isDflError } from '../src/core/errors.js';
import { buildFlowModel } from '../src/core/flow.js';
import { FLOW_VIEW_HELP, FLOW_VIEW_HELP_SHORT, FlowView } from '../src/tui/FlowView.js';
import { centerOn, clampView, flowToGraph, renderGraph, type Direction, type ViewOrigin, type ZoomLevel } from '../src/tui/graph/index.js';
import { runFlowView } from '../src/tui/run-flow-view.js';
import { sampleFlowDefinition } from './helpers/project.js';

const model = buildFlowModel(sampleFlowDefinition(), path.join(os.tmpdir(), 'dfl-flowview-test'));

/** Terminal size seen by every ink-testing-library instance (its fake stdout has no `rows`). */
const size = { columns: 80, rows: 16 };

beforeAll(() => {
  const probe = render(<Text>probe</Text>);
  const proto = Object.getPrototypeOf(probe.stdout) as object;
  Object.defineProperty(proto, 'columns', { get: () => size.columns, configurable: true });
  Object.defineProperty(proto, 'rows', { get: () => size.rows, configurable: true });
  probe.unmount();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function waitFor(check: () => boolean, what: string, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const header = (frame: string | undefined): string => frame?.split('\n')[0] ?? '';

function position(frame: string | undefined): ViewOrigin {
  const match = /pos (\d+),(\d+) of/.exec(header(frame));
  if (!match) throw new Error(`No position in header: ${header(frame)}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** What the header shows for a view origin (negative = canvas centred in a wider view). */
const shown = (origin: ViewOrigin): ViewOrigin => ({ x: Math.max(0, origin.x), y: Math.max(0, origin.y) });

async function canvasFor(zoom: ZoomLevel, direction: Direction) {
  return renderGraph(flowToGraph(model), { zoom, direction, highlight: 'build' });
}

/** Renders the viewer at `columns`×`rows` and waits until the first layout is on screen. */
async function mount(props: { zoom?: ZoomLevel; direction?: Direction }, columns: number, rows: number) {
  size.columns = columns;
  size.rows = rows;
  const app = render(<FlowView model={model} current="build" {...props} />);
  await waitFor(() => header(app.lastFrame()).includes(' pos '), 'the first layout');
  // Let useInput attach its stdin listener.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const press = async (keys: string, until: (frame: string) => boolean): Promise<string> => {
    app.stdin.write(keys);
    await waitFor(() => until(app.lastFrame() ?? ''), `the frame after "${keys}"`);
    return app.lastFrame()!;
  };
  return { app, press };
}

describe('FlowView', () => {
  it('shows "Laying out…" first, then a full-screen view centred on the current step', async () => {
    const { app } = await mount({ zoom: 1 }, 80, 16);
    expect(app.frames[0]).toContain('Laying out…');
    const frame = app.lastFrame()!;
    const lines = frame.split('\n');
    expect(lines).toHaveLength(16);
    expect(lines[0]).toContain('Sample flow · zoom 1/3 · TB');
    expect(lines[0]).toContain('step: Build');
    expect(lines.at(-1)).toContain(FLOW_VIEW_HELP_SHORT);
    expect(frame).toContain('┃ Build ┃');

    const canvas = await canvasFor(1, 'TB');
    expect(header(frame)).toContain(`of ${canvas.width}×${canvas.height}`);
    expect(position(frame)).toEqual(shown(centerOn(canvas, 'build', 80, 14)!));
  });

  it('pans a quarter view with w/a/s/d and a page with W/A/S/D, clamped to the canvas', async () => {
    const { app, press } = await mount({ zoom: 2, direction: 'LR' }, 70, 10);
    const canvas = await canvasFor(2, 'LR');
    const [w, h] = [70, 8];
    let expected = centerOn(canvas, 'build', w, h)!;
    expect(position(app.lastFrame())).toEqual(shown(expected));

    const steps: Array<[string, number, number]> = [
      ['d', 17, 0],
      ['s', 0, 2],
      ['a', -17, 0],
      ['w', 0, -2],
      ['D', w, 0],
      ['S', 0, h],
      ['A', -w, 0],
      ['W', 0, -h],
    ];
    for (const [key, dx, dy] of steps) {
      const next = clampView(canvas, expected.x + dx, expected.y + dy, w, h);
      const frame = await press(key, (f) => {
        const p = position(f);
        return p.x === shown(next).x && p.y === shown(next).y;
      });
      expect(position(frame)).toEqual(shown(next));
      expected = next;
    }
    expect(expected).toEqual({ x: 0, y: 0 });
  });

  it('zooms with q/e within 0..3, keeps the focused step in view and toggles the layout with l', async () => {
    const { press } = await mount({ zoom: 1 }, 80, 16);
    let frame = await press('q', (f) => header(f).includes('zoom 2/3') && header(f).includes(' pos '));
    expect(position(frame)).toEqual(shown(centerOn(await canvasFor(2, 'TB'), 'build', 80, 14)!));
    expect(frame).toContain('Build it');

    frame = await press('q', (f) => header(f).includes('zoom 3/3') && header(f).includes(' pos '));
    expect(frame).toContain('/build');
    await press('q', (f) => header(f).includes('zoom 3/3'));

    frame = await press('e', (f) => header(f).includes('zoom 2/3') && header(f).includes(' pos '));
    frame = await press('e', (f) => header(f).includes('zoom 1/3') && header(f).includes(' pos '));
    frame = await press('e', (f) => header(f).includes('zoom 0/3') && header(f).includes(' pos '));
    expect(frame).toContain('▐Build▌');
    frame = await press('e', (f) => header(f).includes('zoom 0/3'));

    frame = await press('l', (f) => header(f).includes('zoom 0/3 · LR') && header(f).includes(' pos '));
    expect(frame).toContain('►');
    frame = await press('l', (f) => header(f).includes('zoom 0/3 · TB') && header(f).includes(' pos '));
  });

  it('centres on the current step with c', async () => {
    const { app, press } = await mount({ zoom: 3 }, 80, 16);
    const initial = position(app.lastFrame());
    const canvas = await canvasFor(3, 'TB');
    const bottom = clampView(canvas, 0, canvas.height, 80, 14);
    for (const key of ['S', 'S', 'S']) app.stdin.write(key);
    await waitFor(() => position(app.lastFrame()).y === bottom.y, 'paging down');
    const frame = await press('c', (f) => position(f).y === initial.y);
    expect(position(frame)).toEqual(initial);
  });

  it('shows the full key help when it fits', async () => {
    const { app } = await mount({ zoom: 1 }, 100, 16);
    // The footer is dimmed; strip the styling in case colours are forced (FORCE_COLOR).
    expect(stripVTControlCharacters(app.lastFrame()!).split('\n').at(-1)).toBe(` ${FLOW_VIEW_HELP}`);
  });

  it('picks the highest zoom that fits when none is given', async () => {
    const small = await mount({}, 80, 16);
    expect(header(small.app.lastFrame())).toContain('zoom 1/3');
    cleanup();
    const large = await mount({}, 200, 80);
    expect(header(large.app.lastFrame())).toContain('zoom 3/3');
  });

  for (const key of ['x', 'X']) {
    it(`exits on ${key}`, async () => {
      const { app } = await mount({ zoom: 1 }, 80, 16);
      const before = app.frames.length;
      app.stdin.write(key);
      await waitFor(() => !app.lastFrame()!.includes(FLOW_VIEW_HELP_SHORT), 'the exit');
      expect(app.frames.length).toBeGreaterThan(before);
      expect(app.lastFrame()!.trim()).toBe('');
    });
  }
});

describe('runFlowView (print mode)', () => {
  function capture(): { text: () => string } {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    return { text: () => chunks.join('') };
  }

  it('prints the whole canvas at zoom 2 by default', async () => {
    const out = capture();
    await runFlowView(model, { print: true, current: 'build' });
    const text = out.text();
    expect(text).toContain('Plan the work');
    expect(text).not.toContain('/plan');
    expect(text).toContain('┏');
    for (const line of text.trimEnd().split('\n')) expect(line).toBe(line.trimEnd());
  });

  it('honours zoom, direction and ascii', async () => {
    const out = capture();
    await runFlowView(model, { print: true, zoom: 3, direction: 'LR', ascii: true });
    const text = out.text();
    expect(text).toContain('/plan');
    expect(text).toContain('>');
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('rejects invalid zoom levels', async () => {
    const error = await runFlowView(model, { print: true, zoom: 7 }).catch((e: unknown) => e);
    expect(isDflError(error) && error.code).toBe('INVALID_ZOOM');
  });
});
