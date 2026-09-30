/**
 * Step CRUD: edits flow.json and step directories (OWNER: flow-engine agent).
 *
 * Every mutation validates the edited definition before writing anything. It is refused (DflError
 * `INVALID_FLOW`, listing only the new errors) when it introduces a validation error the flow did not
 * already have; errors the flow already had do not block it, so a flow with several independent errors
 * can be repaired one edit at a time. Errors that remain are returned as `remainingErrors`. Templates
 * must compile (DflError `INVALID_TEMPLATE`). The functions return the reloaded FlowModel (plus details
 * of the change) and never render or install skills (callers run sync).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DflError } from './errors.js';
import {
  NEXT_EVENT,
  SKILL_TEMPLATE_FILE,
  defaultStepTemplate,
  loadFlow,
  normalizeTransitions,
  orderStates,
  readFlowDefinition,
  writeFlowDefinition,
} from './flow.js';
import { exists, readTextIfExists, removePath, writeText } from './fsx.js';
import { assertValidStepId, isValidId, titleCase } from './ids.js';
import { moveCurrentInRuntime, renameStateInRuntime } from './machine.js';
import { checkTemplateSource, diffDefinitionErrors, invalidFlowError, templateCheckEnv } from './validate.js';
import type {
  FlowDefinition,
  FlowMachineConfig,
  FlowModel,
  FlowStateNodeConfig,
  FlowTransitionConfig,
  ProjectPaths,
  ValidationIssue,
} from './types.js';

/**
 * A transition as the step APIs accept it: a target step id, or a target plus the condition for
 * firing the event (`description`, shown to the agent by the flow-context partial).
 */
export type TransitionInput = string | { target: string; description?: string | undefined };

export interface AddStepOptions {
  id: string;
  title?: string | undefined;
  description?: string | undefined;
  /** Insert after this step: its `event` transition is redirected to the new step, which inherits the old target. */
  after?: string | undefined;
  /**
   * Insert before this step: every `event` transition targeting it is redirected to the new step. The new
   * step becomes the initial step only when this is the initial step and `event` is `NEXT`.
   */
  before?: string | undefined;
  /** Event used for rewiring. Default `NEXT`. */
  event?: string | undefined;
  /** Explicit outgoing transitions of the new step (merged over the inherited one). */
  on?: Record<string, TransitionInput> | undefined;
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
  /**
   * Set or remove (null) outgoing transitions. A string retargets and keeps an existing description; an
   * object sets the target and the description ('' removes it, omitted keeps it).
   */
  on?: Record<string, TransitionInput | null> | undefined;
  /** Make this step the initial state (not allowed for a final state: DflError `FINAL_STEP`). */
  initial?: boolean | undefined;
}

export interface RemoveStepOptions {
  /** Allow removal even when incoming transitions cannot be rewired (they are dropped). */
  force?: boolean | undefined;
}

/** Details every mutation returns next to the reloaded model. */
export interface StepEditInfo {
  /** Validation errors the flow already had before the edit and still has (the edit added none). */
  remainingErrors: ValidationIssue[];
}

/** How addStep wired the new step into the flow. */
export interface StepPlacement {
  /** The event used for the wiring. */
  event: string;
  /** The step whose `event` transition now leads to the new step (insert after). */
  after?: string | undefined;
  /** The step the new step leads to via `event` (insert before, or the final state of an empty flow). */
  before?: string | undefined;
  /** True when no after/before was given and dfl chose the position (the end of the NEXT path). */
  auto: boolean;
  /** True when the new step became the initial step. */
  initial: boolean;
  /** Steps whose `event` transition was redirected to the new step. */
  rewired: string[];
}

export type AddStepResult = FlowModel & StepEditInfo & { placement: StepPlacement };
export type UpdateStepResult = FlowModel & StepEditInfo;
export type SetTransitionResult = FlowModel & StepEditInfo;

/** An incoming transition of a removed step that now leads to the step's NEXT target. */
export interface RewiredTransition {
  source: string;
  event: string;
  from: string;
  to: string;
}

