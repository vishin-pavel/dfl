# Fast-forward runs: assessment and recommended design

Status: proposal of 2026-10-08, implemented in 0.3.0; the owner's decisions are pending (§10). §11 lists where
the implementation differs from this proposal, including the changes made after review. The binding contract of the
implementation is [docs/ARCHITECTURE.md §10](../ARCHITECTURE.md), with §1.6 for the run file and §2.3 for forward
paths; this document keeps the assessment and the rationale.

## 1. Summary

**Recommendation.** A built-in skill, `/fast-forward` (Codex: `$fast-forward`), runs the flow's steps one after
another in the developer's place until a target state becomes current. Without a target it runs to the end of the
flow. dfl, not the model, keeps the run and decides after every move whether it goes on.

- **Target.** "Fast-forward to X" means that X becomes current and is not run. A selected target is cheap to support:
  one pure module, `src/core/forward.ts`, defines "ahead" as the flow order that `dfl flow view` already draws. The
  default target is the final state the `NEXT` path reaches (`done` in dev).
- **dfl stores intent, not progress.** `.df/fast-forward.json` (git-ignored) holds one record per flow, or per ticket:
  the target, where the current segment started, and an explicit stop. Moves, visits and whether the run reached its
  target are derived from the flow history. Moves therefore never write the file, and a replayed or timed-out Jira
  move cannot put it out of step.
- **dfl enforces the outer bounds.**
  - While a run is running, dfl refuses every event and every goto into a final state other than the target
    (`FAST_FORWARD_EVENT_REFUSED`), before any Jira request.
  - A state that becomes current a 4th time in a run segment stops the run (`loop`).
  - A goto, a reset, a step removal or a move from elsewhere ends it (`moved`).
  - A route that skips the target ends it (`skipped`); the run never continues to the end instead.
- **One policy text, generated at runtime.** While a run is running, and after it stopped or ended until the flow
  moves on, `get_status` and the move results carry a `fastForward` block. Its `instructions` say how to run the step,
  how to decide, what never to decide, and how to complete or stop. Rendered skills stay static:
  - the built-in skill drives the loop;
  - one sentence in `flow-context` gives the block precedence inside every step of every flow;
  - the dev flow's `brief` partial says where decisions go and how acceptances are marked.
- **Small surface.** One MCP tool (`fast_forward`: start, resume or stop), one CLI command (`dfl fast-forward`) and one
  optional result key. Without a run, every result stays byte-identical.
- **Cost.** About 1,600 lines of production code and 2,300 lines of tests, plus the skill and about 80 lines of dev
  content (§7).

How this was evaluated: six reader reports on the code (state and runtime, MCP, tracker, rendering, the dev flow's
checkpoints, CLI/docs/tests). Then four competing designs, each written by an advocate of one angle, were scored by
three judges with different lenses: intent and UX, architecture, robustness and safety. A specification merged the
winner with the best ideas of the others. The scores are in §5.

## 2. Your request and how it is read

> I want to develop a way to fast-forward the flow to a selected state, if possible, or to the last state otherwise
> (or if that would be an ugly solution). The way I see the user experience is a prompt like
> "/fastforward-task-to {state_name}," and the LLM will follow all steps and automatically resolve all questionable
> solutions and suggestions by choosing the best one based on its knowledge.

| Part | Reading |
|---|---|
| "to a selected state, if possible, or to the last state otherwise (or if that would be an ugly solution)" | A design-time choice. A selected target is supported because it is not ugly here: one pure helper gives start validation, the default target, skip detection and the guard. "The last state" is the default when no state is typed. |
| "if possible", at runtime | Never "else go on to the end". A target that the chosen route skips (dev: `CODE_ONLY` from Classify skips Tech design) ends the run as `skipped` at the state the route reached, which is not run. Going on to the end would push and open a pull request that you may have put out of scope by choosing an earlier target. |
| "the last state" | `flowEnd`: the final state the `NEXT` path from the initial step reaches (dev: `done`). Other final states are side exits (dev: `not-handled`): never a target, never entered by a run. |
| "fast-forward to X" | X becomes current and is not run. That is one meaning for steps and final states, the same as `goto`. To have X run, target the state after it, or the end. |
| "follow all steps" | Each step runs from its own rendered skill file, read in full every time, in a fresh sub-agent where the agent can start one. |
| "resolve all questionable solutions and suggestions by choosing the best one based on its knowledge" | The step's recommended or default option "unless your knowledge of this repository gives a concrete reason to prefer another", then the option most consistent with what is accepted, then the smallest reversible one (§6.6). Every decision is logged. A short list of hard stops stays with you. |

**Caveat for the dev flow.** With the default of Q1 (§10), a run on a flow tracked in Jira stops before Ship fires
`NEXT`, because `done` hands the ticket to the QA team. The default target `done` is therefore reached only on
untracked flows; a tracked run to the end stops at Ship with the draft pull request open. The stop reason tells you to
run the Ship command yourself after review; a bare resume would only stop at Ship again.

**Name: `/fast-forward`, not `/fastforward-task-to`.**
- "fast-forward" is the usual hyphenated spelling, and skill names are kebab-case.
- The target is optional, and a command that ends in `-to` reads as broken without one. `to` moves into the argument:
  `/fast-forward to verify-task`. The keyword also keeps the grammar unambiguous: `/fast-forward done button is
  broken` is a request, not a target.
- "task" already means a Jira ticket in dfl (`--task`, `start_task`, `/init-task`), and runs work for any flow.
- **Renaming is cheap.** The skill name is one constant (`FAST_FORWARD_SKILL`), the template directory
  `templates/skills/fast-forward/`, one entry of `BUILTIN_SKILL_NAMES`, two authoring texts (`guide.ts`,
  `add-flow-step`), the wording of the tool description and `SERVER_INSTRUCTIONS`, and the test lists. The MCP tool, the CLI command, the run file and the `fastForward` key do not
  depend on it, nothing stored names it, and projects get a new name at their next sync. `fast-forward-task` is the
  alternative (Q2).

## 3. Requirements and constraints

Your requirements:

| # | Requirement | How it is met |
|---|---|---|
| R1 | A command with a state runs the flow to that state. | `/fast-forward to <state>`, or a state id as the whole text. dfl validates the target at start (§6.2). |
| R2 | Otherwise, run to the last state. | Without a target: resume a stopped run with its target, else run to `flowEnd`. |
| R3 | The agent follows all steps. | The skill loops until the block says the run stopped or ended; each step runs from its skill file. |
| R4 | The agent resolves questions and suggestions with the best option, from its knowledge. | The decision rule in `fastForward.instructions`; in dev, ` (auto)` markers, `## Fast-forward log` and `Source: assumed`. |

Constraints in today's dfl, and how each is met:

