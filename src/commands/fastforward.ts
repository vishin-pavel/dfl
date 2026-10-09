/**
 * `dfl fast-forward`: starts, resumes or stops a fast-forward run of a flow (and the ticket of a
 * flow tracked in Jira), the CLI form of the `fast_forward` MCP tool (core/fastforward/start.ts).
 * A start stores the run's target and shows the likely path; the agent drives the run with the
 * built-in `/fast-forward` skill. A stop keeps the target, so a bare start resumes the run.
 */
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import { dflLauncher } from '../agents/mcp-config.js';
import { getSelectedAgents } from '../core/config.js';
import { FAST_FORWARD_SKILL, fastForwardStartView, fastForwardStopView, type FastForwardStartView } from '../core/fastforward/instructions.js';
import { assertFastForwardOptions, startFastForward, stopFastForward } from '../core/fastforward/start.js';
import { loadFlowOrActive } from '../core/flow.js';
import { checkFlowSyncState } from '../core/sync.js';
import type { FlowModel, ProjectPaths } from '../core/types.js';
import { c } from '../ui/colors.js';
import { cliCommandPrefix, skillCommand } from '../ui/format.js';
import { print, printJson, sym, warning } from '../ui/output.js';
import { TASK_OPTION_HASH_HINT, locked, projectFor, withShellHashHint, type CliContext } from './shared.js';
import { TASK_OPTION, TASK_OPTION_MISSING, localizeFastForward, localizeTask, runFlags, runTarget, statusJson, untrackedNote } from './state.js';

export function registerFastForwardCommand(program: CommandUnknownOpts, ctx: CliContext): void {
  withShellHashHint(program.command('fast-forward'), TASK_OPTION_MISSING, TASK_OPTION_HASH_HINT)
    .description('Start or resume a fast-forward run to a state (default: resume a stopped run, else the end of the flow), or stop it')
    .argument('[state]', 'step or final state the run stops at (it becomes current and is not run)')
    .option('--stop', 'stop the run instead of starting one')
    .option('--reason <text>', 'with --stop: why the run stops (one line)')
    .option('--flow <name>', 'act on another flow instead of the active one')
    .option('--task <key>', TASK_OPTION)
    .option('--json', 'print JSON')
    .action(async (target, opts) => {
      assertFastForwardOptions({ to: target, stop: opts.stop, reason: opts.reason });
      const paths = projectFor(ctx);
      const model = loadFlowOrActive(paths, opts.flow);
      // A ticket named with --task but not used: the flow is not tracked in Jira.
      const note = untrackedNote(paths, model, opts.task, undefined);
      const prefix = cliCommandPrefix(getSelectedAgents(paths));

      if (opts.stop) {
        const stopped = await stopFastForward(
          paths,
          model,
          { task: opts.task, reason: opts.reason },
          { withLock: (fn) => locked(paths, fn) },
        );
        const fastForward = localizeFastForward(paths, fastForwardStopView(model, stopped.run, { prefix, evaluation: stopped.evaluation }));
        if (opts.json) {
          printJson({ flow: model.name, ...(stopped.task ? { task: stopped.task } : {}), fastForward });
          return;
        }
        if (note && !stopped.task) warning(note.message);
        print(`${c.yellow(sym.halt)} Fast-forward run to ${runTarget(fastForward)} stopped on flow "${model.name}"${stopped.task ? ` for ${stopped.task}` : ''}.`);
        return;
      }

      // The ticket is read outside the lock; the run file is read, planned and written under it.
      const started = await startFastForward(paths, model, { to: target, task: opts.task }, { withLock: (fn) => locked(paths, fn) });
      const fastForward = localizeFastForward(
        paths,
        fastForwardStartView(model, started.plan, started.state, started.evaluation, started.warnings, { prefix }),
      );
      const task = started.task && localizeTask(paths, started.task);
      if (opts.json) {
        printJson({
          ...statusJson(paths, model, started.state, checkFlowSyncState(paths, model.name)),
          ...(task ? { task } : note ? { task: note } : {}),
          fastForward,
        });
        return;
      }
      if (!task && note) warning(note.message);
      for (const text of [...(task?.warnings ?? []), ...fastForward.warnings]) warning(text);
      const named = task && task.key !== null && task.via === 'arg' ? task.key : null;
      printStarted(paths, model, started.state.current, started.plan.run.task, fastForward, runFlags(opts.flow, named));
    });
}

/**
 * `» Fast-forward run to Review (review) started on flow "sample" at Plan (plan).`, the likely path,
 * the steps where the route may skip the target, and how to drive and stop the run.
 */
function printStarted(paths: ProjectPaths, model: FlowModel, current: string, task: string | null, view: FastForwardStartView, flags: string): void {
  const title = (id: string): string => model.byId.get(id)?.title ?? id;
  const verb = view.resumed ? 'resumed' : 'started';
  print(
    `${c.cyan(sym.run)} Fast-forward run to ${runTarget(view)} ${verb} on flow "${model.name}"${task ? ` for ${task}` : ''} ` +
      `at ${c.bold(title(current))} ${c.dim(`(${current})`)}.`,
  );
  print(`  Path: ${view.path.map(title).join(c.dim(` ${sym.arrow} `))}`);
  if (view.forks.length > 0) print(`  The route may skip the target at: ${view.forks.map(title).join(', ')}`);
  const drive = skillCommand(FAST_FORWARD_SKILL, getSelectedAgents(paths));
  print(`  Drive it with ${c.cyan(drive)} in your agent; stop it with \`${dflLauncher(paths)} fast-forward --stop${flags}\`.`);
}
