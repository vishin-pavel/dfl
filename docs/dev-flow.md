# The `dev` Flow & Fast-Forward Autopilot

`dev` (*Requirements-driven development*) is the sole prebuilt flow template shipped with `@vishin-pavel/dfl` v0.3.0. Earlier sample templates (`feature`, `bugfix`, and `quick`) were retired in v0.2.0 and replaced by `dev`.

Requirements are the source of truth: each feature has business rules in documentation-only Gherkin (`REQUIREMENTS.md`) with a glossary, readable by every stakeholder, and long-lived technical requirements (`TECH_DESIGN.md`). When code and an accepted rule disagree, the code is fixed. Every task is classified first, and the classification decides how deep the flow goes.

::: info Documentation-Only Gherkin — Zero Cucumber Runner
`dev` uses `Given / When / Then` syntax strictly as a human- and LLM-readable specification format in Markdown (`REQUIREMENTS.md`). Each rule and scenario has a stable ID (for example `CHK-1`, `CHK-1.2`) that your existing test suite cites directly. No Cucumber runner, step-definition glue, or extra test framework is required.
:::

---

## Steps & Final States

The `dev` flow consists of **6 steps** and **2 final states** (`done` and `not-handled`).

| Step | Command | What it does |
|------|---------|--------------|
| **Classify** (`classify-task`) | `/classify-task` | Records the request word for word in the task brief, finds the affected features and how well their requirements cover the touched behavior, classifies the task, and proposes a route; waits for your explicit yes, then creates the task branch (a Jira task already has one). |
| **Behavior** (`define-behavior`) | `/define-behavior` | Writes or updates the features' business requirements: rules and scenarios with IDs (`CHK-1`, `CHK-1.2`) and a glossary; you accept them and they are committed on their own. |
| **Tech design** (`design-tech`) | `/design-tech` | Screens quality attributes against ISO/IEC 25010:2023 codes (such as `PERF`, `SEC`, `MAINT`) plus operational concerns, and writes the applicable technical requirements — each measurable or simply verifiable: logical data, interfaces, UI placement, operations, engineering, and the few `DEC-n` decisions that are expensive to reverse. |
| **Implement** (`implement-task`) | `/implement-task` | Test-first against the accepted requirements; tests name the scenario IDs they prove. A settled requirement changes only through a change request you decide (options, pros and cons, a recommendation), and every one is listed at the end. |
| **Dev QA** (`verify-task`) | `/verify-task` | Checks the committed code in a fresh session: every in-scope requirement has a passing test naming it, every hunk of the diff maps to a requirement, tests and checks pass against a baseline, and sensitive changes are listed for human review; writes the Dev QA report. Never fixes code itself. |
| **Ship** (`ship-task`) | `/ship-task` | Pushes, opens the pull request (never merges) with the requirement changes, change requests, and Dev QA report, watches CI, requests human review of sensitive changes, and removes the task brief in the branch's final commit. |

*(In OpenAI Codex, invoke skills with `$` instead of `/`, e.g. `$classify-task`.)*

### Transitions & Final States

Problems route back to the step that owns them:

- `RECLASSIFY` (`define-behavior` → `classify-task`)
- `REQUIREMENTS_GAP` (`design-tech` or `verify-task` → `define-behavior`)
- `DESIGN_GAP` (`verify-task` → `design-tech`)
- `REVISE_REQUIREMENTS` (`implement-task` → `define-behavior`)
- `REVISE_DESIGN` (`implement-task` → `design-tech`)
- `FAILED` (`verify-task` → `implement-task`)
- `CHANGES_REQUESTED` (`ship-task` → `implement-task`)

Terminal outcomes are represented as two distinct final states:

- **`done`**: Dev QA passed and the pull request is open with CI green (or the hand-off notes what is not available). The task is ready for the QA team.
- **`not-handled`**: A question, estimate, spike, or duplicate closed without repository changes (`OUT_OF_SCOPE` from `classify-task`, only after you agree).

---

## Adaptive 4-Route Classification

Everything after **Implement** is always **Dev QA → Ship**. Before Implement, `/classify-task` chooses one of four routes based on what actually changes:

