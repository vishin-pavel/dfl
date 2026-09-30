/**
 * Flow validation (OWNER: flow-engine agent). See docs/ARCHITECTURE.md §2.1.
 */
import path from 'node:path';
import { DflError, errorMessage } from './errors.js';
import { SKILL_TEMPLATE_FILE, normalizeTransitions, parseFlowDefinition, skillNameFor } from './flow.js';
import { exists, isFile, listDirs, readJson, walkFiles } from './fsx.js';
import { RESERVED_FLOW_NAMES, isValidId } from './ids.js';
import { createFlowMachine } from './machine.js';
import type { FlowDefinition, FlowStateNodeConfig, ProjectPaths, ValidationIssue } from './types.js';

/** Skills dfl installs next to every flow's step skills; step skill names must not collide with them. */
export const BUILTIN_SKILL_NAMES: readonly string[] = ['add-flow-step', 'edit-flow-step', 'delete-flow-step'];

/** Built-in slash commands of common coding agents; a step skill with such a name is shadowed or confusing. */
export const AGENT_COMMAND_NAMES: readonly string[] = [
  'review',
  'init',
  'plan',
  'help',
  'clear',
  'compact',
  'config',
  'memory',
  'model',
  'status',
  'skills',
  'mcp',
  'agents',
  'resume',
  'cost',
  'doctor',
  'login',
  'logout',
  'permissions',
  'tools',
];

/** State node keys that configure xstate features dfl does not support. */
const UNSUPPORTED_STATE_KEYS = ['states', 'initial', 'always', 'after', 'entry', 'exit', 'invoke', 'onDone', 'onError'];
/** Machine (root) keys that configure xstate features dfl does not support. */
const UNSUPPORTED_MACHINE_KEYS = ['type', 'on', 'always', 'after', 'entry', 'exit', 'invoke', 'onDone'];
/** Transition object keys that configure xstate features dfl does not support. */
const UNSUPPORTED_TRANSITION_KEYS = ['guard', 'cond', 'actions'];

/** Pure checks on a definition (no file system): ids, targets, unsupported xstate features, xstate createMachine, reachability. */
export function validateDefinition(def: FlowDefinition, expectedName?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (message: string, step?: string): void => {
    issues.push({ level: 'error', message, step });
  };
  const warning = (message: string, step?: string): void => {
    issues.push({ level: 'warning', message, step });
  };

  if (expectedName !== undefined && def.name !== expectedName) {
    error(`Flow name "${def.name}" does not match its directory name "${expectedName}".`);
  }
  if (!isValidId(def.name)) {
    error(`Invalid flow name "${def.name}": use lowercase letters, digits and single hyphens, max 64 characters.`);
  } else if (RESERVED_FLOW_NAMES.has(def.name)) {
    error(`"${def.name}" is a reserved name and cannot be used as a flow name.`);
  }

  for (const key of UNSUPPORTED_MACHINE_KEYS) {
    if (def.machine && Object.hasOwn(def.machine, key)) {
      error(`The machine uses "${key}", which dfl does not support (flows are flat: atomic and final states only).`);
    }
  }
  const states: Record<string, FlowStateNodeConfig> = def.machine?.states ?? {};
  const keys = Object.keys(states);
  const initial = def.machine?.initial;
  if (keys.length === 0) error('The flow has no states.');
  else if (!initial || !Object.hasOwn(states, initial)) {
    error(`Initial step "${initial ?? ''}" does not exist (states: ${keys.join(', ')}).`);
  }

  const skillNames = new Map<string, string>();
  for (const id of keys) {
    const node = states[id]!;
    const final = node.type === 'final';
    if (!isValidId(id)) {
      error(`Invalid step id "${id}": use lowercase letters, digits and single hyphens, max 64 characters.`, id);
    }
    checkStateNode(id, node, states, error);

    if (final) continue;
    const skillName = skillNameFor(def, id);
    if (isValidId(id) && !isValidId(skillName)) {
      error(`Invalid skill name "${skillName}" for step "${id}" (skillPrefix "${def.skillPrefix ?? ''}").`, id);
    }
    const other = skillNames.get(skillName);
    if (other !== undefined) error(`Steps "${other}" and "${id}" have the same skill name "${skillName}".`, id);
    else skillNames.set(skillName, id);
    if (BUILTIN_SKILL_NAMES.includes(skillName)) {
      error(`Skill name "${skillName}" of step "${id}" collides with a built-in dfl skill.`, id);
    } else if (AGENT_COMMAND_NAMES.includes(skillName)) {
      warning(`Skill name "${skillName}" of step "${id}" equals a built-in command of some coding agents (/${skillName}); consider a more specific name.`, id);
    }
  }

  // xstate reports only the first problem and in its own words, so it runs only on otherwise clean definitions.
  if (issues.some((issue) => issue.level === 'error')) return issues;
  try {
    createFlowMachine(def);
  } catch (e) {
    error(errorMessage(e));
    return issues;
  }

  // Reachability (initial exists here).
  const reachable = new Set<string>([initial]);
  const queue = [initial];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const t of normalizeTransitions(id, states[id]!)) {
      if (!reachable.has(t.target)) {
        reachable.add(t.target);
        queue.push(t.target);
      }
    }
  }
  for (const id of keys) {
    if (!reachable.has(id)) warning(`Step "${id}" is unreachable from the initial step "${initial}".`, id);
  }
  if (![...reachable].some((id) => states[id]!.type === 'final')) {
    warning(
      keys.some((id) => states[id]!.type === 'final')
        ? `No final state is reachable from the initial step "${initial}"; the flow can never complete.`
        : 'The flow has no final state (`"type": "final"`); it can never complete.',
    );
  }
  for (const id of keys) {
    const node = states[id]!;
    if (node.type !== 'final' && normalizeTransitions(id, node).length === 0) {
      warning(`Step "${id}" has no outgoing transitions (dead end).`, id);
    }
  }
  return issues;
}

