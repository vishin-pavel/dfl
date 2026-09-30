/**
 * Step CRUD: edits flow.json and step directories (OWNER: flow-engine agent).
 * All functions validate the resulting flow (validateDefinition) before writing and
 * return the reloaded FlowModel. They never render or install skills (callers run sync).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DflError } from './errors.js';
import {
  NEXT_EVENT,
  SKILL_TEMPLATE_FILE,
  defaultStepTemplate,
  loadFlow,
  orderStates,
  readFlowDefinition,
  writeFlowDefinition,
} from './flow.js';
import { exists, readTextIfExists, removePath, writeText } from './fsx.js';
import { assertValidStepId, isValidId, titleCase } from './ids.js';
import { renameStateInRuntime } from './machine.js';
import { invalidFlowError, validateDefinition } from './validate.js';
import type { FlowDefinition, FlowModel, FlowStateNodeConfig, FlowTransitionConfig, ProjectPaths } from './types.js';

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

/** Where a new state key goes in `machine.states` (declaration order is the flow order). */
type Placement = { after: string } | { before: string } | 'start';

/**
 * Adds a step. Without after/before it is inserted after the last non-final step in flow order
 * (a flow without non-final steps gets it as its initial step, leading to the first final state).
 * An existing SKILL.md.hbs in the new step's directory is kept unless `template` is given.
 */
export function addStep(paths: ProjectPaths, flowName: string, options: AddStepOptions): FlowModel {
  const { id } = options;
  assertValidStepId(id);
  const def = readFlowDefinition(paths, flowName);
  const { machine } = def;
  const states = machine.states;
  if (Object.hasOwn(states, id)) {
    throw new DflError(`Step "${id}" already exists in flow "${flowName}".`, { code: 'STEP_EXISTS' });
  }
  if (options.after !== undefined && options.before !== undefined) {
    throw new DflError('A step can be inserted either after or before another step, not both.', { code: 'INVALID_OPTIONS' });
  }

  const event = options.event ?? NEXT_EVENT;
  const title = options.title ?? titleCase(id);
  const on: Record<string, FlowTransitionConfig> = {};
  /** "After X": the new step takes over X's `event` target and X leads to the new step. */
  const insertAfter = (anchorId: string): void => {
    const anchor = states[anchorId]!;
    const current = anchor.on?.[event];
    const inherited = current === undefined ? undefined : transitionTarget(current);
    if (inherited !== undefined) on[event] = inherited;
    anchor.on = { ...anchor.on, [event]: current === undefined ? id : retarget(current, id) };
  };

  let placement: Placement;
  if (options.after !== undefined) {
    const anchor = requireState(def, flowName, options.after);
    if (anchor.type === 'final') {
      throw new DflError(`Cannot add a step after the final state "${options.after}".`, {
        hint: `Insert it before "${options.after}" instead.`,
        code: 'INVALID_POSITION',
      });
    }
    insertAfter(options.after);
    placement = { after: options.after };
  } else if (options.before !== undefined) {
    const before = options.before;
    requireState(def, flowName, before);
    for (const [sourceId, source] of Object.entries(states)) {
      const value = source.on?.[event];
      if (sourceId === before || value === undefined || transitionTarget(value) !== before) continue;
      source.on![event] = retarget(value, id);
    }
    on[event] = before;
    if (machine.initial === before) machine.initial = id;
    placement = { before };
  } else {
    const last = orderStates(machine)
      .filter((key) => states[key]!.type !== 'final')
      .at(-1);
    if (last !== undefined) {
      insertAfter(last);
      placement = { after: last };
    } else {
      const firstFinal = Object.keys(states).find((key) => states[key]!.type === 'final');
      if (firstFinal !== undefined) on[event] = firstFinal;
      machine.initial = id;
      placement = 'start';
    }
  }

  const node: FlowStateNodeConfig = {
    ...(options.description !== undefined ? { description: options.description } : {}),
    meta: { title },
  };
  const outgoing = { ...on, ...options.on };
  if (Object.keys(outgoing).length > 0) node.on = outgoing;
  machine.states = insertState(states, id, node, placement);
  assertDefinitionValid(def, flowName);

  const templateFile = path.join(paths.stepDir(flowName, id), SKILL_TEMPLATE_FILE);
  if (options.template !== undefined || !exists(templateFile)) {
    writeText(templateFile, options.template ?? defaultStepTemplate({ title, description: options.description }));
  }
  writeFlowDefinition(paths, def);
  return loadFlow(paths, flowName);
}

