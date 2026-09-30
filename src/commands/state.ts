/**
 * Runtime state commands: `status`, `next`, `goto`, `reset`.
 */
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import { dflLauncher } from '../agents/mcp-config.js';
import { getSelectedAgents } from '../core/config.js';
import { loadFlowOrActive } from '../core/flow.js';
import { availableEvents, gotoStep, loadRuntimeState, resetFlow, sendEvent } from '../core/machine.js';
import { checkFlowSyncState, type SyncState } from '../core/sync.js';
import type { FlowModel, FlowRuntimeState, ProjectPaths, TransitionResult } from '../core/types.js';
import { c } from '../ui/colors.js';
import { progressChain, skillCommand, skillInvocations, stepPosition, stepStatuses } from '../ui/format.js';
import { print, printJson, sym, terminalWidth, truncate, warning } from '../ui/output.js';
import { confirm, isInteractive } from '../ui/prompts.js';
import { table } from '../ui/table.js';
import { locked, notInstalledMessage, projectFor, type CliContext } from './shared.js';

export function registerStateCommands(program: CommandUnknownOpts, ctx: CliContext): void {
  program
    .command('status')
    .description('Show the active flow, the current step and the available events')
    .option('--flow <name>', 'show another flow instead of the active one')
    .option('--json', 'print JSON')
    .action((opts) => {
      const paths = projectFor(ctx);
      const model = loadFlowOrActive(paths, opts.flow);
      const state = loadRuntimeState(paths, model);
      // The active flow's installed skills; for another flow only when its skills are the installed ones
      // (the active flow changed since, e.g. the team default after a pull), undefined otherwise.
      const sync = checkFlowSyncState(paths, model.name);
      if (opts.json) printJson(statusJson(paths, model, state, sync));
      else printStatus(paths, model, state, sync);
    });

  program
    .command('next')
    .description('Complete the current step: fire an event (default NEXT)')
    .argument('[event]', 'event to fire', 'NEXT')
    .option('--from <step>', 'only if this step is the current one')
    .option('--flow <name>', 'act on another flow instead of the active one')
    .option('--json', 'print JSON')
    .action(async (event, opts) => {
      const paths = projectFor(ctx);
      const { model, repaired, result } = await locked(paths, () => {
        const model = loadFlowOrActive(paths, opts.flow);
        // A stored step that no longer exists (renamed or removed upstream) fell back to the initial step.
        const repaired = loadRuntimeState(paths, model).repaired;
        return { model, repaired, result: sendEvent(paths, model, event, { from: opts.from }) };
      });
      if (opts.json) printJson(withRepaired(result, repaired));
      else printMove(paths, model, result, repaired);
    });

  program
    .command('goto')
    .description('Jump to any step of the flow')
    .argument('<step>', 'step id')
    .option('--flow <name>', 'act on another flow instead of the active one')
    .option('--json', 'print JSON')
    .action(async (stepId, opts) => {
      const paths = projectFor(ctx);
      const { model, repaired, result } = await locked(paths, () => {
        const model = loadFlowOrActive(paths, opts.flow);
        const repaired = loadRuntimeState(paths, model).repaired;
        return { model, repaired, result: gotoStep(paths, model, stepId) };
      });
      if (opts.json) printJson(withRepaired(result, repaired));
      else printMove(paths, model, result, repaired);
    });

  program
    .command('reset')
    .description('Move the flow back to its initial step')
    .option('--flow <name>', 'act on another flow instead of the active one')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--json', 'print JSON')
    .action(async (opts) => {
      const paths = projectFor(ctx);
      const model = loadFlowOrActive(paths, opts.flow);
      const repaired = loadRuntimeState(paths, model).repaired;
      if (repaired && !opts.json) warning(repaired);
      if (!opts.json && isInteractive(opts)) {
        const current = loadRuntimeState(paths, model).current;
        const ok = await confirm({
          message: `Reset flow "${model.name}" from "${current}" to its initial step "${model.initial}"?`,
          initialValue: true,
        });
        if (!ok) {
          print(c.dim('Nothing changed.'));
          return;
        }
      }
      const state = await locked(paths, () => resetFlow(paths, loadFlowOrActive(paths, opts.flow)));
      if (opts.json) {
        printJson(withRepaired(state, repaired));
        return;
      }
      const step = model.byId.get(state.current);
      print(`${c.green(sym.ok)} Reset flow "${model.name}" to ${c.bold(step?.title ?? state.current)} ${c.dim(`(${state.current})`)}`);
      printNow(paths, model, state);
    });
}

/** Adds `repaired` (why the stored step was replaced by the initial step) to JSON output. */
function withRepaired<T extends object>(value: T, repaired: string | undefined): T & { repaired?: string } {
  return repaired ? { ...value, repaired } : value;
}

/** `▲ Installed skills are out of date: …`, or the not-installed note; undefined when all is well. */
function syncNotice(paths: ProjectPaths, sync: SyncState | undefined): { level: 'warning' | 'note'; text: string } | undefined {
  if (!sync || sync.upToDate) return undefined;
  if (!sync.installed) return { level: 'note', text: notInstalledMessage(paths) };
  const fix = syncFix(paths, sync) ?? `Run \`${dflLauncher(paths)} flow-update\`.`;
  return { level: 'warning', text: `Installed skills are out of date: ${sync.reason ?? 'the flow changed'}. ${fix}` };
}

