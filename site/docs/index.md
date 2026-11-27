---
layout: home
title: dfl (devFlow)
titleTemplate: Deterministic Dev Workflows for Coding Agents (XState + MCP)
description: Deterministic Dev Workflows for Coding Agents (XState + MCP) — fresh-session diff verification, ISO/IEC 25010:2023 quality attributes, Ink + ELKjs terminal DAG viewer, 9 coding agents, 100% local and zero telemetry.

hero:
  name: dfl (devFlow)
  text: Deterministic Dev Workflows for Coding Agents
  tagline: Enforced by XState v5 + stdio MCP, audited in a fresh session, steered by ISO/IEC 25010:2023 quality attributes, and portable across 9 coding agents.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/dev-flow
    - theme: alt
      text: Read Blog
      link: /blog/
    - theme: alt
      text: View on GitHub
      link: https://github.com/vishin-pavel/dfl
---

<script setup>
import { withBase } from 'vitepress'
</script>

<div class="dfl-trust-strip" role="region" aria-label="Zero Telemetry Guarantee">
  <div class="dfl-trust-badges">
    <span class="dfl-badge">100% Local</span>
    <span class="dfl-badge">Zero Telemetry</span>
    <span class="dfl-badge dfl-badge--cyan">MIT Open Source</span>
    <span class="dfl-badge dfl-badge--cyan">Node.js &gt;= 22.12</span>
  </div>
  <p class="dfl-trust-note">
    Zero analytics dependencies and zero phone-home calls — the sole <code>fetch()</code> in
    <code>@vishin-pavel/dfl</code> is optional Jira Cloud sync when you explicitly configure
    <code>.df/tracker.json</code>.
  </p>
</div>

## See `dfl` in Action

<div class="dfl-demo-primary">
  <div class="dfl-demo-card">
    <div class="dfl-demo-card__bar">
      <span>Demo 1 · Fresh-Session Audit</span>
      <span class="dfl-demo-card__tag">/verify-task</span>
    </div>
    <img :src="withBase('/assets/dfl-hero.gif')" alt="Demo 1: dfl catching a poisoned coding agent lying about unmapped git diff hunks in a fresh verification session" />
    <div class="dfl-demo-card__body">
      <strong>Catching a Poisoned Agent Lying</strong>
      <code>/verify-task</code> refuses same-session self-grading, maps every <code>git diff</code> hunk to an accepted requirement ID (<code>CHK-1.2</code>), and routes defects back through XState.
    </div>
  </div>

  <div class="dfl-demo-card">
    <div class="dfl-demo-card__bar">
      <span>Demo 2 · Compiler-Guarded MCP Edit</span>
      <span class="dfl-demo-card__tag">dfl flow view</span>
    </div>
    <img :src="withBase('/assets/dfl-flow-edit.gif')" alt="Demo 2: Live LLM flow edit guarded by the stdio MCP compiler with instant Ink and ELKjs terminal DAG update" />
    <div class="dfl-demo-card__body">
      <strong>Live LLM Flow Edit + Terminal DAG</strong>
      Edit workflows in plain English via <code>/add-flow-step</code> — the stdio MCP server validates XState transitions and Handlebars templates before writing to disk.
    </div>
  </div>
</div>

<div class="dfl-demo-secondary">
  <div class="dfl-demo-card">
    <div class="dfl-demo-card__bar">
      <span>Demo 3 · Anti-Waterfall</span>
      <span class="dfl-demo-card__tag">4 routes</span>
    </div>
    <img :src="withBase('/assets/dfl-demo-3-routes.svg')" alt="Demo 3: Adaptive 4-route classification (code, behavior, design, full) avoiding AI waterfall" />
    <div class="dfl-demo-card__body">
      <strong>Adaptive 4-Route Classification</strong>
      Bug fixes take the <code>code</code> route straight to <code>implement → verify → ship</code>.
    </div>
  </div>

  <div class="dfl-demo-card">
    <div class="dfl-demo-card__bar">
      <span>Demo 4 · Team Portability</span>
      <span class="dfl-demo-card__tag">9 agents</span>
    </div>
    <img :src="withBase('/assets/dfl-demo-4-portability.svg')" alt="Demo 4: One git-committed .df directory compiled into native skills and MCP configs for 9 coding agents" />
    <div class="dfl-demo-card__body">
      <strong>One <code>.df/</code> Folder → 9 Coding Agents</strong>
      Renders native <code>agentskills.io</code> skills and comment-preserving MCP configs across your team.
    </div>
  </div>

  <div class="dfl-demo-card">
    <div class="dfl-demo-card__bar">
      <span>Demo 5 · Technical Design</span>
      <span class="dfl-demo-card__tag">ISO 25010</span>
    </div>
    <img :src="withBase('/assets/dfl-demo-5-iso25010.svg')" alt="Demo 5: ISO/IEC 25010:2023 quality attributes and DEC-n architectural steering" />
    <div class="dfl-demo-card__body">
      <strong>ISO/IEC 25010:2023 Steering</strong>
      Define measurable <code>PERF</code>, <code>SEC</code>, and <code>MAINT</code> targets instead of micromanaging file layouts.
    </div>
  </div>
