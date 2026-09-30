import path from 'node:path';
import { z } from 'zod';
import { DflError } from './errors.js';
import { copyDir, exists, isDir, listDirs, readJson, readJsonIfExists, removePath, writeJson, writeText } from './fsx.js';
import { assertValidFlowName, assertValidStepId, titleCase } from './ids.js';
import { flowTemplatesDir } from './paths.js';
import { getActiveFlowName, loadLocalConfig, loadProjectConfig, saveLocalConfig, saveProjectConfig } from './config.js';
import type {
  FlowDefinition,
  FlowMachineConfig,
  FlowModel,
  FlowSource,
  FlowStateNodeConfig,
  FlowTransition,
  ProjectPaths,
  StateFile,
  StepInfo,
} from './types.js';

/** The template file every non-final step must have. */
export const SKILL_TEMPLATE_FILE = 'SKILL.md.hbs';
/** The conventional forward event. */
export const NEXT_EVENT = 'NEXT';

// ---------------------------------------------------------------------------
// Schema (structure only – semantic checks live in validate.ts)
// ---------------------------------------------------------------------------

const transitionSchema = z.union([
  z.string().min(1),
  z.looseObject({ target: z.string().min(1), description: z.string().optional() }),
]);

const stateNodeSchema = z.looseObject({
  description: z.string().optional(),
  meta: z.looseObject({ title: z.string().optional() }).optional(),
  on: z.record(z.string(), z.union([transitionSchema, z.array(z.unknown())])).optional(),
  type: z.string().optional(),
});

export const flowDefinitionSchema = z.looseObject({
  $schema: z.string().optional(),
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  skillPrefix: z.string().optional(),
  vars: z
    .record(
      z.string(),
      z.looseObject({
        description: z.string().optional(),
        default: z.union([z.string(), z.number(), z.boolean()]).optional(),
        scope: z.enum(['project', 'personal']).optional(),
        required: z.boolean().optional(),
      }),
    )
    .optional(),
  source: z
    .looseObject({
      type: z.enum(['template', 'git', 'local', 'created']),
      ref: z.string().optional(),
      path: z.string().optional(),
      rev: z.string().optional(),
    })
    .optional(),
  machine: z.looseObject({
    id: z.string().optional(),
    initial: z.string().min(1),
    description: z.string().optional(),
    states: z.record(z.string(), stateNodeSchema),
  }),
});

/** Parses and structurally validates flow.json content. */
export function parseFlowDefinition(data: unknown, file = 'flow.json'): FlowDefinition {
  const result = flowDefinitionSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new DflError(`Invalid flow definition in ${file}: ${details}`, { code: 'INVALID_FLOW' });
  }
  return result.data as unknown as FlowDefinition;
}

// ---------------------------------------------------------------------------
// Listing, reading, writing
// ---------------------------------------------------------------------------

/** Flow names: directories under `.df/` containing flow.json (sorted). */
export function listFlows(paths: ProjectPaths): string[] {
  return listDirs(paths.dfDir).filter((name) => exists(paths.flowFile(name)));
}

export function flowExists(paths: ProjectPaths, name: string): boolean {
  return exists(paths.flowFile(name));
}

export function readFlowDefinition(paths: ProjectPaths, name: string): FlowDefinition {
  const file = paths.flowFile(name);
  if (!exists(file)) {
    throw new DflError(`Flow "${name}" not found (${file} does not exist).`, {
      hint: 'List flows with `dfl flow list`.',
      code: 'FLOW_NOT_FOUND',
    });
  }
  return parseFlowDefinition(readJson(file), file);
}

export function writeFlowDefinition(paths: ProjectPaths, def: FlowDefinition): void {
  writeJson(paths.flowFile(def.name), def);
}

export function loadFlow(paths: ProjectPaths, name: string): FlowModel {
  return buildFlowModel(readFlowDefinition(paths, name), paths.flowDir(name));
}

/** Loads the active flow; throws a helpful DflError when there is none. */
export function loadActiveFlow(paths: ProjectPaths): FlowModel {
  const name = getActiveFlowName(paths);
  if (!name) {
    const flows = listFlows(paths);
    throw new DflError(flows.length === 0 ? 'This project has no flows yet.' : 'No active flow is selected.', {
      hint: flows.length === 0 ? 'Run `dfl install` or `dfl flow create <name>`.' : `Run \`dfl flow use <name>\` (available: ${flows.join(', ')}).`,
      code: 'NO_ACTIVE_FLOW',
    });
  }
  return loadFlow(paths, name);
}