/** SyncState.fix with the project's dfl launcher (e.g. `npx --no-install dfl install`). */
function syncFix(paths: ProjectPaths, sync: SyncState): string | undefined {
  if (sync.fix === undefined) return undefined;
  const cli = dflLauncher(paths);
  return cli === 'dfl' ? sync.fix : sync.fix.replaceAll('`dfl ', `\`${cli} `);
}

function statusJson(paths: ProjectPaths, model: FlowModel, state: FlowRuntimeState, sync: SyncState | undefined): unknown {
  const agents = getSelectedAgents(paths);
  const step = model.byId.get(state.current);
  const position = stepPosition(model, state.current);
  return {
    flow: model.name,
    title: model.title,
    current: state.current,
    done: state.done,
    step: step
      ? {
          id: step.id,
          title: step.title,
          description: step.description,
          skillName: step.final ? undefined : step.skillName,
          commands: step.final ? [] : skillInvocations(step.skillName, agents),
          final: step.final,
          number: position.number > 0 ? position.number : undefined,
          total: position.total,
        }
      : undefined,
    events: step ? availableEvents(model, step.id).map((t) => ({ event: t.event, target: t.target, description: t.description })) : [],
    steps: stepStatuses(model, state).map(({ step: s, status }) => ({ id: s.id, title: s.title, status })),
    history: state.history.slice(-10),
    updatedAt: state.updatedAt,
    ...(state.repaired ? { repaired: state.repaired } : {}),
    ...(sync
      ? {
          skills: {
            installed: sync.installed,
            upToDate: sync.upToDate,
            ...(sync.reason !== undefined ? { reason: sync.reason } : {}),
            ...(sync.upToDate
              ? {}
              : { hint: syncFix(paths, sync) ?? (sync.installed ? `${dflLauncher(paths)} flow-update` : `${dflLauncher(paths)} install`) }),
          },
        }
      : {}),
  };
}

function printStatus(paths: ProjectPaths, model: FlowModel, state: FlowRuntimeState, sync: SyncState | undefined): void {
  if (state.repaired) warning(state.repaired);
  const notice = syncNotice(paths, sync);
  if (notice?.level === 'warning') warning(notice.text);
  printStatusBody(paths, model, state);
  if (notice?.level === 'note') {
    print();
    print(c.dim(notice.text));
  }
}

function printStatusBody(paths: ProjectPaths, model: FlowModel, state: FlowRuntimeState): void {
  const width = terminalWidth();
  print(`${c.bold(model.title)} ${c.dim(`(${model.name})`)}`);
  for (const line of progressChain(model, state, width)) print(line);
  print();

  const step = model.byId.get(state.current);
  if (!step) return;
  if (state.done) {
    print(`${c.green(sym.ok)} Flow complete: ${c.bold(step.title)}${step.description ? c.dim(` – ${step.description}`) : ''}`);
    print(c.dim('Start over with `dfl reset`, or jump to a step with `dfl goto <step>`.'));
    return;
  }
  printNow(paths, model, state);

  const events = availableEvents(model, step.id);
  if (events.length === 0) {
    print();
    print(c.dim('This step has no outgoing transitions; move on with `dfl goto <step>`.'));
    return;
  }
  print();
  print(c.bold('Events'));
  const rows = events.map((t) => {
    const target = model.byId.get(t.target);
    const label = target ? target.title : t.target;
    return [c.cyan(t.event), `${c.dim(sym.arrow)} ${t.target}`, { text: t.description ? `${label} – ${t.description}` : label }];
  });
  for (const line of table(rows, { maxWidth: width })) print(line);
  print();
  print(c.dim(`Complete the step with \`dfl next\`${events.length > 1 || events[0]?.event !== 'NEXT' ? ' or `dfl next <event>`' : ''}.`));
}

/** `● Implement (step 3 of 6) /implement-feature` plus the step description. */
function printNow(paths: ProjectPaths, model: FlowModel, state: FlowRuntimeState): void {
  const step = model.byId.get(state.current);
  if (!step) return;
  if (step.final) {
    print(`${c.green(sym.ok)} Flow "${model.name}" is complete ${c.dim(`(${step.title})`)}`);
    return;
  }
  const { number, total } = stepPosition(model, step.id);
  const command = skillCommand(step.skillName, getSelectedAgents(paths));
  print(`${c.cyan(sym.current)} ${c.bold(step.title)} ${c.dim(`(step ${number} of ${total})`)}  ${c.cyan(command)}`);
  if (step.description) print(`  ${c.dim(truncate(step.description, terminalWidth() * 3 - 2))}`);
}

function printMove(paths: ProjectPaths, model: FlowModel, result: TransitionResult, repaired: string | undefined): void {
  if (repaired) warning(repaired);
  const from = model.byId.get(result.from);
  const to = model.byId.get(result.to);
  print(
    `${c.green(sym.ok)} ${from?.title ?? result.from} ${c.dim(sym.arrow)} ${c.bold(to?.title ?? result.to)} ${c.dim(`(${result.event})`)}`,
  );
  printNow(paths, model, result.state);
}
