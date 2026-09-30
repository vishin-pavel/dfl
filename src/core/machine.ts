/**
 * xstate runtime for flows (OWNER: flow-engine agent).
 *
 * Uses xstate v5 pure functions (`initialTransition`, `transition`, `machine.resolveState`)
 * – never long-running actors. Only `{ current, history, updatedAt }` is persisted per flow in
 * `.df/state.json` (see `StateFile`).
 */
import type { AnyStateMachine } from 'xstate';
import type { FlowDefinition, FlowModel, FlowRuntimeState, FlowTransition, ProjectPaths, TransitionResult } from './types.js';

const notImplemented = (): never => {
  throw new Error('not implemented');
};

/** Builds an xstate machine from `def.machine` (plain JSON config, no setup()). Throws DflError on xstate errors. */
export function createFlowMachine(def: FlowDefinition): AnyStateMachine {
  return notImplemented();
}

/**
 * Current runtime state of `model` from `.df/state.json`. Missing entry → initial state.
 * If the stored `current` no longer exists in the machine, falls back to the initial state and
 * sets `repaired` to a human-readable explanation (the repaired state is NOT written back).
 */
export function loadRuntimeState(paths: ProjectPaths, model: FlowModel): FlowRuntimeState {
  return notImplemented();
}

/** Persists the runtime state of one flow into `.df/state.json` (other flows are preserved; history capped at 200). */
export function saveRuntimeState(paths: ProjectPaths, state: FlowRuntimeState): void {
  notImplemented();
}

/** Outgoing transitions of a step (from the model; declaration order). */
export function availableEvents(model: FlowModel, stepId: string): FlowTransition[] {
  return notImplemented();
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
  event?: string,
  options?: { from?: string | undefined },
): TransitionResult {
  return notImplemented();
}

/** Jumps to any existing state (records event `GOTO` in history). Throws DflError `STEP_NOT_FOUND`. */
export function gotoStep(paths: ProjectPaths, model: FlowModel, stepId: string): TransitionResult {
  return notImplemented();
}

/** Resets the flow to its initial state (records event `RESET`). */
export function resetFlow(paths: ProjectPaths, model: FlowModel): FlowRuntimeState {
  return notImplemented();
}

/** Renames a state inside `.df/state.json` (used when a step is renamed). No-op when absent. */
export function renameStateInRuntime(paths: ProjectPaths, flow: string, from: string, to: string): void {
  notImplemented();
}
