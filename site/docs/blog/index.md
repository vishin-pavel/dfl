---
title: Engineering Blog
description: Deep-dive technical articles on deterministic AI coding workflows, fresh-session diff verification, ISO/IEC 25010:2023 quality attributes, and terminal graph rendering with Ink and ELKjs.
---

# Engineering Blog

Deep, zero-hype technical write-ups grounded in the architecture and source code of `@vishin-pavel/dfl` (v0.3.0).

---

## [Why I Stopped Letting Coding Agents Grade Their Own Homework](/blog/fresh-session-diff-verification)

When the same LLM context that wrote a feature is asked to verify it, it rationalizes shortcuts, rubber-stamps unrequested refactors, and mistakes "tests pass" for "requirements met." Here is how `dfl` pairs an XState v5 deterministic transition graph with fresh-session `/verify-task` diff-to-requirement hunk mapping — and where deterministic enforcement ends and prompt-enforced discipline begins.

*Topics: Fresh-session verification · Diff-to-requirement auditing · XState v5 · MCP*

---

## [Steering AI Architecture with ISO 25010 Quality Attributes](/blog/iso-25010-ai-architecture)

Prose prompts like *"keep it clean, fast, and secure"* cause architectural drift because they give coding agents no measurable boundaries. By screening all 9 ISO/IEC 25010:2023 quality characteristics (`FUNC`, `PERF`, `COMP`, `IC`, `REL`, `SEC`, `MAINT`, `FLEX`, `SAFE`), 8 operational concerns, and `DEC-n` expensive-to-reverse decisions in `/design-tech`, teams steer AI architecture with verifiable constraints instead of micromanaging file layouts.

*Topics: ISO/IEC 25010:2023 · Quality attributes · Technical design · AI architecture*

---

## [Building an Orthogonal Terminal DAG Viewer with Ink & ELKjs](/blog/orthogonal-terminal-dag-ink-elkjs)

How `dfl flow view` computes layered orthogonal graph layouts directly in terminal character cells using `elkjs`, renders a bitmask-resolved Unicode/ASCII canvas through Ink 7 + React 19 with 4 zoom levels (`0..3`) and non-interactive `--print`/`--ascii` modes, and isolates `elkjs` (`EPL-2.0 OR GPL-3.0-or-later`) via lazy dynamic import.

*Topics: Ink 7 · React 19 · ELKjs · Terminal UI · Orthogonal DAG routing*
