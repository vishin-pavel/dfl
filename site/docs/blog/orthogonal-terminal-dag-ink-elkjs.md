---
title: Building an Orthogonal Terminal DAG Viewer with Ink & ELKjs
description: Inside dfl flow view — computing ELK layered orthogonal layouts directly in terminal cells, resolving Unicode/ASCII box-drawing junctions via bitmasks, Ink 7 + React 19 viewport rendering, 4 zoom levels, and elkjs EPL-2.0/GPL-3.0 dynamic-import licensing.
tags: [cli, ink, elkjs, typescript, showdev]
crosspost:
  devto:
    tags: [showdev, typescript, cli, react]
    note: Use #showdev (never #opensource); set canonical_url to this page before publishing.
  hashnode:
    tags: [typescript, cli, ink, graph-layout]
    note: Set canonicalUrl to this page; preserve the elkjs licensing section and Honest Trade-Offs.
---

# Building an Orthogonal Terminal DAG Viewer with Ink & ELKjs

Workflow state machines are notoriously hard to read as raw JSON. Once a flow has six steps, two final states, and seven back-edges (`FAILED`, `REQUIREMENTS_GAP`, `DESIGN_GAP`, `CHANGES_REQUESTED`), reading `flow.json` linearly hides the actual topology.

When building [`@vishin-pavel/dfl`](https://github.com/vishin-pavel/dfl) (`v0.3.0`), I wanted `dfl flow view` to render any XState v5 flow directly inside the terminal as a crisp, pan-and-zoom **orthogonal DAG** — with zero browser window, full Unicode box-drawing *and* 7-bit `--ascii` support, and instant `--print` output for scripts and documentation.

Here is how `src/tui/` actually works under the hood: from running `elkjs` directly in terminal-cell coordinates to resolving line junctions with a 4-bit direction mask, keeping ANSI escape codes out of the layout canvas, and handling `elkjs`'s `EPL-2.0 OR GPL-3.0-or-later` license cleanly in an MIT-licensed CLI.

---

## Architecture Overview (`src/tui/`)

The viewer is split into a pure, headless graph pipeline (`src/tui/graph/`) and a thin interactive React/Ink shell (`src/tui/FlowView.tsx`):

```text
FlowModel
  └─► flowToGraph()           # nodes + edges (src/tui/graph/index.ts)
        └─► measureNode()     # cell-accurate box dimensions per zoom 0..3 (measure.ts)
              └─► layoutGraph()   # ELK layered orthogonal routing in cell units (layout.ts)
                    └─► Canvas    # 4-bit junction bitmask → Unicode/ASCII grid (canvas.ts)
                          ├─► --print / non-TTY: stdout directly (no Ink/React loaded!)
                          └─► TTY: Ink 7 + React 19 alternate-screen viewport (FlowView.tsx)
```

Notice the lazy boundary in `src/tui/run-flow-view.tsx` (lines 41–53): when `--print` is passed or `stdin`/`stdout` is not a TTY, `runFlowView` renders the canvas and writes straight to `stdout` **without ever importing `ink` or `react`**. Interactive users get the full alternate-screen TUI (`alternateScreen: true, exitOnCtrlC: true`) via dynamic `Promise.all([import('ink'), import('react'), import('./FlowView.js')])`.

---

## 1. Running ELKjs Directly in Terminal Cell Units

Most graph renderers compute layout in floating-point pixels and then quantize to a character grid — which produces misaligned arrows, colliding bends, and double-thick borders.

`src/tui/graph/layout.ts` takes the opposite approach: **1 ELK unit = 1 terminal cell** (lines 1–4). Before calling ELK, `layoutFlowGraph` (`src/tui/graph/render.ts:49–74`) measures every node's exact width and height in terminal cells (respecting Unicode display width via `string-width`) and widens or heightens boxes so every incoming/outgoing edge has its own dedicated port at least 2 cells apart.

ELK is configured with layered orthogonal routing (`src/tui/graph/layout.ts:204–232`):

```ts
layoutOptions: {
  'elk.algorithm': 'layered',
  'elk.direction': direction === 'TB' ? 'DOWN' : 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.edgeNode': '2',
  'elk.spacing.edgeEdge': '2',
  'elk.layered.spacing.edgeNodeBetweenLayers': '2',
  'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.feedbackEdges': 'true',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.separateConnectedComponents': 'false',
}
```

Three subtle ELK choices make a huge difference for state machines:

- **`MODEL_ORDER` cycle breaking + `feedbackEdges: 'true'`:** Steps arrive in `flow.json` declaration order (initial first, finals last). Because ELK respects model order, forward skips (`TECH_ONLY`, `CODE_ONLY`) flow smoothly forward while rework loops (`FAILED`, `REQUIREMENTS_GAP`) route cleanly around the outside as feedback edges instead of tangling the main spine.
- **Unified snapping (`layout.ts:34, 59–127`):** ELK still emits fractional coordinates, so every node, port, and bend passes through a single rounding rule `R = (v) => Math.round(v + 1e-6)`. `snapEnd()` places each edge endpoint at the first cell *outside* the snapped box, keeping arrows off box corners and off card separator rows, while tracking `taken` slots so two edges never share an arrowhead unless a side is completely full.
- **Zoom-0 left-to-right port planning (`planPorts`, `layout.ts:149–172`):** At zoom `0`, nodes are single-row (`[Classify]`), leaving only 1 cell on their left and right sides. In `--lr` mode, `planPorts` pins the main forward `NEXT` edge to East/West, routes skip edges out the North side, and routes loop edges out the South side with `elk.portConstraints: FIXED_SIDE`.

---

## 2. Bitmask Character Canvas & Label Scoring

Once ELK returns orthogonal polylines, `src/tui/graph/canvas.ts` draws them onto a flat character buffer backed by three parallel arrays (`ch`, `kind`, and `mask`, lines 62–72).

Instead of guessing corner characters while drawing each segment, every line cell records a **4-bit connection mask** (`N = 1`, `E = 2`, `S = 4`, `W = 8`, lines 5–8). When two edges cross or bend on the same cell, their bits simply OR together (`this.mask[i] |= b`, line 92), and converting the canvas to text resolves the exact glyph automatically (`canvas.ts:20–24`):

```ts
const UNI: Record<number, string> = {
  [N]: '│', [S]: '│', [N | S]: '│', [E]: '─', [W]: '─', [E | W]: '─',
  [S | E]: '╭', [S | W]: '╮', [N | E]: '╰', [N | W]: '╯',
  [N | S | E]: '├', [N | S | W]: '┤', [E | W | S]: '┬', [E | W | N]: '┴', [N | E | S | W]: '┼',
};
```

Boxes use three distinct border styles (`light` for normal steps, `heavy` `┏━┓` for the current step, and `final` `╔═╗` for terminal states like `done` and `not-handled`), with pure 7-bit fallbacks (`+`, `#`, `/\`) when `--ascii` is enabled (`canvas.ts:41–52`).

Edge labels (`FAILED`, `DESIGN_GAP`, etc.) are placed last by `placeLabel()` (`src/tui/graph/render.ts:85–100`), which scores candidate positions next to each edge segment — preferring ELK's reserved label side (`label │` in `TB`, below `───` in `LR`) and penalizing any candidate whose far side is fewer than `FAR_GAP = 3` cells from another line so readers can immediately tell which edge owns the label.

---

## 3. Four Zoom Levels & Zero-ANSI Viewport Slicing in Ink 7

`src/tui/FlowView.tsx` renders the pre-computed canvas inside a 3-row Ink 7 + React 19 layout: a 1-line inverted header, the scrollable viewport (`rows - 2`), and a 1-line dim help footer (`FlowView.tsx:207–219`).

- **4 zoom levels (`0..3`):**
  - `0`: One-line nodes (`[Classify]`)
  - `1`: Title boxes
  - `2`: Cards with truncated descriptions (also `PRINT_ZOOM = 2` default for `--print`)
  - `3`: Full cards with complete descriptions and agent-specific skill commands (`/classify-task`, or `$classify-task` when Codex is selected)
- **Auto-zoom & canvas caching:** On startup (without `--zoom`), `pickZoom()` selects the highest zoom level whose canvas fits the terminal viewport. Switching zoom (`q`/`e`) or orientation (`l` for `TB`/`LR`) caches layouts in `createCanvasCache`, keeps the previous drawing on screen while ELK computes the next layout (zero blank flash, `FlowView.tsx:123`), and calls `nearestNode()` to preserve the user's focal point (`FlowView.tsx:141–160`).
- **ANSI-free canvas invariant (`FlowView.tsx:183–204`):** No ANSI escape sequences ever enter the `Canvas` grid. Slicing the viewport by `(view.x, view.y, viewW, viewH)` happens on pure plain-text cells first; only *after* slicing does `FlowView` split the highlighted current-step box via `splitCells()` and wrap `inside` in `<Text color="cyan" bold>`. That eliminates an entire class of broken-escape-code and cell-width miscalculation bugs.

---

## 4. Lazy Loading & `elkjs` Licensing (`EPL-2.0 OR GPL-3.0-or-later`)

Two practical engineering concerns govern how `dfl` depends on `elkjs`:

1. **Startup latency:** `elkjs/lib/elk.bundled.js` is ~1.6 MB and takes ~100 ms to parse (`src/tui/graph/layout.ts:11–23`). Because `dfl status`, `dfl next`, and `dfl mcp` never draw graphs, `getElk()` loads `elkjs` via lazy `await import('elkjs/lib/elk.bundled.js')` so only `dfl flow view` pays the parse cost.
2. **License isolation (`NOTICE`):** `@vishin-pavel/dfl` is MIT-licensed, while `elkjs` is dual-licensed under **`EPL-2.0 OR GPL-3.0-or-later`**. Rather than bundling `elkjs` into `dist/cli.mjs`, `dfl` keeps `elkjs` as an external npm runtime dependency, imports it dynamically and unmodified at runtime, and documents the attribution and EPL-2.0 terms explicitly in [`NOTICE`](https://github.com/vishin-pavel/dfl/blob/main/NOTICE) (lines 13–18).

---

## Honest Trade-Offs

- **ELK bundle footprint:** Even though `elkjs` is lazy-loaded so everyday CLI/MCP commands stay fast, it still adds ~1.6 MB to `node_modules` on install.
- **Dense cyclic graphs at zoom 0:** Very high-degree nodes with many cross-cutting back-edges can force boxes to widen significantly to maintain 2-cell port spacing. Switching orientation (`l`) or zooming out (`e`) usually resolves visual crowding, and `--print --zoom 1` gives a compact overview.
- **No mouse scrolling:** Interactive navigation is keyboard-driven (`wasd`/arrows, `WASD`/PgUp/PgDn, `q`/`e`, `l`, `c`, `x`).

---

## Try It in Your Terminal

```sh
dfl flow view                  # interactive full-screen DAG viewer
dfl flow view --print --zoom 1 # compact non-interactive graph
dfl flow view --print --lr --ascii
```

See the [CLI Reference & Flow Viewer guide](/guide/cli-reference#terminal-flow-viewer-dfl-flow-view) for all flags and keybindings.
