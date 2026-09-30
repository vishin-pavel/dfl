/**
 * Implementations of the dfl MCP tools as plain functions over a project (OWNER: mcp agent).
 * server.ts resolves the project and wraps these into MCP results. Every function re-reads the
 * files it needs; nothing is cached between calls. See docs/ARCHITECTURE.md §7.
 */
import path from 'node:path';
import { dflLauncher } from '../agents/mcp-config.js';
import { getActiveFlowName } from '../core/config.js';
import { DflError, errorMessage, isDflError } from '../core/errors.js';
import {
  NEXT_EVENT,
  SKILL_TEMPLATE_FILE,
  getStep,
  listFlows,
  loadActiveFlow,
  loadFlow,
  loadFlowOrActive,
  readFlowDefinition,
} from '../core/flow.js';
import { readTextIfExists, relPosix, walkFiles } from '../core/fsx.js';
import { gotoStep, loadRuntimeState, sendEvent } from '../core/machine.js';
import { addStep, readStepTemplate, removeStep, updateStep, type StepPlacement, type TransitionInput } from '../core/steps.js';
import { NOT_INSTALLED_MESSAGE, checkFlowSyncState, isInstalledForUser, syncProject, type SyncState } from '../core/sync.js';
import { titleCase } from '../core/ids.js';
import { validateFlow } from '../core/validate.js';
import { resolveVars } from '../core/vars.js';
import type {
  AgentId,
  FlowModel,
  FlowRuntimeState,
  FlowTransition,
  HistoryEntry,
  ProjectPaths,
  StepInfo,
  SyncReport,
  TransitionResult,
  ValidationIssue,
  VarScope,
} from '../core/types.js';

/** Number of history entries `get_status` returns. */
export const STATUS_HISTORY_LIMIT = 10;

// ---------------------------------------------------------------------------
// Call context
// ---------------------------------------------------------------------------

/** How the connected agent invokes a skill: `/name` (default) or `$name` (Codex). */
export type CommandPrefix = '/' | '$';

/** Per-call facts the server knows about the client and the project. */
export interface ToolContext {
  /** Invocation prefix of the connected client (see commandPrefixForClient). Default `/`. */
  commandPrefix?: CommandPrefix | undefined;
  /** How to run the dfl CLI in this project (dflLauncher). Default: computed from the project. */
  cli?: string | undefined;
}

/** `$` for Codex clients (their skills have no slash commands), `/` for everything else. */
export function commandPrefixForClient(clientName: string | undefined): CommandPrefix {
  return clientName !== undefined && /codex/i.test(clientName) ? '$' : '/';
}

/** dflLauncher that never throws (falls back to `dfl`). */
export function cliFor(paths: ProjectPaths | undefined): string {
  if (!paths) return 'dfl';
  try {
    return dflLauncher(paths);
  } catch {
    return 'dfl';
  }
}

/**
 * Rewrites the `` `dfl … `` commands of a message (core errors, hints and sync warnings name the
 * global binary) into the form this project runs dfl with, e.g. `` `npx --no-install dfl … ``.
 */
export function localizeCli(text: string, cli: string): string {
  return cli === 'dfl' ? text : text.replaceAll('`dfl ', `\`${cli} `);
}

// ---------------------------------------------------------------------------
// Result shapes (the JSON contract shared with the skill templates)
// ---------------------------------------------------------------------------

export interface TransitionView {
  event: string;
  target: string;
  description?: string;
}

export interface IncomingView {
  event: string;
  source: string;
  description?: string;
}

export interface StepSummary {
  id: string;
  skillName: string;
  title: string;
  description: string;
  final: boolean;
  index: number;
  transitions: TransitionView[];
}

/** Whether this developer's installed skills match the flow (`.df/installed.json` fingerprint). */
export interface SkillsStatus {
  /** This developer ran `dfl install` (`.df/installed.json` exists). */
  installed: boolean;
  /** The installed skills are the ones of this flow and match its templates, variables and settings. */
  upToDate: boolean;
  /** Set when not up to date: what is wrong (same as `dfl status --json` → `skills.reason`). */
  reason?: string;
  /** Set when not up to date: what is wrong and how to fix it (tell the user). */
  warning?: string;
}

