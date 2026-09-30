import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DflError } from './errors.js';
import { copyDir, ensureDir, exists, isDir, isFile, listDirs, lstatOrUndefined, readJson, readJsonIfExists, removePath, writeJson, writeText } from './fsx.js';
import { assertValidFlowName, assertValidStepId, isValidFlowName, isValidId, titleCase } from './ids.js';
import { flowTemplatesDir } from './paths.js';
import { getActiveFlowName, loadLocalConfig, loadProjectConfig, saveLocalConfig, saveProjectConfig } from './config.js';
import { invalidFlowError, validateDefinition } from './validate.js';
import type {
  FlowDefinition,
  FlowMachineConfig,
  FlowModel,
  FlowSource,
  FlowStateNodeConfig,
  FlowTransition,
  ProjectPaths,
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
      commit: z.string().optional(),
    })
    .optional(),
  machine: z.looseObject({
    id: z.string().optional(),
    initial: z.string().min(1),
    description: z.string().optional(),
    states: z.record(z.string(), stateNodeSchema),
  }),
});

/**
 * Parses and structurally validates flow.json content. Returns the input object itself (the schema
 * has no transforms or defaults), so key order – and therefore the committed file's diff – is kept
 * when the definition is written back.
 */
export function parseFlowDefinition(data: unknown, file = 'flow.json'): FlowDefinition {
  const result = flowDefinitionSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new DflError(`Invalid flow definition in ${file}: ${details}`, { code: 'INVALID_FLOW' });
  }
  return data as FlowDefinition;
}

// ---------------------------------------------------------------------------
// Listing, reading, writing
// ---------------------------------------------------------------------------

/** Flow names: directories under `.df/` with a valid flow name that contain flow.json (sorted). */
export function listFlows(paths: ProjectPaths): string[] {
  return listDirs(paths.dfDir).filter((name) => isValidFlowName(name) && exists(paths.flowFile(name)));
}

/** True when `.df/<name>/flow.json` exists; always false for invalid flow names. */
export function flowExists(paths: ProjectPaths, name: string): boolean {
  return isValidFlowName(name) && exists(paths.flowFile(name));
}

/**
 * Reads `.df/<name>/flow.json`. Throws INVALID_NAME for an invalid name, FLOW_NOT_FOUND when it is
 * missing and INVALID_FLOW when its `name` differs from the directory name.
 */
export function readFlowDefinition(paths: ProjectPaths, name: string): FlowDefinition {
  assertValidFlowName(name);
  const file = paths.flowFile(name);
  if (!exists(file)) {
    throw new DflError(`Flow "${name}" not found (${file} does not exist).`, {
      hint: 'List flows with `dfl flow list`.',
      code: 'FLOW_NOT_FOUND',
    });
  }
  const def = parseFlowDefinition(readJson(file), file);
  if (def.name !== name) {
    throw new DflError(`Flow name "${def.name}" in .df/${name}/flow.json does not match its directory "${name}".`, {
      hint: `Set "name": "${name}" in .df/${name}/flow.json, or rename the directory to .df/${def.name}/.`,
      code: 'INVALID_FLOW',
    });
  }
  return def;
}

