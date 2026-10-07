/**
 * xstate runtime for flows (OWNER: flow-engine agent).
 *
 * Uses xstate v5 pure functions (`initialTransition`, `transition`, `machine.resolveState`)
 * – never long-running actors. Only `{ current, history, updatedAt }` is persisted per flow in
 * `.df/state.json` (see `StateFile`). The planners (`runtimeFromStored`, `planEvent`, `planGoto`,
 * `planReset`) do no I/O, so the same checks and history rules also apply to a position stored
 * elsewhere (a tracker record); `sendEvent`/`gotoStep`/`resetFlow` are load → plan → save.
 */
import {
  createMachine,
  initialTransition,
  transition,
  type AnyEventObject,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type MachineConfig,
  type MachineContext,
  type StateValue,
} from 'xstate';
import { DflError, errorMessage } from './errors.js';
import { NEXT_EVENT, getStep } from './flow.js';
import { exists, readJson, writeJson } from './fsx.js';
import type {
  FlowDefinition,
  FlowModel,
  FlowRuntimeState,
  FlowTransition,
  HistoryEntry,
  ProjectPaths,
  StateFile,
  TransitionResult,
} from './types.js';

/** Maximum number of history entries kept per flow. */
export const HISTORY_LIMIT = 200;
/** Event recorded in history by `gotoStep`. */
export const GOTO_EVENT = 'GOTO';
/** Event recorded in history by `resetFlow`. */
export const RESET_EVENT = 'RESET';
/**
 * Event recorded in history when the current step was removed (`dfl step remove`, or a `flow pull` /
 * `flow import --force` whose new version no longer has it) and the position moved (`moveCurrentInRuntime`).
 */
export const STEP_REMOVED_EVENT = 'STEP_REMOVED';

/** Builds an xstate machine from `def.machine` (plain JSON config, no setup()). Throws DflError on xstate errors. */
export function createFlowMachine(def: FlowDefinition): AnyStateMachine {
  const config = { ...def.machine, id: def.machine.id ?? def.name };
  try {
    return createMachine(config as unknown as MachineConfig<MachineContext, AnyEventObject>) as unknown as AnyStateMachine;
  } catch (error) {
    throw new DflError(`Flow "${def.name}" is not a valid state machine: ${errorMessage(error)}`, {
      hint: `Check .df/${def.name}/flow.json with \`dfl flow validate ${def.name}\`.`,
      code: 'INVALID_FLOW',
      cause: error,
    });
  }
}

/**
 * Current runtime state of `model` from `.df/state.json`. Missing entry → initial state.
 * If the stored `current` no longer exists in the machine, falls back to the initial state and
 * sets `repaired` to a human-readable explanation (the repaired state is NOT written back).
 */
export function loadRuntimeState(paths: ProjectPaths, model: FlowModel): FlowRuntimeState {
  const { file, problem } = readStateFile(paths);
  const state = runtimeFromStored(model, file.flows[model.name]);
  if (problem && !file.flows[model.name]) {
    state.repaired = `${problem}; flow "${model.name}" starts at its initial step "${state.current}".`;
  }
  return state;
}

/**
 * Runtime state of `model` from a stored position (`.df/state.json` entry, or a tracker record),
 * without I/O. `undefined` → the initial step with no history. A stored step that no longer exists
 * in the flow falls back to the initial step (history kept) and sets `repaired`.
 */
export function runtimeFromStored(
  model: FlowModel,
  stored: { current: string; history: HistoryEntry[]; updatedAt: string } | undefined,
): FlowRuntimeState {
  const machine = createFlowMachine(model.def);
  const history = stored?.history ?? [];
  const updatedAt = stored?.updatedAt ?? new Date().toISOString();

  if (stored) {
    const snapshot = model.byId.has(stored.current) ? tryResolve(machine, stored.current) : undefined;
    if (snapshot) return runtimeState(model.name, snapshot, history, updatedAt);
  }

  const initial = initialSnapshot(machine, model);
  const state = runtimeState(model.name, initial, history, updatedAt);
  if (stored) {
    state.repaired =
      `Step "${stored.current}" no longer exists in flow "${model.name}"; ` +
      `falling back to the initial step "${state.current}".`;
  }
  return state;
}

/** Persists the runtime state of one flow into `.df/state.json` (other flows are preserved; history capped at 200). */
export function saveRuntimeState(paths: ProjectPaths, state: FlowRuntimeState): void {
  const { file } = readStateFile(paths);
  file.flows[state.flow] = {
    current: state.current,
    history: state.history.slice(-HISTORY_LIMIT),
    updatedAt: state.updatedAt,
  };
  writeJson(paths.stateFile, file);
}

/** Outgoing transitions of a step (from the model; declaration order). */
export function availableEvents(model: FlowModel, stepId: string): FlowTransition[] {
  return getStep(model, stepId).transitions;
}