</div>

## Why `dfl`? Before vs. After

| Vibe Coding & Markdown Prompt Packs | With `dfl (devFlow)` |
|---|---|
| Coding agent grades its own homework in a poisoned context | **`/verify-task` refuses same-session grading** (unless explicitly overridden & logged) and maps every `git diff` hunk to an accepted requirement ID |
| "AI Waterfall": 1,000 lines of spec prose for a 5-line bug | **Adaptive 4-route classification** (`code`, `behavior`, `design`, `full`) — bug fixes skip straight to `implement → verify → ship` |
| Markdown rules are suggestions LLMs silently skip | **Real XState v5 state machine over stdio MCP** — invalid transitions, unintended exits, and loops (4th visit) are blocked deterministically |
| Locked into one IDE fork or agent vendor | **One git-committed `.df/` folder → 9 coding agents** (Claude Code, Cursor, Antigravity, Codex, Gemini CLI, Copilot, Windsurf/Devin, OpenCode, Kiro) |
| Spec walls nobody reads; brittle Cucumber boilerplate | **Scannable `Given/When/Then` rules with stable IDs (`CHK-1.2`)** in Markdown — zero Cucumber runner required |
| Over-specified architecture prose or sloppy defaults | **Quality-Attribute steering (ISO/IEC 25010:2023)** — define measurable `PERF` / `SEC` / `MAINT` targets and `DEC-n` decisions |

## 60-Second Quickstart

Requires **Node.js `>=22.12`** (macOS, Linux, or WSL).

```bash
# 1. Install globally (note the scoped package name)
npm install -g @vishin-pavel/dfl

# 2. Initialize the built-in dev flow and compile native skills + MCP config
dfl install --yes --agents claude,cursor

# 3. Commit .df/ and MCP config on your default branch so /verify-task starts clean
git add .df .mcp.json .cursor/mcp.json && git commit -m "Add dfl dev flow"

# 4. Inspect the orthogonal workflow DAG directly in your terminal
dfl flow view --print --zoom 1
```

Then invoke skills inside your coding agent (OpenAI Codex uses `$name`, e.g. `$classify-task`):

- `/classify-task <describe your task>` — classifies scope and selects `code`, `behavior`, `design`, or `full`
- `/fast-forward to verify-task` — bounded autopilot with fresh sub-agents per step, logged assumptions, and loop protection
- `/verify-task` (in a **fresh session**) — maps every `git diff` hunk to accepted requirements and verifies tests