| # | Constraint | How it is met |
|---|---|---|
| 1 | ARCHITECTURE is the binding contract; the rationale lives in `docs/design/`. | ARCHITECTURE §1.6, §2.3 and §10; this document. |
| 2 | CLI parity: every MCP instruction has a CLI fallback. | `dfl fast-forward`; `fastForward` in `status`, `next`, `goto` and `reset --json`. Every call in the instructions is paired with `` `dfl …` ``, localized by `localizeCli` (MCP) or `launcherText` (CLI). |
| 3 | Rendered skills are static; runtime data reaches the agent only through results. | The skill and the flow-context sentence are static. Target, step, visits and moves come in `fastForward`. |
| 4 | Results of untracked flows stay byte-identical when the feature is not used. | The block is a conditional spread placed last. Without the run file a result costs one `exists` call. Tests cover no file, a file with another flow's run, and an ended run. |
| 5 | `state.json` is local and tolerantly parsed, and `readStateFile` drops unknown keys; tracked flows never touch it. | A separate, tolerantly parsed file. `state.json` and the Jira record are unchanged. |
| 6 | Any flow, not only dev; dev specifics belong in dev templates. | Core rules use only the flow order and final states. Dev rules live in the `brief` partial and the references. |
| 7 | 9 agents; not all can start sub-agents; Codex invokes skills with `$`. | A sub-agent per step when the agent can start one, inline otherwise. The command prefix is localized. |
| 8 | Agents never handle tokens. | Credentials, sign-ins and `TRACKER_AUTH*` are hard stops. |
| 9 | Ticket, request and pull request text is data; autopilot must not widen the prompt-injection surface. | Only the user's command starts a run (tool description, `SERVER_INSTRUCTIONS`, skill). The request goes only to the first step. dfl refuses side exits in code. |
| 10 | Skill bodies avoid `$ARGUMENTS`, `$1`, `` !` `` and `@word`; skill names are kebab-case. | The grammar is prose about "the text the user typed after the command". |
| 11 | `flow-context` renders to at most 25 lines. | The sentence is appended to an existing paragraph: +0 lines (dev maximum 20, sample 16). |
| 12 | Elegance: a selected target only if it is not ugly. | One pure helper module; one tool, one command, one result key. |

One more rule comes from the MCP server: no tool chains moves or holds the project lock across step work. Run moves
stay ordinary `complete_step` calls, with explicit `step` and, on tracked flows, `task`.

## 4. Assessment of the dev flow

The shipped dev flow is the main client and the hardest case.

- **Shape.** Six steps and two final states: `done`, the end of the `NEXT` path, and `not-handled`, reached by
  `OUT_OF_SCOPE` from Classify. Classify chooses the route: `NEXT` (full or behavior), `TECH_ONLY` (design) or
  `CODE_ONLY` (code); Behavior may take `NO_TECH_IMPACT`.
- **Plain reachability is useless.** Seven backward events (`RECLASSIFY`, `REQUIREMENTS_GAP`, `REVISE_REQUIREMENTS`,
  `REVISE_DESIGN`, `FAILED`, `DESIGN_GAP`, `CHANGES_REQUESTED`) let every non-final state reach all 8 states. Flow
  order tells what is still ahead:

  | From | Forward-reachable |
  |---|---|
  | `classify-task` | all 8 states |
  | `define-behavior` | `define-behavior`, `design-tech`, `implement-task`, `verify-task`, `ship-task`, `done` |
  | `implement-task` | `implement-task`, `verify-task`, `ship-task`, `done` |
  | `ship-task` | `ship-task`, `done` |

- **About 80 checkpoints** ask, wait for or confirm with the developer: decisions with and without a default, facts
  only the developer has, approval gates, git safety, outward actions and independence. Ten of them are exit
  criteria or later checks that pass only on a human yes: Classify's dated yes, Behavior's acceptance "in this
  conversation", four clauses of Tech design's exit, Implement's `Accepted:` check, change request decisions (with
  "no developer reachable: pending, stop"), and Dev QA's independence and should-fix default. All are prose: no dfl
  code reads the brief. Each needed a text change before an automatic acceptance could pass the later checks (§6.7).
- **Natural boundaries.** Implement ends with "run `/verify-task` in a fresh session", and Dev QA stops when the
  conversation wrote the code. So `to implement-task` stops for a review of the specs before any code,
  `to verify-task` stops at the independence boundary, and `to ship-task` stops before anything goes outward. Ship is
  the only step with outward actions: push, pull request, reviewers.
- **Ending without work.** Only `OUT_OF_SCOPE`, also reachable through `RECLASSIFY` when the task "turns out to be out
  of scope". In the example Jira mapping it sets *Won't Do*; `done` sets *Ready for QA*.
- **Loops.** The content has no hard cap. Dev QA escalates a finding that failed in two earlier rounds to a GAP event;
  other findings and `CHANGES_REQUESTED` loop freely. A run needs its own bound, high enough not to pre-empt that
  escalation.
- **Budgets and pinned text.** Tech design, Implement and Dev QA are at the 140-line cap (Classify, Behavior and Ship
  at 138); references may have 150 lines. The `brief` partial is included by all six steps and has no budget, so dev
  rules belong there. Every backticked upper-case token in a dev template must be a flow event, and several
  sentences are pinned by tests.

## 5. Alternatives considered

| | Approach | Main idea | Intent/UX | Architecture | Robustness | Total | Fatal issue (any judge) |
|---|---|---|---|---|---|---|---|
| **A** | **dfl-enforced run** | dfl stores the run, decides continue or stop after every move and returns generated instructions; a thin driver skill | 7.5 | 8 | 7.5 | **23** | The dev default never reached `done`; every stop deleted the run, so a bare re-invocation widened the target |
| C | Flow-declared autonomy | `meta.fastForward` (`auto`, `isolated`, `manual`) and `fastForwardNote` in flow.json; dfl enforces them | 7 | 5 | 7 | 19 | A new flow.json vocabulary with validation and view changes; stops also deleted the run |
| D | Orchestrator, audit, reversibility | An intent-only record with progress derived from history; a sub-agent per step; checkpoint refs and `dfl fast-forward undo` | 6.5 | 4 | 8 | 18.5 | Destructive git in dfl core (`reset --keep`, refs never deleted); a crashed run takes over a manual session |
| B | Minimal, skill-first | No stored run; the skill holds the policy; read-only `get_forward_path` and `dfl status --to` | 6 | 7 | 5 | 18 | dfl enforces nothing: `OUT_OF_SCOPE` (*Won't Do*) is guarded by prose only, and termination depends on the model |

Scores are 1–10, one judge per lens. A won intent/UX and architecture; D won robustness. The design keeps A as the
base and takes:

- **From D:** the intent-only record with progress derived from history (both other judges grafted it); stops that
  keep the target, so a bare re-invocation resumes; one fresh sub-agent per step with a fixed prompt and a reply of at
  most 12 lines; a greenfield repository handled without stopping.
- **From B:** "ahead" as the flow order (`forward.ts`); target neutrality ("never choose an option, route or event
  because it reaches, avoids or skips the target"); the request only for the first step; the path and forks at start;
  the decision order.
- **From C:** a bare `stop`; the guard on every final state other than the target, and side exits refused as targets;
  the rule that a session which did not start the run asks first.

Rejected:

- **Skill-only and stateless (B).** Prose alone stands between injected ticket text and *Won't Do*; termination and
  loop detection depend on the model calling a helper again; the target is lost at compaction.
- **Deleting the run on every stop (A, C).** A bare re-invocation silently widens a narrower target into a push and a
  pull request.
- **Writing progress on every move (A, C).** Six hooked call sites; a write after a committed Jira `PUT` can fail; a
  timeout of unknown outcome leaves the file out of step. Derivation from history removes all three.
- **A's "NEXT or a later index" as "ahead".** Two notions of ahead; replaced by the viewer's flow order.
- **A's side-exit-only guard.** In custom flows it misses an event into the main final state that skips a step target.
- **D's refusal of route-skipping events, and its filtered `events` list.** Both bias the classification toward the
  target and stop a correct `CODE_ONLY` before it is recorded. Target neutrality wins. B's per-event effect labels
  were not taken either; the block lists only `refusedEvents`.
- **D's checkpoint refs and `undo`.** Destructive git and refs that are never deleted, in dfl core; not requested.
- **D's refusal of a dirty tree at start.** It blocks common starts; the steps' git rules and the hard stops cover it.
- **D's two tools and four subcommands.** One tool with `stop` is enough.
- **C's flow.json vocabulary.** A new authoring concept, free text interpolated into instructions, and dev policy in
  three places. A transition-level `manual` marker is deferred (§8).
- **C's stop on any `task.warnings`, and its loop limit of 2.** The first halts runs on harmless projection gaps; the
  second pre-empts Dev QA's GAP escalation.
- **Run state in `state.json` or in the Jira record.** `readStateFile` drops unknown keys on every write, and tracked
  flows must not touch the file. The record is shared, readable by anyone with Browse, ignored by older dfl versions
  and needs the network.
- **A `to` input on `get_status`.** It breaks the pinned `['flow','task']` schema and mixes a read with a write.
- **One dfl call that chains moves, or a `goto` to the target.** Steps are agent work: it would hold the lock for
  minutes, or skip the work and make one Jira jump.
- **An external orchestrator that starts agent CLIs.** Not portable across 9 agents, and it brings token handling.
- **Mandatory sub-agents.** Not every agent can start them.
- **A bare first-word target (B).** Ambiguous: "done button is broken".

## 6. Recommended design

### 6.1 Architecture

```
 user: /fast-forward [to <state>] [<ticket>] [<request>]             terminal / CI
   built-in skill fast-forward (driver)                              dfl fast-forward [state] [--stop]
     fast_forward: start · resume · stop                             dfl status · next · goto · reset
     per step (sub-agent or inline): get_status → step skill → complete_step   │
        │                                                                       │
   src/mcp/tools.ts                                          src/commands/fastforward.ts, state.ts
        └───────────────────────────────┬───────────────────────────────────────┘
                                        ▼
   src/core/fastforward/  start.ts         startFastForward · stopFastForward · assertSkillsCurrent
                          run.ts           evaluateRun · planFastForwardStart · checkFastForwardEvent/Goto (pure)
                                           sendEventChecked · gotoStepChecked · the guards · fastForwardBlock (I/O)
                          store.ts         .df/fast-forward.json: intent only
                          instructions.ts  the fastForward block and its instructions
   src/core/forward.ts    forwardReachable · flowEnd · forwardPath · bypassSteps (pure)
                                        │ reads
          flow history: .df/state.json (untracked flows) · the ticket's dfl.run record (tracked flows)