/**
 * Fires `event` (default `NEXT`) from the current state using xstate `transition()`.
 * If `options.from` is given it must equal the current state (else DflError code `NOT_CURRENT`).
 * Throws DflError code `EVENT_NOT_ALLOWED` (listing allowed events) when the event is not handled,
 * or `FLOW_DONE` when the flow is in a final state. Persists and returns the result.
 */
export function sendEvent(
  paths: ProjectPaths,
  model: FlowModel,
  event: string = NEXT_EVENT,
  options: { from?: string | undefined } = {},
): TransitionResult {
  return persist(paths, planEvent(model, loadRuntimeState(paths, model), event, options));
}

/** Jumps to any existing state (records event `GOTO` in history). Throws DflError `STEP_NOT_FOUND`. */
export function gotoStep(paths: ProjectPaths, model: FlowModel, stepId: string): TransitionResult {
  getStep(model, stepId);
  return persist(paths, planGoto(model, loadRuntimeState(paths, model), stepId));
}

/** Resets the flow to its initial state (records event `RESET`). */
export function resetFlow(paths: ProjectPaths, model: FlowModel): FlowRuntimeState {
  return persist(paths, planReset(model, loadRuntimeState(paths, model))).state;
}

/**
 * The outcome of firing `event` (default `NEXT`) in `state`, without I/O (the checks and errors of
 * {@link sendEvent}: `STEP_NOT_FOUND`/`NOT_CURRENT` for `options.from`, `FLOW_DONE`,
 * `EVENT_NOT_ALLOWED`). The new state has the history entry appended (capped) and `updatedAt` = now.
 */
export function planEvent(
  model: FlowModel,
  state: FlowRuntimeState,
  event: string = NEXT_EVENT,
  options: { from?: string | undefined } = {},
): TransitionResult {
  if (options.from !== undefined && options.from !== state.current) {
    getStep(model, options.from);
    throw new DflError(`Step "${options.from}" is not the current step of flow "${model.name}" (current: "${state.current}").`, {
      hint: 'Check the current step with `dfl status` (or the get_status MCP tool).',
      code: 'NOT_CURRENT',
    });
  }
  if (state.done) {
    throw new DflError(`Flow "${model.name}" is already complete (final step "${state.current}").`, {
      hint: 'Run `dfl reset` to start over or `dfl goto <step>` to jump to a step.',
      code: 'FLOW_DONE',
    });
  }

  const machine = createFlowMachine(model.def);
  const snapshot = resolveSnapshot(machine, model, state.current);
  const [next] = transition(machine, snapshot, { type: event });
  // A handled self-transition also returns the same snapshot object, hence the `can()` check.
  if (next === snapshot && !snapshot.can({ type: event })) {
    const allowed = availableEvents(model, state.current);
    throw new DflError(`Event "${event}" is not allowed in step "${state.current}" of flow "${model.name}".`, {
      hint:
        allowed.length > 0
          ? `Allowed events: ${allowed.map((t) => `${t.event} → ${t.target}`).join(', ')}.`
          : `Step "${state.current}" has no outgoing transitions; use \`dfl goto <step>\` to move on.`,
      code: 'EVENT_NOT_ALLOWED',
    });
  }
  return advance(model, state, next, event);
}

/** The outcome of jumping from `state` to `stepId` (event `GOTO`), without I/O. Throws DflError `STEP_NOT_FOUND`. */
export function planGoto(model: FlowModel, state: FlowRuntimeState, stepId: string): TransitionResult {
  getStep(model, stepId);
  const machine = createFlowMachine(model.def);
  return advance(model, state, resolveSnapshot(machine, model, stepId), GOTO_EVENT);
}

/** The outcome of resetting `state` to the initial step (event `RESET`), without I/O. */
export function planReset(model: FlowModel, state: FlowRuntimeState): TransitionResult {
  const machine = createFlowMachine(model.def);
  return advance(model, state, initialSnapshot(machine, model), RESET_EVENT);
}

/** Renames a state inside `.df/state.json` (used when a step is renamed). No-op when absent. */
export function renameStateInRuntime(paths: ProjectPaths, flow: string, from: string, to: string): void {
  if (from === to || !exists(paths.stateFile)) return;
  const { file, problem } = readStateFile(paths);
  const entry = file.flows[flow];
  if (problem || !entry) return;
  const rename = (id: string): string => (id === from ? to : id);
  const next = {
    current: rename(entry.current),
    history: entry.history.map((h) => ({ ...h, from: rename(h.from), to: rename(h.to) })),
    updatedAt: entry.updatedAt,
  };
  if (JSON.stringify(next) === JSON.stringify(entry)) return;
  file.flows[flow] = next;
  writeJson(paths.stateFile, file);
}

/**
 * Moves the current step of `flow` from `from` to `to` in `.df/state.json` and records a
 * `STEP_REMOVED` history entry (used when the current step is removed from the flow). Other flows and
 * the existing history are kept. No-op (returns false) when state.json is missing or unreadable, the
 * flow has no entry, or its current step is not `from`.
 */