/** Full validation of `.df/<name>`: parse + validateDefinition + step directories/templates + stray files. */
export function validateFlow(paths: ProjectPaths, name: string): ValidationIssue[] {
  const file = paths.flowFile(name);
  if (!exists(file)) {
    return [{ level: 'error', message: `Flow "${name}" not found (${file} does not exist).`, file }];
  }
  let def: FlowDefinition;
  try {
    def = parseFlowDefinition(readJson(file), file);
  } catch (e) {
    return [{ level: 'error', message: errorMessage(e), file }];
  }

  const issues = validateDefinition(def, name).map((issue) => ({ ...issue, file: issue.file ?? file }));
  const states = def.machine.states;
  const stepsDir = paths.stepsDir(name);

  for (const [id, node] of Object.entries(states)) {
    if (!isValidId(id)) continue; // already reported; never build paths from invalid ids
    const dir = paths.stepDir(name, id);
    if (node.type === 'final') {
      if (exists(dir)) {
        issues.push({
          level: 'warning',
          message: `Final state "${id}" has a steps/${id} directory; final states have no skill, so it is ignored.`,
          step: id,
          file: dir,
        });
      }
      continue;
    }
    const template = path.join(dir, SKILL_TEMPLATE_FILE);
    if (!isFile(template)) {
      issues.push({
        level: 'error',
        message: `Step "${id}" has no template (steps/${id}/${SKILL_TEMPLATE_FILE} is missing).`,
        step: id,
        file: template,
      });
    }
  }

  for (const dir of listDirs(stepsDir)) {
    if (!Object.hasOwn(states, dir)) {
      issues.push({
        level: 'warning',
        message: `Directory steps/${dir} does not belong to any step (no state "${dir}" in flow.json); it is ignored.`,
        file: path.join(stepsDir, dir),
      });
    }
  }

  for (const rel of walkFiles(stepsDir)) {
    if (!rel.endsWith('.md')) continue;
    const abs = path.join(stepsDir, ...rel.split('/'));
    if (isFile(`${abs}.hbs`)) continue;
    const step = rel.split('/')[0];
    issues.push({
      level: 'warning',
      message:
        `steps/${rel} has no ${path.posix.basename(rel)}.hbs template: .md files under steps/ are treated as ` +
        `generated output (git-ignored and overwritten). Rename it to ${path.posix.basename(rel)}.hbs to keep it.`,
      step: step !== undefined && Object.hasOwn(states, step) ? step : undefined,
      file: abs,
    });
  }
  return issues;
}

/** Throws a DflError (code `INVALID_FLOW`) listing all errors if validateFlow reports any error. Returns warnings. */
export function assertFlowValid(paths: ProjectPaths, name: string): ValidationIssue[] {
  const issues = validateFlow(paths, name);
  const errors = issues.filter((issue) => issue.level === 'error');
  if (errors.length > 0) throw invalidFlowError(name, errors);
  return issues.filter((issue) => issue.level === 'warning');
}

/** The DflError (code `INVALID_FLOW`) used for a list of validation errors. */
export function invalidFlowError(name: string, errors: ValidationIssue[]): DflError {
  const lines = errors.map((issue) => `  - ${issue.message}`).join('\n');
  return new DflError(`Flow "${name}" is invalid:\n${lines}`, {
    hint: `Fix .df/${name}/flow.json and the step templates, then run \`dfl flow validate ${name}\`.`,
    code: 'INVALID_FLOW',
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function checkStateNode(
  id: string,
  node: FlowStateNodeConfig,
  states: Record<string, FlowStateNodeConfig>,
  error: (message: string, step?: string) => void,
): void {
  if (node.type !== undefined && node.type !== 'final') {
    error(`Step "${id}" has unsupported type "${String(node.type)}" (only "final" is supported).`, id);
  }
  for (const key of UNSUPPORTED_STATE_KEYS) {
    if (Object.hasOwn(node, key)) {
      error(`Step "${id}" uses "${key}", which dfl does not support (flows are flat: atomic and final states only).`, id);
    }
  }
  if (node.on === undefined) return;
  if (!node.on || typeof node.on !== 'object' || Array.isArray(node.on)) {
    error(`Step "${id}" has an invalid "on" (expected an object of event → target).`, id);
    return;
  }
  if (node.type === 'final') {
    if (Object.keys(node.on).length > 0) error(`Final state "${id}" must not have transitions ("on").`, id);
    return;
  }
  for (const [event, value] of Object.entries(node.on)) {
    const label = `Transition "${event}" of step "${id}"`;
    if (event.trim() === '' || /\s/.test(event)) error(`Step "${id}" has an invalid event name "${event}".`, id);
    else if (event.includes('*')) error(`${label} uses a wildcard event, which dfl does not support.`, id);
    else if (event.startsWith('xstate.')) error(`${label} uses a reserved xstate event name.`, id);

    let target: unknown;
    if (typeof value === 'string') target = value;
    else if (Array.isArray(value)) {
      error(`${label} is an array; only a target string or { "target", "description" } is supported.`, id);
      continue;
    } else if (value && typeof value === 'object') {
      for (const key of UNSUPPORTED_TRANSITION_KEYS) {
        if (Object.hasOwn(value, key)) error(`${label} uses "${key}", which dfl does not support.`, id);
      }
      target = (value as { target?: unknown }).target;
    }
    if (typeof target !== 'string' || target === '') {
      error(`${label} has no target.`, id);
    } else if (!Object.hasOwn(states, target)) {
      error(`${label} targets "${target}", which does not exist.`, id);
    }
  }
}