```

How it plugs into the existing code:

- **Moves keep their paths.** Local events go through `sendEventChecked` (MCP `transition` and `complete_step`, CLI
  `next`), gotos through `gotoStepChecked` (MCP `goto_step`, CLI `goto`). On tracked flows `taskMove` builds both
  guards inside its lock and passes them to `moveTask`, which calls the one of the move's kind after replay detection
  and before the record `PUT`. Resets have no guard: they end the run.
- **Views after the fact.** `fastForwardBlock` evaluates the run in the state the result already holds. It never
  throws, so a result never fails because of its block.
- **No import cycles.** `flow.ts` imports only `store.ts` (for `deleteFlow`), `tracker/runtime.ts` imports `run.ts`,
  and `run.ts` imports neither `sync.ts` nor any tracker module. `instructions.ts` imports only types from `run.ts`;
  the visit limit both use lives in `store.ts`.
- **Locks.** `fast_forward` uses `lockInside`: a tracked ticket is read outside the lock, and the run file is read,
  planned and written under it. Move tools still hold the lock for the whole call, and the guards and the view read
  run inside it. The lock is never held across step work.

### 6.2 Semantics

**Forward paths** (`forward.ts`, pure):
- *Flow order* is `StepInfo.index` (`orderStates`: declaration order, initial first, finals last). A transition
  `s → t` is *forward* when `index(t) > index(s)`; every other edge is a loop. Array-form (guarded) transitions are
  ignored, as everywhere. The forward subgraph is a DAG, and it is the split `dfl flow view` draws.
- `forwardReachable(model, from): Set<string>`: a BFS over forward edges, `from` included.
- `flowEnd(model): string | undefined`: the first final state of the `NEXT` walk from the initial step (with a visited
  set); else the only final state; else undefined.
- `forwardPath(model, from, target): string[]`: the likely path. At each state it takes the forward transition that is
  or still reaches `target`, `NEXT` first, else the first declared. It returns `[]` when `target` is unreachable.
- `bypassSteps(model, path, target): string[]`: the forks, the steps of the path with a forward transition to a
  non-final state from which `target` is unreachable. Dev, Classify → Tech design: `classify-task`,
  `define-behavior`. Classify → Dev QA: none.

**Start** (`planFastForwardStart`, pure). The first failing check throws:
1. The current state is final: `FLOW_DONE`.
2. The current step is not known (a repaired state: the stored step is gone): `FAST_FORWARD_POSITION_UNKNOWN`.
3. An unknown target: `STEP_NOT_FOUND`.
4. A running run of the key: with the same or no target it is resumed as it is (no write, counts kept); another target
   is `FAST_FORWARD_ACTIVE`.
5. The target is `to`, else an open (stopped) run's target, else `flowEnd`. None: `FAST_FORWARD_TARGET_REQUIRED`.
6. `validateTarget`: a final state other than the end, the current step, a step behind the current one, or a state
   that is not forward-reachable is `FAST_FORWARD_TARGET_INVALID`, with a message and hint for each case. For a bare
   resume of an open run, any failure of its stored target becomes `FAST_FORWARD_TARGET_INVALID` naming the stopped
   run (`… targets "verify-task", which is behind the current step "ship-task".`) and how to name a target: the target
   is never widened silently.
7. The target of an open run: a new segment of that run (`from`, `anchor` and `resumedAt` set, `stopped` cleared,
   `startedAt` kept). Otherwise a new run.

Before planning, the I/O layer checks two things:
- **The skills** (`FAST_FORWARD_SKILLS_STALE`). The flow must be the active one, with its skills installed and
  current, because a run reads the rendered step files. A current sync also guarantees that `.df/.gitignore` lists the
  run file.
- **The ticket** of a tracked flow: it must be started (`TASK_REQUIRED`, `TASK_NOT_STARTED`, `TASK_STEP_UNKNOWN`).

**Evaluation** (`evaluateRun`, pure). One walk over the history entries after the segment's `anchor`, the last entry
when the segment started, compared on `from`, `to`, `event` and `at`. The walk starts at `run.from` with visit 1.
- A **run move** is an entry from the walk's position along one of the flow's own transitions (event and target),
  whoever made it; a flow's own events named `START`, `RESET` or `GOTO` count too. Any other entry (a goto, a reset, a
  restart, a step removal, a move from another position) is `ended`/`moved`. So are a lost anchor (truncated
  history), a target or start step the flow no longer has (a rename), and a repaired state.
- After a run move the walk counts a visit:
  - the target: `ended`/`reached`. This is checked first, so a target reached on a 4th visit counts as reached;
  - a state from which the target is not forward-reachable: `ended`/`skipped`. A final state other than the target is
    one;
  - a 4th visit: the run halts (`loop`), and the walk goes on.
- An explicit stop (`run.stopped`) halts the run from the start; the walk goes on too.
- The walk ends at the current step: `stopped`/`loop` or `stopped`/`stopped` when the run halted, else `running` with
  that step's visit count. It ends anywhere else: `moved`.

So a stopped run stays open while later moves head for the target, and closes like a running one when the flow
reaches the target, skips it or leaves the run; a stop recorded on a run that had already ended changes nothing. A
move by anyone from the run's position counts as a run move: the run follows the position. A tracked replay adds no
history entry, so it counts once; a timed-out move that succeeded appears in the history and is adopted.
`endedByLastEntry` says that the run's last word is current: the last history entry ended or stopped it, or nothing
moved since an explicit stop. Results show the block of a run that is not running only then.

| Status | Reasons | A bare `/fast-forward` |
|---|---|---|
| `running` | none | resumes it (crash or compaction recovery): no write, counts kept |
| `stopped` (open) | `stopped`, `loop` | resumes it: same target, new segment, counts restart |
| `ended` (closed) | `reached`, `skipped`, `moved` | starts a new run to the end of the flow |

At a final state every start throws `FLOW_DONE` first: a reset or a goto comes before the next run.

**Guards** (`checkFastForwardEvent` before every event move, `checkFastForwardGoto` before every goto). While the run
is `running`, an event of the current step whose transition enters a final state other than the target, or a goto
into such a state, throws `FAST_FORWARD_EVENT_REFUSED`. It applies to every such move, including your own
`dfl next OUT_OF_SCOPE` or `dfl goto not-handled` (Q7). It writes nothing and never ends the run: the agent stops the
run with its proposal as the reason instead. A goto into a step stays allowed and ends the run as `moved`. Route skips
are fired and end the run as `skipped`; refusing them would bias the classification toward the target.

**Loop bound.** At most 3 visits per state per segment, the start state counted as visit 1, so a segment makes at most
3 × (non-final states) moves. In dev: implement (1) → `FAILED` → implement (2) → `FAILED` → implement (3) →
`DESIGN_GAP` (Dev QA's own escalation runs) → design-tech → implement (4) → stop `loop`.

### 6.3 The run file

`.df/fast-forward.json` (`ProjectPaths.fastForwardFile`), listed in `DF_GITIGNORE_CONTENT` after `state.json`. It is
not a reserved flow name: like `tracker.json`, it cannot clash with a flow directory.

```json
{
  "version": 1,
  "runs": {
    "dev": {
      "flow": "dev", "task": null, "target": "verify-task", "from": "classify-task",
      "anchor": null, "startedAt": "2026-10-08T09:00:00.000Z"
    },
    "dev#ABC-123": {
      "flow": "dev", "task": "ABC-123", "target": "done", "from": "implement-task",
      "anchor": { "from": "design-tech", "to": "implement-task", "event": "NEXT", "at": "2026-10-08T10:02:11.000Z" },
      "startedAt": "2026-10-07T15:20:00.000Z", "resumedAt": "2026-10-08T10:05:00.000Z",
      "stopped": { "at": "2026-10-08T11:40:00.000Z", "reason": "CR-2 needs the settlement time only the developer knows" }
    }
  }
}
```

- **Keys.** `<flow>` for an untracked flow, and for a tracked flow with `requireTask: false` and no ticket bound.
  `<flow>#<KEY>` for a ticket, with Jira's `issue.key`.
