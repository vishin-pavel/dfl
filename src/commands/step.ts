/**
 * `dfl step list | add | edit | remove | transition`. Mutations re-sync the active flow unless `--no-sync`.
 */
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import { getSelectedAgents } from '../core/config.js';
import { DflError } from '../core/errors.js';
import { loadFlowOrActive } from '../core/flow.js';
import { loadRuntimeState } from '../core/machine.js';
import { addStep, removeStep, setTransition, updateStep, type UpdateStepOptions } from '../core/steps.js';
import type { FlowModel, ProjectPaths } from '../core/types.js';
import { c } from '../ui/colors.js';
import { skillInvocations } from '../ui/format.js';
import { print, printJson, printLines, success, sym, terminalWidth } from '../ui/output.js';
import { isInteractive } from '../ui/prompts.js';
import { table } from '../ui/table.js';
import { confirmDestructive, projectFor, readTemplateFile, syncAfterChange, type CliContext } from './shared.js';

export function registerStepCommands(program: CommandUnknownOpts, ctx: CliContext): void {
  const step = program.command('step').description('Manage the steps of a flow');

  step
    .command('list')
    .alias('ls')
    .description('List the steps of a flow in flow order')
    .option('--flow <name>', 'flow (default: the active flow)')
    .option('--json', 'print JSON')
    .action((opts) => {
      const paths = projectFor(ctx);
      const model = loadFlowOrActive(paths, opts.flow);
      const current = currentOf(paths, model);
      const agents = getSelectedAgents(paths);
      if (opts.json) {
        printJson({
          flow: model.name,
          initial: model.initial,
          current,
          steps: model.steps.map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description,
            final: s.final,
            skillName: s.final ? undefined : s.skillName,
            commands: s.final ? [] : skillInvocations(s.skillName, agents),
            current: s.id === current,
            transitions: s.transitions.map((t) => ({ event: t.event, target: t.target, description: t.description })),
          })),
        });
        return;
      }
      print(`${c.bold(model.title)} ${c.dim(`(${model.name})`)}`);
      let number = 0;
      const rows = model.steps.map((s) => {
        const marker = s.id === current ? c.cyan(sym.current) : ' ';
        const transitions = { text: s.transitions.map((t) => `${t.event} ${sym.arrow} ${t.target}`).join(', ') };
        if (s.final) return [marker, '', c.dim(s.id), c.dim(s.title), c.dim('(final)'), transitions];
        number += 1;
        return [
          marker,
          c.dim(String(number)),
          s.id === current ? c.bold(s.id) : s.id,
          s.title,
          c.cyan(skillInvocations(s.skillName, agents).join(' ')),
          transitions,
        ];
      });
      printLines(
        table(rows, { head: ['', '#', 'STEP', 'TITLE', 'COMMAND', 'TRANSITIONS'], align: ['left', 'right'], maxWidth: terminalWidth() }),
      );
    });

  step
    .command('add')
    .description('Add a step (creates steps/<id>/SKILL.md.hbs and wires it into the flow)')
    .argument('<id>', 'step id (lowercase letters, digits and hyphens)')
    .option('--after <step>', 'insert after this step (it now leads to the new step)')
    .option('--before <step>', 'insert before this step (its incoming transitions lead to the new step)')
    .option('--title <title>', 'step title')
    .option('--description <text>', 'step description (also the skill description)')
    .option('--event <event>', 'event used for wiring', 'NEXT')
    .option('--template-file <path>', 'use this file as SKILL.md.hbs')
    .option('--flow <name>', 'flow (default: the active flow)')
    .option('--no-sync', 'do not re-install skills')
    .action(async (id, opts) => {
      const paths = projectFor(ctx);
      const flowName = loadFlowOrActive(paths, opts.flow).name;
      const model = addStep(paths, flowName, {
        id,
        after: opts.after,
        before: opts.before,
        title: opts.title,
        description: opts.description,
        event: opts.event,
        template: opts.templateFile !== undefined ? readTemplateFile(opts.templateFile) : undefined,
      });
      const added = model.byId.get(id);
      const where = opts.after ? ` after "${opts.after}"` : opts.before ? ` before "${opts.before}"` : '';
      success(`Added step ${c.bold(id)}${added ? c.dim(` (${added.title})`) : ''} to flow "${flowName}"${where}`);
      print(c.dim(`  Template: .df/${flowName}/steps/${id}/SKILL.md.hbs`));
      await syncAfterChange(paths, { sync: opts.sync, flow: flowName, interactive: isInteractive() });
    });

  step
    .command('edit')
    .description('Change a step: title, description, template, id or initial step')
    .argument('<id>', 'step id')
    .option('--title <title>', 'new title')
    .option('--description <text>', 'new description')
    .option('--rename <new-id>', 'rename the step (transitions, directory and runtime state follow)')
    .option('--template-file <path>', 'replace SKILL.md.hbs with this file')
    .option('--initial', 'make it the initial step')
    .option('--flow <name>', 'flow (default: the active flow)')
    .option('--no-sync', 'do not re-install skills')
    .action(async (id, opts) => {
      const paths = projectFor(ctx);
      const flowName = loadFlowOrActive(paths, opts.flow).name;
      const patch: UpdateStepOptions = {
        title: opts.title,
        description: opts.description,
        rename: opts.rename,
        template: opts.templateFile !== undefined ? readTemplateFile(opts.templateFile) : undefined,
        initial: opts.initial,
      };
      if (Object.values(patch).every((value) => value === undefined)) {
        throw new DflError(`Nothing to change for step "${id}".`, {
          hint: 'Pass --title, --description, --rename, --template-file or --initial.',
          code: 'INVALID_OPTIONS',
        });
      }
      updateStep(paths, flowName, id, patch);
      const changed = [
        opts.title !== undefined && 'title',
        opts.description !== undefined && 'description',
        opts.templateFile !== undefined && 'template',
        opts.initial && 'initial step',
      ].filter(Boolean);
      const label = opts.rename && opts.rename !== id ? `${id} ${c.dim(sym.arrow)} ${c.bold(opts.rename)}` : c.bold(id);
      success(
        `Updated step ${label} in flow "${flowName}"${changed.length > 0 ? c.dim(` (${changed.join(', ')})`) : ''}`,
      );
      await syncAfterChange(paths, { sync: opts.sync, flow: flowName, interactive: isInteractive() });
    });

  step
    .command('remove')
    .alias('rm')
    .description('Remove a step and its directory; incoming transitions are rerouted to its NEXT target')
    .argument('<id>', 'step id')
    .option('--force', 'drop incoming transitions that cannot be rerouted')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--flow <name>', 'flow (default: the active flow)')
    .option('--no-sync', 'do not re-install skills')
    .action(async (id, opts) => {
      const paths = projectFor(ctx);
      const model = loadFlowOrActive(paths, opts.flow);
      const target = model.byId.get(id);
      const ok = await confirmDestructive(
        `Remove step "${id}" from flow "${model.name}"${target && !target.final ? ` (deletes .df/${model.name}/steps/${id}/)` : ''}?`,
        opts,
      );
      if (!ok) {
        print(c.dim('Nothing changed.'));
        return;
      }
      removeStep(paths, model.name, id, { force: opts.force });
      success(`Removed step ${c.bold(id)} from flow "${model.name}"`);
      await syncAfterChange(paths, { sync: opts.sync, flow: model.name, interactive: isInteractive() });
    });

  step
    .command('transition')
    .description('Set or remove a transition: <id> --<event>--> <target>')
    .argument('<id>', 'source step id')
    .argument('<event>', 'event name, e.g. NEXT or CHANGES_REQUESTED')
    .argument('[target]', 'target step id')
    .option('--remove', 'remove the transition instead')
    .option('--flow <name>', 'flow (default: the active flow)')
    .option('--no-sync', 'do not re-install skills')
    .action(async (id, event, target, opts) => {
      const paths = projectFor(ctx);
      const flowName = loadFlowOrActive(paths, opts.flow).name;
      if (opts.remove && target !== undefined) {
        throw new DflError('Give either a target step or --remove, not both.', { code: 'INVALID_OPTIONS' });
      }
      if (!opts.remove && target === undefined) {
        throw new DflError(`Missing the target step of "${id}" ${event}.`, {
          hint: `Run \`dfl step transition ${id} ${event} <target>\`, or add --remove to delete the transition.`,
          code: 'INVALID_OPTIONS',
        });
      }
      setTransition(paths, flowName, id, event, opts.remove ? null : target!);
      if (opts.remove) success(`Removed transition ${c.bold(id)} ${c.cyan(event)} in flow "${flowName}"`);
      else success(`${c.bold(id)} ${c.dim('--')}${c.cyan(event)}${c.dim(`-${sym.arrow}`)} ${c.bold(target!)} in flow "${flowName}"`);
      await syncAfterChange(paths, { sync: opts.sync, flow: flowName, interactive: isInteractive() });
    });
}

/** Current step of the flow (every flow keeps its own position); undefined when it cannot be read. */
function currentOf(paths: ProjectPaths, model: FlowModel): string | undefined {
  try {
    return loadRuntimeState(paths, model).current;
  } catch {
    return undefined;
  }
}
