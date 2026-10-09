/**
 * Fast-forward runs: whether a run goes on, where it may start, and which moves it refuses
 * (docs/ARCHITECTURE.md §10). The run file (store.ts) holds only intent: the target, where the
 * current segment started and an explicit stop. Progress is derived from the flow history after the
 * segment's anchor, so moves never write the run file and replays count once. A move along one of
 * the flow's own transitions from the run's position is a run move, whoever made it; anything else
 * (a goto, a reset, a restart, a step removal, a move from another position, a repaired state,
 * history lost past the anchor) ends the run as `moved`.
 *
 * The planners are pure. The I/O glue (`sendEventChecked`, `gotoStepChecked`, the guards,
 * `fastForwardBlock`) reads the run file and never throws, except the guards' refusals and the
 * errors of the move itself. Without `.df/fast-forward.json` it costs one `exists` call and
 * changes nothing, so results stay byte-identical when no run was ever started.
 */
import { DflError, isDflError } from '../errors.js';
import { getStep } from '../flow.js';
import { flowEnd, forwardReachable } from '../forward.js';
import { gotoStep, loadRuntimeState, sendEvent } from '../machine.js';
import { exists } from '../fsx.js';
import type { FlowModel, FlowRuntimeState, HistoryEntry, ProjectPaths, TransitionResult } from '../types.js';
import { fastForwardDetail, fastForwardView, type FastForwardView } from './instructions.js';
import { FAST_FORWARD_MAX_VISITS, readFastForwardRun, runKey, type FastForwardRun } from './store.js';

export { FAST_FORWARD_MAX_VISITS } from './store.js';

/** `running`; `stopped` (open: a bare start resumes it); `ended` (closed: a bare start begins a new run). */
export type FastForwardStatus = 'running' | 'stopped' | 'ended';
/** `ended`: reached, skipped, moved; `stopped`: loop, stopped (explicit). */
export type FastForwardReason = 'reached' | 'skipped' | 'loop' | 'moved' | 'stopped';

export interface RunEvaluation {
  status: FastForwardStatus;
  /** Undefined while running. */
  reason?: FastForwardReason | undefined;
  /** Running: the current step; loop: where the visit limit was passed; else where the walk stopped (`state.current` for moved and stopped). */
  at: string;
  /** Running only: how often `at` became current in this segment. */
  visit?: number | undefined;
  /** Window entries accepted as run moves, the ending one included (`{from, to, event, at}` only). */
  moves: HistoryEntry[];
  /**
   * The run's last word is current: the last history entry ended or stopped it, or nothing moved
   * since an explicit stop. Results show the block of a run that is not running only then.
   */
  endedByLastEntry: boolean;
  /** `ended`: the `at` of the history entry that ended the run, when one did. */
  endAt?: string | undefined;
}

export interface FastForwardStartPlan {
  run: FastForwardRun;
  /** False only when an already running run is resumed (nothing to store). */
  write: boolean;
  resumed?: { after: 'running' | 'stopped' | 'loop'; note?: string | undefined } | undefined;
}

// ---------------------------------------------------------------------------
// Pure planners
// ---------------------------------------------------------------------------

/**
 * Where `run` stands in `state`: one walk over the history entries after the segment's anchor,
 * starting at `run.from`. A run move is a move along one of the flow's own transitions from the
 * run's position, whoever made it (a flow's own events named GOTO, RESET or START count too).
 * Reaching the target (`reached`), a position it cannot be reached from going forward (`skipped`)
 * and any other entry (`moved`) end the run, also after an explicit stop or the visit limit: a
 * stopped run stays open while the moves after the stop head for the target. Reaching the target
 * wins over the visit limit; a stop recorded on a run that had already ended changes nothing.
 */
