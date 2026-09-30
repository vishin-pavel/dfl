/**
 * Flow validation (OWNER: flow-engine agent). See docs/ARCHITECTURE.md §2.1.
 */
import path from 'node:path';
import { DflError, errorMessage } from './errors.js';
import { SKILL_TEMPLATE_FILE, normalizeTransitions, parseFlowDefinition, skillNameFor } from './flow.js';
import { exists, isFile, listDirs, readJson, readText, walkFiles } from './fsx.js';
import { RESERVED_FLOW_NAMES, isValidId } from './ids.js';
import { createFlowMachine } from './machine.js';
import { createHandlebars, type HandlebarsEnv } from './render.js';
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
/** Transition object keys dfl accepts (`meta` is inert xstate metadata). Anything else is an error. */
const SUPPORTED_TRANSITION_KEYS = new Set(['target', 'description', 'meta']);
/** Only these files under steps/ are templates (see render.ts). */
const TEMPLATE_SUFFIX = '.md.hbs';
/** Same compile options as render.ts. */
const COMPILE_OPTIONS = { noEscape: true, strict: false } as const;

/** A validation issue plus a stable identity (kind + ids) used to tell old errors from new ones. */
interface KeyedIssue extends ValidationIssue {
  key: string;
}

/** Pure checks on a definition (no file system): ids, targets, unsupported xstate features, xstate createMachine, reachability. */
export function validateDefinition(def: FlowDefinition, expectedName?: string): ValidationIssue[] {
  return definitionIssues(def, expectedName).map(({ level, message, step }) => ({ level, message, step }));
}

/**
 * Compares the errors of two versions of a definition (before/after an edit). `added` are errors
 * `after` has that `before` did not; `remaining` are errors both have. Errors are matched by kind and
 * the ids involved (not by message text), so a changed state list or a renamed step (`rename`) does not
 * make an old error look new.
 */