export function moveCurrentInRuntime(paths: ProjectPaths, flow: string, from: string, to: string): boolean {
  if (from === to || !exists(paths.stateFile)) return false;
  const { file, problem } = readStateFile(paths);
  const entry = file.flows[flow];
  if (problem || !entry || entry.current !== from) return false;
  const at = new Date().toISOString();
  file.flows[flow] = {
    current: to,
    history: [...entry.history, { from, to, event: STEP_REMOVED_EVENT, at }].slice(-HISTORY_LIMIT),
    updatedAt: at,
  };
  writeJson(paths.stateFile, file);
  return true;
}

/**
 * The current step stored for `flow` in `.df/state.json`, as written (it may no longer exist in the
 * flow). Undefined when nothing is stored for the flow or the file cannot be read.
 */
export function storedCurrentStep(paths: ProjectPaths, flow: string): string | undefined {
  const { file, problem } = readStateFile(paths);
  return problem ? undefined : file.flows[flow]?.current;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Moves to `next` and appends a history entry (capped); nothing is persisted. */
function advance(model: FlowModel, state: FlowRuntimeState, next: AnyMachineSnapshot, event: string): TransitionResult {
  const at = new Date().toISOString();
  const to = stateKey(next.value, model);
  const entry: HistoryEntry = { from: state.current, to, event, at };
  const updated: FlowRuntimeState = {
    flow: model.name,
    current: to,
    done: next.status === 'done',
    history: [...state.history, entry].slice(-HISTORY_LIMIT),
    updatedAt: at,
  };
  return { from: state.current, to, event, done: updated.done, state: updated };
}

/** Saves the planned state and returns the result unchanged. */
function persist(paths: ProjectPaths, result: TransitionResult): TransitionResult {
  saveRuntimeState(paths, result.state);
  return result;
}

function runtimeState(flow: string, snapshot: AnyMachineSnapshot, history: HistoryEntry[], updatedAt: string): FlowRuntimeState {
  return {
    flow,
    current: String(snapshot.value),
    done: snapshot.status === 'done',
    history: history.slice(-HISTORY_LIMIT),
    updatedAt,
  };
}

function tryResolve(machine: AnyStateMachine, stepId: string): AnyMachineSnapshot | undefined {
  try {
    return machine.resolveState({ value: stepId, context: {} });
  } catch {
    return undefined;
  }
}

function resolveSnapshot(machine: AnyStateMachine, model: FlowModel, stepId: string): AnyMachineSnapshot {
  const snapshot = tryResolve(machine, stepId);
  if (!snapshot) {
    throw new DflError(`Step "${stepId}" cannot be entered in flow "${model.name}".`, {
      hint: `Check the flow with \`dfl flow validate ${model.name}\`.`,
      code: 'INVALID_FLOW',
    });
  }
  return snapshot;
}

function initialSnapshot(machine: AnyStateMachine, model: FlowModel): AnyMachineSnapshot {
  try {
    return initialTransition(machine)[0];
  } catch (error) {
    throw new DflError(`Flow "${model.name}" has no valid initial step: ${errorMessage(error)}`, {
      hint: `Check "initial" in .df/${model.name}/flow.json with \`dfl flow validate ${model.name}\`.`,
      code: 'INVALID_FLOW',
      cause: error,
    });
  }
}

/** Flows are flat, so a state value is always a state key. */
function stateKey(value: StateValue, model: FlowModel): string {
  if (typeof value === 'string') return value;
  throw new DflError(`Flow "${model.name}" uses nested states, which are not supported.`, { code: 'INVALID_FLOW' });
}

/**
 * Reads `.df/state.json`, tolerating a missing or malformed file (runtime state is disposable).
 * `problem` describes why the content was discarded.
 */
function readStateFile(paths: ProjectPaths): { file: StateFile; problem?: string | undefined } {
  const empty: StateFile = { version: 1, flows: {} };
  if (!exists(paths.stateFile)) return { file: empty };
  let data: unknown;
  try {
    data = readJson(paths.stateFile);
  } catch {
    return { file: empty, problem: `${paths.stateFile} could not be parsed and was ignored` };
  }
  const flows = (data as { flows?: unknown } | null)?.flows;
  if (!flows || typeof flows !== 'object' || Array.isArray(flows)) {
    return { file: empty, problem: `${paths.stateFile} has an unexpected shape and was ignored` };
  }
  const file: StateFile = { version: 1, flows: {} };
  for (const [name, raw] of Object.entries(flows as Record<string, unknown>)) {
    const entry = raw as { current?: unknown; history?: unknown; updatedAt?: unknown } | null;
    if (!entry || typeof entry.current !== 'string') continue;
    file.flows[name] = {
      current: entry.current,
      history: Array.isArray(entry.history) ? entry.history.filter(isHistoryEntry) : [],
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
    };
  }
  return { file };
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  const h = value as Partial<HistoryEntry> | null;
  return !!h && typeof h.from === 'string' && typeof h.to === 'string' && typeof h.event === 'string' && typeof h.at === 'string';
}
