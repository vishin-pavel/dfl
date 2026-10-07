/**
 * `dfl task start`: starts (or resumes) work on a Jira ticket of a tracked flow – binds it to a git
 * branch (creating the branch when needed), records the task at its first step and moves the ticket
 * to the mapped status (core/tracker/runtime.ts startTask, the CLI form of the start_task tool).
 */
import { Option, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { getSelectedAgents } from '../core/config.js';
import { loadFlow } from '../core/flow.js';
import { checkFlowSyncState } from '../core/sync.js';
import { BRANCH_MODES, startTask, type StartTaskResult } from '../core/tracker/runtime.js';
import type { FlowModel, ProjectPaths } from '../core/types.js';
import { c } from '../ui/colors.js';
import { skillCommand, stepPosition } from '../ui/format.js';
import { plain, print, printJson, sym, truncate, warning } from '../ui/output.js';
import { launcherText, locked, projectFor, withShellHashHint, type CliContext } from './shared.js';
import { statusJson } from './state.js';

export function registerTaskCommands(program: CommandUnknownOpts, ctx: CliContext): void {
  const task = program.command('task').description('Work on Jira tickets of a flow tracked in Jira');

  withShellHashHint(task.command('start'), /missing required argument 'ref'/)
    .description('Start or continue a ticket: bind it to a git branch (created when needed), record the task, move the ticket to its status')
    .argument('<ref>', 'the ticket: ABC-123, 123, "#123" or its URL')
    .option('--flow <name>', 'flow to start it in (default: flowSelect in .df/tracker.json, else the active flow)')
    .option('--step <step>', 'step to start at (default: the initial step)')
    .addOption(
      new Option(
        '--branch <mode>',
        'auto: create a branch on a protected branch, use one that contains the key; create: always create one; current: use the checked-out branch',
      )
        .choices(BRANCH_MODES)
        .default('auto' as const),
    )
    .option('--slug <slug>', 'slug for a new branch name (default: from the ticket summary)')
    .option('--json', 'print JSON')
    .action(async (ref, opts) => {
      const paths = projectFor(ctx);
      const started = await startTask(
        paths,
        { task: ref, flow: opts.flow, step: opts.step, branch: opts.branch, slug: opts.slug },
        { withLock: (fn) => locked(paths, fn) },
      );
      const model = loadFlow(paths, started.state.flow);
      const taskView = {
        ...started.task,
        warnings: started.task.warnings.map((text) => launcherText(paths, text)),
        instructions: launcherText(paths, started.task.instructions),
      };
      if (opts.json) {
        printJson({
          ...statusJson(paths, model, started.state, checkFlowSyncState(paths, model.name)),
          task: taskView,
          branch: started.branch,
          ...(started.resumed ? { resumed: true } : {}),
        });
        return;
      }
      for (const text of taskView.warnings) warning(text);
      printStarted(paths, model, { ...started, task: taskView });
    });
}

/**
 * `✔ Started ABC-1 · <title>` plus the branch, the Jira status and the step to work on (ticket and
 * record text through `plain`/`truncate`: no control characters reach the terminal).
 */
function printStarted(paths: ProjectPaths, model: FlowModel, started: StartTaskResult): void {
  const { task, branch, state } = started;
  const verb = started.resumed ? 'Continuing' : 'Started';
  print(`${c.green(sym.ok)} ${verb} ${c.bold(task.key)} ${c.dim(sym.dot)} ${truncate(task.title, 70)}`);
  const branchNote =
    branch.action === 'created' ? 'created and checked out' : branch.action === 'current' ? 'checked out' : c.yellow('switch to it to continue');
  print(`  Branch  ${plain(branch.name)} ${c.dim(`(${branchNote})`)}`);
  const { actual, expected, inSync } = task.status;
  const mismatch = expected !== null && !inSync ? ` ${c.yellow(`≠ expected ${plain(expected)}`)}` : '';
  print(`  Jira    ${plain(actual)}${mismatch}  ${c.dim(task.url)}`);
  const step = model.byId.get(state.current);
  if (!step || step.final) return;
  const { number, total } = stepPosition(model, step.id);
  const command = skillCommand(step.skillName, getSelectedAgents(paths));
  print(`  Step    ${c.cyan(sym.current)} ${c.bold(step.title)} ${c.dim(`(step ${number} of ${total})`)}  ${c.cyan(command)}`);
}
