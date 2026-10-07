/**
 * Runtime state commands: `status`, `next`, `goto`, `reset`.
 *
 * For a flow tracked in Jira (`.df/tracker.json` has `flows.<flow>`) they work on the task of the
 * ticket in the branch name (or `--task`) through core/tracker/runtime.ts: the position is the
 * task's record in Jira, `--set name=value` sets task params, and `status` shows the ticket. Other
 * flows keep using `.df/state.json`, with unchanged output.
 */
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import { dflLauncher } from '../agents/mcp-config.js';
import { getSelectedAgents } from '../core/config.js';
import { loadFlowOrActive } from '../core/flow.js';
import { availableEvents, gotoStep, loadRuntimeState, resetFlow, sendEvent } from '../core/machine.js';
import { checkFlowSyncState, type SyncState } from '../core/sync.js';
import { loadTrackedFlow } from '../core/tracker/config.js';
import { resolveTask } from '../core/tracker/resolve.js';
import { isTracked, taskMove, taskStatus, type TaskMoveArgs, type TaskMoveResult, type TaskView } from '../core/tracker/runtime.js';
import type { FlowModel, FlowRuntimeState, ProjectPaths, TransitionResult } from '../core/types.js';
import { c } from '../ui/colors.js';
import { progressChain, skillCommand, skillInvocations, stepPosition, stepStatuses } from '../ui/format.js';
import { plain, print, printJson, printLines, sym, terminalWidth, truncate, warning } from '../ui/output.js';
import { confirm, isInteractive } from '../ui/prompts.js';
import { table } from '../ui/table.js';
import {
  STATUS_TASK_HASH_HINT,
  TASK_OPTION_HASH_HINT,
  launcherText,
  locked,
  notInstalledMessage,
  parseParamSetting,
  projectFor,
  withShellHashHint,
  type CliContext,
} from './shared.js';

/** `--task` given without a value (an unquoted `#123` is a shell comment). */
const TASK_OPTION_MISSING = /option '--task <key>' argument missing/;
const TASK_OPTION = 'ticket of a flow tracked in Jira, e.g. ABC-123 (default: the key in the branch name)';
const STATUS_TASK_OPTION = 'ticket of a flow tracked in Jira, e.g. ABC-123 (also 123 when jira.defaultProjectKey is set; default: the key in the branch name)';
const SET_OPTION = 'set a task param of a flow tracked in Jira, repeatable (name= deletes it)';