export function updateStep(paths: ProjectPaths, flowName: string, stepId: string, patch: UpdateStepOptions): FlowModel {
  const def = readFlowDefinition(paths, flowName);
  const { machine } = def;
  const node = requireState(def, flowName, stepId);
  if (patch.template !== undefined && node.type === 'final') {
    throw new DflError(`"${stepId}" is a final state and has no skill template.`, { code: 'FINAL_STEP' });
  }

  if (patch.title !== undefined) node.meta = { ...node.meta, title: patch.title };
  if (patch.description !== undefined) node.description = patch.description;
  for (const [event, target] of Object.entries(patch.on ?? {})) {
    if (target === null) {
      if (node.on) delete node.on[event];
    } else {
      requireState(def, flowName, target, 'Target step');
      const current = node.on?.[event];
      node.on = { ...node.on, [event]: current === undefined ? target : retarget(current, target) };
    }
  }
  if (node.on && Object.keys(node.on).length === 0) delete node.on;
  if (patch.initial) machine.initial = stepId;

  const rename = patch.rename !== undefined && patch.rename !== stepId ? patch.rename : undefined;
  if (rename !== undefined) {
    assertValidStepId(rename);
    if (Object.hasOwn(machine.states, rename)) {
      throw new DflError(`Step "${rename}" already exists in flow "${flowName}".`, { code: 'STEP_EXISTS' });
    }
    if (exists(paths.stepDir(flowName, rename))) {
      throw new DflError(`Directory steps/${rename} already exists in flow "${flowName}".`, {
        hint: 'Remove or rename that directory first.',
        code: 'STEP_EXISTS',
      });
    }
    renameInDefinition(def, stepId, rename);
  }
  assertDefinitionValid(def, flowName);

  const id = rename ?? stepId;
  if (rename !== undefined && isValidId(stepId) && exists(paths.stepDir(flowName, stepId))) {
    fs.renameSync(paths.stepDir(flowName, stepId), paths.stepDir(flowName, rename));
  }
  if (patch.template !== undefined) writeText(path.join(paths.stepDir(flowName, id), SKILL_TEMPLATE_FILE), patch.template);
  writeFlowDefinition(paths, def);
  if (rename !== undefined) renameStateInRuntime(paths, flowName, stepId, rename);
  return loadFlow(paths, flowName);
}

/**
 * Removes a step and its directory. Incoming transitions are retargeted to the removed step's
 * `NEXT` target; if there is none, DflError `CANNOT_REWIRE` unless `force` (then they are dropped).
 * If it was the initial state, `initial` becomes its `NEXT` target.
 * Refuses to remove the last non-final step (DflError `LAST_STEP`). A retargeted transition that
 * would point back at its own source (e.g. `BACK` to the removed step) is dropped.
 */
export function removeStep(paths: ProjectPaths, flowName: string, stepId: string, options: RemoveStepOptions = {}): FlowModel {
  const def = readFlowDefinition(paths, flowName);
  const { machine } = def;
  const states = machine.states;
  const node = requireState(def, flowName, stepId);
  const others = Object.keys(states).filter((key) => key !== stepId);
  if (node.type !== 'final' && !others.some((key) => states[key]!.type !== 'final')) {
    throw new DflError(`Cannot remove "${stepId}": it is the last step of flow "${flowName}".`, {
      hint: 'Add another step first, or delete the whole flow with `dfl flow delete`.',
      code: 'LAST_STEP',
    });
  }

  const nextValue = node.on?.[NEXT_EVENT];
  const nextTarget = nextValue === undefined ? undefined : transitionTarget(nextValue);
  const replacement = nextTarget !== undefined && nextTarget !== stepId && Object.hasOwn(states, nextTarget) ? nextTarget : undefined;
  const incoming: Array<{ source: string; event: string }> = [];
  for (const source of others) {
    for (const [event, value] of Object.entries(states[source]!.on ?? {})) {
      if (transitionTarget(value) === stepId) incoming.push({ source, event });
    }
  }
  const isInitial = machine.initial === stepId;
  if (replacement === undefined && !options.force && (incoming.length > 0 || isInitial)) {
    const refs = incoming.map((t) => `${t.source} —${t.event}→ ${stepId}`);
    if (isInitial) refs.push('initial step');
    throw new DflError(`Cannot remove "${stepId}": it has no ${NEXT_EVENT} transition to reroute its references to (${refs.join(', ')}).`, {
      hint: `Give "${stepId}" a ${NEXT_EVENT} transition first, or force the removal to drop those transitions.`,
      code: 'CANNOT_REWIRE',
    });
  }

  for (const { source, event } of incoming) {
    const on = states[source]!.on!;
    if (replacement === undefined || replacement === source) delete on[event];
    else on[event] = retarget(on[event]!, replacement);
  }
  for (const { source } of incoming) {
    if (Object.keys(states[source]!.on ?? {}).length === 0) delete states[source]!.on;
  }
  if (isInitial) {
    const order = orderStates(machine).filter((key) => key !== stepId);
    machine.initial = replacement ?? order.find((key) => states[key]!.type !== 'final') ?? order[0] ?? '';
  }
  delete states[stepId];
  assertDefinitionValid(def, flowName);

  writeFlowDefinition(paths, def);
  if (isValidId(stepId)) removePath(paths.stepDir(flowName, stepId));
  return loadFlow(paths, flowName);
}