export interface FlowView {
  name: string;
  title: string;
  description: string;
  initial: string;
  active: boolean;
  /** Current step; null when the flow is not a valid state machine (see `problem`). */
  current: string | null;
  steps: StepSummary[];
  vars: Array<{ name: string; description: string; scope: VarScope; required: boolean; hasValue: boolean }>;
  skills: SkillsStatus;
  /** Set when the flow is not a valid state machine: why, and how to repair it. */
  problem?: string;
  /** The validation errors of a broken flow (same as validate_flow). */
  issues?: ValidationIssue[];
}

export interface FlowList {
  active: string | null;
  flows: Array<{ name: string; title: string; description: string; steps: number; error?: string }>;
}

export interface StatusView {
  flow: string;
  flowTitle: string;
  current: {
    id: string;
    title: string;
    description: string;
    skillName: string;
    /** How the user invokes the step's skill (`/<skillName>`, `$<skillName>` for Codex); null for a final state. */
    command: string | null;
    final: boolean;
  };
  done: boolean;
  events: Array<{
    event: string;
    target: string;
    targetTitle: string;
    /** null when the target is a final state. */
    targetCommand: string | null;
    description?: string;
  }>;
  history: HistoryEntry[];
  skills: SkillsStatus;
  repaired?: string;
}

export interface StepDetails extends StepSummary {
  incoming: IncomingView[];
  /** Project-relative path of SKILL.md.hbs; null for final states. */
  templatePath: string | null;
  /** SKILL.md.hbs text (`''` when missing); null for final states. */
  template: string | null;
  /** SKILL.md rendered by the last sync; null when not rendered yet. */
  rendered: string | null;
  /** Files in the step directory, relative to it (posix). */
  files: string[];
}

export interface TransitionOutcome {
  from: string;
  to: string;
  event: string;
  done: boolean;
  next: { id: string; title: string; command: string | null };
  /** Set when the stored step no longer existed and the flow was reset to its initial step first. */
  repaired?: string;
}

/** Compact SyncReport for mutating tool results. */
export interface SyncSummary {
  flow: string;
  agents: AgentId[];
  /** Installed skill names (deduplicated across agent skill dirs). */
  skills: string[];
  removed: string[];
  warnings: string[];
}

export interface StepMutationResult {
  step: StepDetails;
  /** add_step only: where the step was wired in (`auto`: no after/before given, dfl chose the end of the NEXT path). */
  placement?: StepPlacement;
  /** null when the skills were not re-installed (see `warnings`). */
  sync: SyncSummary | null;
  warnings: string[];
}