- **Tolerant parsing.** A missing file is empty. An unreadable or malformed file is empty with a problem; a start that
  replaces it warns. An entry is dropped unless its ids, ticket key, strings and stop reason (one line of at most 300
  characters, no control characters) are valid and it is stored under its own key. Unknown keys are dropped. Reads
  never throw; without the file a read costs one `exists` call.
- **Writers.** Only a start (a new run or segment) and a stop (a stop without a reason keeps the earlier one; a run
  of the local position that has already ended is not stopped). `deleteFlow` drops the flow's runs, and
  `dfl uninstall --purge` deletes the file. At most 20 runs are kept: the oldest others, by `resumedAt ?? startedAt`,
  are evicted. An empty file is removed. Writes are atomic, run under the project lock and throw on failure, before
  anything else is committed.
- **Moves never write it.** A closed record stays until it is replaced, evicted or removed with its flow.

### 6.4 MCP and CLI surface

| Tool or command | Change |
|---|---|
| `fast_forward` *(new)* | `{to?, stop?, reason?, flow?, task?}`. A start or resume returns the status like `get_status`, plus `fastForward` with `resumed?`, `path`, `forks` and `warnings`. `stop: true`, with an optional one-line `reason`, returns `{flow, task?, fastForward}` (`task` is the key string) and reads no Jira: a run of the local position is evaluated first (an ended one is not stopped) and returned with its moves; a ticket's run is stopped unread. Annotations `TRACKER_WRITES` (open world); `lockInside`; no `list_changed`. |
| `get_status`, `dfl status --json` | `fastForward` last while the run is running, and after it stopped or ended until the flow moves on. The `get_status` inputs stay `['flow','task']`. |
| `complete_step`, `transition`, `goto_step`; `dfl next`, `goto`, `reset --json` | `fastForward` last, by the same rule: a move that ended or stopped the run shows it. |
| `dfl fast-forward [state] [--stop [--reason <text>]] [--flow <name>] [--task <key>] [--json]` *(new)* | A start prints a `»` line with the target and the start step, the path, the forks, and how to drive the run (`/fast-forward`) and stop it. Warnings go to stderr. `--json` prints the same block as MCP. |
| `dfl status`, `next`, `goto`, `reset` (text) | One more line: `» Fast-forward to <title> (<id>): <step> next, visit n of 3 · stop it with …[ · refuses <events>]` (status), `» … continues with /<step> (visit n of 3).` (moves), or `■ … stopped: <detail>` / `■ … ended: <detail>`. `status` also shows an open-stopped run with its note (or the loop detail) and "resume it with /fast-forward", only while a bare resume can work. |

The block, `FastForwardView`: `target`, `targetTitle`, `toEnd`, `status`, `reason?`, `detail?` (one sentence),
`note?` (the stop reason; data), `step?` (running only: `id`, `title`, `command` as `/x` or `$x`, `skillFile` as
`.df/<flow>/steps/<id>/SKILL.md`, `visit`, `refusedEvents`), `maxVisits`, `moves?` (this segment), `startedAt` and
`instructions`, in this order. A start adds `resumed?`, `path`, `forks` and `warnings` before `instructions`.

Errors (all `DflError`):

| Code | When |
|---|---|
| `FAST_FORWARD_SKILLS_STALE` | The flow is not the active one, its skills are not installed for you, or they are out of date. |
| `FAST_FORWARD_TARGET_REQUIRED` | No target, no open run, and the flow has no end. |
| `FAST_FORWARD_TARGET_INVALID` | A side exit, the current step, a step behind, or a state that cannot be reached going forward; for a bare resume, the stopped run's stored target. |
| `FAST_FORWARD_POSITION_UNKNOWN` | A start on a repaired state: the current step is not known. |
| `FAST_FORWARD_ACTIVE` | A run to another target is running for the key. |
| `FAST_FORWARD_NOT_ACTIVE` | A stop without a record (the message says when the run file could not be read), or of a local run that has already ended. |
| `FAST_FORWARD_EVENT_REFUSED` | The guards (§6.2), for an event or a goto. |
| `INVALID_OPTIONS` (existing) | `to` with `stop`, `reason` without `stop`, or a reason that is not one line of at most 300 characters. |

`mcpHintFor` adds the MCP form of the hint for `FAST_FORWARD_ACTIVE`, `FAST_FORWARD_EVENT_REFUSED`,
`FAST_FORWARD_TARGET_REQUIRED` and `FAST_FORWARD_POSITION_UNKNOWN`.

### 6.5 What the agent is told