/**
 * Sets (`target` string) or removes (`null`) one transition. The target must exist; removing a
 * transition the step does not have is a DflError `TRANSITION_NOT_FOUND`. Retargeting an object-form
 * transition keeps its description.
 */
export function setTransition(
  paths: ProjectPaths,
  flowName: string,
  stepId: string,
  event: string,
  target: string | null,
): FlowModel {
  const def = readFlowDefinition(paths, flowName);
  const node = requireState(def, flowName, stepId);
  const current = node.on?.[event];
  if (target === null) {
    if (current === undefined || !node.on) {
      const events = Object.keys(node.on ?? {});
      throw new DflError(`Step "${stepId}" has no "${event}" transition.`, {
        hint: events.length > 0 ? `Its transitions: ${events.join(', ')}.` : `Step "${stepId}" has no transitions.`,
        code: 'TRANSITION_NOT_FOUND',
      });
    }
    delete node.on[event];
    if (Object.keys(node.on).length === 0) delete node.on;
  } else {
    requireState(def, flowName, target, 'Target step');
    node.on = { ...node.on, [event]: current === undefined ? target : retarget(current, target) };
  }
  assertDefinitionValid(def, flowName);
  writeFlowDefinition(paths, def);
  return loadFlow(paths, flowName);
}

/** Reads `.df/<flow>/steps/<id>/SKILL.md.hbs` ('' when missing). */
export function readStepTemplate(paths: ProjectPaths, flowName: string, stepId: string): string {
  assertValidStepId(stepId);
  return readTextIfExists(path.join(paths.stepDir(flowName, stepId), SKILL_TEMPLATE_FILE)) ?? '';
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireState(def: FlowDefinition, flowName: string, stepId: string, label = 'Step'): FlowStateNodeConfig {
  const node = Object.hasOwn(def.machine.states, stepId) ? def.machine.states[stepId] : undefined;
  if (!node) {
    throw new DflError(`${label} "${stepId}" does not exist in flow "${flowName}".`, {
      hint: `Steps: ${Object.keys(def.machine.states).join(', ') || '(none)'}`,
      code: 'STEP_NOT_FOUND',
    });
  }
  return node;
}

/** Throws DflError `INVALID_FLOW` (nothing is written) when the edited definition has errors. */
function assertDefinitionValid(def: FlowDefinition, flowName: string): void {
  const errors = validateDefinition(def, flowName).filter((issue) => issue.level === 'error');
  if (errors.length > 0) throw invalidFlowError(flowName, errors);
}

function transitionTarget(value: FlowTransitionConfig): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.target === 'string') return value.target;
  return undefined;
}

/** Points a transition at `target`, keeping the object form (and its description) when present. */
function retarget(value: FlowTransitionConfig, target: string): FlowTransitionConfig {
  return typeof value === 'string' ? target : { ...value, target };
}

/** Rebuilds `states` with `id` inserted at `placement`, keeping the declaration order of the others. */
function insertState(
  states: Record<string, FlowStateNodeConfig>,
  id: string,
  node: FlowStateNodeConfig,
  placement: Placement,
): Record<string, FlowStateNodeConfig> {
  const out: Record<string, FlowStateNodeConfig> = {};
  if (placement === 'start') out[id] = node;
  for (const [key, value] of Object.entries(states)) {
    if (placement !== 'start' && 'before' in placement && placement.before === key) out[id] = node;
    out[key] = value;
    if (placement !== 'start' && 'after' in placement && placement.after === key) out[id] = node;
  }
  return out;
}

/** Renames a state key in place (same position) and rewrites every target and `initial`. */
function renameInDefinition(def: FlowDefinition, from: string, to: string): void {
  const states: Record<string, FlowStateNodeConfig> = {};
  for (const [key, node] of Object.entries(def.machine.states)) {
    for (const [event, value] of Object.entries(node.on ?? {})) {
      if (transitionTarget(value) === from) node.on![event] = retarget(value, to);
    }
    states[key === from ? to : key] = node;
  }
  def.machine.states = states;
  if (def.machine.initial === from) def.machine.initial = to;
}