export interface DeleteStepResult {
  deleted: string;
  /** Incoming transitions now leading to the deleted step's NEXT target. */
  rewired: Array<{ source: string; event: string; to: string }>;
  /** Incoming transitions that were removed instead (no NEXT target, or they would point at their own source). */
  dropped: Array<{ source: string; event: string; description?: string; reason: 'self-loop' | 'no-next' }>;
  sync: SyncSummary | null;
  warnings: string[];
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

/**
 * `get_flow` – also works on a flow that is not a valid state machine (e.g. a transition to a
 * deleted step after a merge): `current` is then null and `problem`/`issues` say what to repair.
 */
export function describeFlow(paths: ProjectPaths, flow?: string, ctx: ToolContext = {}): FlowView {
  const cli = ctx.cli ?? cliFor(paths);
  const model = loadToolFlow(paths, flow);
  const { values } = resolveVars(paths, model.def);
  let current: string | null = null;
  let broken: { problem: string; issues: ValidationIssue[] } | undefined;
  try {
    current = loadRuntimeState(paths, model).current;
  } catch (error) {
    if (!isDflError(error) || error.code !== 'INVALID_FLOW') throw error;
    broken = {
      problem: `${localizeCli(error.message, cli)} ${INVALID_FLOW_MCP_HINT}`,
      issues: validationErrors(paths, model.name),
    };
  }
  return {
    name: model.name,
    title: model.title,
    description: model.description,
    initial: model.initial,
    active: getActiveFlowName(paths) === model.name,
    current,
    steps: model.steps.map(stepSummary),
    vars: Object.entries(model.def.vars ?? {}).map(([name, def]) => ({
      name,
      description: def.description ?? '',
      scope: def.scope ?? 'project',
      required: def.required === true,
      hasValue: !isEmptyValue(values[name]),
    })),
    skills: skillsStatus(paths, model.name, cli),
    ...(broken ?? {}),
  };
}

/** `list_flows` – a flow whose flow.json cannot be read is listed with an `error`. */
export function listFlowsInfo(paths: ProjectPaths): FlowList {
  const flows = listFlows(paths).map((name): FlowList['flows'][number] => {
    try {
      const def = readFlowDefinition(paths, name);
      return {
        name,
        title: def.title ?? titleCase(name),
        description: def.description ?? '',
        steps: Object.values(def.machine.states).filter((state) => state.type !== 'final').length,
      };
    } catch (error) {
      return { name, title: titleCase(name), description: '', steps: 0, error: errorMessage(error) };
    }
  });
  return { active: getActiveFlowName(paths) ?? null, flows };
}

/** `get_status` */
export function describeStatus(paths: ProjectPaths, flow?: string, ctx: ToolContext = {}): StatusView {
  const cli = ctx.cli ?? cliFor(paths);
  const prefix = ctx.commandPrefix ?? '/';
  const model = loadToolFlow(paths, flow);
  const state: FlowRuntimeState = loadRuntimeState(paths, model);
  const step = getStep(model, state.current);
  return {
    flow: model.name,
    flowTitle: model.title,
    current: {
      id: step.id,
      title: step.title,
      description: step.description,
      skillName: step.skillName,
      command: commandFor(step, prefix),
      final: step.final,
    },
    done: state.done,
    events: step.transitions.map((t) => {
      const target = model.byId.get(t.target);
      return {
        event: t.event,
        target: t.target,
        targetTitle: target?.title ?? titleCase(t.target),
        targetCommand: target ? commandFor(target, prefix) : null,
        ...optionalDescription(t),
      };
    }),
    history: state.history.slice(-STATUS_HISTORY_LIMIT),
    skills: skillsStatus(paths, model.name, cli),
    ...(state.repaired !== undefined ? { repaired: state.repaired } : {}),
  };
}

/** `get_step` */
export function describeStep(paths: ProjectPaths, stepId: string, flow?: string): StepDetails {
  const model = loadToolFlow(paths, flow);
  return stepDetails(paths, model, getStep(model, stepId));
}

/** `validate_flow` – works on a broken flow.json too (it is reported as an issue). */
export function validateFlowInfo(paths: ProjectPaths, flow?: string): ValidationResult {
  const name = flow ?? getActiveFlowName(paths) ?? loadActiveFlow(paths).name;
  const issues = validateFlow(paths, name).map((issue) => ({
    ...issue,
    ...(issue.file !== undefined ? { file: relPosix(paths.root, issue.file) } : {}),
  }));
  return { valid: !issues.some((issue) => issue.level === 'error'), issues };
}

/** SKILL.md.hbs text of a step of the active flow (the `dfl://steps/{id}` resource). */
export function stepTemplateText(paths: ProjectPaths, stepId: string): string {
  const model = loadToolFlow(paths);
  const step = getStep(model, stepId);
  if (step.final) {
    throw new DflError(`"${stepId}" is a final state and has no skill template.`, { code: 'FINAL_STEP' });
  }
  return readStepTemplate(paths, model.name, step.id);
}

/**
 * Whether this developer's installed skills are the ones of `flowName` and up to date
 * (checkSyncState / checkFlowSyncState: `.df/installed.json` flow + fingerprint). For a flow that is
 * not active but whose skills are the installed ones (the active flow changed, e.g. the team default
 * after a `git pull`), it says so and suggests `dfl flow-update` or `dfl flow use <flow>`. Never throws.
 */
export function skillsStatus(paths: ProjectPaths, flowName: string, cli: string = cliFor(paths)): SkillsStatus {
  let state: SyncState | undefined;
  try {
    // checkSyncState for the active flow; for another flow, whether its skills are the installed ones.
    state = checkFlowSyncState(paths, flowName);
    if (state === undefined && !isInstalledForUser(paths)) state = { installed: false, upToDate: false };
  } catch (error) {
    return { installed: isInstalledForUser(paths), upToDate: false, warning: `Cannot check the installed skills: ${errorMessage(error)}` };
  }
  if (state === undefined) {
    // Not the active flow, and the installed skills are another flow's.
    let active: string | undefined;
    try {
      active = getActiveFlowName(paths);
    } catch {
      active = undefined;
    }
    return {
      installed: true,
      upToDate: false,
      reason: `flow "${flowName}" is not the active flow`,
      warning:
        `Flow "${flowName}" is not the active flow${active ? ` (active: "${active}")` : ''}, so its steps are not installed ` +
        `as skills. Run \`${cli} flow use ${flowName}\` to switch to it.`,
    };
  }
  if (!state.installed) {
    const reason = localizeCli(NOT_INSTALLED_MESSAGE, cli);
    return { installed: false, upToDate: false, reason, warning: `${capitalize(reason)}.` };
  }
  if (state.upToDate) return { installed: true, upToDate: true };
  const reason = localizeCli(state.reason ?? 'the flow changed since they were installed', cli);
  return {
    installed: true,
    upToDate: false,
    reason,
    warning:
      `The installed skills are out of date: ${reason}. ` +
      (state.fix !== undefined
        ? localizeCli(state.fix, cli)
        : `Run \`${cli} flow-update\` (or call the sync tool) to re-install them.`),
  };
}

// ---------------------------------------------------------------------------
// Runtime tools
// ---------------------------------------------------------------------------

/** `transition` */
export function fireEvent(
  paths: ProjectPaths,
  args: { event?: string | undefined; from?: string | undefined; flow?: string | undefined },
  ctx: ToolContext = {},
): TransitionOutcome {
  const model = loadToolFlow(paths, args.flow);
  const repaired = repairedState(paths, model);
  return transitionOutcome(model, sendEvent(paths, model, args.event ?? NEXT_EVENT, { from: args.from }), ctx, repaired);
}

/**
 * `complete_step` – fails with `NOT_CURRENT` unless `step` is the current step. When the step is
 * unknown or not current and the installed skills are out of date (a stale skill after a pull or a
 * flow switch), the hint says so.
 */
export function completeStep(
  paths: ProjectPaths,
  args: { step: string; event?: string | undefined; flow?: string | undefined },
  ctx: ToolContext = {},
): TransitionOutcome {
  const model = loadToolFlow(paths, args.flow);
  try {
    getStep(model, args.step);
    const repaired = repairedState(paths, model);
    return transitionOutcome(model, sendEvent(paths, model, args.event ?? NEXT_EVENT, { from: args.step }), ctx, repaired);
  } catch (error) {
    if (isDflError(error) && (error.code === 'STEP_NOT_FOUND' || error.code === 'NOT_CURRENT')) {
      const skills = skillsStatus(paths, model.name, ctx.cli ?? cliFor(paths));
      if (skills.installed && !skills.upToDate && skills.warning) {
        throw new DflError(error.message, {
          hint: [error.hint, `The skill you ran may be stale. ${skills.warning}`].filter(Boolean).join(' '),
          code: error.code,
          cause: error,
        });
      }
    }
    throw error;
  }
}

/** `goto_step` */
export function jumpToStep(paths: ProjectPaths, args: { step: string; flow?: string | undefined }, ctx: ToolContext = {}): TransitionOutcome {
  const model = loadToolFlow(paths, args.flow);
  const repaired = repairedState(paths, model);
  return transitionOutcome(model, gotoStep(paths, model, args.step), ctx, repaired);
}

// ---------------------------------------------------------------------------
// Authoring tools
// ---------------------------------------------------------------------------

export interface AddStepArgs {
  id: string;
  title?: string | undefined;
  description?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  event?: string | undefined;
  /** Event → target step id, or `{ target, description }` (the condition for firing the event). */
  on?: Record<string, TransitionInput> | undefined;
  template?: string | undefined;
  flow?: string | undefined;
}

export interface UpdateStepArgs {
  step: string;
  title?: string | undefined;
  description?: string | undefined;
  template?: string | undefined;
  rename?: string | undefined;
  /**
   * Event → target (retargets, keeps the description), `{ target, description }` (sets both;
   * `description: ''` removes it) or null (removes the event).
   */
  on?: Record<string, TransitionInput | null> | undefined;
  initial?: boolean | undefined;
  flow?: string | undefined;
}

/** `add_step` – writes flow.json and the step directory, then re-installs the skills. */
export async function addStepTool(paths: ProjectPaths, args: AddStepArgs, ctx: ToolContext = {}): Promise<StepMutationResult> {
  const flowName = loadToolFlow(paths, args.flow).name;
  const result = addStep(paths, flowName, {
    id: args.id,
    title: args.title,
    description: args.description,
    after: args.after,
    before: args.before,
    event: args.event,
    on: args.on,
    template: args.template,
  });
  const done = await finishStepMutation(paths, flowName, args.id, ctx, remainingErrorWarnings(result.remainingErrors));
  return { ...done, placement: result.placement };
}

/** `update_step` */
export async function updateStepTool(paths: ProjectPaths, args: UpdateStepArgs, ctx: ToolContext = {}): Promise<StepMutationResult> {
  const flowName = loadToolFlow(paths, args.flow).name;
  const result = updateStep(paths, flowName, args.step, {
    title: args.title,
    description: args.description,
    template: args.template,
    rename: args.rename,
    on: args.on,
    initial: args.initial,
  });
  return finishStepMutation(paths, flowName, args.rename ?? args.step, ctx, remainingErrorWarnings(result.remainingErrors));
}

/** `delete_step` */
export async function deleteStepTool(
  paths: ProjectPaths,
  args: { step: string; force?: boolean | undefined; flow?: string | undefined },
  ctx: ToolContext = {},
): Promise<DeleteStepResult> {
  const flowName = loadToolFlow(paths, args.flow).name;
  const result = removeStep(paths, flowName, args.step, { force: args.force });
  const warnings: string[] = [];
  if (result.currentMoved) {
    warnings.push(`"${result.currentMoved.from}" was the current step; the flow now continues at "${result.currentMoved.to}".`);
  }
  if (result.initialMoved) {
    warnings.push(`"${result.initialMoved.from}" was the initial step; the flow now starts at "${result.initialMoved.to}".`);
  }
  for (const t of result.dropped) {
    warnings.push(
      `Removed the transition ${t.source} —${t.event}→ ${t.target}${t.description ? ` ("${t.description}")` : ''}: ` +
        (t.reason === 'self-loop' ? `rerouting it would point "${t.source}" at itself.` : `"${t.target}" had no NEXT target to reroute it to.`),
    );
  }
  warnings.push(...remainingErrorWarnings(result.remainingErrors));
  const sync = await syncAfterChange(paths, flowName, warnings, ctx.cli ?? cliFor(paths));
  collectStateWarning(paths, flowName, warnings);
  return {
    deleted: args.step,
    rewired: result.rewired.map((t) => ({ source: t.source, event: t.event, to: t.to })),
    dropped: result.dropped.map((t) => ({
      source: t.source,
      event: t.event,
      ...(t.description !== undefined ? { description: t.description } : {}),
      reason: t.reason,
    })),
    sync,
    warnings: unique(warnings),
  };
}

/**
 * `sync` – the full report of `dfl flow-update` (non-interactive: missing required vars become
 * warnings). Like flow-update it always syncs, also for a developer who never ran `dfl install`.
 * The personal MCP preference (`dfl install --no-mcp`) is honoured by syncProject.
 */
export async function syncTool(paths: ProjectPaths, ctx: ToolContext = {}): Promise<SyncReport> {
  const cli = ctx.cli ?? cliFor(paths);
  loadToolFlow(paths); // an unloadable flow.json gets the right hint (syncProject would report it too)
  const report = await syncProject(paths);
  return { ...report, warnings: report.warnings.map((warning) => localizeCli(warning, cli)) };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * What MCP agents should do for a flow that loads but is not valid (a transition to a missing step,
 * a validation error): get_flow still shows it and update_step can repair it. The CLI hint names
 * `dfl flow validate`.
 */
export const INVALID_FLOW_MCP_HINT =
  'Call validate_flow to list the problems, then fix them with update_step (get_flow still shows the flow).';

/**
 * What MCP agents should do when flow.json itself cannot be loaded (schema error, `name` that differs
 * from the directory, an unusable step id): no tool can open the flow, so the file is edited directly.
 */
export function invalidFlowFileMcpHint(flow: string | undefined): string {
  const file = flow ? `.df/${flow}/flow.json` : 'the flow.json file';
  return (
    `get_flow and update_step cannot open this flow until ${file} loads: edit ${file} directly as the error says, ` +
    'then call validate_flow to check it.'
  );
}

/** INVALID_FLOW errors raised while loading flow.json itself (see loadToolFlow) → the flow they concern. */
const flowFileErrors = new WeakMap<object, string | undefined>();

/**
 * loadFlowOrActive for tools: an INVALID_FLOW error from reading flow.json itself is remembered, so
 * its hint does not promise that get_flow or update_step can repair the flow (they cannot load it either).
 */
function loadToolFlow(paths: ProjectPaths, flow?: string): FlowModel {
  try {
    return loadFlowOrActive(paths, flow);
  } catch (error) {
    if (isDflError(error) && error.code === 'INVALID_FLOW') {
      let name = flow;
      try {
        name ??= getActiveFlowName(paths);
      } catch {
        // keep undefined
      }
      flowFileErrors.set(error, name);
    }
    throw error;
  }
}

/** MCP-side alternatives appended to core hints that only name CLI commands. */
function mcpHintFor(error: DflError): string | undefined {
  switch (error.code) {
    case 'INVALID_FLOW':
      return flowFileErrors.has(error) ? invalidFlowFileMcpHint(flowFileErrors.get(error)) : INVALID_FLOW_MCP_HINT;
    case 'FLOW_DONE':
      return 'Over MCP: call goto_step to jump to a step.';
    case 'EVENT_NOT_ALLOWED':
      return error.hint?.includes('goto') ? 'Over MCP: call goto_step.' : undefined;
    default:
      return undefined;
  }
}

/** The hint of an error as MCP clients see it: CLI commands localized, MCP alternatives appended. */
export function errorHint(error: unknown, cli = 'dfl'): string | undefined {
  if (!isDflError(error)) return undefined;
  const parts = [error.hint, mcpHintFor(error)].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return undefined;
  return localizeCli(parts.join(' '), cli);
}

/** User-facing text of an error: DflError message plus its hint (`cli` localizes CLI commands). */
export function formatError(error: unknown, cli = 'dfl'): string {
  if (isDflError(error)) {
    const hint = errorHint(error, cli);
    const message = localizeCli(error.message, cli);
    return hint ? `${message}\nHint: ${hint}` : message;
  }
  return errorMessage(error);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function summarizeSync(report: SyncReport, cli = 'dfl'): SyncSummary {
  return {
    flow: report.flow,
    agents: report.agents,
    skills: unique(report.skills.map((skill) => skill.name)),
    removed: report.removed,
    warnings: report.warnings.map((warning) => localizeCli(warning, cli)),
  };
}

function stepSummary(step: StepInfo): StepSummary {
  return {
    id: step.id,
    skillName: step.skillName,
    title: step.title,
    description: step.description,
    final: step.final,
    index: step.index,
    transitions: step.transitions.map((t) => ({ event: t.event, target: t.target, ...optionalDescription(t) })),
  };
}

function stepDetails(paths: ProjectPaths, model: FlowModel, step: StepInfo): StepDetails {
  const templateFile = path.join(step.dir, SKILL_TEMPLATE_FILE);
  return {
    ...stepSummary(step),
    incoming: step.incoming.map((t) => ({ event: t.event, source: t.source, ...optionalDescription(t) })),
    templatePath: step.final ? null : relPosix(paths.root, templateFile),
    template: step.final ? null : readStepTemplate(paths, model.name, step.id),
    rendered: step.final ? null : (readTextIfExists(path.join(step.dir, 'SKILL.md')) ?? null),
    files: walkFiles(step.dir),
  };
}

function transitionOutcome(model: FlowModel, result: TransitionResult, ctx: ToolContext, repaired?: string): TransitionOutcome {
  const next = model.byId.get(result.to);
  return {
    from: result.from,
    to: result.to,
    event: result.event,
    done: result.done,
    next: {
      id: result.to,
      title: next?.title ?? titleCase(result.to),
      command: next ? commandFor(next, ctx.commandPrefix ?? '/') : null,
    },
    ...(repaired !== undefined ? { repaired } : {}),
  };
}

/** Why the stored step was replaced by the initial step before a move (undefined when it was fine). */
function repairedState(paths: ProjectPaths, model: FlowModel): string | undefined {
  try {
    return loadRuntimeState(paths, model).repaired;
  } catch {
    return undefined;
  }
}

async function finishStepMutation(
  paths: ProjectPaths,
  flowName: string,
  stepId: string,
  ctx: ToolContext,
  initialWarnings: string[] = [],
): Promise<StepMutationResult> {
  const warnings: string[] = [...initialWarnings];
  const sync = await syncAfterChange(paths, flowName, warnings, ctx.cli ?? cliFor(paths));
  collectStateWarning(paths, flowName, warnings);
  const model = loadFlow(paths, flowName);
  return { step: stepDetails(paths, model, getStep(model, stepId)), sync, warnings: unique(warnings) };
}

/**
 * Re-installs the skills after a change of `flowName` when it is the active flow and this developer
 * installed dfl (`.df/installed.json` exists; otherwise the change must not install anything). A sync
 * failure does not undo the change: it is reported as a warning and the summary is null.
 */
async function syncAfterChange(paths: ProjectPaths, flowName: string, warnings: string[], cli: string): Promise<SyncSummary | null> {
  const active = getActiveFlowName(paths);
  if (active !== flowName) {
    warnings.push(
      `Flow "${flowName}" is not the active flow${active ? ` (active: "${active}")` : ''}, so no skills were re-installed. ` +
        `Run \`${cli} flow use ${flowName}\` to activate it.`,
    );
    return null;
  }
  if (!isInstalledForUser(paths)) {
    warnings.push(`The change was saved, but no skills were synced (${localizeCli(NOT_INSTALLED_MESSAGE, cli)}).`);
    return null;
  }
  try {
    const report = await syncProject(paths);
    const summary = summarizeSync(report, cli);
    warnings.push(...summary.warnings);
    return summary;
  } catch (error) {
    warnings.push(`The change was saved, but re-installing the skills failed: ${formatError(error, cli)}`);
    return null;
  }
}

/** Reports when the flow's current step no longer exists (e.g. it was deleted or renamed away). */
function collectStateWarning(paths: ProjectPaths, flowName: string, warnings: string[]): void {
  try {
    const repaired = loadRuntimeState(paths, loadFlow(paths, flowName)).repaired;
    if (repaired) warnings.push(repaired);
  } catch {
    // The change itself succeeded; validation problems are reported by the sync.
  }
}

/** Errors the flow already had before a mutation and still has (the mutation added none). */
function remainingErrorWarnings(errors: ValidationIssue[]): string[] {
  if (errors.length === 0) return [];
  return [
    `The flow still has ${errors.length} validation error${errors.length === 1 ? '' : 's'} (skills cannot be installed until they are fixed): ` +
      errors.map((issue) => issue.message).join(' '),
  ];
}

/** Error-level issues of validate_flow (never throws). */
function validationErrors(paths: ProjectPaths, flowName: string): ValidationIssue[] {
  try {
    return validateFlowInfo(paths, flowName).issues.filter((issue) => issue.level === 'error');
  } catch {
    return [];
  }
}

function commandFor(step: StepInfo, prefix: CommandPrefix): string | null {
  return step.final ? null : `${prefix}${step.skillName}`;
}

function optionalDescription(t: FlowTransition): { description?: string } {
  return t.description !== undefined ? { description: t.description } : {};
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