| Layer | Content |
|---|---|
| `fastForward.instructions`, generated in `instructions.ts` (**authoritative**) | Running: who follows them, how to run the step, how to decide, the hard stops, the data rule, refused events, how to complete, the tracked timeout protocol, the sub-agent hand-back and how to stop. Stopped or ended: why, what the driver reports and what comes next. |
| Built-in skill `fast-forward` | The argument grammar, the start and its errors, the announcement, the sub-agent prompt, the loop, progress lines and the report. No decision policy. |
| `flow-context` sentence (every flow) | "If the result has a `fastForward`, follow `fastForward.instructions` first: they come before any question this skill asks the user and before telling the user the next step's slash command." |
| `SERVER_INSTRUCTIONS` | Follow a `fastForward`'s instructions (a run is running, or has just stopped or ended); start, resume or retarget a run with `fast_forward` only when the user invoked the fast-forward skill, and stop it when the user asks or a run's instructions say so. |
| Dev `brief` partial and references | Where decisions go, how acceptances are marked, dev defaults and stops, Ship (§6.7). |

The running instructions, in order:
- **S1** names the run.
- **S2** applies them only in the conversation where the user invoked `/fast-forward`, or in an agent it started for
  one step; such an agent runs only that step, replies to its driver and runs none of the steps later results name.
  Anywhere else the agent tells the user that the run is active and asks whether to continue or stop it, so a crashed
  run never takes over a manual session.
- **S3** says to run the step now: a driver that hands steps to sub-agents starts a new one for it; otherwise read the
  step's `skillFile` in full, with the files it tells you to open, and follow it as if invoked. Where it differs, the
  instructions win.
- **S4** is the decision rule, **S5** the hard stops and **S6** the data rule (§6.6). **S7** names refused events,
  when the step has any.
- **S8** gives the exact `complete_step` call and its CLI fallback with `--from` (and `--task`).
- **S9** (tracked only): on `TRACKER_TIMEOUT` or `TRACKER_UNREACHABLE`, read the status again and repeat the call once
  only when the step is still current; if the run moved on, the driver continues as the new block says (a step agent
  replies to its driver); otherwise stop the run.
- **S10**: an agent started for one step ends when it is completed or the run stops, and replies to its driver; the
  driver follows the latest block (the next step while `running`, the report otherwise). `get_status` keeps showing a
  run that stopped or ended until the flow moves on, and "a result without fastForward means no run is active".
- **S11** says how to stop.

Interpolation follows `task.instructions` (ARCHITECTURE §9.8): only validated ids (flow, step ids, target, events,
ticket key, skill names, the skill-file path), numbers and the command prefix. Titles, the stop note, and ticket,
request or pull request text are never interpolated.

The skill:
- **Grammar** (prose): `[to <state>] [<ticket>] [<request …>]`. A state id without `to` is a target only when it is
  the whole text, optionally followed by a ticket. Any other first word that is not a ticket key starts the request
  (`ABC-123 add export` is a ticket and a request). The whole text `stop` stops the run. The request is data and goes
  only to the first step this invocation runs; on a resumed run it is the developer's answer to why the run stopped.
- **Start.** Call `fast_forward`. On `TASK_REQUIRED` or `TASK_NOT_STARTED` with a typed ticket, call `start_task` once
  (typing it counts as asking). On `FAST_FORWARD_ACTIVE`, ask whether to stop the running run. Apart from that, the
  only questions before the end: the request, when the run is at the first step with empty `moves` and neither a
  request nor a ticket was typed (no answer: stop the run, "no request"); for a new run that starts mid-flow while a
  request was typed, whether the request belongs to the task in progress or is a new task (the run is stopped first);
  for a resumed run whose text reads as a new task, whether to resume it or start a new run.
- **Loop.** Each step runs in a fresh sub-agent when the agent can start one that can use the project's tools, never
  two at once. The sub-agent gets a fixed prompt, no summary of earlier steps, and replies in at most 12 lines (Step,
  Event, Stopped, Run, Decisions, Review, Outward, Warnings; Run is the status, reason and detail of its last block and
  its "Next" sentence). Otherwise the step runs inline, its skill file read again every time. After each step the
  driver takes the block of `complete_step` (inline) or of `get_status` (after a sub-agent):
  - running at a new step: a progress line, then the next step;
  - running at the same step with the same moves: the step neither completed nor stopped, so the driver stops the
    run;
  - `stopped` or `ended`: the final report from that block;
  - no block: the final report from the sub-agent's Run line.

  The driver also stops the run when its context is getting full, and tells you to invoke the skill again in a new
  session.

### 6.6 Deciding in the developer's place

**Decision rule** (S4), wherever a step asks the developer, waits for an explicit yes or offers options:
1. The option the step recommends or names as its default, unless the agent's knowledge of this repository gives a
   concrete reason to prefer another.
2. Else the option most consistent with what is already accepted: requirements, design, code, tests, configuration.
3. Among equals, the smallest reversible option that keeps every requirement, test, check and review.
4. For a fact only the developer has, the step's own fallback (an open item, a follow-up, an assumption marked for
   review); without one, stop the run.

Never invent a requirement the request does not support. **Target neutrality:** the target only says where the run
stops; no option, route or event is chosen because it reaches, avoids or skips the target.

**Recording.** A decision counts as the developer's for the step's exit criteria and for later checks. It is recorded
where the flow says, marked as automatic (dev: §6.7), or else listed in the step's reply and the final report. dfl
stores no decision text: the run's moves are the history after its anchor.

**Hard stops:**