export function registerStateCommands(program: CommandUnknownOpts, ctx: CliContext): void {
  withShellHashHint(program.command('status'), TASK_OPTION_MISSING, STATUS_TASK_HASH_HINT)
    .description('Show the active flow, the current step and the available events')
    .option('--flow <name>', 'show another flow instead of the active one')
    .option('--task <key>', STATUS_TASK_OPTION)
    .option('--json', 'print JSON')
    .action(async (opts) => {
      const paths = projectFor(ctx);
      const model = loadFlowOrActive(paths, opts.flow);
      // The active flow's installed skills; for another flow only when its skills are the installed ones
      // (the active flow changed since, e.g. the team default after a pull), undefined otherwise.
      const sync = checkFlowSyncState(paths, model.name);
      const tracked = isTracked(paths, model.name) ? await taskStatus(paths, model, { task: opts.task }) : undefined;
      if (tracked) {
        const task = localizeTask(paths, tracked.task);
        if (opts.json) printJson({ ...statusJson(paths, model, tracked.state, sync), task });
        else printTrackedStatus(paths, model, tracked.state, task, sync);
        return;
      }
      // Untracked (or tracked without a required ticket and none bound): the local position.
      const state = loadRuntimeState(paths, model);
      const note = untrackedNote(paths, model, opts.task, undefined);
      if (opts.json) printJson({ ...statusJson(paths, model, state, sync), ...(note ? { task: note } : {}) });
      else {
        if (note) warning(note.message);
        printStatus(paths, model, state, sync);
      }
    });

  withShellHashHint(program.command('next'), TASK_OPTION_MISSING, TASK_OPTION_HASH_HINT)
    .description('Complete the current step: fire an event (default NEXT)')
    .argument('[event]', 'event to fire', 'NEXT')
    .option('--from <step>', 'only if this step is the current one')
    .option('--flow <name>', 'act on another flow instead of the active one')
    .option('--task <key>', TASK_OPTION)
    .option('--set <name=value>', SET_OPTION, parseParamSetting)
    .option('--json', 'print JSON')
    .action(async (event, opts) => {
      const paths = projectFor(ctx);
      // A person runs `dfl next` once and sees the outcome: no `--from` needed (agents pass it).
      const args: TaskMoveArgs = { kind: 'event', event, from: opts.from, task: opts.task, params: opts.set, requireFrom: false };
      const tracked = await trackedMove(paths, opts.flow, args);
      if (tracked) {
        printTrackedMove(paths, tracked.model, tracked.moved, opts.json === true);
        return;
      }
      const { model, repaired, result } = await locked(paths, () => {
        const model = loadFlowOrActive(paths, opts.flow);
        // A stored step that no longer exists (renamed or removed upstream) fell back to the initial step.
        const repaired = loadRuntimeState(paths, model).repaired;
        return { model, repaired, result: sendEvent(paths, model, event, { from: opts.from }) };
      });
      const note = untrackedNote(paths, model, opts.task, opts.set);
      if (opts.json) printJson({ ...withRepaired(result, repaired), ...(note ? { task: note } : {}) });
      else {
        if (note) warning(note.message);
        printMove(paths, model, result, repaired);
      }
    });

  withShellHashHint(program.command('goto'), TASK_OPTION_MISSING, TASK_OPTION_HASH_HINT)
    .description('Jump to any step of the flow')
    .argument('<step>', 'step id')
    .option('--flow <name>', 'act on another flow instead of the active one')
    .option('--task <key>', TASK_OPTION)
    .option('--set <name=value>', SET_OPTION, parseParamSetting)
    .option('--json', 'print JSON')
    .action(async (stepId, opts) => {
      const paths = projectFor(ctx);
      const tracked = await trackedMove(paths, opts.flow, { kind: 'goto', step: stepId, task: opts.task, params: opts.set });
      if (tracked) {
        printTrackedMove(paths, tracked.model, tracked.moved, opts.json === true);
        return;
      }
      const { model, repaired, result } = await locked(paths, () => {
        const model = loadFlowOrActive(paths, opts.flow);
        const repaired = loadRuntimeState(paths, model).repaired;
        return { model, repaired, result: gotoStep(paths, model, stepId) };
      });
      const note = untrackedNote(paths, model, opts.task, opts.set);
      if (opts.json) printJson({ ...withRepaired(result, repaired), ...(note ? { task: note } : {}) });
      else {
        if (note) warning(note.message);
        printMove(paths, model, result, repaired);
      }
    });

  withShellHashHint(program.command('reset'), TASK_OPTION_MISSING, TASK_OPTION_HASH_HINT)
    .description('Move the flow back to its initial step')
    .option('--flow <name>', 'act on another flow instead of the active one')
    .option('--task <key>', TASK_OPTION)
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--json', 'print JSON')
    .action(async (opts) => {
      const paths = projectFor(ctx);
      const model = loadFlowOrActive(paths, opts.flow);
      const bound = trackedReset(paths, model, opts.task);
      if (bound) {
        // Asked outside the lock (other dfl processes wait at most 15 s for it).
        if (bound.key !== undefined && !opts.json && isInteractive(opts)) {
          const ok = await confirm({ message: `Reset ${bound.key} (${model.name}) to ${model.initial}?`, initialValue: false });
          if (!ok) {
            print(c.dim('Nothing changed.'));
            return;
          }
        }
        const moved = await taskMove(paths, model, { kind: 'reset', task: opts.task }, { withLock: (fn) => locked(paths, fn) });
        if (moved) {
          const task = { ...moved.task, warnings: moved.task.warnings.map((text) => launcherText(paths, text)) };
          if (opts.json) {
            printJson({ ...moved.result.state, task });
            return;
          }
          for (const text of task.warnings) warning(text);
          const step = model.byId.get(moved.result.to);
          print(
            `${c.green(sym.ok)} Reset ${task.key} (${model.name}) to ${c.bold(step?.title ?? moved.result.to)} ${c.dim(`(${moved.result.to})`)}`,
          );
          print(`  ${jiraMoveLine(task.status)}`);
          printNow(paths, model, moved.result.state);
          return;
        }
      }

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
      const note = untrackedNote(paths, model, opts.task, undefined);
      if (opts.json) {
        printJson({ ...withRepaired(state, repaired), ...(note ? { task: note } : {}) });
        return;
      }
      if (note) warning(note.message);
      const step = model.byId.get(state.current);
      print(`${c.green(sym.ok)} Reset flow "${model.name}" to ${c.bold(step?.title ?? state.current)} ${c.dim(`(${state.current})`)}`);
      printNow(paths, model, state);
    });
}

/** Adds `repaired` (why the stored step was replaced by the initial step) to JSON output. */
function withRepaired<T extends object>(value: T, repaired: string | undefined): T & { repaired?: string } {
  return repaired ? { ...value, repaired } : value;
}

// ---------------------------------------------------------------------------
// Tracked flows
// ---------------------------------------------------------------------------