export function diffDefinitionErrors(
  before: FlowDefinition,
  after: FlowDefinition,
  expectedName?: string,
  rename?: { from: string; to: string } | undefined,
): { added: ValidationIssue[]; remaining: ValidationIssue[] } {
  const errorsOf = (def: FlowDefinition): KeyedIssue[] => definitionIssues(def, expectedName).filter((i) => i.level === 'error');
  const renameKey = (key: string): string =>
    rename === undefined
      ? key
      : key
          .split(KEY_SEPARATOR)
          .map((part) => (part === rename.from ? rename.to : part))
          .join(KEY_SEPARATOR);
  const known = new Map<string, number>();
  for (const issue of errorsOf(before)) {
    const key = renameKey(issue.key);
    known.set(key, (known.get(key) ?? 0) + 1);
  }
  const added: ValidationIssue[] = [];
  const remaining: ValidationIssue[] = [];
  for (const { key, level, message, step } of errorsOf(after)) {
    const count = known.get(key) ?? 0;
    if (count > 0) {
      known.set(key, count - 1);
      remaining.push({ level, message, step });
    } else {
      added.push({ level, message, step });
    }
  }
  return { added, remaining };
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

  let env: TemplateCheckEnv | undefined;
  try {
    env = templateCheckEnv(paths, name);
  } catch (e) {
    issues.push({ level: 'error', message: `Cannot load the partials of flow "${name}": ${errorMessage(e)}`, file: paths.partialsDir(name) });
  }

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
    if (!env) continue;
    for (const rel of walkFiles(dir)) {
      if (!rel.endsWith(TEMPLATE_SUFFIX)) continue;
      const abs = path.join(dir, ...rel.split('/'));
      for (const message of checkTemplateSource(readText(abs), `steps/${id}/${rel}`, env)) {
        issues.push({ level: 'error', message, step: id, file: abs });
      }
    }
  }

  if (env) {
    const partialsDir = paths.partialsDir(name);
    for (const rel of walkFiles(partialsDir)) {
      if (!rel.endsWith('.hbs')) continue;
      const abs = path.join(partialsDir, ...rel.split('/'));
      for (const message of checkTemplateSource(readText(abs), `partials/${rel}`, env)) {
        issues.push({ level: 'error', message, file: abs });
      }
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
    const abs = path.join(stepsDir, ...rel.split('/'));
    const step = rel.split('/')[0];
    const stepOf = step !== undefined && Object.hasOwn(states, step) ? step : undefined;
    if (rel.endsWith('.hbs') && !rel.endsWith(TEMPLATE_SUFFIX)) {
      issues.push({
        level: 'warning',
        message:
          `steps/${rel} is ignored: only *${TEMPLATE_SUFFIX} templates are rendered, and other .hbs files are not copied ` +
          `into the skill. Rename it to *${TEMPLATE_SUFFIX} if it is Markdown, or drop the .hbs extension to copy it verbatim.`,
        step: stepOf,
        file: abs,
      });
      continue;
    }
    if (!rel.endsWith('.md')) continue;
    if (isFile(`${abs}.hbs`)) continue;
    issues.push({
      level: 'warning',
      message:
        `steps/${rel} has no ${path.posix.basename(rel)}.hbs template: .md files under steps/ are treated as ` +
        `generated output (git-ignored and overwritten). Rename it to ${path.posix.basename(rel)}.hbs to keep it.`,
      step: stepOf,
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
// Templates
// ---------------------------------------------------------------------------

/** What template checks need: the dfl Handlebars environment and the partial names it knows. */
export interface TemplateCheckEnv {
  hb: HandlebarsEnv;
  partials: ReadonlySet<string>;
}

/** The environment templates of `flow` are rendered with: dfl helpers, built-in partials and `.df/<flow>/partials`. */
export function templateCheckEnv(paths: ProjectPaths, flow: string): TemplateCheckEnv {
  const hb = createHandlebars({ partialsDirs: [paths.partialsDir(flow)] });
  return { hb, partials: new Set(Object.keys(hb.partials)) };
}

/**
 * Problems of one template source, as messages starting with `displayPath`: a Handlebars syntax error
 * (with its line) or partials (`{{> name}}`) that do not exist. Empty when the template compiles.
 */
export function checkTemplateSource(source: string, displayPath: string, env: TemplateCheckEnv): string[] {
  let ast: unknown;
  try {
    ast = env.hb.parse(source);
    // The compiler reports a few errors the parser does not (e.g. partials with too many arguments).
    env.hb.precompile(source, COMPILE_OPTIONS);
  } catch (error) {
    return [templateSyntaxMessage(displayPath, error)];
  }
  const known = [...env.partials].sort();
  return [...referencedPartials(ast)]
    .filter((name) => !env.partials.has(name))
    .map(
      (name) =>
        `${displayPath} uses the partial {{> ${name}}}, which does not exist ` +
        `(known partials: ${known.join(', ') || '(none)'}; a flow partial lives in partials/${name}.hbs).`,
    );
}

/** One-line description of a Handlebars parse/compile error. */
function templateSyntaxMessage(displayPath: string, error: unknown): string {
  const raw = errorMessage(error);
  const lines = raw.split('\n');
  const first = lines[0] ?? '';
  const lineNumber = (error as { lineNumber?: unknown } | null)?.lineNumber;
  const lineMatch = /\bon line (\d+)/.exec(first) ?? / - (\d+):\d+$/.exec(first);
  const line = typeof lineNumber === 'number' ? lineNumber : lineMatch ? Number(lineMatch[1]) : undefined;
  const head = first
    .replace(/ on line \d+:$/, '')
    .replace(/ on line \d+\./, '.')
    .replace(/ - \d+:\d+$/, '')
    .trim();
  const caret = lines.findIndex((l) => /^-*\^$/.test(l));
  let detail = head;
  if (caret > 0) {
    const rest = lines
      .slice(caret + 1)
      .join(' ')
      .trim();
    detail = `${head}${rest ? ` (${rest})` : ''} near "${lines[caret - 1]!.trim()}"`;
  }
  return `${displayPath}${line === undefined ? '' : `, line ${line}`}: Handlebars syntax error: ${detail}`;
}

/** Names of the partials a template renders with `{{> name}}` (not partial blocks, which have a fallback, nor its inline partials). */
function referencedPartials(ast: unknown): Set<string> {
  const used = new Set<string>();
  const inline = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n['type'] === 'PartialStatement') {
      const name = literalPartialName(n['name']);
      if (name !== undefined) used.add(name);
    } else if (n['type'] === 'DecoratorBlock' && (n['path'] as { original?: unknown } | undefined)?.original === 'inline') {
      const first = (n['params'] as Array<{ type?: unknown; value?: unknown }> | undefined)?.[0];
      if (first?.type === 'StringLiteral' && typeof first.value === 'string') inline.add(first.value);
    }
    for (const [key, value] of Object.entries(n)) {
      if (key !== 'loc' && value && typeof value === 'object') visit(value);
    }
  };
  visit(ast);
  for (const name of inline) used.delete(name);
  return used;
}

/** `{{> name}}` / `{{> "name"}}`; undefined for dynamic (`{{> (expr)}}`) and `@partial-block` partials. */
function literalPartialName(name: unknown): string | undefined {
  const n = name as { type?: unknown; original?: unknown; value?: unknown; data?: unknown } | undefined;
  if (n?.type === 'PathExpression' && !n.data && typeof n.original === 'string') return n.original;
  if (n?.type === 'StringLiteral' && typeof n.value === 'string') return n.value;
  return undefined;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const KEY_SEPARATOR = '\u001f';
const issueKey = (...parts: string[]): string => parts.join(KEY_SEPARATOR);

function definitionIssues(def: FlowDefinition, expectedName?: string): KeyedIssue[] {
  const issues: KeyedIssue[] = [];
  const error = (key: string, message: string, step?: string): void => {
    issues.push({ level: 'error', message, step, key });
  };
  const warning = (key: string, message: string, step?: string): void => {
    issues.push({ level: 'warning', message, step, key });
  };

  if (expectedName !== undefined && def.name !== expectedName) {
    error(issueKey('flow-name-mismatch'), `Flow name "${def.name}" does not match its directory name "${expectedName}".`);
  }
  if (!isValidId(def.name)) {
    error(issueKey('flow-name'), `Invalid flow name "${def.name}": use lowercase letters, digits and single hyphens, max 64 characters.`);
  } else if (RESERVED_FLOW_NAMES.has(def.name)) {
    error(issueKey('flow-name-reserved'), `"${def.name}" is a reserved name and cannot be used as a flow name.`);
  }

  for (const key of UNSUPPORTED_MACHINE_KEYS) {
    if (def.machine && Object.hasOwn(def.machine, key)) {
      error(
        issueKey('machine-key', key),
        `The machine uses "${key}", which dfl does not support (flows are flat: atomic and final states only).`,
      );
    }
  }
  const states: Record<string, FlowStateNodeConfig> = def.machine?.states ?? {};
  const keys = Object.keys(states);
  const initial = def.machine?.initial;
  if (keys.length === 0) error(issueKey('no-states'), 'The flow has no states.');
  else if (!initial || !Object.hasOwn(states, initial)) {
    error(issueKey('initial-missing', initial ?? ''), `Initial step "${initial ?? ''}" does not exist (states: ${keys.join(', ')}).`);
  } else if (states[initial]!.type === 'final' && keys.some((id) => states[id]!.type !== 'final')) {
    // A flow of final states only (no steps yet) legitimately starts at one of them.
    error(
      issueKey('initial-final', initial),
      `Initial step "${initial}" is a final state, so the flow would start complete; make a step the initial one.`,
      initial,
    );
  }

  const skillNames = new Map<string, string>();
  for (const id of keys) {
    const node = states[id]!;
    const final = node.type === 'final';
    if (!isValidId(id)) {
      error(issueKey('step-id', id), `Invalid step id "${id}": use lowercase letters, digits and single hyphens, max 64 characters.`, id);
    }
    checkStateNode(id, node, states, error);

    if (final) continue;
    const skillName = skillNameFor(def, id);
    if (isValidId(id) && !isValidId(skillName)) {
      error(issueKey('skill-name', id), `Invalid skill name "${skillName}" for step "${id}" (skillPrefix "${def.skillPrefix ?? ''}").`, id);
    }
    const other = skillNames.get(skillName);
    if (other !== undefined) error(issueKey('skill-name-dup', other, id), `Steps "${other}" and "${id}" have the same skill name "${skillName}".`, id);
    else skillNames.set(skillName, id);
    if (BUILTIN_SKILL_NAMES.includes(skillName)) {
      error(issueKey('skill-name-builtin', id), `Skill name "${skillName}" of step "${id}" collides with a built-in dfl skill.`, id);
    } else if (AGENT_COMMAND_NAMES.includes(skillName)) {
      warning(
        issueKey('skill-name-command', id),
        `Skill name "${skillName}" of step "${id}" equals a built-in command of some coding agents (/${skillName}); consider a more specific name.`,
        id,
      );
    }
  }

  // xstate reports only the first problem and in its own words, so it runs only on otherwise clean definitions.
  if (issues.some((issue) => issue.level === 'error')) return issues;
  try {
    createFlowMachine(def);
  } catch (e) {
    error(issueKey('xstate'), errorMessage(e));
    return issues;
  }

  // Reachability (initial exists here).
  const reachable = new Set<string>([initial!]);
  const queue = [initial!];
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
    if (!reachable.has(id)) warning(issueKey('unreachable', id), `Step "${id}" is unreachable from the initial step "${initial}".`, id);
  }
  if (![...reachable].some((id) => states[id]!.type === 'final')) {
    warning(
      issueKey('no-final'),
      keys.some((id) => states[id]!.type === 'final')
        ? `No final state is reachable from the initial step "${initial}"; the flow can never complete.`
        : 'The flow has no final state (`"type": "final"`); it can never complete.',
    );
  }
  for (const id of keys) {
    const node = states[id]!;
    if (node.type !== 'final' && normalizeTransitions(id, node).length === 0) {
      warning(issueKey('dead-end', id), `Step "${id}" has no outgoing transitions (dead end).`, id);
    }
  }
  return issues;
}

function checkStateNode(
  id: string,
  node: FlowStateNodeConfig,
  states: Record<string, FlowStateNodeConfig>,
  error: (key: string, message: string, step?: string) => void,
): void {
  if (node.type !== undefined && node.type !== 'final') {
    error(issueKey('state-type', id), `Step "${id}" has unsupported type "${String(node.type)}" (only "final" is supported).`, id);
  }
  for (const key of UNSUPPORTED_STATE_KEYS) {
    if (Object.hasOwn(node, key)) {
      error(
        issueKey('state-key', id, key),
        `Step "${id}" uses "${key}", which dfl does not support (flows are flat: atomic and final states only).`,
        id,
      );
    }
  }
  if (node.on === undefined) return;
  if (!node.on || typeof node.on !== 'object' || Array.isArray(node.on)) {
    error(issueKey('on-invalid', id), `Step "${id}" has an invalid "on" (expected an object of event → target).`, id);
    return;
  }
  if (node.type === 'final') {
    if (Object.keys(node.on).length > 0) error(issueKey('final-on', id), `Final state "${id}" must not have transitions ("on").`, id);
    return;
  }
  for (const [event, value] of Object.entries(node.on)) {
    const label = `Transition "${event}" of step "${id}"`;
    if (event.trim() === '' || /\s/.test(event)) error(issueKey('event-name', id, event), `Step "${id}" has an invalid event name "${event}".`, id);
    else if (event.includes('*')) error(issueKey('event-wildcard', id, event), `${label} uses a wildcard event, which dfl does not support.`, id);
    else if (event.startsWith('xstate.')) error(issueKey('event-reserved', id, event), `${label} uses a reserved xstate event name.`, id);

    let target: unknown;
    if (typeof value === 'string') target = value;
    else if (Array.isArray(value)) {
      error(
        issueKey('transition-array', id, event),
        `${label} is an array; only a target string or { "target", "description" } is supported.`,
        id,
      );
      continue;
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (UNSUPPORTED_TRANSITION_KEYS.includes(key)) {
          error(issueKey('transition-key', id, event, key), `${label} uses "${key}", which dfl does not support.`, id);
        } else if (!SUPPORTED_TRANSITION_KEYS.has(key)) {
          error(
            issueKey('transition-key', id, event, key),
            `${label} has an unsupported key "${key}" (only "target" and "description" are supported).`,
            id,
          );
        }
      }
      target = (value as { target?: unknown }).target;
    }
    if (typeof target !== 'string' || target === '') {
      error(issueKey('transition-no-target', id, event), `${label} has no target.`, id);
    } else if (!Object.hasOwn(states, target)) {
      error(issueKey('target-missing', id, event, target), `${label} targets "${target}", which does not exist.`, id);
    }
  }
}