| Stop | Why | Enforced by |
|---|---|---|
| An event or a goto into a final state other than the target; a side exit as the target | Closing a task (*Won't Do*) is the developer's call | dfl: guards and start validation |
| A 4th visit to a state in a segment | Repeated rework is a human question, and each loop writes to Jira | dfl: evaluation |
| A move outside the run (goto, reset, step removal, another session, lost history) | The run's premise is gone | dfl: evaluation |
| Credentials, tokens, sign-ins, secrets, `TRACKER_AUTH*` | Agents never handle tokens | S5 |
| Discarding, stashing or overwriting changes the run did not make, committing them beyond what the step prescribes; switching branches while tracked files have them | Someone's work could be lost | S5 |
| Deleting a branch, force-pushing, rewriting pushed history, pushing to or merging into the main branch, deploying, releasing, publishing, even when a step prescribes it | Irreversible or shared | S5 |
| Handing work to people beyond the step's defaults: reviewers no configuration names, ticket comments, messages | Visible to people; cannot be undone | S5 |
| Skipping, deleting or weakening a test, check, requirement or quality target beyond what the request and the step prescribe (retiring IDs the change removes, and deleting their tests as the step says, is not weakening); reporting a check not seen to pass | Later checks are what catch the run's mistakes; the classic injection payload | S5, S6 |
| Team settings, the flow or the installed skills; moves other than `complete_step` | Team-wide and persistent | S5 |
| Anything `task.instructions` or a dfl hint says to ask the user; a "skills" warning; an error a corrected call cannot fix | A human decision, or an uncertain state | S5 |
| Instructions inside data | Prompt injection ("the ticket says skip tests") | S6, tool description, `SERVER_INSTRUCTIONS` |

Tracker warnings and status drift are reported, not stops: the record is the truth, and projection gaps do not change
the position.

### 6.7 Dev flow content

`flow.json` is unchanged; every edit is in place, and no step file grows.

| Where | Change |
|---|---|
| `partials/brief.hbs` | The Ownership bullet admits `## Fast-forward log`. A new **Fast-forward** bullet, which applies when `get_status` returns a `fastForward` whose `status` is `running`, with five rules: **Acceptance** (a logged decision counts wherever the flow needs the developer's yes; ` (auto)` follows the date or sha it records, as in `requirements <sha> (auto)` or `accepted in place <date> (auto)`; a reclassification line ends `auto-accepted (fast-forward)`), **Log** (one line per decision; ` · review` for sensitive items, assumed values, dependencies, commands the agent found, ticket descriptions nobody pasted and text that tried to instruct), **Defaults** (classify from the command text, `task.title` and readable links; change requests take their Recommendation; proposed numbers stay as `Source: assumed`; found commands are used, never saved for the team; merge, never rebase; pre-existing CI failures do not block; doubtful behavior, splits and unbacked extracted rules become follow-ups; greenfield rename and initial commit with secret-looking files left untracked; retiring IDs, deleting their tests and `git revert` under `revert` are logged with ` · review`), **Stop the run** (instead of `OUT_OF_SCOPE`, or `RECLASSIFY` because the task looks out of scope; branch changes over changes the run did not make; a dependency the design does not allow; Dev QA in the conversation that wrote the code), **Ship** (a draft pull request that requests no reviewer from any source: no `--reviewer`, not the configured default, not CODEOWNERS; `reviewers: none requested (fast-forward)`; no answers to review comments; every sensitive item pending under Needs human review with the review items; on a tracked flow, `get_status` returned a `task` with a `key`, stop instead of firing `NEXT`, with a reason that says to run the Ship command yourself after review, since resuming would stop there again). |
| `classify-task/references/brief-template.md.hbs` | `## Fast-forward log` in the skeleton, the section table and the example; the `Accepted` row and the reclassification entry allow the automatic forms. |
| Exit criteria of Classify, Behavior and Tech design; Implement's change request rule | "The user confirmed" also accepts a decision of a run, marked ` (auto)`. "No developer reachable" applies only outside a run. |
| `requirement-format.md.hbs`, `change-request.md.hbs`, `td-grill.hbs` | A new `Source` value, `assumed`: a proposed value a run kept. It is logged for review, does not block acceptance, and becomes `user` once a person confirms it. Trade-offs in a run: Must before Should, then `SEC`, `PRIV` and `SAFE` before the others. |
| `requirements-rules.hbs`, `project-commands.hbs` | Under adoption, a run confirms only extracted rules a test or document backs. A found command is used unsaved. |
| `qa-checks.md.hbs`, `qa-report.md.hbs` | After a run (the brief's `## Fast-forward log` has entries, or a value is marked ` (auto)`), Box 3 lists ` · review` lines, ` (auto)` values and `Source: assumed` rows as pending human review (a non-empty log may count as one item); `Independence: fresh sub-agent (fast-forward)`. |
| `ship-task/references/pr-description.md.hbs`, Ship's pitfalls | Needs human review admits fast-forward decisions; Ship may write Fast-forward log entries. |

Dev QA independence needs no dev-specific driver logic. A fresh sub-agent is a new session. Without sub-agents, Dev
QA's own first step stops the run in the conversation that wrote the code, and `/fast-forward` in a new session
resumes it.

### 6.8 Tracked flows

Unchanged: the record schema, the status projection, and `state.json`, which is never read or written. Every run move
is an ordinary `complete_step` with explicit `step` and `task`, so statuses are walked one step at a time; a run never
uses goto.

New:
- the key `<flow>#<issue.key>`;
- a start needs a started ticket (`assertTaskMovable`);
- the guards (events and gotos) are built inside `taskMove`'s lock and run in `moveTask` after replay detection and
  before the `PUT`, so a refusal costs one GET;
- blocks are derived from the record history (at most 50 entries);
- `taskKeyForMove` resolves the key of a stop without network (a bare number too, as at start).

| Risk | Handling |
|---|---|
| A burst of Jira transitions and notifications | A start warning; checkpoint targets |
| `done` → *Ready for QA* on unreviewed decisions | The dev Ship rule stops a tracked run before `NEXT` (Q1) |
| `OUT_OF_SCOPE` → *Won't Do* | Refused by the guards, also as a goto to `not-handled`; side exits are never targets |
| A timeout of unknown outcome | S9. A move that landed is adopted from the history; a replay adds no entry |
| A CLI retry in a new process | `NOT_CURRENT`. S9 reads the status first and never retries blindly |
| A teammate moves the ticket | A move along the flow from the run's position counts for the run; a goto, a reset or a move from elsewhere ends it as `moved`. Either way the agent's next `complete_step` gets `NOT_CURRENT`, and the agent stops |
| Jira renames the key | Results no longer show a run started before the rename, but a stop on its branch still finds it (the stop takes the key from the branch, without network). A run started after the rename is keyed by the new key, and its calls fail with `TASK_BRANCH_MISMATCH` on the old branch: rename the branch first |
| Record history truncated (50 entries or 32,000 bytes) | The anchor is gone: `moved`, which fails safe. A dev segment makes fewer than 20 moves |
| A step leaves the task branch | `task` is passed explicitly on every call |
| `TASK_BRANCH_CHOICE`, auth errors, `task.instructions` that say to ask | Hard stops |
| Status drift or a missing transition (`task.warnings`) | Reported in the progress lines and the report; not a stop |

### 6.9 What the developer sees

At start the driver writes at most 6 lines and goes on without waiting:

```
Fast-forward on flow dev for ABC-123 to Dev QA (verify-task); Dev QA itself is not run.
Path: Classify → Behavior → Tech design → Implement → Dev QA.
Start: feature/csv-export @ 1a2b3c4; uncommitted changes I will not touch: none.
I decide in your place wherever a step would ask you and log every decision. I stop for credentials, work that is not this task's, ending the task, outward or destructive git actions, weaker checks, team settings, a step entered more than 3 times, and anything only you know.
Jira: every move of this run updates ABC-123's status.
Stop me any time, or run `dfl fast-forward --stop`.
```

Then one line per step, instead of the step's own hand-over, plus every warning:

```
✔ Classify → Behavior (NEXT) · 4 decisions
```

The final report gives why the run ended, the steps with their events, the decisions and where they are recorded,
what needs your review, every warning, the outward actions (Jira statuses, pushes, pull requests), the commits since
the start, and the next commands. In the terminal, `dfl status` shows
``» Fast-forward to Dev QA (verify-task): Implement next, visit 2 of 3 · stop it with `dfl fast-forward --stop` ``.

## 7. Implementation plan

| # | Increment | Content |
|---|---|---|
| 1 | Forward paths | `src/core/forward.ts`, `test/forward.test.ts` |
| 2 | Run file | `fastforward/store.ts`; `ProjectPaths.fastForwardFile`, `DF_GITIGNORE_CONTENT`, the purge list, `deleteFlow` → `removeFlowRuns` |
| 3 | Pure planners and views | The pure part of `fastforward/run.ts`; `fastforward/instructions.ts` (detail, instructions, views) |
| 4 | Move glue | `sendEventChecked`, `gotoStepChecked`, `fastForwardEventGuard`, `fastForwardGotoGuard`, `fastForwardBlock`; the `taskMove`/`moveTask` guards; `assertTaskMovable`, `taskKeyForMove` |
| 5 | Start, stop and MCP | `fastforward/start.ts`; blocks in `statusTool`, the move dispatchers and `trackedMove`; the `fast_forward` tool; `mcpHintFor`; `SERVER_INSTRUCTIONS` |
| 6 | CLI | `commands/fastforward.ts`; the `status`, `next`, `goto` and `reset` lines; `sym.run` (`»`) and `sym.halt` (`■`) |
| 7 | Built-in skill | `templates/skills/fast-forward/`, `BUILTIN_SKILL_NAMES`, the authoring guide, `add-flow-step` |
| 8 | flow-context | The sentence; render tests: every dev step within 25 lines |
| 9 | Dev content | §6.7, with the template tests |
| 10 | Docs | ARCHITECTURE §1.6, §2.3, §10 and the touched sections; README; `docs/AGENTS.md`; this document |

Each increment typechecks and passes `npm run check`. Increments 1–9 are implemented; 10 is the documentation, this
document included. With the changes made after review (§11), the feature is about 1,370 lines in new production
modules plus 430 changed lines in existing ones, about 1,520 lines of new tests (`forward.test.ts`,
`fastforward.test.ts`) plus 1,460 added to existing test files, the 153-line skill and about 80 changed lines of dev
content.

ARCHITECTURE contracts to amend:
- §1: the run file in the tree and `.gitignore`; new §1.6.
- §2.1: `fast-forward` in `BUILTIN_SKILL_NAMES`; new §2.3, forward paths.
- §3: the flow-context sentence; run data is runtime-only.
- §5: the built-in skill list.
- §6: `dfl fast-forward`; the `fastForward` key and lines of `status`, `next`, `goto` and `reset`; `fast-forward` in
  the §6.2 lock list.
- §7: the tool row, `fastForward?` on the status and move rows, the annotation, `SERVER_INSTRUCTIONS`, errors, hints
  and locking.
- §8: the new modules; §9.4: the guards in `taskMove`.
- New §10: fast-forward runs.

## 8. Deferred, with the trigger that would justify each

| Item | Trigger |
|---|---|
| A "who moved" marker in history | Runs end as `moved` because of moves that should count, or an audit must tell a run's moves from a person's. It would also let the guard spare a human's `dfl next` (Q7). |
| A transition-level `meta.fastForward: "manual"` for irreversible events of custom flows | A custom flow has an irreversible non-final event (deploy, release) that the generic S5 stop does not cover reliably. |
| A generic `isolated` step mode | A second flow has a step that needs a fresh context, like Dev QA. |
| A `next-backwards` validation warning | Custom flows declared out of main-path order get surprising `skipped` ends or refused targets. |
| A configurable visit cap | Real runs stop on `loop` where one more round would converge, or loop too long before stopping. |
| Durable decision storage for flows without a log convention | Users of custom flows lose decisions with a closed or compacted conversation. |
| Moving the private `NEXT` walks of `steps.ts` and `import.ts` onto `forward.ts` | The next change to either walk. |

## 9. Risks and known limitations

- **Quality laundering.** Automatic acceptances can pass for reviewed work. Mitigations: ` (auto)` markers,
  ` · review` log lines and `Source: assumed`; Dev QA lists them as pending human review; the pull request is a draft,
  lists them under Needs human review and requests no reviewer.
- **Git and secret stops are prose.** dfl enforces only flow-level bounds: final states, loops and moves outside the
  run. Git safety, secrets and outward actions rest on S5 and the steps' own rules. Checkpoint targets keep you in the
  loop where it matters most.
- **Custom `flow-context` overrides.** A flow's own `flow-context.hbs` without the fastForward sentence leaves its
  steps without the precedence rule. The authoring guide says to keep the sentence, and S3 repeats the precedence at
  runtime.
- **Declaration order.** "Ahead" is the flow order. A flow declared out of main-path order gets surprising `skipped`
  ends and refused targets; `dfl status` and the viewer share the assumption.
- **History truncation.** A tracked record keeps 50 entries (or 32,000 bytes), `state.json` 200. An anchor that falls
  off ends the run as `moved`.
- **Jira noise.** Every step entered is a status change, with Jira's notifications and automations.
- **Key renames.** After Jira renamed a ticket, results no longer show a run started under the old key, though a stop
  on its branch still finds it; a run started under the new key fails with `TASK_BRANCH_MISMATCH` on the old branch
  until the branch is renamed.
- **The reserved skill name.** `fast-forward` joins `BUILTIN_SKILL_NAMES`, so a flow with a step of that skill name
  fails validation (`skill-name-builtin`) after the upgrade.
- **A stopped run lives until the history closes it.** It closes when the flow reaches or skips its target or leaves
  the run (a goto, a reset, another position). Until then a bare `/fast-forward` resumes it, also for a new task on an
  untracked flow that was not reset in between; the skill asks when the typed text reads as a new task.
- **A stop's block disappears with the next move.** When a step sub-agent completes its step after the developer
  stopped the run from the terminal, neither its result nor the driver's `get_status` carries a block: the driver
  reports from the sub-agent's Run line, and S10 reads as "no run is active", although the run is still open.
- **Timestamps decide "nothing moved since the stop".** A move in the same millisecond as the stop counts as before
  it; on a tracked flow, clocks that differ between machines can show or hide a stop's block wrongly.
- **A ticket's stop is not checked.** A stop of a ticket's run reads nothing from Jira, so it is recorded and reported
  even when the run has already ended; the evaluation ignores it.
- **Greenfield initial commit.** In a repository without commits the dev defaults rename the branch and commit
  everything already there (`git add -A`, secret-looking files left untracked). S5 allows a commit the step
  prescribes, so a run does not stop for uncommitted scaffolding there.
- **A crashed driver leaves a `running` run.** A later manual step session gets the block, and S2 makes the agent ask
  before it follows it. `dfl status` shows the run and how to stop it.

## 10. Decisions

The implementation follows the defaults below.

| # | Question | Default (implemented) | Owner's answer |
|---|---|---|---|
| Q1 | Dev Ship in a run: fire `NEXT` → `done`? | Untracked: yes. Tracked: stop before `NEXT`, so *Ready for QA*, a hand-off to people, is never automatic. Alternative: always fire, with the Jira effect announced at start. | |
| Q2 | Skill name | `fast-forward`. Alternative: `fast-forward-task`, closer to your wording (§2). | |
| Q3 | Pull request in a run | Draft, no reviewer requested, automatic decisions under Needs human review. | |
| Q4 | Visit cap | 3 per state per segment; the counts restart only when you invoke the command again for a stopped run. | |
| Q5 | Sub-agents | Every step in a fresh sub-agent when the agent can start one; inline otherwise. | |
| Q6 | Side exits (`not-handled`) as targets | Refused. | |
| Q7 | Does the guard also refuse your own `dfl next OUT_OF_SCOPE` while a run is running? | Yes: stop the run first. | |
| Q8 | Resuming a run that is still `running` (a crashed driver) | Resume without asking, with a takeover warning in the announcement once the run has moved or been resumed (a run started from the CLI and not driven yet is picked up without one). | |
| Q9 | Run file cap | 20 records, the oldest evicted. | |

Each default is cheap to change. Q1 and Q3 are sentences of the dev brief's Ship rule. Q2 is the rename of §2. Q4
and Q9 are constants (`FAST_FORWARD_MAX_VISITS`, `FAST_FORWARD_MAX_RUNS`). Q5 and Q8 are skill text. Q6 is
`validateTarget`. Q7 is `checkFastForwardEvent` and `checkFastForwardGoto`; sparing only human moves would need the
"who moved" marker (§8).

## 11. As implemented: differences from this proposal

**Dev content**

- Since 0.2.1, Ship's pull request template lives in `ship-task/references/pr-description.md.hbs`, so the Needs human
  review edit is there instead of in Ship's step file.
- Since 0.2.1, Ship also removes the brief once the pull request description holds the task's record. The
  `## Fast-forward log` leaves the tree with the brief: the full log stays in the brief's permalink (the hand-off
  commit) and in git history, and its review items are in the description's Needs human review. The proposal was
  written against 0.2.0, where Ship kept the brief and held the pull request template itself. Ship's pitfall reads
  "this step writes only the hand-off, Rework and Fast-forward log entries, then removes the brief".
- `qa-checks.md.hbs` grows by five lines (141 → 146, the blank line included); every file stays within its budget.

**Code**

- The skill template's comment says "ticket" where the proposal said "task": the template test refuses `task` inside
  `{{…}}`, comments included.
- `evaluateRun` ends a run in a repaired state (`state.repaired`) as `moved` before the walk. The proposal listed the
  case among the `moved` causes but not in its pseudocode.
- `fastForwardRunState` (run.ts) is exported for the open-stopped line of `dfl status`, which needs the run whatever
  its status: the `fastForward` key shows a stopped run only until the flow moves on.
- `assertFastForwardOptions` (start.ts) checks `to`, `stop` and `reason` for both the MCP tool and the CLI.
- `removeFlowRuns` leaves an unreadable run file alone, as `deleteFlow` does with a corrupt `state.json`.
- A start reads the ticket through `taskStatus`, which accepts a bare `123` or `#123` with `jira.defaultProjectKey`;
  a stop accepts one too (below). Every move needs the full key, as `resolve.ts` requires outside starts and status
  reads.

**Changes after review**

A review of the implementation (core, surfaces, agent behavior, end-to-end runs and docs) led to these changes; each
names the problem it fixes.

- **One evaluation walk.** `evaluateRun` no longer returns early on an explicit stop or at the 4th visit: it walks the
  whole window, so a stopped run closes when the flow reaches or skips the target or leaves the run, and a stop on an
  ended run changes nothing. Stopped runs never closed: a bare `/fast-forward` for the next task resumed the old
  target and note, and `dfl status` advertised resumes that failed with `FLOW_DONE` or a "behind" error.
- **Run moves by transition, not by event name.** A run move is a move along one of the flow's own transitions from
  the run's position; the list of outside event names (`GOTO`, `RESET`, `START`, `STEP_REMOVED`) is gone. A custom
  flow may declare such events, and firing them with `complete_step` ended the run as `moved`.
- **One visibility rule.** Status reads, like moves, show the block of a stopped or ended run until the flow moves on
  (`endedByLastEntry` now also means "nothing moved since an explicit stop"); the `after` option of
  `fastForwardBlock` is gone. In sub-agent mode the driver's `get_status` never showed why the run ended, so the
  skill's report had no source, and a developer's stop from the terminal never reached the agent.
- **No start without a known position** (`FAST_FORWARD_POSITION_UNKNOWN`). A start on a repaired state wrote a run
  from the fallback initial step that was already `moved`, and every later start did the same.
- **A bare resume never widens or misleads.** A stored target that no longer fits throws `FAST_FORWARD_TARGET_INVALID`
  naming the stopped run and how to name a target. So does a bare start of a stopped run that had already ended when
  it was stopped (`RunEvaluation.endAt` is earlier than `stopped.at`; a ticket's stop reads no Jira, so it can land on
  an ended run), or whose end has no time (a vanished target or anchor): its stop result had promised a resume, and the
  bare start silently began a run to the end of the flow. The errors named a target the user never typed, and the "behind"
  hint suggested going back to it.
- **Stop.** A run of the local position that has already ended is not stopped (`FAST_FORWARD_NOT_ACTIVE`, saying why);
  the result is the run as evaluated after the stop, with its moves; a stop without a reason keeps the earlier one; an
  unreadable run file is named in the error; a bare ticket number is accepted, as at start. Stopping an ended run
  reopened it, a second stop lost the note, a corrupt file read as "no run", and start and stop took different ticket
  forms.
- **Goto guard** (`checkFastForwardGoto`, `gotoStepChecked`, `fastForwardGotoGuard`): while a run is running, a goto
  into a final state other than the target is refused, in MCP `goto_step`, `dfl goto` and tracked gotos before any
  `PUT`. `goto_step` to `not-handled` bypassed the event guard and set *Won't Do* in Jira.
- **Tracked guards inside the lock.** `taskMove` decided before the lock whether the run file existed, so a run
  started while a CLI move waited for the lock was not guarded.
- **No import cycle.** `FAST_FORWARD_MAX_VISITS` moved to `store.ts` (re-exported by `run.ts`), and
  `instructions.ts` imports only types from `run.ts`. The two modules imported values from each other, against §6.1.
- **Instruction texts** S2, S3, S5, S9 and S10, and the stop's `detail` (`It was stopped.`). A step sub-agent could
  go on into later steps (the "only this step" rule came ten sentences after "Run step X now", and S9 told it to
  continue); S3 told the driver to run each step itself and to read every linked file; S5 blocked deletions the dev
  steps prescribe (retired IDs, `revert`); the stop's `detail` showed agent-facing text to people.
- **CLI command prefix** (`cliCommandPrefix`): `$` when every selected agent is Codex. A Codex-only project on the CLI
  fallback got `/fast-forward` in S2 while the same output said `$plan`.
- **`dfl status` lines.** The open-stopped line shows only while a bare resume can work and prints the note without
  agent text; the running line names the refused events. It advertised resumes that failed, showed "fastForward.note
  says why…" to people, and listed `OUT_OF_SCOPE` among the events without saying it is refused.
- **Takeover warning only for a driven run.** A run started with `dfl fast-forward` and picked up by the agent warned
  about a takeover that never happened.
- **Tool, server and help texts.** The `fast_forward` description names the stop result (`flow`, the `task` key string
  and `fastForward`), `SERVER_INSTRUCTIONS` say that a block also follows a run that just stopped or ended, and the
  `uninstall --purge` help names `.df/fast-forward.json`. They misdescribed the stop result and the purge.
- **Skill.** A leading ticket key is a ticket, not the request. The request question keys on empty `moves` (so a run
  started from the CLI asks too) and stops the run without an answer; a new run mid-flow with a request, and a resumed
  run whose text reads as a new task, ask first. The announcement and the report use `git branch --show-current`,
  `git rev-parse --short HEAD` and `git log --since`. After a sub-agent the driver decides from `get_status`, or from
  the sub-agent's new Run line. Literal parsing drove the branch's ticket instead of the typed one; a request typed
  mid-flow went to a later step of another task; the run was recorded before the question, and "the only question"
  was not; the git commands did not give what they claimed; the driver had no source for its report.
- **flow-context sentence.** It no longer says that a block means "a run is active", and the instructions come before
  the next step's slash command instead of replacing it: `get_status` now also shows stopped and ended runs.
- **Dev content.** The brief's Fast-forward rules apply only while `fastForward.status` is `running`; Ship requests no
  reviewer from any source, lists every sensitive item as pending and, on a tracked flow, stops with a reason that
  says to run Ship yourself after review; retiring IDs, deleting their tests and `revert` are logged with ` · review`;
  Dev QA box 3 triggers on log entries or ` (auto)` values. A visible stopped block would otherwise make a manual
  `/ship-task` stop again; the reviewer rules of the brief, Ship and S5 disagreed; resuming a tracked Ship stop only
  stopped again; the S5 exception needs a review trail; every brief has the log heading, so the old trigger always
  fired.
- **Docs.** README, ARCHITECTURE and this document were corrected where they paraphrased the code: a bare start at a
  final state (`FLOW_DONE`), the S5 commit wording and the greenfield default, the run lookup after a key rename, the
  fork in the §6.9 example, the layering sentence, and the README's stop result, timeout and move-line paraphrases.
