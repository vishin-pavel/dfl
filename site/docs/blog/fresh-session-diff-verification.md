---
title: Why I Stopped Letting Coding Agents Grade Their Own Homework
description: How poisoned context turns LLM self-verification into rubber-stamping, and how dfl combines XState v5 deterministic transitions with fresh-session /verify-task diff-to-requirement hunk mapping.
tags: [ai-coding, mcp, xstate, verification, showdev]
crosspost:
  devto:
    tags: [showdev, ai, programming, testing]
    note: Use #showdev (never #opensource); set canonical_url to this page before publishing.
  hashnode:
    tags: [ai, software-engineering, mcp, xstate]
    note: Set canonicalUrl to this page; preserve the Honest Trade-Offs section verbatim.
---

# Why I Stopped Letting Coding Agents Grade Their Own Homework

If you have shipped non-trivial code with a coding agent, you have seen this exact failure mode:

1. You ask the agent to implement a feature or bug fix.
2. Twenty tool calls later, the context window is saturated with stack traces, abandoned approaches, and rationalizations about why an edge case "probably doesn't apply."
3. You ask: *"Double-check everything against the requirements and make sure tests pass."*
4. The agent runs the test suite it just wrote, sees green, and replies: *"All requirements are met and verified!"*

Then you open `git diff` and find an unrequested refactor in an unrelated module, a weakened assertion on an existing test, and a subtle edge case the agent silently dropped ten turns earlier.

The problem is not that the model is incapable of spotting bugs. The problem is **poisoned-context self-verification**: asking the author of a patch, inside the same context window that produced the patch, to act as an independent auditor.