export function evaluateRun(model: FlowModel, run: FastForwardRun, state: FlowRuntimeState): RunEvaluation {
  const moved = (moves: HistoryEntry[], last: boolean, by?: HistoryEntry): RunEvaluation => ({
    status: 'ended',
    reason: 'moved',
    at: state.current,
    moves,
    endedByLastEntry: last,
    ...(by ? { endAt: by.at } : {}),
  });
  if (!model.byId.has(run.target) || !model.byId.has(run.from) || state.repaired !== undefined) return moved([], false);
  const window = entriesAfter(state.history, run.anchor);
  if (!window) return moved([], false);

  let pos = run.from;
  const visits = new Map<string, number>([[pos, 1]]);
  const moves: HistoryEntry[] = [];
  // Set by the explicit stop, or by the first visit past the limit; the walk goes on either way.
  let halt: { kind: 'stopped' } | { kind: 'loop'; at: string; index: number } | undefined = run.stopped ? { kind: 'stopped' } : undefined;
  for (const [i, entry] of window.entries()) {
    const last = i === window.length - 1;
    if (!isRunMove(model, pos, entry)) return moved(moves, last, entry);
    pos = entry.to;
    moves.push(last4(entry));
    if (pos === run.target) return { status: 'ended', reason: 'reached', at: pos, moves, endedByLastEntry: last, endAt: entry.at };
    if (!forwardReachable(model, pos).has(run.target)) {
      return { status: 'ended', reason: 'skipped', at: pos, moves, endedByLastEntry: last, endAt: entry.at };
    }
    if (!halt) {
      const visit = (visits.get(pos) ?? 0) + 1;
      visits.set(pos, visit);
      if (visit > FAST_FORWARD_MAX_VISITS) halt = { kind: 'loop', at: pos, index: i };
    }
  }
  if (pos !== state.current) return moved(moves, false);
  if (halt?.kind === 'loop') {
    return { status: 'stopped', reason: 'loop', at: halt.at, moves, endedByLastEntry: halt.index === window.length - 1 };
  }
  if (halt?.kind === 'stopped') {
    const stoppedAt = run.stopped!.at;
    return { status: 'stopped', reason: 'stopped', at: state.current, moves, endedByLastEntry: !window.some((entry) => entry.at > stoppedAt) };
  }
  return { status: 'running', at: pos, visit: visits.get(pos) ?? 1, moves, endedByLastEntry: false };
}

/**
 * Throws unless a run from `current` may stop at `target`: `FLOW_DONE` (the flow is at a final
 * state), `STEP_NOT_FOUND`, or `FAST_FORWARD_TARGET_INVALID` (a side exit, the current step, a step
 * behind it, or one that cannot be reached going forward).
 */
export function validateTarget(model: FlowModel, current: string, target: string): void {
  const here = model.byId.get(current);
  if (here?.final) throw flowDoneError(model, current);
  const step = getStep(model, target);
  const end = flowEnd(model);
  const invalid = (message: string, hint: string): DflError => new DflError(message, { hint, code: 'FAST_FORWARD_TARGET_INVALID' });
  if (step.final && target !== end) {
    throw invalid(
      `"${target}" is not the end of flow "${model.name}": a fast-forward run never ends a flow at another final state.`,
      `Target a step${end !== undefined ? `, or the end of the flow ("${end}")` : ''}; fire the exit's event yourself when it applies.`,
    );
  }
  if (target === current) {
    throw invalid(`Step "${target}" is already the current step of flow "${model.name}".`, 'Run the step yourself, or name a target further ahead.');
  }
  if (here && step.index < here.index) {
    throw invalid(
      `Step "${target}" is behind the current step "${current}" of flow "${model.name}": a fast-forward run only moves forward.`,
      `Going back is your decision: \`dfl goto ${target}\`, then start the run again.`,
    );
  }
  const reachable = forwardReachable(model, current);
  if (!reachable.has(target)) {
    const ahead = model.steps.filter((s) => s.id !== current && reachable.has(s.id) && !(s.final && s.id !== end)).map((s) => s.id);
    throw invalid(
      `Step "${target}" cannot be reached going forward from the current step "${current}" of flow "${model.name}".`,
      `States ahead: ${ahead.length > 0 ? ahead.join(', ') : 'none'}.`,
    );
  }
}

/**
 * Starts or resumes a run in `state` (pure; `existing` is the stored run of the key, if any):
 * - a running run with the same or no target is resumed as it is (`write: false`, counts kept);
 *   another target → `FAST_FORWARD_ACTIVE`;
 * - an open (stopped) run with the same or no target gets a new segment from the current step
 *   (`FAST_FORWARD_TARGET_INVALID` naming the stopped run when its stored target no longer fits a
 *   bare resume: never widened silently);
 * - otherwise a new run to `to`, else the end of the flow (`FAST_FORWARD_TARGET_REQUIRED` without one).
 * Throws `FLOW_DONE`, `FAST_FORWARD_POSITION_UNKNOWN` (a repaired state: the current step is not
 * known), `STEP_NOT_FOUND` and the errors of {@link validateTarget}.
 */