/** Writes `.df/<name>/flow.json` (`name` defaults to `def.name`; both must agree and be a valid flow name). */
export function writeFlowDefinition(paths: ProjectPaths, def: FlowDefinition, name: string = def.name): void {
  assertValidFlowName(name);
  if (def.name !== name) {
    throw new DflError(`Cannot write flow "${def.name}" into .df/${name}/: the names differ.`, { code: 'INVALID_FLOW' });
  }
  writeJson(paths.flowFile(name), def);
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
 * Flow order: the declaration order of `machine.states`, with the initial state moved first and
 * final states moved last (stable). Branches and shortcuts therefore never reorder the main path.
 */
export function orderStates(machine: FlowMachineConfig): string[] {
  const keys = Object.keys(machine.states);
  const initial = Object.hasOwn(machine.states, machine.initial) ? machine.initial : undefined;
  const rest = keys.filter((key) => key !== initial);
  const isFinal = (key: string): boolean => machine.states[key]?.type === 'final';
  return [...(initial === undefined ? [] : [initial]), ...rest.filter((key) => !isFinal(key)), ...rest.filter(isFinal)];
}

/** Pure: derives the flow model from a definition. */
export function buildFlowModel(def: FlowDefinition, dir: string): FlowModel {
  const { machine } = def;
  for (const id of Object.keys(machine.states)) {
    // Step ids become directory names: never let one point outside steps/.
    if (id === '' || id === '.' || id === '..' || /[/\\\0]/.test(id)) {
      throw new DflError(`Invalid step id "${id}" in flow "${def.name}".`, {
        hint: 'Step ids use lowercase letters, digits and single hyphens.',
        code: 'INVALID_FLOW',
      });
    }
  }
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

/** A flow copied into a hidden staging dir under `.df/`, ready to be moved into place. */
export interface StagedFlow {
  name: string;
  /** Staging directory (`.df/.dfl-stage-*`, never a valid flow name). */
  dir: string;
  def: FlowDefinition;
}

/**
 * Copies a flow directory (containing flow.json) into a staging dir under `.df/`, rewriting the
 * definition name/id and recording its source. Rendered `.md` files under steps/, VCS metadata and
 * symlinks are skipped. Throws INVALID_NAME for an invalid `name` and INVALID_SOURCE when the source
 * and `.df/<name>` overlap (same directory, or one inside the other). Nothing outside the staging dir
 * is touched; finish with {@link commitStagedFlow} and always {@link discardStagedFlow}.
 */
export function stageFlowCopy(paths: ProjectPaths, srcDir: string, name: string, source?: FlowSource): StagedFlow {
  assertValidFlowName(name);
  const src = path.resolve(srcDir);
  const file = path.join(src, 'flow.json');
  if (!isFile(file)) {
    throw new DflError(`No flow.json found in ${srcDir}.`, { code: 'FLOW_NOT_FOUND' });
  }
  assertNoOverlap(paths, src, name);
  const def = parseFlowDefinition(readJson(file), file);
  const next = renamedDefinition(def, name, source);
  buildFlowModel(next, paths.flowDir(name)); // rejects unsafe step ids before anything is copied
  const stage = makeStagingDir(paths);
  try {
    copyDir(src, stage, (rel) => {
      const parts = rel.split('/');
      if (parts.some((part) => part === '.git' || part === 'node_modules')) return false;
      if (rel === 'flow.json') return false;
      if (parts[0] === 'steps' && rel.endsWith('.md')) return false;
      return true;
    });
    writeJson(path.join(stage, 'flow.json'), next);
  } catch (error) {
    removePath(stage);
    throw error;
  }
  return { name, dir: stage, def: next };
}

/**
 * Moves a staged flow to `.df/<name>`. An existing flow directory is replaced only with
 * `replace` (FLOW_EXISTS otherwise); the swap goes through a backup so a failure leaves the old
 * flow in place. Runtime state and active-flow settings (keyed by name) are untouched.
 */
export function commitStagedFlow(paths: ProjectPaths, staged: StagedFlow, replace = false): FlowModel {
  const target = paths.flowDir(staged.name);
  const existing = lstatOrUndefined(target);
  if (existing && !replace) {
    // A leftover dir with nothing but rendered output (e.g. after switching git branches) is reused.
    if (!existing.isDirectory() || !onlyRenderedOutput(target)) {
      throw new DflError(
        flowExists(paths, staged.name) ? `Flow "${staged.name}" already exists.` : `.df/${staged.name}/ already exists (without a flow.json).`,
        { hint: 'Pick another name, or replace it (`--force`).', code: 'FLOW_EXISTS' },
      );
    }
    removePath(target);
  }
  if (existing && replace) {
    const backup = path.join(paths.dfDir, `.dfl-backup-${staged.name}-${randomBytes(4).toString('hex')}`);
    fs.renameSync(target, backup);
    try {
      fs.renameSync(staged.dir, target);
    } catch (error) {
      fs.renameSync(backup, target);
      throw error;
    }
    try {
      removePath(backup);
    } catch {
      // the new flow is in place; a leftover hidden backup is harmless
    }
  } else {
    fs.renameSync(staged.dir, target);
  }
  return buildFlowModel(staged.def, target);
}

/** Removes a staging dir that was not committed (no-op after a commit). */
export function discardStagedFlow(staged: StagedFlow): void {
  removePath(staged.dir);
}

/**
 * Copies a flow directory (containing flow.json) into `.df/<name>`, rewriting the definition
 * name/id and recording its source. Rendered `.md` files under steps/, VCS metadata and symlinks
 * are skipped. Fails when the target flow exists, unless `replace` (then the flow is swapped
 * atomically: on any error the existing flow stays untouched).
 */
export function copyFlowFromDir(
  paths: ProjectPaths,
  srcDir: string,
  name: string,
  source?: FlowSource,
  options: { replace?: boolean | undefined } = {},
): FlowModel {
  assertValidFlowName(name);
  if (!options.replace && flowExists(paths, name)) {
    throw new DflError(`Flow "${name}" already exists.`, { hint: 'Pick another name with --name.', code: 'FLOW_EXISTS' });
  }
  const staged = stageFlowCopy(paths, srcDir, name, source);
  try {
    return commitStagedFlow(paths, staged, options.replace ?? false);
  } finally {
    discardStagedFlow(staged);
  }
}

export interface CreateFlowOptions {
  /** Prebuilt template name to copy. */
  from?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  /** Step ids for a blank flow (linear, NEXT transitions, final `done`). Default: [`<name>-step`]. */
  steps?: string[] | undefined;
}

/**
 * Creates `.df/<name>` from a template or as a blank linear flow. A blank flow is validated before
 * anything is written (INVALID_FLOW, e.g. a step named like a built-in skill); nothing is left
 * behind on failure.
 */
export function createFlow(paths: ProjectPaths, name: string, options: CreateFlowOptions = {}): FlowModel {
  assertValidFlowName(name);
  if (flowExists(paths, name)) {
    throw new DflError(`Flow "${name}" already exists.`, { code: 'FLOW_EXISTS' });
  }
  if (options.from) {
    const template = getFlowTemplate(options.from);
    const staged = stageFlowCopy(paths, template.dir, name, { type: 'template', ref: template.name });
    try {
      if (options.title || options.description) {
        staged.def = {
          ...staged.def,
          ...(options.title ? { title: options.title } : {}),
          ...(options.description ? { description: options.description } : {}),
        };
        writeJson(path.join(staged.dir, 'flow.json'), staged.def);
      }
      return commitStagedFlow(paths, staged);
    } finally {
      discardStagedFlow(staged);
    }
  }

  const stepIds = options.steps && options.steps.length > 0 ? options.steps : [`${name}-step`];
  for (const id of stepIds) assertValidStepId(id);
  if (new Set(stepIds).size !== stepIds.length) throw new DflError('Step ids must be unique.', { code: 'INVALID_NAME' });
  const finalId = finalStateId(stepIds);
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
  const errors = validateDefinition(def, name).filter((issue) => issue.level === 'error');
  if (errors.length > 0) throw invalidFlowError(name, errors);

  const staged: StagedFlow = { name, dir: makeStagingDir(paths), def };
  try {
    writeJson(path.join(staged.dir, 'flow.json'), def);
    for (const id of stepIds) {
      writeText(path.join(staged.dir, 'steps', id, SKILL_TEMPLATE_FILE), defaultStepTemplate({ title: titleCase(id) }));
    }
    return commitStagedFlow(paths, staged);
  } finally {
    discardStagedFlow(staged);
  }
}

/**
 * Deletes `.df/<name>` and clears references to it in config.json, local.json and state.json.
 * The name is validated first (INVALID_NAME) so nothing outside `.df/<flow>` can ever be removed;
 * the bookkeeping runs before the directory is removed, and a corrupt state.json is ignored.
 */
export function deleteFlow(paths: ProjectPaths, name: string): void {
  assertValidFlowName(name);
  const dir = paths.flowDir(name);
  if (path.dirname(path.resolve(dir)) !== path.resolve(paths.dfDir)) {
    throw new DflError(`Invalid flow name "${name}".`, { code: 'INVALID_NAME' });
  }
  if (!isDir(dir) || !flowExists(paths, name)) {
    throw new DflError(`Flow "${name}" not found.`, { hint: 'List flows with `dfl flow list`.', code: 'FLOW_NOT_FOUND' });
  }
  const project = loadProjectConfig(paths);
  const local = exists(paths.localFile) ? loadLocalConfig(paths) : undefined;
  if (project.activeFlow === name) saveProjectConfig(paths, { ...project, activeFlow: undefined });
  if (local?.activeFlow === name) saveLocalConfig(paths, { ...local, activeFlow: undefined });
  removeFlowState(paths, name);
  removePath(dir);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Creates an empty staging dir `.df/.dfl-stage-<random>` (never a valid flow name). It is renamed
 * into place as the flow dir, so it is made with `mkdir` and gets the permissions the umask gives
 * (mkdtemp would always create it with mode 0700, hiding the flow from other users and CI jobs).
 */
function makeStagingDir(paths: ProjectPaths): string {
  ensureDir(paths.dfDir);
  for (;;) {
    const dir = path.join(paths.dfDir, `.dfl-stage-${randomBytes(6).toString('hex')}`);
    try {
      fs.mkdirSync(dir);
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/** True when `dir` holds only directories and rendered `steps/**\/*.md` files (git-ignored dfl output). */
function onlyRenderedOutput(dir: string): boolean {
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const rel = path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep);
    if (!entry.isFile() || rel[0] !== 'steps' || rel.length < 3 || !entry.name.endsWith('.md')) return false;
  }
  return true;
}

/** `done`, or `done-2`, `done-3`, … when a step already uses that id. */
function finalStateId(stepIds: string[]): string {
  if (!stepIds.includes('done')) return 'done';
  for (let n = 2; ; n++) {
    const id = `done-${n}`;
    if (!stepIds.includes(id) && isValidId(id)) return id;
  }
}

/** `def` with `name`/`machine.id` set to `name` and `source` recorded, keeping the key order. */
function renamedDefinition(def: FlowDefinition, name: string, source: FlowSource | undefined): FlowDefinition {
  const out: Record<string, unknown> = {};
  const hadSource = Object.hasOwn(def, 'source');
  for (const [key, value] of Object.entries(def)) {
    if (key === 'machine' && source && !hadSource) out['source'] = source;
    if (key === 'name') out[key] = name;
    else if (key === 'machine') out[key] = { ...def.machine, id: name };
    else if (key === 'source' && source) out[key] = source;
    else out[key] = value;
  }
  if (source && !Object.hasOwn(out, 'source')) out['source'] = source;
  return out as unknown as FlowDefinition;
}

/** INVALID_SOURCE when `src` and `.df/<name>` are the same directory or one contains the other. */
function assertNoOverlap(paths: ProjectPaths, src: string, name: string): void {
  const realSrc = realpathOr(src);
  const target = paths.flowDir(name);
  const realTarget = exists(target) ? realpathOr(target) : path.join(realpathOr(paths.dfDir), name);
  if (isInsideOrEqual(realSrc, realTarget) || isInsideOrEqual(realTarget, realSrc)) {
    throw new DflError(`Cannot import ${src} as flow "${name}": the source overlaps .df/${name}/.`, {
      hint: "The source is this project's own flow directory; there is nothing to import.",
      code: 'INVALID_SOURCE',
    });
  }
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    // a missing path: resolve its closest existing ancestor
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realpathOr(parent), path.basename(p));
  }
}

/** True when `child` equals `parent` or lies inside it. */
function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Drops `flows[name]` from state.json; a missing or corrupt file is left alone (machine.ts rewrites it). */
function removeFlowState(paths: ProjectPaths, name: string): void {
  let state: unknown;
  try {
    state = readJsonIfExists(paths.stateFile);
  } catch {
    return;
  }
  if (!isRecord(state)) return;
  const flows = state['flows'];
  if (!isRecord(flows) || !Object.hasOwn(flows, name)) return;
  delete flows[name];
  writeJson(paths.stateFile, state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