/**
 * `task` of the output when `--task` / `--set` were given but the local state was used: the flow is
 * not tracked in Jira (or, for `--set`, no ticket is bound and the flow does not require one).
 */
function untrackedNote(
  paths: ProjectPaths,
  model: FlowModel,
  task: string | undefined,
  params: Record<string, unknown> | undefined,
): { tracked: false; message: string } | undefined {
  const unused = [
    ...(task !== undefined && task.trim() !== '' ? ['the ticket was not used'] : []),
    ...(params !== undefined && Object.keys(params).length > 0 ? ['--set was ignored'] : []),
  ];
  if (unused.length === 0) return undefined;
  if (isTracked(paths, model.name)) {
    return {
      tracked: false,
      message: `No ticket is bound to this branch, so flow "${model.name}" used its local state; ${unused.join(' and ')} (pass --task <key>).`,
    };
  }
  return { tracked: false, message: `No tracker is configured for flow "${model.name}"; ${unused.join(' and ')}.` };
}

/**
 * Moves the task when the flow is tracked in Jira (the requests run under the project lock);
 * undefined when the local state applies (untracked, or no ticket bound and none required).
 */
async function trackedMove(
  paths: ProjectPaths,
  flow: string | undefined,
  args: TaskMoveArgs,
): Promise<{ model: FlowModel; moved: TaskMoveResult } | undefined> {
  const model = loadFlowOrActive(paths, flow);
  if (!isTracked(paths, model.name)) return undefined;
  const moved = await taskMove(paths, model, args, { withLock: (fn) => locked(paths, fn) });
  return moved ? { model, moved } : undefined;
}

/**
 * `dfl reset` of a tracked flow, before anything is asked or written: the ticket (from `--task` or
 * the branch; undefined when none is bound and the flow requires one, so the move reports it).
 * Undefined when the local state applies. No network.
 */
function trackedReset(paths: ProjectPaths, model: FlowModel, task: string | undefined): { key: string | undefined } | undefined {
  // Like isTracked: a broken tracker.json that does not name the flow leaves it untracked.
  const tracker = loadTrackedFlow(paths, model.name);
  if (!tracker) return undefined;
  const { cfg, tracked } = tracker;
  const resolved = resolveTask(paths, cfg, { task });
  if (!resolved && !tracked.requireTask) return undefined;
  return { key: resolved?.key };
}

/** A task view with its warnings and instructions spelled with this project's dfl launcher. */
function localizeTask(paths: ProjectPaths, task: TaskView): TaskView {
  return { ...task, warnings: task.warnings.map((text) => launcherText(paths, text)), instructions: launcherText(paths, task.instructions) };
}

function printTrackedStatus(paths: ProjectPaths, model: FlowModel, state: FlowRuntimeState, task: TaskView, sync: SyncState | undefined): void {
  // A record at a step the flow no longer has: the warning says how to repair it.
  if (state.repaired && (task.key === null || task.stepUnknown === undefined)) warning(state.repaired);
  const notice = syncNotice(paths, sync);
  if (notice?.level === 'warning') warning(notice.text);
  for (const text of task.warnings) warning(text);
  const flag = task.key !== null && task.via === 'arg' ? ` --task ${task.key}` : '';
  printStatusBody(paths, model, state, { lines: taskLines(paths, model, task), flag, movable: task.key !== null && task.started });
  if (notice?.level === 'note') {
    print();
    print(c.dim(notice.text));
  }
}

/**
 * The ticket block of `dfl status`: `ABC-1 · <title> · Jira: In Progress ✓ · branch <b>`, the URL, the
 * params. Ticket and record text goes through `plain`/`truncate` (no control characters reach the terminal).
 */
function taskLines(paths: ProjectPaths, model: FlowModel, task: TaskView): string[] {
  const cli = dflLauncher(paths);
  if (task.key === null) {
    return [
      `${c.yellow(sym.warn)} Flow "${model.name}" is tracked in Jira, but no ticket is bound to this branch.`,
      c.dim(
        `Start one with \`${cli} task start <ticket>\`, or pass --task <key>.` +
          (task.suggested !== undefined ? ` The previous branch was for ${task.suggested}: \`${cli} status --task ${task.suggested}\`.` : ''),
      ),
    ];
  }
  const parts = [c.bold(task.key), truncate(task.title, 60), jiraStatusText(task)];
  if (task.branch !== null) parts.push(`branch ${plain(task.branch)}`);
  if (!task.started) parts.push(c.yellow('not started'));
  const lines = [parts.join(c.dim(` ${sym.dot} `)), `  ${c.dim(task.url)}`];
  const params = Object.entries(task.params).filter(([name]) => name !== 'branch');
  if (params.length > 0) lines.push(...table(params.map(([name, value]) => [c.dim(name), { text: value }]), { maxWidth: terminalWidth() }));
  if (!task.started) lines.push('', c.dim(`Start it with \`${cli} task start ${task.key}\`.`));
  return lines;
}