This is the core failure mode that shaped `/verify-task` in [`@vishin-pavel/dfl`](https://github.com/vishin-pavel/dfl) (`v0.3.0`, MIT). Instead of hoping a single prompt will make an agent honest with itself, `dfl` splits the problem into two layers: a **deterministic XState v5 + MCP state machine** governing transitions, and an **independent, fresh-session Dev QA protocol** that audits committed `git diff` hunks against stable requirement IDs.

---

## Why Same-Session Verification Fails

A coding agent's context window is not a neutral workspace — it is a transcript of prior commitments. Once an agent has spent 15 turns convincing itself that a shortcut is acceptable or that an extra refactor is "cleaner," every subsequent token it generates is conditioned on that trajectory:

- **Confirmation bias over prior claims:** Commit messages, task summaries, and earlier assistant messages sit in the same prompt as the code. The agent reads its own checklist and treats claims as evidence.
- **"Tests pass" masquerading as "requirements met":** An authoring session knows *why* it wrote a shallow mock or skipped an awkward error path, so it rarely challenges the test's assertions.
- **Unbounded scope creep:** During implementation, agents frequently touch adjacent files ("while I'm here" cleanups, debug logs, tweaked configs). Inside the same session, those hunks feel intentional rather than out of bounds.

You would not let a developer merge a production PR with only their own self-approval. Letting a coding agent grade its own homework inside the same context window is strictly worse.

---

## How `/verify-task` Enforces Fresh-Session Independence

In `dfl`'s built-in [`dev` flow](/guide/dev-flow), implementation (`implement-task`) and verification (`verify-task`) are separate states in `templates/flows/dev/flow.json` (lines 95–113). When `implement-task` completes with `NEXT`, the flow transitions to `verify-task`, whose skill template (`templates/flows/dev/steps/verify-task/SKILL.md.hbs`) enforces three hard rules from line 1:

### 1. Refuse Same-Session Grading

Step 1 of `verify-task/SKILL.md.hbs` (lines 25–29) explicitly refuses to verify code written in the same conversation:

> **Independence.** If this conversation wrote or changed the task's code, stop: tell the user to run `/verify-task` in a new session, ideally with another agent or model. Continue only on an explicit override, recorded in the report. Evidence is only what you read or run yourself; the brief's Implementation section, commit messages and summaries are claims.

Notice the deliberate framing: the task brief's `## Implementation` checklist and declared change map are explicitly labeled **"claims to check, not evidence"** (`verify-task/SKILL.md.hbs:13`). In [`/fast-forward`](/guide/dev-flow#fast-forward-autopilot-fast-forward) autopilot mode, `dfl` instructs agents that support sub-agents to spawn a **fresh sub-agent with zero summary of earlier steps** (`Independence: fresh sub-agent (fast-forward)`). On agents without sub-agent support, `/fast-forward` pauses at `verify-task` so you open a fresh session yourself.

### 2. Audit Committed Code Against a Clean Baseline Worktree

Step 2 (`verify-task/SKILL.md.hbs:30–42`) requires a clean working tree (`git status`) and computes an exact diff base (`git merge-base HEAD origin/<mainBranch>`). Uncommitted changes are rejected — Dev QA only audits committed code at `HEAD`.

Even more importantly, Step 3 (`verify-task/SKILL.md.hbs:43–48`) handles failing tests without touching the main working tree:

```sh
git worktree add ../<project>-baseline <base>
# install dependencies & run the same failing test/check command
git worktree remove ../<project>-baseline
```

If a check fails at `HEAD` *and* fails at `<base>` in the clean worktree, it is classified as pre-existing (logged as a follow-up). If it passes at `<base>` and fails at `HEAD`, it is a **blocker**. And a bug's reproduction test must prove the inverse: it must **fail on the base** and **pass on `HEAD`** (`verify-task/SKILL.md.hbs:53`).

### 3. Diff-to-Requirement Hunk Mapping

The highest-leverage check in `/verify-task` is combining requirement traceability with hunk-level scope auditing (`verify-task/SKILL.md.hbs:49–68`):

- **Forward traceability (Requirement → Test):** Every in-scope Gherkin scenario ID (for example `CHK-1.2` in `docs/requirements/checkout/REQUIREMENTS.md`) must exist in code at `HEAD` *and* have a passing test that explicitly cites `CHK-1.2` (using whole-word search so `CHK-1.2` never false-matches `CHK-1.20`, line 124) and asserts its actual outcome.
- **Reverse traceability (Diff Hunk → Requirement):** Every hunk in `git diff <base> HEAD` is classified against scope rules. **Unmapped hunks**, debug leftovers, `.only`/skipped tests, weakened or deleted tests (outside a retired ID), and hand-edited generated files are **blockers** (`verify-task/SKILL.md.hbs:61–63`).
- **Route & screening integrity:** If a task took the `code` route (skipping `define-behavior`) yet introduced a user-visible behavior change, `/verify-task` flags it: unintended changes become a `FAILED` blocker; intended changes fire `REQUIREMENTS_GAP` (`verify-task/SKILL.md.hbs:64–68`).
- **Never fix, only report:** Line 7 and line 121 are unambiguous: *"You never fix anything yourself — not even a typo: report it."* The only commit `/verify-task` is allowed to make is appending the Dev QA report and rework entry to the task brief (`docs(task): Dev QA report round <n> for <task>`).

---

## Where XState v5 + MCP Are Deterministic — And Where Prompts Take Over

Senior engineers are rightly skeptical of AI tools that claim "deterministic agents." An LLM is probabilistic; pretending otherwise is marketing theater. In `dfl`, the boundary between **deterministic code enforcement** and **prompt-enforced discipline** is explicit:

### Deterministically Enforced by Code (XState v5 + `dfl mcp`)

`templates/flows/dev/flow.json` defines a flat XState v5 state machine. Every transition goes through `dfl`'s runtime (`complete_step`, `transition`, `goto_step` in `src/mcp/server.ts`, serialized behind `.df/.lock`):

```json
"verify-task": {
  "meta": { "title": "Dev QA" },
  "on": {
    "NEXT":             { "target": "ship-task" },
    "FAILED":           { "target": "implement-task" },
    "REQUIREMENTS_GAP": { "target": "define-behavior" },
    "DESIGN_GAP":       { "target": "design-tech" }
  }
}
```

1. **Valid transitions only:** `verify-task` can only fire `NEXT`, `FAILED`, `REQUIREMENTS_GAP`, or `DESIGN_GAP`. It cannot invent ad-hoc states or jump straight to `done`.
2. **Stale-step guard:** `complete_step` requires the caller to name the expected current step (`verify-task`) and fails if the flow has already moved.
3. **Loop ceiling:** During `/fast-forward`, `dfl` derives visit counts from the flow history and automatically halts with `loop` if any step becomes current a **4th time** — preventing infinite `implement-task ↔ verify-task` burn loops.
4. **Unintended final-state refusal:** During `/fast-forward`, `dfl` rejects events leading to side-exit final states like `OUT_OF_SCOPE` → `not-handled` (`FAST_FORWARD_EVENT_REFUSED`) before writing state or touching Jira.

### Prompt-Enforced & Git-Auditable (Inside a Step)

Inside `verify-task`, whether the agent actually reads every diff hunk, refuses a same-session run without an override, or avoids editing source files is **prompt-enforced**, not OS-sandboxed.

Why does that still work reliably in practice? Because every inside-step claim leaves a **git-auditable paper trail**:

- The Dev QA report is committed in the task brief (`docs/tasks/<key>.md`) with the diff base, per-ID evidence table, and independence status (`fresh session`, `fresh sub-agent`, or `override`).
- Sensitive paths (`auth/**`, `migrations/**`, `SEC`/`PRIV`/`SAFE` IDs, new dependencies, public APIs) are explicitly surfaced in the PR description by `/ship-task` for **mandatory human review** — Dev QA is forbidden from approving them (`verify-task/SKILL.md.hbs:73–76`).
- Because `/verify-task` runs in a clean context window (or with a different model altogether, e.g., Claude implementing and Codex or Gemini verifying), there is no prior sunk-cost bias to rationalize away a blocker.

---

## Honest Trade-Offs

- **Not an OS sandbox:** `dfl` does not wrap your coding agent in a read-only container during `/verify-task`. If an agent ignores its skill instructions and edits a source file, git history will expose the extra diff, but the OS will not block the write.
- **Extra session overhead:** Opening a fresh session (or spawning a fresh sub-agent) adds 10–20 seconds of startup and re-reading cost per task. On a 2-line typo fix, that feels heavier than yolo-merging; on any real feature or bug fix, it pays for itself the first time it catches an unmapped hunk.
- **Documentation-only Gherkin:** Requirement IDs (`CHK-1.2`) live in Markdown (`REQUIREMENTS.md`), not executable Cucumber `.feature` files. Traceability relies on tests citing the ID in their test name or comment, verified by `/verify-task`.

---

## Try It Yourself

```sh
npm install -g @vishin-pavel/dfl   # requires Node.js >=22.12
cd your-project
dfl install --yes --agents claude,cursor
```

Start a task with `/classify-task`, implement it with `/implement-task`, and then open a fresh agent session to run `/verify-task`. Read the full [`dev` flow reference](/guide/dev-flow) or inspect the [`dfl` MCP server](/guide/mcp-server) to see how all 15 tools wire into your existing agents.