/** An incoming transition of a removed step that was deleted instead of rerouted. */
export interface DroppedTransition {
  source: string;
  event: string;
  /** The removed step it pointed at. */
  target: string;
  description?: string | undefined;
  /** `self-loop`: it came from the NEXT target itself; `no-next`: forced removal of a step without NEXT. */
  reason: 'self-loop' | 'no-next';
}

export type RemoveStepResult = FlowModel &
  StepEditInfo & {
    rewired: RewiredTransition[];
    dropped: DroppedTransition[];
    /** Set when the removed step was the initial step. */
    initialMoved?: { from: string; to: string } | undefined;
    /** Set when the removed step was the developer's current step (state.json was updated). */
    currentMoved?: { from: string; to: string } | undefined;
  };

/** Where a new state key goes in `machine.states` (declaration order is the flow order). */
type KeyPlacement = { after: string } | { before: string } | 'start';

/**
 * Adds a step. Without after/before it goes after the last step on the NEXT path from the initial step
 * (the one leading to the final state) and inherits its NEXT target; its key is declared after the last
 * non-final state, so it is listed last. A flow without non-final steps gets it as its initial step,
 * leading to the first final state. An existing SKILL.md.hbs in the new step's directory is kept unless
 * `template` is given (it must compile: DflError `INVALID_TEMPLATE`).
 */
export function addStep(paths: ProjectPaths, flowName: string, options: AddStepOptions): AddStepResult {
  const { id } = options;
  assertValidStepId(id);
  const def = readFlowDefinition(paths, flowName);
  const original = structuredClone(def);
  const { machine } = def;
  const states = machine.states;
  if (Object.hasOwn(states, id)) {
    throw new DflError(`Step "${id}" already exists in flow "${flowName}".`, { code: 'STEP_EXISTS' });
  }
  if (options.after !== undefined && options.before !== undefined) {
    throw new DflError('A step can be inserted either after or before another step, not both.', { code: 'INVALID_OPTIONS' });
  }
  const explicitOn: Record<string, FlowTransitionConfig> = {};
  for (const [event, input] of Object.entries(options.on ?? {})) {
    const { target, description } = parseTransitionInput(input, `Transition "${event}" of step "${id}"`);
    explicitOn[event] = description ? { target, description } : target;
  }

  const event = options.event ?? NEXT_EVENT;
  const title = options.title ?? titleCase(id);
  const on: Record<string, FlowTransitionConfig> = {};
  const placement: StepPlacement = { event, auto: false, initial: false, rewired: [] };
  /** "After X": the new step takes over X's `event` target and X leads to the new step. */
  const insertAfter = (anchorId: string): void => {
    const anchor = states[anchorId]!;
    const current = anchor.on?.[event];
    if (current !== undefined) {
      const inherited = transitionTarget(current);
      if (inherited === undefined) throw unsupportedTransitionError(flowName, anchorId, event);
      on[event] = inherited;
    }
    anchor.on = { ...anchor.on, [event]: current === undefined ? id : retarget(current, id) };
    placement.after = anchorId;
    placement.rewired = [anchorId];
  };

  let keyPlacement: KeyPlacement;
  if (options.after !== undefined) {
    const anchor = requireState(def, flowName, options.after);
    if (anchor.type === 'final') {
      throw new DflError(`Cannot add a step after the final state "${options.after}".`, {
        hint: `Insert it before "${options.after}" instead.`,
        code: 'INVALID_POSITION',
      });
    }
    insertAfter(options.after);
    keyPlacement = { after: options.after };
  } else if (options.before !== undefined) {
    const before = options.before;
    requireState(def, flowName, before);
    for (const [sourceId, source] of Object.entries(states)) {
      const value = source.on?.[event];
      if (sourceId === before || value === undefined || transitionTarget(value) !== before) continue;
      source.on![event] = retarget(value, id);
      placement.rewired.push(sourceId);
    }
    // Only a NEXT insert before the starting step changes where the flow starts.
    const startsHere = event === NEXT_EVENT && machine.initial === before;
    if (placement.rewired.length === 0 && !startsHere) {
      throw new DflError(`Cannot add "${id}" before "${before}": no "${event}" transition leads to "${before}".`, {
        hint: `Use --after <step> (after in MCP), or add a "${event}" transition to "${before}" first.`,
        code: 'INVALID_POSITION',
      });
    }
    on[event] = before;
    if (startsHere) {
      machine.initial = id;
      placement.initial = true;
    }
    placement.before = before;
    keyPlacement = { before };
  } else {
    placement.auto = true;
    const anchor = defaultAnchor(machine);
    if (anchor !== undefined) {
      insertAfter(anchor.id);
      // Never leave the new step as a dead end when the anchor had no such transition to inherit.
      if (Object.keys(on).length === 0 && Object.keys(explicitOn).length === 0 && anchor.final !== undefined) {
        on[NEXT_EVENT] = anchor.final;
      }
      const lastStep = Object.keys(states).filter((key) => states[key]!.type !== 'final').at(-1);
      keyPlacement = { after: lastStep ?? anchor.id };
    } else {
      const firstFinal = Object.keys(states).find((key) => states[key]!.type === 'final');
      if (firstFinal !== undefined) {
        on[event] = firstFinal;
        placement.before = firstFinal;
      }
      machine.initial = id;
      placement.initial = true;
      keyPlacement = 'start';
    }
  }

  const node: FlowStateNodeConfig = {
    ...(options.description !== undefined ? { description: options.description } : {}),
    meta: { title },
  };
  const outgoing = { ...on, ...explicitOn };
  if (Object.keys(outgoing).length > 0) node.on = outgoing;
  machine.states = insertState(states, id, node, keyPlacement);
  const remainingErrors = assertNoNewErrors(original, def, flowName);
  if (options.template !== undefined) assertTemplateCompiles(paths, flowName, id, options.template);

  const stepDir = paths.stepDir(flowName, id);
  const templateFile = path.join(stepDir, SKILL_TEMPLATE_FILE);
  const hadDir = exists(stepDir);
  const previousTemplate = readTextIfExists(templateFile);
  if (options.template !== undefined || previousTemplate === undefined) {
    writeText(templateFile, options.template ?? defaultStepTemplate({ title, description: options.description }));
  }
  try {
    writeFlowDefinition(paths, def);
  } catch (error) {
    // flow.json was not changed: undo the template write so no orphan step directory is left behind.
    try {
      if (!hadDir) removePath(stepDir);
      else if (previousTemplate === undefined) removePath(templateFile);
      else writeText(templateFile, previousTemplate);
    } catch {
      // Best effort: the original error is what matters.
    }
    throw error;
  }
  return Object.assign(loadFlow(paths, flowName), { placement, remainingErrors });
}