/** `Jira: In Progress ✓`, `Jira: Blocked ≠ expected In Review`, or `Jira: To Do` when the step keeps the status. */
function jiraStatusText(task: Extract<TaskView, { key: string }>): string {
  const actual = plain(task.status.actual);
  const expected = task.status.expected === null ? null : plain(task.status.expected);
  if (expected === null) return `Jira: ${actual}`;
  return task.status.inSync ? `Jira: ${actual} ${c.green('✓')}` : `Jira: ${actual} ${c.yellow(`≠ expected ${expected}`)}`;
}

/** `Jira: To Do → In Progress`, or why it did not move. */
function jiraMoveLine(moved: TaskMoveResult['task']['status']): string {
  const status = { before: plain(moved.before), after: plain(moved.after), expected: moved.expected === null ? null : plain(moved.expected) };
  if (status.before !== status.after) return `Jira: ${status.before} ${c.dim(sym.arrow)} ${c.bold(status.after)}`;
  if (status.expected === null) return c.dim(`Jira: ${status.after} (this step keeps the ticket's status)`);
  return status.after.toLowerCase() === status.expected.toLowerCase() || status.expected.startsWith('id:')
    ? `Jira: ${status.after}`
    : `Jira: ${status.after} ${c.yellow(`≠ expected ${status.expected}`)}`;
}

function printTrackedMove(paths: ProjectPaths, model: FlowModel, moved: TaskMoveResult, json: boolean): void {
  const task = { ...moved.task, warnings: moved.task.warnings.map((text) => launcherText(paths, text)) };
  if (json) {
    printJson({ ...moved.result, task, ...(moved.replayed ? { replayed: true } : {}) });
    return;
  }
  for (const text of task.warnings) warning(text);
  printMove(paths, model, moved.result, undefined, [
    `  ${c.bold(task.key)} ${c.dim(sym.dot)} ${jiraMoveLine(task.status)}`,
    ...(moved.replayed ? [c.dim('  This move was already made; nothing was written again.')] : []),
  ]);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

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

/** `dfl status --json` (the tracked variant adds `task`). */
export function statusJson(paths: ProjectPaths, model: FlowModel, state: FlowRuntimeState, sync: SyncState | undefined): Record<string, unknown> {
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

/**
 * Title, progress, current step and events. A tracked flow's ticket block goes after the progress
 * (`task.lines`); its commands get `task.flag` (`--task KEY` when the ticket came from `--task`), and
 * a task that cannot move yet (no ticket, not started) shows no step and events.
 */
function printStatusBody(
  paths: ProjectPaths,
  model: FlowModel,
  state: FlowRuntimeState,
  task?: { lines: string[]; flag: string; movable: boolean },
): void {
  const width = terminalWidth();
  const flag = task?.flag ?? '';
  print(`${c.bold(model.title)} ${c.dim(`(${model.name})`)}`);
  for (const line of progressChain(model, state, width)) print(line);
  print();
  if (task) {
    printLines(task.lines);
    if (!task.movable) return;
    print();
  }

  const step = model.byId.get(state.current);
  if (!step) return;
  if (state.done) {
    print(`${c.green(sym.ok)} Flow complete: ${c.bold(step.title)}${step.description ? c.dim(` – ${step.description}`) : ''}`);
    print(c.dim(`Start over with \`dfl reset${flag}\`, or jump to a step with \`dfl goto <step>${flag}\`.`));
    return;
  }
  printNow(paths, model, state);

  const events = availableEvents(model, step.id);
  if (events.length === 0) {
    print();
    print(c.dim(`This step has no outgoing transitions; move on with \`dfl goto <step>${flag}\`.`));
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
  print(c.dim(`Complete the step with \`dfl next${flag}\`${events.length > 1 || events[0]?.event !== 'NEXT' ? ` or \`dfl next <event>${flag}\`` : ''}.`));
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

function printMove(paths: ProjectPaths, model: FlowModel, result: TransitionResult, repaired: string | undefined, extra: readonly string[] = []): void {
  if (repaired) warning(repaired);
  const from = model.byId.get(result.from);
  const to = model.byId.get(result.to);
  print(
    `${c.green(sym.ok)} ${from?.title ?? result.from} ${c.dim(sym.arrow)} ${c.bold(to?.title ?? result.to)} ${c.dim(`(${result.event})`)}`,
  );
  printLines(extra);
  printNow(paths, model, result.state);
}