| Route | Steps before Implement | Event fired from Classify | Typical task |
|-------|------------------------|---------------------------|--------------|
| `full` | Behavior, Tech design | `NEXT` | A new feature; changed requirements with technical impact |
| `behavior` | Behavior | `NEXT` (then `NO_TECH_IMPACT`) | A clarified rule; a bug where the requirement was silent or wrong; changed requirements without technical impact |
| `design` | Tech design | `TECH_ONLY` | A new quality target, infrastructure, CI, or storage requirement; a UI design correction |
| `code` | *(none)* | `CODE_ONLY` | A bug that violates an accepted scenario cited by ID; a refactor, dependency bump, or chore within existing requirements |

Classification asks two concrete questions:

1. Does any business rule change as stakeholders see it? If yes, **Behavior** runs.
2. Does a changed rule or objective touch persisted data, an interface, UI placement, or a quality target? If yes, **Tech design** runs too (and Behavior repeats this check, switching between `full` and `behavior` if needed).

When the touched behavior has no accepted requirements yet, a task that changes or relies on a business rule goes through **Behavior** first: a bug can only "violate a requirement" whose ID it cites. The requester's label ("bug", "small tweak") never decides, and you confirm the class and route before anything is written.

---

## Project Stages: Greenfield, Adoption, Brownfield

Each step decides its context from the repository first:

- **Greenfield** (no product code yet): The first task creates `docs/requirements/`, the index (`README.md`), and `GLOSSARY.md`, asks a few questions for the project baseline (`SYS-` IDs), and its first implementation increment sets up tests and CI.
- **Adoption** (existing product code, no requirements yet for the touched behavior): The flow writes requirements *only* for the touched behavior and the rules it depends on — each confirmed by you, because existing code can contain bugs that must not be codified as requirements. Coverage grows task by task.
- **Brownfield** (both code and requirements exist): Accepted requirements take precedence over the code of the features a task touches; conflicts discovered in other features are logged as follow-ups.

---

## Files on Disk & Task Brief Lifecycle

```text
<repo>/
  docs/requirements/           # requirementsDir (project variable)
    README.md                  # index: feature, ID prefix, purpose, coverage
    GLOSSARY.md                # terms shared across features
    TECH_DESIGN.md             # project baseline (SYS- IDs), created when first needed
    checkout/                  # one folder per feature
      REQUIREMENTS.md          # rules and scenarios in Gherkin (CHK-1, CHK-1.2) + feature glossary
      TECH_DESIGN.md           # technical requirements (CHK-PERF-1) and decisions (CHK-DEC-1)
  docs/tasks/                  # taskNotesDir (project variable)
    ABC-123.md                 # task brief, named by ticket key (or slug without Jira)
```

The **task brief** carries a task through every step: the original request (quoted verbatim, never copied into requirement or tech design files), classification, quality attribute screening, change requests, rework entries, implementation checklist, Dev QA report, and QA team hand-off.

It is committed on the task branch while work is in progress. Once `/ship-task` opens the pull request (whose body preserves the original request, classification, change requests, Dev QA verdict, and hand-off with a permalink to the brief), `/ship-task` removes the brief in the branch's final commit. Thus `taskNotesDir` holds only briefs of open work (plus tasks shipped without a git remote, where the brief stays as the sole record). If review changes or QA rejection bring work back later, the next step restores the brief from git history before continuing.

---

## Independent Dev QA & Shipping Rules