/** Resolves `name` or falls back to the active flow. */
export function loadFlowOrActive(paths: ProjectPaths, name?: string): FlowModel {
  return name ? loadFlow(paths, name) : loadActiveFlow(paths);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export function skillNameFor(def: Pick<FlowDefinition, 'skillPrefix'>, stepId: string): string {
  return `${def.skillPrefix ?? ''}${stepId}`;
}

/** Outgoing transitions of a state in declaration order (array-form transitions are skipped). */
export function normalizeTransitions(source: string, node: FlowStateNodeConfig): FlowTransition[] {
  const out: FlowTransition[] = [];
  for (const [event, value] of Object.entries(node.on ?? {})) {
    if (typeof value === 'string') out.push({ event, source, target: value });
    else if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.target === 'string') {
      out.push({ event, source, target: value.target, description: value.description });
    }
  }
  return out;
}

/**
 * Flow order: BFS from `initial`, following `NEXT` first and then other events in
 * declaration order; unreachable states follow in declaration order.
 */
export function orderStates(machine: FlowMachineConfig): string[] {
  const keys = Object.keys(machine.states);
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [];
  if (machine.states[machine.initial]) {
    queue.push(machine.initial);
    seen.add(machine.initial);
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    const transitions = normalizeTransitions(id, machine.states[id]!);
    transitions.sort((a, b) => Number(b.event === NEXT_EVENT) - Number(a.event === NEXT_EVENT));
    for (const t of transitions) {
      if (!seen.has(t.target) && machine.states[t.target]) {
        seen.add(t.target);
        queue.push(t.target);
      }
    }
  }
  for (const key of keys) if (!seen.has(key)) order.push(key);
  return order;
}

/** Pure: derives the flow model from a definition. */
export function buildFlowModel(def: FlowDefinition, dir: string): FlowModel {
  const { machine } = def;
  const order = orderStates(machine);
  const transitions: FlowTransition[] = [];
  for (const [id, node] of Object.entries(machine.states)) transitions.push(...normalizeTransitions(id, node));
  const steps: StepInfo[] = order.map((id, index) => {
    const node = machine.states[id]!;
    return {
      id,
      skillName: skillNameFor(def, id),
      title: node.meta?.title ?? titleCase(id),
      description: node.description ?? '',
      final: node.type === 'final',
      index,
      transitions: transitions.filter((t) => t.source === id),
      incoming: transitions.filter((t) => t.target === id),
      dir: path.join(dir, 'steps', id),
    };
  });
  return {
    def,
    name: def.name,
    title: def.title ?? titleCase(def.name),
    description: def.description ?? '',
    dir,
    initial: machine.initial,
    steps,
    byId: new Map(steps.map((step) => [step.id, step])),
    transitions,
  };
}

export function getStep(model: FlowModel, stepId: string): StepInfo {
  const step = model.byId.get(stepId);
  if (!step) {
    throw new DflError(`Step "${stepId}" does not exist in flow "${model.name}".`, {
      hint: `Steps: ${model.steps.map((s) => s.id).join(', ')}`,
      code: 'STEP_NOT_FOUND',
    });
  }
  return step;
}

/** Non-final steps (the ones that have skills), in flow order. */
export function skillSteps(model: FlowModel): StepInfo[] {
  return model.steps.filter((step) => !step.final);
}

// ---------------------------------------------------------------------------
// Templates, creation, copying, deletion
// ---------------------------------------------------------------------------

/** Body of a new step's SKILL.md.hbs (frontmatter is generated by dfl at render time). */
export function defaultStepTemplate(step: { title: string; description?: string | undefined }): string {
  return [
    `# {{step.title}}`,
    '',
    // Standalone block lines are dropped by Handlebars: no blank gap when the step has no description.
    '{{#if step.description}}',
    '{{step.description}}',
    '',
    '{{/if}}',
    '## Instructions',
    '',
    `<!-- Describe what the agent must do in the "${step.title}" step. -->`,
    '1. Confirm the goal of this step with the user if it is unclear.',
    '2. Do the work.',
    '3. Summarize the result.',
    '',
    '## Done when',
    '',
    '- The outcome of this step is written down and the user agrees it is complete.',
    '',
    '{{> flow-context}}',
    '',
  ].join('\n');
}

export interface FlowTemplateInfo {
  name: string;
  title: string;
  description: string;
  steps: number;
  dir: string;
}

/** Prebuilt flow templates shipped in the package (`templates/flows/*`). */
export function listFlowTemplates(): FlowTemplateInfo[] {
  const root = flowTemplatesDir();
  return listDirs(root)
    .filter((name) => exists(path.join(root, name, 'flow.json')))
    .map((name) => {
      const def = parseFlowDefinition(readJson(path.join(root, name, 'flow.json')), path.join(root, name, 'flow.json'));
      return {
        name,
        title: def.title ?? titleCase(name),
        description: def.description ?? '',
        steps: Object.values(def.machine.states).filter((s) => s.type !== 'final').length,
        dir: path.join(root, name),
      };
    });
}

export function getFlowTemplate(name: string): FlowTemplateInfo {
  const template = listFlowTemplates().find((t) => t.name === name);
  if (!template) {
    throw new DflError(`Unknown flow template "${name}".`, {
      hint: `Available templates: ${listFlowTemplates().map((t) => t.name).join(', ') || '(none)'}`,
      code: 'TEMPLATE_NOT_FOUND',
    });
  }
  return template;
}