**Want to try `dfl flow view` in under 30 seconds without touching your own repository?**  
Run the 1-command isolated sandbox from [`demo/run-demo.sh`](https://github.com/vishin-pavel/dfl/blob/main/demo/run-demo.sh):

```bash
./demo/run-demo.sh
```

## Adaptive 4-Route `dev` Flow

`dfl` ships with one battle-tested default template: **`dev`** (6 steps: `classify-task`, `define-behavior`, `design-tech`, `implement-task`, `verify-task`, `ship-task`; 2 final states: `done`, `not-handled`). `/classify-task` picks the lightest route that fits:

| Route | When It Triggers | Steps Executed |
|---|---|---|
| **`code`** | Bug violating an accepted scenario, chore, or refactor within existing rules | `implement-task` → `verify-task` → `ship-task` |
| **`behavior`** | Business rule or user behavior change with no architectural impact | `define-behavior` → `implement-task` → `verify-task` → `ship-task` |
| **`design`** | Architecture or quality-attribute change with unchanged user behavior | `design-tech` → `implement-task` → `verify-task` → `ship-task` |
| **`full`** | New feature or major change spanning both behavior and architecture | `define-behavior` → `design-tech` → `implement-task` → `verify-task` → `ship-task` |

If `/verify-task` catches a defect, an unmapped diff hunk, a missing requirement, or an unscreened quality risk, the XState machine routes work back via `FAILED`, `REQUIREMENTS_GAP`, or `DESIGN_GAP` — never silently shipping.

## How `dfl` Compares (Nov 2026)

| Capability | `dfl` | GitHub Spec Kit | OpenSpec | GSD | Superpowers | BMAD |
|---|---|---|---|---|---|---|
| **State Enforcement** | XState v5 + MCP | Markdown | Markdown | Markdown | Markdown | Markdown |
| **Terminal DAG Viewer** | Built-in (`Ink` + `elkjs`) | None | None | None | None | None |
| **Adaptive Anti-Waterfall Routing** | 4 routes (`code` skips specs) | Rigid phases | Fluid | Atomic plans | Fixed phases | Heavy agile |
| **Fresh-Session Diff-to-Req Audit** | Built-in (`/verify-task`) | Manual | Manual | Fresh coding | Manual | Manual |
| **Quality-Attribute Tech Design** | ISO 25010:2023 + 8 concerns | Freeform | Freeform | Freeform | Freeform | Freeform |
| **Coding Agents Supported** | 9 (`agentskills.io` + MCP) | 30+ | 30+ | 13 | 5 | Multi |
| **Zero Telemetry by Default** | Yes (0 analytics deps) | Undocumented (Issue #1274) | Opt-out default | Yes | Yes | Yes |

## Four Core Differentiators

<div class="dfl-diff-grid">
  <div class="dfl-diff-card">
    <div class="dfl-diff-card__kicker">01 · Independent Verification</div>
    <h3>Fresh-Session Diff Verification</h3>
    <p><code>/verify-task</code> refuses to run in the same session that wrote the code (unless explicitly overridden &amp; logged), checks every <code>git diff</code> hunk against accepted requirement IDs, reproduces bug fixes in a clean <code>git worktree</code>, and never edits code itself.</p>
  </div>

  <div class="dfl-diff-card">
    <div class="dfl-diff-card__kicker">02 · Measurable Architecture</div>
    <h3>ISO/IEC 25010:2023 Quality Attributes</h3>
    <p><code>/design-tech</code> screens all 9 ISO/IEC 25010:2023 characteristics plus 8 operational concerns into concise targets and <code>DEC-n</code> expensive-to-reverse decisions — giving coding agents verifiable constraints without micromanagement.</p>
  </div>

  <div class="dfl-diff-card">
    <div class="dfl-diff-card__kicker">03 · Terminal DAG + MCP Guard</div>
    <h3>Interactive DAG &amp; Compiler-Guarded Edits</h3>
    <p>Inspect workflows with <code>dfl flow view</code> (Ink + ELKjs orthogonal routing, 4 zoom levels, <code>--print</code>/<code>--ascii</code>). Modify steps via 15 stdio MCP tools and 2 resources with automatic XState + Handlebars validation.</p>
  </div>

  <div class="dfl-diff-card">
    <div class="dfl-diff-card__kicker">04 · Mixed-Agent Teams</div>
    <h3>9-Agent Portability + Jira Cloud</h3>
    <p>Commit one <code>.df/</code> folder to support Claude Code, Cursor, Antigravity, Codex, Gemini CLI, Copilot, Windsurf/Devin, OpenCode, and Kiro. Optionally sync branch flow state via hidden Jira Cloud <code>dfl.run</code> issue properties.</p>
  </div>
</div>

## Honest Trade-Offs & Limitations

<div class="dfl-tradeoffs">
  <strong>Upfront clarity before you install:</strong>
  <ol>
    <li><strong>Node.js <code>&gt;=22.12</code> required:</strong> Runtime requires Node.js <code>&gt;=22.12</code> (building from source requires <code>&gt;=22.18</code> or <code>&gt;=24.11</code>).</li>
    <li><strong>Inside-step LLM compliance is prompt-enforced, not OS-sandboxed:</strong> XState v5 + MCP deterministically enforce state transitions, <code>/fast-forward</code> loop limits (4th visit), and refusal of unintended final states; inside an individual step, compliance relies on structured skill protocols and git auditability.</li>
    <li><strong>Documentation-only Gherkin:</strong> <code>REQUIREMENTS.md</code> uses declarative <code>Given/When/Then</code> Markdown linked to tests by stable IDs (<code>CHK-1.2</code>), not an executable Cucumber runner.</li>
    <li><strong>Native Windows MCP workaround:</strong> macOS, Linux, and WSL are first-class; native Windows MCP currently requires a small <code>.df/config.json</code> <code>.cmd</code> shim override (see the <a :href="withBase('/guide/mcp-server')">MCP Server guide</a>).</li>
    <li><strong>Fixed 9 built-in agent adapters:</strong> Supports 9 coding agents out of the box; custom user-declared agent adapters are not yet supported.</li>
    <li><strong>Jira Cloud classic API tokens only:</strong> Optional tracker sync supports Jira Cloud with classic API tokens (no GitHub Issues, Linear, Jira Server/Data Center, or scoped Atlassian tokens yet).</li>
    <li><strong><code>elkjs</code> dependency license:</strong> The terminal DAG layout engine <code>elkjs</code> is licensed under <code>EPL-2.0 OR GPL-3.0-or-later</code>; it is dynamically imported unmodified at runtime and documented in <code>NOTICE</code>.</li>
  </ol>
</div>

## Modular Documentation Guides

<div class="dfl-links-grid">
  <a class="dfl-link-card" :href="withBase('/guide/dev-flow')">
    <span class="dfl-link-card__title">Built-In dev Flow &amp; /fast-forward</span>
    <span class="dfl-link-card__desc">6 steps, 4 adaptive routes, brownfield adoption, fresh-session verification, and autopilot safety rails.</span>
  </a>
  <a class="dfl-link-card" :href="withBase('/guide/variables-and-templates')">
    <span class="dfl-link-card__title">Variables, Templates &amp; Custom Flows</span>
    <span class="dfl-link-card__desc">.df/ layout, 4-layer variable precedence, Handlebars helpers, 9 agents, and cross-repo flow sharing.</span>
  </a>
  <a class="dfl-link-card" :href="withBase('/guide/mcp-server')">
    <span class="dfl-link-card__title">MCP Server &amp; Authoring Tools</span>
    <span class="dfl-link-card__desc">All 15 stdio MCP tools, 2 resources, project locking, comment-preserving configs, and Windows shim.</span>
  </a>
  <a class="dfl-link-card" :href="withBase('/guide/jira')">
    <span class="dfl-link-card__title">Jira Cloud State Sync</span>
    <span class="dfl-link-card__desc">.df/tracker.json, hidden dfl.run issue properties, branch templates, and 0600 local credentials.</span>
  </a>
  <a class="dfl-link-card" :href="withBase('/guide/cli-reference')">
    <span class="dfl-link-card__title">CLI Reference</span>
    <span class="dfl-link-card__desc">Every subcommand, dfl flow view controls, --json / --yes CI flags, and all 12 DFL_* env vars.</span>
  </a>
</div>

## Canonical Engineering Articles

<div class="dfl-links-grid">
  <a class="dfl-link-card" :href="withBase('/blog/fresh-session-diff-verification')">
    <span class="dfl-link-card__title">Why I Stopped Letting Coding Agents Grade Their Own Homework</span>
    <span class="dfl-link-card__desc">Poisoned-context self-verification, clean worktree reproduction, and diff-to-requirement hunk mapping.</span>
  </a>
  <a class="dfl-link-card" :href="withBase('/blog/iso-25010-ai-architecture')">
    <span class="dfl-link-card__title">Steering AI Architecture with ISO 25010 Quality Attributes</span>
    <span class="dfl-link-card__desc">Replacing vague prose prompts with 9 ISO/IEC 25010:2023 characteristics, 8 operational concerns, and DEC-n.</span>
  </a>
  <a class="dfl-link-card" :href="withBase('/blog/orthogonal-terminal-dag-ink-elkjs')">
    <span class="dfl-link-card__title">Building an Orthogonal Terminal DAG Viewer with Ink &amp; ELKjs</span>
    <span class="dfl-link-card__desc">Terminal-cell ELK layouts, 4-bit direction-mask canvas, zero-ANSI slicing, and dynamic-import isolation.</span>
  </a>
</div>