export function planFastForwardStart(
  model: FlowModel,
  state: FlowRuntimeState,
  existing: FastForwardRun | undefined,
  args: { to?: string | undefined; task: string | null; now: string },
): FastForwardStartPlan {
  if (state.done) throw flowDoneError(model, state.current);
  if (state.repaired !== undefined) {
    throw new DflError(`Flow "${model.name}" has no known current step to fast-forward from: ${state.repaired}`, {
      hint: 'Move the flow to the step you are at (`dfl goto <step>`), then start the run again.',
      code: 'FAST_FORWARD_POSITION_UNKNOWN',
    });
  }
  if (args.to !== undefined) getStep(model, args.to);
  const ev = existing ? evaluateRun(model, existing, state) : undefined;
  if (existing && ev?.status === 'running') {
    if (args.to === undefined || args.to === existing.target) return { run: existing, write: false, resumed: { after: 'running' } };
    const task = existing.task;
    throw new DflError(`A fast-forward run to "${existing.target}" is already running on flow "${model.name}"${task ? ` for ${task}` : ''}.`, {
      hint: `Stop it first (\`dfl fast-forward --stop --flow ${model.name}${task ? ` --task ${task}` : ''}\`) if you want the new target.`,
      code: 'FAST_FORWARD_ACTIVE',
    });
  }
  if (args.to === undefined && existing?.stopped && ev?.status === 'ended') assertNotEndedBeforeStop(model, existing, ev);
  const open = existing && ev?.status === 'stopped' ? existing : undefined;
  const target = args.to ?? (open ? open.target : flowEnd(model));
  if (target === undefined) throw targetRequiredError(model);
  if (args.to === undefined && open) validateStoredTarget(model, state.current, open.target);
  else validateTarget(model, state.current, target);
  const lastEntry = state.history.at(-1);
  const segment = { from: state.current, anchor: lastEntry ? last4(lastEntry) : null };
  if (open && target === open.target) {
    const { resumedAt: _resumedAt, stopped, ...rest } = open;
    const note = stopped?.reason;
    return {
      run: { ...rest, ...segment, resumedAt: args.now },
      write: true,
      resumed: { after: ev?.reason === 'loop' ? 'loop' : 'stopped', ...(note !== undefined ? { note } : {}) },
    };
  }
  return { run: { flow: model.name, task: args.task, target, ...segment, startedAt: args.now }, write: true };
}

/**
 * The guard before every event move: while `run` is running, an event of the current step into a
 * final state other than the run's target throws `FAST_FORWARD_EVENT_REFUSED`. Anything else passes
 * (the move's own checks report `NOT_CURRENT`, `EVENT_NOT_ALLOWED` and the like). Writes nothing.
 */
export function checkFastForwardEvent(
  model: FlowModel,
  run: FastForwardRun | undefined,
  state: FlowRuntimeState,
  event: string,
  from?: string,
): void {
  if (!run) return;
  if (from !== undefined && from !== state.current) return;
  if (evaluateRun(model, run, state).status !== 'running') return;
  const transition = model.byId.get(state.current)?.transitions.find((t) => t.event === event);
  if (!transition || !model.byId.get(transition.target)?.final || transition.target === run.target) return;
  throw new DflError(
    `Event "${event}" of step "${state.current}" ends flow "${model.name}" at "${transition.target}", but the fast-forward run to ` +
      `"${run.target}" may end the flow only at its target.`,
    { hint: stopFirstHint(model, run), code: 'FAST_FORWARD_EVENT_REFUSED' },
  );
}

/**
 * The guard before every goto: while `run` is running, a goto into a final state other than the
 * run's target throws `FAST_FORWARD_EVENT_REFUSED`. A goto into any other step passes (it ends the
 * run as `moved`). Writes nothing.
 */