/**
 * Copies a flow directory (containing flow.json) into `.df/<name>`, rewriting the
 * definition name/id and recording its source. Rendered `.md` files under steps/
 * and VCS metadata are skipped. Fails when the target flow exists.
 */
export function copyFlowFromDir(paths: ProjectPaths, srcDir: string, name: string, source?: FlowSource): FlowModel {
  assertValidFlowName(name);
  if (!exists(path.join(srcDir, 'flow.json'))) {
    throw new DflError(`No flow.json found in ${srcDir}.`, { code: 'FLOW_NOT_FOUND' });
  }
  if (flowExists(paths, name)) {
    throw new DflError(`Flow "${name}" already exists.`, { hint: 'Pick another name with --name.', code: 'FLOW_EXISTS' });
  }
  const def = parseFlowDefinition(readJson(path.join(srcDir, 'flow.json')), path.join(srcDir, 'flow.json'));
  const target = paths.flowDir(name);
  copyDir(srcDir, target, (rel) => {
    const parts = rel.split('/');
    if (parts.some((part) => part === '.git' || part === 'node_modules')) return false;
    if (rel === 'flow.json') return false;
    if (parts[0] === 'steps' && rel.endsWith('.md')) return false;
    return true;
  });
  const next: FlowDefinition = {
    ...def,
    name,
    machine: { ...def.machine, id: name },
    ...(source ? { source } : {}),
  };
  writeFlowDefinition(paths, next);
  return buildFlowModel(next, target);
}

export interface CreateFlowOptions {
  /** Prebuilt template name to copy. */
  from?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  /** Step ids for a blank flow (linear, NEXT transitions, final `done`). Default: [`<name>-step`]. */
  steps?: string[] | undefined;
}

/** Creates `.df/<name>` from a template or as a blank linear flow. */
export function createFlow(paths: ProjectPaths, name: string, options: CreateFlowOptions = {}): FlowModel {
  assertValidFlowName(name);
  if (flowExists(paths, name)) {
    throw new DflError(`Flow "${name}" already exists.`, { code: 'FLOW_EXISTS' });
  }
  if (options.from) {
    const template = getFlowTemplate(options.from);
    const model = copyFlowFromDir(paths, template.dir, name, { type: 'template', ref: template.name });
    if (options.title || options.description) {
      const def: FlowDefinition = {
        ...model.def,
        ...(options.title ? { title: options.title } : {}),
        ...(options.description ? { description: options.description } : {}),
      };
      writeFlowDefinition(paths, def);
      return buildFlowModel(def, model.dir);
    }
    return model;
  }

  const stepIds = options.steps && options.steps.length > 0 ? options.steps : [`${name}-step`];
  for (const id of stepIds) assertValidStepId(id);
  if (new Set(stepIds).size !== stepIds.length) throw new DflError('Step ids must be unique.', { code: 'INVALID_NAME' });
  const finalId = stepIds.includes('done') ? `${name}-done` : 'done';
  const states: Record<string, FlowStateNodeConfig> = {};
  stepIds.forEach((id, i) => {
    states[id] = {
      description: `${titleCase(id)} step of the ${options.title ?? titleCase(name)} flow.`,
      meta: { title: titleCase(id) },
      on: { [NEXT_EVENT]: stepIds[i + 1] ?? finalId },
    };
  });
  states[finalId] = { type: 'final', description: 'Flow complete.' };
  const def: FlowDefinition = {
    name,
    title: options.title ?? titleCase(name),
    description: options.description ?? '',
    version: '1.0.0',
    skillPrefix: '',
    vars: {},
    source: { type: 'created' },
    machine: { id: name, initial: stepIds[0]!, states },
  };
  writeFlowDefinition(paths, def);
  for (const id of stepIds) {
    writeText(path.join(paths.stepDir(name, id), SKILL_TEMPLATE_FILE), defaultStepTemplate({ title: titleCase(id) }));
  }
  return buildFlowModel(def, paths.flowDir(name));
}

/** Deletes `.df/<name>` and clears references to it in config.json, local.json and state.json. */
export function deleteFlow(paths: ProjectPaths, name: string): void {
  if (!isDir(paths.flowDir(name)) || !flowExists(paths, name)) {
    throw new DflError(`Flow "${name}" not found.`, { code: 'FLOW_NOT_FOUND' });
  }
  removePath(paths.flowDir(name));
  const project = loadProjectConfig(paths);
  if (project.activeFlow === name) saveProjectConfig(paths, { ...project, activeFlow: undefined });
  if (exists(paths.localFile)) {
    const local = loadLocalConfig(paths);
    if (local.activeFlow === name) saveLocalConfig(paths, { ...local, activeFlow: undefined });
  }
  const state = readJsonIfExists<StateFile>(paths.stateFile);
  if (state?.flows?.[name]) {
    delete state.flows[name];
    writeJson(paths.stateFile, state);
  }
}