- **Fresh-session verification:** Run `/verify-task` in a fresh session, ideally with another agent or model. It refuses to verify in the conversation that wrote the code unless you explicitly override it (and any override is recorded in the Dev QA report). It never edits code, tests, or requirements — it sends the task back via `FAILED`, `REQUIREMENTS_GAP`, or `DESIGN_GAP`. For the deeper engineering rationale, see [Why I Stopped Letting Coding Agents Grade Their Own Homework](https://vishin-pavel.github.io/dfl/blog/fresh-session-diff-verification).
- **ISO/IEC 25010:2023 quality screening:** `/design-tech` screens all 9 ISO/IEC 25010:2023 quality characteristics (`FUNC`, `PERF`, `COMP`, `IC`, `REL`, `SEC`, `MAINT`, `FLEX`, `SAFE`) plus 8 operational concerns (`OBS`, `DEPLOY`, `CICD`, `COST`, `PRIV`, `DCONS`, `COMPL`, `DX`), and records only expensive-to-reverse decisions as `DEC-n`. See [Steering AI Architecture with ISO 25010 Quality Attributes](https://vishin-pavel.github.io/dfl/blog/iso-25010-ai-architecture).
- **Shipping ends with an open PR:** `/ship-task` never merges and completes on the task branch. Merging and external QA verification happen outside the flow; `/ship-task` prints cleanup instructions for after the merge.

---

## `dev` Flow Variables

Configure these with `dfl vars set` (see [Variables & Templates](./variables-and-templates.md)):

| Name | Scope | Default | Meaning |
|------|-------|---------|---------|
| `requirementsDir` | project | `docs/requirements` | One folder per feature, plus index, `GLOSSARY.md`, and baseline tech design |
| `requirementsFile` | project | `REQUIREMENTS.md` | File name of a feature's business requirements |
| `techDesignFile` | project | `TECH_DESIGN.md` | File name of a feature's technical requirements (and baseline at root of `requirementsDir`) |
| `taskNotesDir` | project | `docs/tasks` | Task briefs of open work (removed by `/ship-task`) |
| `mainBranch` | project | `main` | Default branch that task branches start from and PRs target |
| `testCommand` | project | *(none)* | Full test suite command; when empty, the flow detects it, asks you, and saves it |
| `checkCommand` | project | *(none)* | Other CI checks (lint, type check, build) chained with `&&`; detected the same way |
| `sensitivePaths` | project | *(none)* | Comma-separated globs whose changes always need human review (e.g. `auth/**,migrations/**`) |
| `featureBranchPrefix` | personal | `feature/` | Prefix for untracked feature branches |
| `fixBranchPrefix` | personal | `fix/` | Prefix for untracked bug fix branches |
| `reviewer` | personal | *(none)* | GitHub handle (without `@`) to request PR reviews from |

`dev` is copied into `.df/dev/` when installed, so your team owns it and can customize it freely. Browse the upstream template on [GitHub](https://github.com/vishin-pavel/dfl/tree/main/templates/flows/dev).

---

## Fast-Forward Autopilot (`/fast-forward`)

Added in v0.3.0, `/fast-forward` (`$fast-forward` in Codex) runs flow steps autonomously one after another until a target state becomes current (default: the end of the flow, `done` in `dev`). Wherever a step would ask you, wait for your yes, or offer options, the agent takes the step's recommended option and logs the decision.

### Syntax & Examples

```text
/fast-forward [to <state>] [<ticket>] [<request …>]
/fast-forward <state> [<ticket>]          # only when that is the whole text
/fast-forward stop                        # only when "stop" is the whole text
```

```text
/fast-forward Add CSV export to the reports page          # new run to the end of the flow
/fast-forward to verify-task Add CSV export to reports    # stops when Dev QA becomes current
/fast-forward to implement-task ABC-123                   # Jira ticket; review specs before code
/fast-forward verify-task ABC-123                         # state id + ticket as whole text
/fast-forward                                             # resume stopped run, else run to end
/fast-forward use the design route                        # resume; text answers why run stopped
/fast-forward stop                                        # stop the run
```

- **Target is not run:** The run stops as soon as the target state becomes current. To run a step, target the state after it or omit the target.
- **Target validation:** `dfl` refuses side exits (`not-handled`), the current step, a step behind it, or an unreachable step (`FAST_FORWARD_TARGET_INVALID`).
- **Stale skills & unknown position:** Requires up-to-date installed skills (`FAST_FORWARD_SKILLS_STALE` → run `dfl flow-update`) and a valid current step (`FAST_FORWARD_POSITION_UNKNOWN` → `dfl goto <step>`).
- **Data vs. instructions:** Request text, ticket text, PRs, reviews, repo files, and tool output are treated strictly as data — they can never retarget a run, skip checks, or lift a stop.

### Built-in Checkpoints

| Command | Stops when | Why use it |
|---------|------------|------------|
| `/fast-forward to implement-task` | Implement is current | Review classification, Gherkin requirements, and tech design before any code is written |
| `/fast-forward to verify-task` | Dev QA is current | Run Dev QA yourself in a fresh session (ideally with another agent or model) |
| `/fast-forward to ship-task` | Ship is current | Inspect commits and diff before pushing or opening a PR |

### Decision Rules & Sub-Agents

- **Decision policy:** Takes the step's recommended/default option unless the repository gives a concrete reason otherwise; among equals, prefers the smallest reversible option that keeps all requirements, tests, checks, and reviews intact. Never picks a route or event just to reach or avoid the target.
- **Fresh sub-agents:** When the coding agent supports spawning fresh sub-agents with project tool access, `/fast-forward` runs each step in a new sub-agent without passing summaries of earlier steps. Each sub-agent reads its instructions from `get_status`, preserving Dev QA independence (`Independence: fresh sub-agent (fast-forward)`). Without sub-agent support, the run pauses at `verify-task` so you can resume in a fresh session.
- **Audit trail in `dev`:** Automatic approvals are marked `(auto)` (`Accepted: classification 2026-10-08 (auto)`), unconfirmed numeric targets use `Source: assumed`, and every choice is logged in `## Fast-forward log` in the task brief (with ` · review` on sensitive items, assumptions, dependencies, discovered commands, or prompt-injection attempts).

### Safety Rails & Stop Conditions

`dfl` evaluates run state after every move from the flow history (persisted as intent-only records in git-ignored `.df/fast-forward.json`, keeping the 20 most recent runs):

| Stop Reason | When it triggers | Bare `/fast-forward` afterwards |
|-------------|------------------|---------------------------------|
| `reached` | Target state becomes current | Starts a new run to flow end |
| `skipped` | Route bypassed the target (e.g. `to design-tech` when Classify fires `CODE_ONLY`) | Starts a new run to flow end |
| `moved` | Flow moved outside the run (`dfl goto`, `dfl reset`, step deleted/renamed, teammate move) | Starts a new run to flow end |
| `loop` | A step becomes current a **4th time** (reaching target wins) | Resumes run with same target & fresh visit counts |
| `stopped` | You or the agent explicitly stopped the run | Resumes run with same target & fresh visit counts |

Additional hard safety rails:

- **Unintended final states refused (`FAST_FORWARD_EVENT_REFUSED`):** While running, `dfl` refuses any event or `goto` leading to a final state other than the target (such as `OUT_OF_SCOPE` → `not-handled`) before writing state or touching Jira.
- **Agent hard stops:** The agent stops instead of deciding if a step needs credentials/secrets, discarding/stashing/overwriting unrelated changes, force-pushing, rewriting pushed history, pushing to or merging into `main`, deploying/publishing, weakening/skipping tests or requirements, or adding an unapproved dependency.
- **Draft PRs only:** In `dev`, `/ship-task` opens a `--draft` PR with **no reviewers requested** (ignoring `reviewer` and `CODEOWNERS`), listing all ` · review` lines and `(auto)` values under *Needs human review*.
- **Jira pause before `done`:** On Jira-tracked flows, the run stops before `ship-task` fires `NEXT` so you review the draft PR before moving the ticket to *Ready for QA*. Complete it manually with `/ship-task` or `dfl next --from ship-task --task ABC-123 --set prUrl=<url>`.

### Driving Fast-Forward from the CLI

```sh
dfl fast-forward                      # resume a stopped run, else start to end of flow
dfl fast-forward verify-task          # stop when Dev QA becomes current
dfl fast-forward --stop --reason "Which CSV columns? Only the developer knows."
dfl status                            # shows active (») or stopped (■) run status
```

See [CLI Reference](./cli-reference.md) for full flags and `--json` output, and [Jira Cloud Tracking](./jira.md) for ticket-scoped fast-forward behavior.