export function checkFastForwardGoto(model: FlowModel, run: FastForwardRun | undefined, state: FlowRuntimeState, step: string): void {
  if (!run) return;
  if (!model.byId.get(step)?.final || step === run.target) return;
  if (evaluateRun(model, run, state).status !== 'running') return;
  throw new DflError(
    `Going to "${step}" ends flow "${model.name}" there, but the fast-forward run to "${run.target}" may end the flow only at its target.`,
    { hint: stopFirstHint(model, run), code: 'FAST_FORWARD_EVENT_REFUSED' },
  );
}

// ---------------------------------------------------------------------------
// I/O glue for moves and views
// ---------------------------------------------------------------------------

/** {@link sendEvent} behind the fast-forward guard of the flow's local run (key = the flow name). */
export function sendEventChecked(paths: ProjectPaths, model: FlowModel, event: string, options: { from?: string | undefined } = {}): TransitionResult {
  const guard = fastForwardEventGuard(paths, model);
  guard?.(loadRuntimeState(paths, model), runKey(model.name), event, options.from);
  return sendEvent(paths, model, event, options);
}

/** {@link gotoStep} behind the fast-forward goto guard of the flow's local run (key = the flow name). */
export function gotoStepChecked(paths: ProjectPaths, model: FlowModel, step: string): TransitionResult {
  const guard = fastForwardGotoGuard(paths, model);
  guard?.(loadRuntimeState(paths, model), runKey(model.name), step);
  return gotoStep(paths, model, step);
}

/**
 * The guard for event moves of `model`: checks the run stored under `key` (read when called) against
 * the state before the move ({@link checkFastForwardEvent}). Undefined when no run file exists.
 */
export function fastForwardEventGuard(
  paths: ProjectPaths,
  model: FlowModel,
): ((state: FlowRuntimeState, key: string, event: string, from?: string) => void) | undefined {
  if (!exists(paths.fastForwardFile)) return undefined;
  return (state, key, event, from) => checkFastForwardEvent(model, readFastForwardRun(paths, key), state, event, from);
}

/**
 * The guard for gotos of `model`: checks the run stored under `key` (read when called) against the
 * state before the move ({@link checkFastForwardGoto}). Undefined when no run file exists.
 */
export function fastForwardGotoGuard(paths: ProjectPaths, model: FlowModel): ((state: FlowRuntimeState, key: string, step: string) => void) | undefined {
  if (!exists(paths.fastForwardFile)) return undefined;
  return (state, key, step) => checkFastForwardGoto(model, readFastForwardRun(paths, key), state, step);
}

/**
 * The run stored under `key` and its evaluation in `state`, whatever its status (e.g. for the
 * open-stopped line of `dfl status`). Undefined without a run file or a run; never throws.
 */