export function updateStep(paths: ProjectPaths, flowName: string, stepId: string, patch: UpdateStepOptions): UpdateStepResult {
  const def = readFlowDefinition(paths, flowName);
  const original = structuredClone(def);
  const { machine } = def;
  const node = requireState(def, flowName, stepId);
  if (patch.template !== undefined && node.type === 'final') {
    throw new DflError(`"${stepId}" is a final state and has no skill template.`, { code: 'FINAL_STEP' });
  }
  if (patch.initial && node.type === 'final') {
    throw new DflError(`"${stepId}" is a final state and cannot be the initial step.`, {
      hint: 'Make a non-final step the initial one; the flow would otherwise start complete.',
      code: 'FINAL_STEP',
    });
  }

  if (patch.title !== undefined) node.meta = { ...node.meta, title: patch.title };
  if (patch.description !== undefined) node.description = patch.description;
  for (const [event, input] of Object.entries(patch.on ?? {})) {
    if (input === null) {
      if (node.on) delete node.on[event];
    } else {
      const { target, description } = parseTransitionInput(input, `Transition "${event}" of step "${stepId}"`);
      requireState(def, flowName, target, 'Target step');
      node.on = { ...node.on, [event]: setTransitionValue(node.on?.[event], target, description) };
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
  const remainingErrors = assertNoNewErrors(original, def, flowName, rename !== undefined ? { from: stepId, to: rename } : undefined);

  const id = rename ?? stepId;
  if (patch.template !== undefined) assertTemplateCompiles(paths, flowName, id, patch.template);
  if (rename !== undefined && isValidId(stepId) && exists(paths.stepDir(flowName, stepId))) {
    fs.renameSync(paths.stepDir(flowName, stepId), paths.stepDir(flowName, rename));
  }
  if (patch.template !== undefined) writeText(path.join(paths.stepDir(flowName, id), SKILL_TEMPLATE_FILE), patch.template);
  writeFlowDefinition(paths, def);
  if (rename !== undefined) renameStateInRuntime(paths, flowName, stepId, rename);
  return Object.assign(loadFlow(paths, flowName), { remainingErrors });
}

/**
 * Removes a step and its directory. Incoming transitions are retargeted to the removed step's
 * `NEXT` target (`rewired`); if there is none, DflError `CANNOT_REWIRE` unless `force` (then they are
 * dropped). A retargeted transition that would point back at its own source (e.g. the NEXT target's
 * `FAILED` back to the removed step) would become a self-loop and is dropped instead (`dropped`).
 * If it was the initial state, `initial` becomes its NEXT target, or the first remaining non-final step
 * when that target is a final state. If it was the developer's current step, state.json moves to the
 * NEXT target (or, when that is final or missing, the step that led to it, else the initial step).
 * Refuses to remove the last non-final step (DflError `LAST_STEP`).
 */
export function removeStep(paths: ProjectPaths, flowName: string, stepId: string, options: RemoveStepOptions = {}): RemoveStepResult {
  const def = readFlowDefinition(paths, flowName);
  const plan = planRemoval(def, flowName, stepId, options);
  writeFlowDefinition(paths, def);
  const currentMoved =
    plan.moveCurrentTo !== '' && moveCurrentInRuntime(paths, flowName, stepId, plan.moveCurrentTo)
      ? { from: stepId, to: plan.moveCurrentTo }
      : undefined;
  if (isValidId(stepId)) removePath(paths.stepDir(flowName, stepId));
  return Object.assign(loadFlow(paths, flowName), {
    rewired: plan.rewired,
    dropped: plan.dropped,
    initialMoved: plan.initialMoved,
    currentMoved,
    remainingErrors: plan.remainingErrors,
  });
}

/** What removeStep would do, computed without writing anything (see planRemoveStep). */
export interface RemoveStepPlan extends StepEditInfo {
  rewired: RewiredTransition[];
  dropped: DroppedTransition[];
  initialMoved?: { from: string; to: string } | undefined;
  /** Where the developer's position moves if the removed step is the current one ('' when nowhere). */
  moveCurrentTo: string;
}

/**
 * Dry run of removeStep: the same checks and errors (`STEP_NOT_FOUND`, `LAST_STEP`, `CANNOT_REWIRE`,
 * `INVALID_FLOW`) and the transitions it would reroute or drop, without writing anything. Lets callers
 * report a refusal before asking for confirmation.
 */
export function planRemoveStep(paths: ProjectPaths, flowName: string, stepId: string, options: RemoveStepOptions = {}): RemoveStepPlan {
  return planRemoval(readFlowDefinition(paths, flowName), flowName, stepId, options);
}

/** Applies the removal of `stepId` to `def` in memory (validated) and reports what changed. */
function planRemoval(def: FlowDefinition, flowName: string, stepId: string, options: RemoveStepOptions): RemoveStepPlan {
  const original = structuredClone(def);
  const { machine } = def;
  const states = machine.states;
  const node = requireState(def, flowName, stepId);
  const others = Object.keys(states).filter((key) => key !== stepId);
  const isStep = (key: string | undefined): key is string => key !== undefined && Object.hasOwn(states, key) && states[key]!.type !== 'final';
  if (node.type !== 'final' && !others.some(isStep)) {
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

  const rewired: RewiredTransition[] = [];
  const dropped: DroppedTransition[] = [];
  for (const { source, event } of incoming) {
    const on = states[source]!.on!;
    const value = on[event]!;
    if (replacement === undefined || replacement === source) {
      const description = transitionDescription(value);
      dropped.push({
        source,
        event,
        target: stepId,
        ...(description !== undefined ? { description } : {}),
        reason: replacement === undefined ? 'no-next' : 'self-loop',
      });
      delete on[event];
    } else {
      on[event] = retarget(value, replacement);
      rewired.push({ source, event, from: stepId, to: replacement });
    }
  }
  for (const { source } of incoming) {
    if (Object.keys(states[source]!.on ?? {}).length === 0) delete states[source]!.on;
  }
  let initialMoved: { from: string; to: string } | undefined;
  if (isInitial) {
    const order = orderStates(machine).filter((key) => key !== stepId);
    // A final replacement would make the flow start complete: prefer the first remaining step.
    const next = (isStep(replacement) ? replacement : order.find(isStep)) ?? replacement ?? order[0] ?? '';
    machine.initial = next;
    initialMoved = { from: stepId, to: next };
  }
  const predecessor =
    incoming.find((t) => t.event === NEXT_EVENT && isStep(t.source))?.source ?? incoming.find((t) => isStep(t.source))?.source;
  delete states[stepId];
  const remainingErrors = assertNoNewErrors(original, def, flowName);
  const moveCurrentTo = isStep(replacement) ? replacement : (predecessor ?? machine.initial);
  return { rewired, dropped, initialMoved, moveCurrentTo, remainingErrors };
}

/**
 * Sets (`target` string) or removes (`null`) one transition. The target must exist; removing a
 * transition the step does not have is a DflError `TRANSITION_NOT_FOUND`. `description` sets the
 * condition for firing the event ('' removes it); when omitted, a retargeted transition keeps its
 * description.
 */
export function setTransition(
  paths: ProjectPaths,
  flowName: string,
  stepId: string,
  event: string,
  target: string | null,
  description?: string | undefined,
): SetTransitionResult {
  const def = readFlowDefinition(paths, flowName);
  const original = structuredClone(def);
  const node = requireState(def, flowName, stepId);
  const current = node.on?.[event];
  if (target === null) {
    if (description !== undefined) {
      throw new DflError('A description can only be given when setting a transition, not when removing it.', {
        code: 'INVALID_OPTIONS',
      });
    }
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
    const input = parseTransitionInput(
      description === undefined ? target : { target, description },
      `Transition "${event}" of step "${stepId}"`,
    );
    requireState(def, flowName, input.target, 'Target step');
    node.on = { ...node.on, [event]: setTransitionValue(current, input.target, input.description) };
  }
  const remainingErrors = assertNoNewErrors(original, def, flowName);
  writeFlowDefinition(paths, def);
  return Object.assign(loadFlow(paths, flowName), { remainingErrors });
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

/**
 * Throws DflError `INVALID_FLOW` (nothing is written) listing the errors the edit introduced; returns
 * the errors the flow already had (`before`) and still has.
 */
function assertNoNewErrors(
  before: FlowDefinition,
  after: FlowDefinition,
  flowName: string,
  rename?: { from: string; to: string } | undefined,
): ValidationIssue[] {
  const { added, remaining } = diffDefinitionErrors(before, after, flowName, rename);
  if (added.length > 0) throw invalidFlowError(flowName, added);
  return remaining;
}

/** Throws DflError `INVALID_TEMPLATE` (nothing is written) when a step template does not compile. */
function assertTemplateCompiles(paths: ProjectPaths, flowName: string, stepId: string, source: string): void {
  const problems = checkTemplateSource(source, `steps/${stepId}/${SKILL_TEMPLATE_FILE}`, templateCheckEnv(paths, flowName));
  if (problems.length === 0) return;
  throw new DflError(`The template of step "${stepId}" in flow "${flowName}" cannot be rendered:\n${problems.map((p) => `  - ${p}`).join('\n')}`, {
    hint: 'Fix the Handlebars syntax and retry; literal braces that are not Handlebars must be escaped as \\{{ … }}.',
    code: 'INVALID_TEMPLATE',
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transitionTarget(value: FlowTransitionConfig): string | undefined {
  if (typeof value === 'string') return value;
  if (isPlainObject(value) && typeof value.target === 'string') return value.target;
  return undefined;
}

function transitionDescription(value: FlowTransitionConfig): string | undefined {
  return isPlainObject(value) && typeof value.description === 'string' ? value.description : undefined;
}

/**
 * Points a transition at `target` while rewiring, keeping the object form (and its description).
 * Only called for values transitionTarget() understands.
 */
function retarget(value: FlowTransitionConfig, target: string): FlowTransitionConfig {
  return isPlainObject(value) ? ({ ...value, target } as FlowTransitionConfig) : target;
}

/**
 * The value of an explicitly set transition. `description` undefined keeps the current description,
 * '' removes it. An unsupported current value (e.g. an xstate guarded-transition array) is replaced.
 * `{ target }` alone collapses to the plain string form.
 */
function setTransitionValue(current: FlowTransitionConfig | undefined, target: string, description: string | undefined): FlowTransitionConfig {
  const next: Record<string, unknown> = { target };
  const kept = description === undefined ? (current === undefined ? undefined : transitionDescription(current)) : description;
  if (kept) next['description'] = kept;
  const meta = isPlainObject(current) ? (current as Record<string, unknown>)['meta'] : undefined;
  if (meta !== undefined) next['meta'] = meta;
  return Object.keys(next).length === 1 ? target : (next as unknown as FlowTransitionConfig);
}

/** Validates a TransitionInput; the description is trimmed with whitespace collapsed ('' = none). */
function parseTransitionInput(input: unknown, label: string): { target: string; description: string | undefined } {
  if (typeof input === 'string') return { target: input, description: undefined };
  if (isPlainObject(input) && typeof input['target'] === 'string') {
    const description = input['description'];
    if (description === undefined) return { target: input['target'], description: undefined };
    if (typeof description === 'string') return { target: input['target'], description: description.replace(/\s+/g, ' ').trim() };
  }
  throw new DflError(`${label} must be a target step id or { "target": "<step>", "description": "<when to fire it>" }.`, {
    code: 'INVALID_OPTIONS',
  });
}

function unsupportedTransitionError(flowName: string, stepId: string, event: string): DflError {
  return new DflError(
    `Transition "${event}" of step "${stepId}" in flow "${flowName}" is not a target string or { "target", "description" } ` +
      '(guarded transition lists are not supported), so a step cannot be inserted after it.',
    {
      hint: `Replace it first, e.g. \`dfl step transition ${stepId} ${event} <target>\` (update_step in MCP).`,
      code: 'INVALID_FLOW',
    },
  );
}

/**
 * Default anchor of addStep: walk NEXT from the initial step and stop at the step whose NEXT leads to a
 * final state (or that has no usable NEXT). On a NEXT cycle, the last reachable non-final step in flow
 * order. `final` is the final state the new step should lead to if it inherits nothing.
 */
function defaultAnchor(machine: FlowMachineConfig): { id: string; final: string | undefined } | undefined {
  const states = machine.states;
  const isStep = (key: string): boolean => Object.hasOwn(states, key) && states[key]!.type !== 'final';
  const firstFinal = Object.keys(states).find((key) => states[key]!.type === 'final');
  if (isStep(machine.initial)) {
    const visited = new Set<string>();
    let current = machine.initial;
    for (;;) {
      visited.add(current);
      const value = states[current]!.on?.[NEXT_EVENT];
      const target = value === undefined ? undefined : transitionTarget(value);
      if (target === undefined || !Object.hasOwn(states, target)) return { id: current, final: firstFinal };
      if (!isStep(target)) return { id: current, final: target };
      if (visited.has(target)) break;
      current = target;
    }
  }
  const reachable = reachableStates(machine);
  const steps = orderStates(machine).filter(isStep);
  const id = steps.filter((key) => reachable.has(key)).at(-1) ?? steps.at(-1);
  return id === undefined ? undefined : { id, final: firstFinal };
}

function reachableStates(machine: FlowMachineConfig): Set<string> {
  const reachable = new Set<string>();
  if (!Object.hasOwn(machine.states, machine.initial)) return reachable;
  const queue = [machine.initial];
  reachable.add(machine.initial);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const t of normalizeTransitions(id, machine.states[id]!)) {
      if (!reachable.has(t.target) && Object.hasOwn(machine.states, t.target)) {
        reachable.add(t.target);
        queue.push(t.target);
      }
    }
  }
  return reachable;
}

/** Rebuilds `states` with `id` inserted at `placement`, keeping the declaration order of the others. */
function insertState(
  states: Record<string, FlowStateNodeConfig>,
  id: string,
  node: FlowStateNodeConfig,
  placement: KeyPlacement,
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
