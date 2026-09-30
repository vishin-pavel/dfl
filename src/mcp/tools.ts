/**
 * Implementations of the dfl MCP tools as plain functions over a project (OWNER: mcp agent).
 * server.ts resolves the project and wraps these into MCP results. Every function re-reads the
 * files it needs; nothing is cached between calls. See docs/ARCHITECTURE.md §7.
 */
import path from 'node:path';
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
import { addStep, readStepTemplate, removeStep, updateStep } from '../core/steps.js';
import { syncProject } from '../core/sync.js';
import { titleCase } from '../core/ids.js';
import { validateFlow } from '../core/validate.js';
import { resolveVars } from '../core/vars.js';
import type {
  AgentId,
  FlowModel,
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

export interface FlowView {
  name: string;
  title: string;
  description: string;
  initial: string;
  active: boolean;
  current: string;
  steps: StepSummary[];
  vars: Array<{ name: string; description: string; scope: VarScope; required: boolean; hasValue: boolean }>;
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
    /** `/<skillName>`; null for a final state (it has no skill). */
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
  /** null when the skills were not re-installed (see `warnings`). */
  sync: SyncSummary | null;
  warnings: string[];
}

export interface DeleteStepResult {
  deleted: string;
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

/** `get_flow` */
export function describeFlow(paths: ProjectPaths, flow?: string): FlowView {
  const model = loadFlowOrActive(paths, flow);
  const state = loadRuntimeState(paths, model);
  const { values } = resolveVars(paths, model.def);
  return {
    name: model.name,
    title: model.title,
    description: model.description,
    initial: model.initial,
    active: getActiveFlowName(paths) === model.name,
    current: state.current,
    steps: model.steps.map(stepSummary),
    vars: Object.entries(model.def.vars ?? {}).map(([name, def]) => ({
      name,
      description: def.description ?? '',
      scope: def.scope ?? 'project',
      required: def.required === true,
      hasValue: !isEmptyValue(values[name]),
    })),
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
export function describeStatus(paths: ProjectPaths, flow?: string): StatusView {
  const model = loadFlowOrActive(paths, flow);
  const state = loadRuntimeState(paths, model);
  const step = getStep(model, state.current);
  return {
    flow: model.name,
    flowTitle: model.title,
    current: {
      id: step.id,
      title: step.title,
      description: step.description,
      skillName: step.skillName,
      command: commandFor(step),
      final: step.final,
    },
    done: state.done,
    events: step.transitions.map((t) => {
      const target = model.byId.get(t.target);
      return {
        event: t.event,
        target: t.target,
        targetTitle: target?.title ?? titleCase(t.target),
        targetCommand: target ? commandFor(target) : null,
        ...optionalDescription(t),
      };
    }),
    history: state.history.slice(-STATUS_HISTORY_LIMIT),
    ...(state.repaired !== undefined ? { repaired: state.repaired } : {}),
  };
}

/** `get_step` */
export function describeStep(paths: ProjectPaths, stepId: string, flow?: string): StepDetails {
  const model = loadFlowOrActive(paths, flow);
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
  const model = loadActiveFlow(paths);
  const step = getStep(model, stepId);
  if (step.final) {
    throw new DflError(`"${stepId}" is a final state and has no skill template.`, { code: 'FINAL_STEP' });
  }
  return readStepTemplate(paths, model.name, step.id);
}

// ---------------------------------------------------------------------------
// Runtime tools
// ---------------------------------------------------------------------------

/** `transition` */
export function fireEvent(paths: ProjectPaths, args: { event?: string | undefined; from?: string | undefined; flow?: string | undefined }): TransitionOutcome {
  const model = loadFlowOrActive(paths, args.flow);
  return transitionOutcome(model, sendEvent(paths, model, args.event ?? NEXT_EVENT, { from: args.from }));
}

/** `complete_step` – fails with `NOT_CURRENT` unless `step` is the current step. */
export function completeStep(paths: ProjectPaths, args: { step: string; event?: string | undefined; flow?: string | undefined }): TransitionOutcome {
  const model = loadFlowOrActive(paths, args.flow);
  getStep(model, args.step);
  return transitionOutcome(model, sendEvent(paths, model, args.event ?? NEXT_EVENT, { from: args.step }));
}

/** `goto_step` */
export function jumpToStep(paths: ProjectPaths, args: { step: string; flow?: string | undefined }): TransitionOutcome {
  const model = loadFlowOrActive(paths, args.flow);
  return transitionOutcome(model, gotoStep(paths, model, args.step));
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
  on?: Record<string, string> | undefined;
  template?: string | undefined;
  flow?: string | undefined;
}

export interface UpdateStepArgs {
  step: string;
  title?: string | undefined;
  description?: string | undefined;
  template?: string | undefined;
  rename?: string | undefined;
  on?: Record<string, string | null> | undefined;
  initial?: boolean | undefined;
  flow?: string | undefined;
}

/** `add_step` – writes flow.json and the step directory, then re-installs the skills. */
export async function addStepTool(paths: ProjectPaths, args: AddStepArgs): Promise<StepMutationResult> {
  const flowName = loadFlowOrActive(paths, args.flow).name;
  addStep(paths, flowName, {
    id: args.id,
    title: args.title,
    description: args.description,
    after: args.after,
    before: args.before,
    event: args.event,
    on: args.on,
    template: args.template,
  });
  return finishStepMutation(paths, flowName, args.id);
}

/** `update_step` */
export async function updateStepTool(paths: ProjectPaths, args: UpdateStepArgs): Promise<StepMutationResult> {
  const flowName = loadFlowOrActive(paths, args.flow).name;
  updateStep(paths, flowName, args.step, {
    title: args.title,
    description: args.description,
    template: args.template,
    rename: args.rename,
    on: args.on,
    initial: args.initial,
  });
  return finishStepMutation(paths, flowName, args.rename ?? args.step);
}

/** `delete_step` */
export async function deleteStepTool(
  paths: ProjectPaths,
  args: { step: string; force?: boolean | undefined; flow?: string | undefined },
): Promise<DeleteStepResult> {
  const flowName = loadFlowOrActive(paths, args.flow).name;
  removeStep(paths, flowName, args.step, { force: args.force });
  const warnings: string[] = [];
  const sync = await syncAfterChange(paths, flowName, warnings);
  collectStateWarning(paths, flowName, warnings);
  return { deleted: args.step, sync, warnings: unique(warnings) };
}

/** `sync` – the full report of `dfl flow-update` (non-interactive: missing required vars become warnings). */
export function syncTool(paths: ProjectPaths): Promise<SyncReport> {
  return syncProject(paths);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** User-facing text of an error: DflError message plus its hint. */
export function formatError(error: unknown): string {
  if (isDflError(error)) return error.hint ? `${error.message}\nHint: ${error.hint}` : error.message;
  return errorMessage(error);
}

export function summarizeSync(report: SyncReport): SyncSummary {
  return {
    flow: report.flow,
    agents: report.agents,
    skills: unique(report.skills.map((skill) => skill.name)),
    removed: report.removed,
    warnings: report.warnings,
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

function transitionOutcome(model: FlowModel, result: TransitionResult): TransitionOutcome {
  const next = model.byId.get(result.to);
  return {
    from: result.from,
    to: result.to,
    event: result.event,
    done: result.done,
    next: { id: result.to, title: next?.title ?? titleCase(result.to), command: next ? commandFor(next) : null },
  };
}

async function finishStepMutation(paths: ProjectPaths, flowName: string, stepId: string): Promise<StepMutationResult> {
  const warnings: string[] = [];
  const sync = await syncAfterChange(paths, flowName, warnings);
  collectStateWarning(paths, flowName, warnings);
  const model = loadFlow(paths, flowName);
  return { step: stepDetails(paths, model, getStep(model, stepId)), sync, warnings: unique(warnings) };
}

/**
 * Re-installs the skills after a change of `flowName` when it is the active flow. A sync failure
 * does not undo the change: it is reported as a warning and the summary is null.
 */
async function syncAfterChange(paths: ProjectPaths, flowName: string, warnings: string[]): Promise<SyncSummary | null> {
  const active = getActiveFlowName(paths);
  if (active !== flowName) {
    warnings.push(
      `Flow "${flowName}" is not the active flow${active ? ` (active: "${active}")` : ''}, so no skills were re-installed. ` +
        `Run \`dfl flow use ${flowName}\` to activate it.`,
    );
    return null;
  }
  try {
    const report = await syncProject(paths);
    warnings.push(...report.warnings);
    return summarizeSync(report);
  } catch (error) {
    warnings.push(`The change was saved, but re-installing the skills failed: ${formatError(error)}`);
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

function commandFor(step: StepInfo): string | null {
  return step.final ? null : `/${step.skillName}`;
}

function optionalDescription(t: FlowTransition): { description?: string } {
  return t.description !== undefined ? { description: t.description } : {};
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