export function fastForwardRunState(
  paths: ProjectPaths,
  model: FlowModel,
  key: string,
  state: FlowRuntimeState,
): { run: FastForwardRun; evaluation: RunEvaluation } | undefined {
  try {
    const run = readFastForwardRun(paths, key);
    return run ? { run, evaluation: evaluateRun(model, run, state) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `fastForward` block of a result (a status read or a move): while the run is running, and
 * after it stopped or ended until the flow moves on (`endedByLastEntry`: the last history entry
 * ended or stopped it, or nothing moved since an explicit stop). Undefined otherwise, without a run
 * file or run, and on any error (a result never fails because of its block).
 */
export function fastForwardBlock(
  paths: ProjectPaths,
  model: FlowModel,
  key: string,
  state: FlowRuntimeState,
  opts: { prefix: '/' | '$' },
): FastForwardView | undefined {
  try {
    const found = fastForwardRunState(paths, model, key, state);
    if (!found) return undefined;
    const { run, evaluation } = found;
    const visible = evaluation.status === 'running' || evaluation.endedByLastEntry;
    return visible ? fastForwardView(model, run, evaluation, { prefix: opts.prefix }) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The entries after the last one equal to `anchor` (all four fields); all of them for null; undefined when it is gone. */
function entriesAfter(history: readonly HistoryEntry[], anchor: HistoryEntry | null): HistoryEntry[] | undefined {
  if (anchor === null) return [...history];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (entry.from === anchor.from && entry.to === anchor.to && entry.event === anchor.event && entry.at === anchor.at) return history.slice(i + 1);
  }
  return undefined;
}

/** A history entry with only its four fields. */
function last4(entry: HistoryEntry): HistoryEntry {
  return { from: entry.from, to: entry.to, event: entry.event, at: entry.at };
}

/** `entry` moved the flow from `pos` along one of the flow's own transitions (whoever fired it). */
function isRunMove(model: FlowModel, pos: string, entry: HistoryEntry): boolean {
  return entry.from === pos && (model.byId.get(pos)?.transitions.some((t) => t.event === entry.event && t.target === entry.to) ?? false);
}

/**
 * {@link validateTarget} for the stored target of a stopped run that a bare start resumes: its
 * errors become `FAST_FORWARD_TARGET_INVALID` naming the stopped run and how to name a target.
 */
function validateStoredTarget(model: FlowModel, current: string, target: string): void {
  try {
    validateTarget(model, current, target);
  } catch (error) {
    if (!isDflError(error)) throw error;
    const step = model.byId.get(target);
    const here = model.byId.get(current);
    const why = !step
      ? 'no longer exists'
      : target === current
        ? 'is already current'
        : here && step.index < here.index
          ? `is behind the current step "${current}"`
          : 'cannot be reached going forward';
    throw new DflError(`The stopped fast-forward run of flow "${model.name}" targets "${target}", which ${why}.`, {
      hint: 'Name a target: `dfl fast-forward <state>`, or "to <state>" after the fast-forward command.',
      code: 'FAST_FORWARD_TARGET_INVALID',
    });
  }
}

/**
 * A bare start after a stop the developer believes they can resume, on a run that had already ended
 * when it was stopped (a ticket's stop is recorded without reading Jira) or whose end has no time
 * (a vanished target or anchor): `FAST_FORWARD_TARGET_INVALID`, so its target is never silently
 * widened to the end of the flow. A run that ended after its stop (finished or moved by hand) is
 * closed as usual: a bare start begins a new run.
 */
function assertNotEndedBeforeStop(model: FlowModel, run: FastForwardRun, ev: RunEvaluation): void {
  if (ev.endAt !== undefined && run.stopped !== undefined && ev.endAt > run.stopped.at) return;
  const detail = fastForwardDetail({
    reason: ev.reason ?? 'moved',
    target: run.target,
    at: ev.at,
    targetFinal: model.byId.get(run.target)?.final ?? false,
    note: false,
    maxVisits: FAST_FORWARD_MAX_VISITS,
  });
  throw new DflError(
    `The stopped fast-forward run of flow "${model.name}" to "${run.target}" had already ended: ${detail.charAt(0).toLowerCase()}${detail.slice(1)}`,
    {
      hint: 'Name a target to start a new run: `dfl fast-forward <state>`, or "to <state>" after the fast-forward command.',
      code: 'FAST_FORWARD_TARGET_INVALID',
    },
  );
}

/** The hint of a refused move: stop the run first (with the proposal as the reason). */
function stopFirstHint(model: FlowModel, run: FastForwardRun): string {
  const task = run.task;
  return (
    `Stop the run first (\`dfl fast-forward --stop --reason "<your proposal>" --flow ${model.name}${task ? ` --task ${task}` : ''}\`), ` +
    'then fire the event only after the user agrees.'
  );
}

/** `FLOW_DONE` as planEvent throws it. */
function flowDoneError(model: FlowModel, current: string): DflError {
  return new DflError(`Flow "${model.name}" is already complete (final step "${current}").`, {
    hint: 'Run `dfl reset` to start over or `dfl goto <step>` to jump to a step.',
    code: 'FLOW_DONE',
  });
}

function targetRequiredError(model: FlowModel): DflError {
  const finals = model.steps.filter((step) => step.final).length;
  return new DflError(
    `Flow "${model.name}" has no end to fast-forward to: its NEXT path from "${model.initial}" reaches no final state, ` +
      `${finals === 0 ? 'and it has no final state' : `and it has ${finals} final states`}.`,
    {
      hint: 'Name the target: `dfl fast-forward <state>`, or "to <state>" after the fast-forward command.',
      code: 'FAST_FORWARD_TARGET_REQUIRED',
    },
  );
}
