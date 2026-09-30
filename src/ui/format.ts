/**
 * Formatting of dfl domain objects (flows, steps, sync reports, validation issues) for the terminal.
 * Pure: returns strings, never prints.
 */
import { getAgent } from '../agents/registry.js';
import { skillSteps } from '../core/flow.js';
import type { AgentId, FlowModel, FlowRuntimeState, StepInfo, SyncReport, ValidationIssue } from '../core/types.js';
import { c } from './colors.js';
import { plural, sym, wrapItems } from './output.js';

export type StepStatus = 'done' | 'current' | 'upcoming';

/**
 * Status of every non-final step in flow order: steps before the current one are done, the rest
 * upcoming. A finished flow (current is final) has every step done. The same order is used for
 * branching flows (see `orderStates`).
 */
export function stepStatuses(model: FlowModel, state: FlowRuntimeState): Array<{ step: StepInfo; status: StepStatus }> {
  const currentIndex = model.byId.get(state.current)?.index ?? -1;
  return skillSteps(model).map((step) => {
    if (state.done) return { step, status: 'done' as const };
    if (step.id === state.current) return { step, status: 'current' as const };
    return { step, status: step.index < currentIndex ? ('done' as const) : ('upcoming' as const) };
  });
}

/** `✔ Spec → ● Plan → ○ Build`, wrapped to `max` columns. */
export function progressChain(model: FlowModel, state: FlowRuntimeState, max: number): string[] {
  const items = stepStatuses(model, state).map(({ step, status }) => {
    if (status === 'done') return `${c.green(sym.ok)} ${step.title}`;
    if (status === 'current') return c.cyan(c.bold(`${sym.current} ${step.title}`));
    return c.dim(`${sym.pending} ${step.title}`);
  });
  if (state.done) {
    const final = model.byId.get(state.current);
    if (final) items.push(c.green(`${sym.ok} ${final.title}`));
  }
  return wrapItems(items, c.dim(` ${sym.arrow} `), max);
}

/** 1-based position of a step among the non-final steps, and their count. */
export function stepPosition(model: FlowModel, stepId: string): { number: number; total: number } {
  const steps = skillSteps(model);
  return { number: steps.findIndex((step) => step.id === stepId) + 1, total: steps.length };
}

/**
 * How to invoke a skill in the selected agents, e.g. `/plan` or `/plan (Claude Code) · $plan (OpenAI Codex)`
 * when the agents disagree. Without agents: `/<skill>`.
 */
export function skillCommand(skillName: string, agents: readonly AgentId[]): string {
  const byInvocation = new Map<string, string[]>();
  for (const id of agents) {
    const adapter = getAgent(id);
    const invocation = adapter.invocation(skillName);
    byInvocation.set(invocation, [...(byInvocation.get(invocation) ?? []), adapter.name]);
  }
  if (byInvocation.size === 0) return `/${skillName}`;
  if (byInvocation.size === 1) return [...byInvocation.keys()][0]!;
  return [...byInvocation.entries()].map(([invocation, names]) => `${invocation} ${c.dim(`(${names.join(', ')})`)}`).join(c.dim(' · '));
}

/** Distinct invocations of a skill (for JSON output). */
export function skillInvocations(skillName: string, agents: readonly AgentId[]): string[] {
  const out = new Set(agents.map((id) => getAgent(id).invocation(skillName)));
  return out.size > 0 ? [...out] : [`/${skillName}`];
}

export function agentNames(agents: readonly AgentId[]): string {
  return agents.length > 0 ? agents.map((id) => getAgent(id).name).join(', ') : 'no agents';
}

/** `↻ Synced 9 skills for Claude Code, OpenAI Codex (+1 −2)` */
export function syncSummaryLine(report: SyncReport, added: readonly string[], dryRun = false): string {
  const changes =
    added.length > 0 || report.removed.length > 0
      ? ` ${c.dim('(')}${c.green(`${sym.added}${added.length}`)} ${c.red(`${sym.removed}${report.removed.length}`)}${c.dim(')')}`
      : '';
  const verb = dryRun ? 'Would sync' : 'Synced';
  if (report.agents.length === 0) {
    return `${c.cyan(sym.sync)} ${verb} flow "${report.flow}": skills rendered into .df only ${c.dim('(no agents selected)')}`;
  }
  const dirs = new Set(report.skills.map((skill) => skill.name));
  return `${c.cyan(sym.sync)} ${verb} ${plural(dirs.size, 'skill')} of flow "${report.flow}" for ${agentNames(report.agents)}${changes}`;
}

/** `✖ message` / `▲ message` lines for validation issues. */
export function issueLines(issues: readonly ValidationIssue[], indent = ''): string[] {
  return issues.map((issue) =>
    issue.level === 'error'
      ? `${indent}${c.red(sym.fail)} ${issue.message}`
      : `${indent}${c.yellow(sym.warn)} ${issue.message}`,
  );
}
