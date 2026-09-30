/**
 * Step CRUD: edits flow.json and step directories (OWNER: flow-engine agent).
 * All functions validate the resulting flow (validateDefinition) before writing and
 * return the reloaded FlowModel. They never render or install skills (callers run sync).
 */
import type { FlowModel, ProjectPaths } from './types.js';

export interface AddStepOptions {
  id: string;
  title?: string | undefined;
  description?: string | undefined;
  /** Insert after this step: its `event` transition is redirected to the new step, which inherits the old target. */
  after?: string | undefined;
  /** Insert before this step: every `event` transition targeting it is redirected to the new step (initial too). */
  before?: string | undefined;
  /** Event used for rewiring. Default `NEXT`. */
  event?: string | undefined;
  /** Explicit outgoing transitions of the new step (merged over the inherited one). */
  on?: Record<string, string> | undefined;
  /** SKILL.md.hbs body. Default: defaultStepTemplate(). */
  template?: string | undefined;
}

export interface UpdateStepOptions {
  title?: string | undefined;
  description?: string | undefined;
  /** New SKILL.md.hbs content. */
  template?: string | undefined;
  /** Rename the step (state key, targets, initial, directory, runtime state). */
  rename?: string | undefined;
  /** Set (string) or remove (null) outgoing transitions. */
  on?: Record<string, string | null> | undefined;
  /** Make this step the initial state. */
  initial?: boolean | undefined;
}

export interface RemoveStepOptions {
  /** Allow removal even when incoming transitions cannot be rewired (they are dropped). */
  force?: boolean | undefined;
}

/** Adds a step. Without after/before it is inserted after the last non-final step in flow order. */
export function addStep(paths: ProjectPaths, flowName: string, options: AddStepOptions): FlowModel {
  throw new Error('not implemented');
}

export function updateStep(paths: ProjectPaths, flowName: string, stepId: string, patch: UpdateStepOptions): FlowModel {
  throw new Error('not implemented');
}

/**
 * Removes a step and its directory. Incoming transitions are retargeted to the removed step's
 * `NEXT` target; if there is none, DflError `CANNOT_REWIRE` unless `force` (then they are dropped).
 * If it was the initial state, `initial` becomes its `NEXT` target.
 */
export function removeStep(paths: ProjectPaths, flowName: string, stepId: string, options?: RemoveStepOptions): FlowModel {
  throw new Error('not implemented');
}

/** Sets (`target` string) or removes (`null`) one transition. */
export function setTransition(
  paths: ProjectPaths,
  flowName: string,
  stepId: string,
  event: string,
  target: string | null,
): FlowModel {
  throw new Error('not implemented');
}

/** Reads `.df/<flow>/steps/<id>/SKILL.md.hbs` ('' when missing). */
export function readStepTemplate(paths: ProjectPaths, flowName: string, stepId: string): string {
  throw new Error('not implemented');
}
