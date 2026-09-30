/**
 * `dfl flow list | templates | use | create | import | delete | validate | view`.
 */
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import { getActiveFlowName, setActiveFlow } from '../core/config.js';
import { DflError, errorMessage } from '../core/errors.js';
import { createFlow, deleteFlow, flowExists, listFlowTemplates, listFlows, loadFlow, loadFlowOrActive, skillSteps } from '../core/flow.js';
import { relPosix } from '../core/fsx.js';
import { importFlows } from '../core/import.js';
import { loadRuntimeState } from '../core/machine.js';
import { uninstallProject } from '../core/sync.js';
import type { FlowModel, ProjectPaths, ValidationIssue } from '../core/types.js';
import { validateFlow } from '../core/validate.js';
import { c } from '../ui/colors.js';
import { CliExit } from '../ui/exit.js';
import { issueLines } from '../ui/format.js';
import { plural, print, printJson, printLines, success, sym, terminalWidth, warning } from '../ui/output.js';
import { isInteractive } from '../ui/prompts.js';
import { table } from '../ui/table.js';
import { confirmDestructive, isInstalled, parseInteger, projectFor, syncAfterChange, type CliContext } from './shared.js';

export function registerFlowCommands(program: CommandUnknownOpts, ctx: CliContext): void {
  const flow = program.command('flow').description('Manage the flows of this project');

  flow
    .command('list')
    .alias('ls')
    .description('List the flows of this project')
    .option('--json', 'print JSON')
    .action((opts) => {
      const paths = projectFor(ctx);
      const active = getActiveFlowName(paths);
      const rows = listFlows(paths).map((name) => flowRow(paths, name, name === active));
      if (opts.json) {
        printJson(rows);
        return;
      }
      if (rows.length === 0) {
        print(c.dim('No flows yet. Create one with `dfl flow create <name>` or run `dfl install`.'));
        return;
      }
      printLines(
        table(
          rows.map((row) => [
            row.active ? c.cyan(sym.current) : ' ',
            row.active ? c.bold(row.name) : row.name,
            row.error ? c.red('invalid') : row.title,
            row.error ? '' : String(row.steps),
            row.error ? { text: row.error, style: c.red } : row.done ? c.green('done') : (row.current ?? ''),
          ]),
          { head: ['', 'FLOW', 'TITLE', 'STEPS', 'CURRENT'], align: ['left', 'left', 'left', 'right'], maxWidth: terminalWidth() },
        ),
      );
      if (!active && rows.length > 1) print(c.dim('\nNo active flow: select one with `dfl flow use <name>`.'));
    });

  flow
    .command('templates')
    .description('List the prebuilt flow templates')
    .option('--json', 'print JSON')
    .action((opts) => {
      const templates = listFlowTemplates().map(({ name, title, description, steps }) => ({ name, title, description, steps }));
      if (opts.json) {
        printJson(templates);
        return;
      }
      printLines(
        table(
          templates.map((t) => [c.bold(t.name), t.title, String(t.steps), { text: t.description, style: c.dim }]),
          { head: ['NAME', 'TITLE', 'STEPS', 'DESCRIPTION'], align: ['left', 'left', 'right'], maxWidth: terminalWidth() },
        ),
      );
      print(c.dim('\nCreate a flow from a template with `dfl flow create <name> --from <template>`.'));
    });

  flow
    .command('use')
    .description('Make a flow the active one and re-install its skills')
    .argument('<name>', 'flow name')
    .option('--project', 'set the team default in .df/config.json instead of your personal .df/local.json')
    .option('--no-sync', 'do not re-install skills')
    .action(async (name, opts) => {
      const paths = projectFor(ctx);
      requireFlow(paths, name);
      setActiveFlow(paths, name, opts.project ? 'project' : 'local');
      success(`Active flow: ${c.bold(name)} ${c.dim(opts.project ? '(team default, .df/config.json)' : '(personal, .df/local.json)')}`);
      await syncAfterChange(paths, { sync: opts.sync, interactive: isInteractive() });
    });

  flow
    .command('create')
    .description('Create a flow from a template or as a blank linear flow')
    .argument('<name>', 'flow name (lowercase letters, digits and hyphens)')
    .option('--from <template>', 'prebuilt template to copy (see `dfl flow templates`)')
    .option('--title <title>', 'flow title')
    .option('--description <text>', 'flow description')
    .option('--steps <ids>', 'comma-separated step ids for a blank flow, e.g. design,build,check')
    .option('--use', 'make it the active flow')
    .option('--no-sync', 'with --use: do not re-install skills')
    .action(async (name, opts) => {
      const paths = projectFor(ctx);
      const steps = opts.steps
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (opts.from && steps) {
        throw new DflError('--steps cannot be combined with --from.', { code: 'INVALID_OPTIONS' });
      }
      const model = createFlow(paths, name, { from: opts.from, title: opts.title, description: opts.description, steps });
      success(
        `Created flow ${c.bold(model.name)} ${c.dim(`(${plural(skillSteps(model).length, 'step')}${opts.from ? `, from template "${opts.from}"` : ''})`)} in ${relPosix(paths.root, model.dir)}/`,
      );
      if (opts.use) {
        setActiveFlow(paths, model.name);
        success(`Active flow: ${c.bold(model.name)}`);
        await syncAfterChange(paths, { sync: opts.sync, interactive: isInteractive() });
      } else {
        print(c.dim(`Activate it with \`dfl flow use ${model.name}\`; edit steps with \`dfl step add|edit|remove\`.`));
      }
    });

  flow
    .command('import')
    .description('Import flows from git (URL or github:owner/repo[/path][#ref]) or a local directory')
    .argument('<source>', 'git URL, github:owner/repo[/path][#ref] or directory')
    .option('--name <name>', 'name for the imported flow (single flow only)')
    .option('--flow <names...>', 'import only these flows from the source')
    .option('--force', 'replace existing flows with the same name')
    .option('--use', 'make the (first) imported flow active')
    .option('--no-sync', 'do not re-install skills')
    .action(async (source, opts) => {
      const paths = projectFor(ctx);
      const models = await importFlows(paths, source, { name: opts.name, flows: opts.flow, force: opts.force });
      for (const model of models) {
        success(`Imported flow ${c.bold(model.name)} ${c.dim(`(${plural(skillSteps(model).length, 'step')})`)}`);
      }
      const active = getActiveFlowName(paths);
      if (opts.use && models[0]) {
        setActiveFlow(paths, models[0].name);
        success(`Active flow: ${c.bold(models[0].name)}`);
        if (models.length > 1) print(c.dim(`Switch with \`dfl flow use <name>\` (${models.map((m) => m.name).join(', ')}).`));
        await syncAfterChange(paths, { sync: opts.sync, interactive: isInteractive() });
      } else if (active && models.some((model) => model.name === active)) {
        await syncAfterChange(paths, { sync: opts.sync, flow: active, interactive: isInteractive() });
      }
    });

  flow
    .command('delete')
    .alias('rm')
    .description('Delete a flow (its directory under .df/ and its runtime state)')
    .argument('<name>', 'flow name')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (name, opts) => {
      const paths = projectFor(ctx);
      requireFlow(paths, name);
      const wasActive = getActiveFlowName(paths) === name;
      const ok = await confirmDestructive(`Delete flow "${name}" (.df/${name}/ and its state)?`, opts);
      if (!ok) {
        print(c.dim('Nothing changed.'));
        return;
      }
      deleteFlow(paths, name);
      success(`Deleted flow ${c.bold(name)}`);
      if (!wasActive || !isInstalled(paths)) return;
      const next = getActiveFlowName(paths);
      if (next) {
        print(c.dim(`Active flow is now "${next}".`));
        await syncAfterChange(paths, { sync: true, interactive: isInteractive() });
        return;
      }
      // No flow is active any more: remove the deleted flow's installed skills and MCP entries.
      const report = uninstallProject(paths);
      print(`${c.cyan(sym.sync)} Removed ${plural(report.removed.length, 'installed skill dir')} of "${name}"`);
      for (const message of report.warnings) warning(message);
      const remaining = listFlows(paths);
      print(
        c.dim(
          remaining.length > 0
            ? `Select the active flow with \`dfl flow use <name>\` (${remaining.join(', ')}).`
            : 'Create a flow with `dfl flow create <name>` or `dfl install --flow <template>`.',
        ),
      );
    });

  flow
    .command('validate')
    .description('Validate a flow (default: the active flow, or all flows when none is active)')
    .argument('[name]', 'flow name')
    .option('--json', 'print JSON')
    .action((name, opts) => {
      const paths = projectFor(ctx);
      const names = name ? [name] : [getActiveFlowName(paths)].filter((n): n is string => n !== undefined);
      const targets = names.length > 0 ? names : listFlows(paths);
      if (targets.length === 0) {
        throw new DflError('This project has no flows to validate.', { hint: 'Run `dfl install` or `dfl flow create <name>`.', code: 'NO_ACTIVE_FLOW' });
      }
      const results = targets.map((flowName) => {
        const issues = validateFlow(paths, flowName);
        return { flow: flowName, valid: !issues.some((issue) => issue.level === 'error'), issues: issues.map((i) => relIssue(paths, i)) };
      });
      if (opts.json) printJson(name || results.length === 1 ? results[0] : results);
      else for (const result of results) printValidation(result.flow, result.issues);
      if (results.some((result) => !result.valid)) throw new CliExit(1);
    });

  flow
    .command('view')
    .description('Show the flow graph (interactive viewer in a terminal, printed otherwise)')
    .argument('[name]', 'flow name (default: the active flow)')
    .option('--zoom <level>', 'detail level 0-3', parseInteger)
    .option('--print', 'print the whole graph and exit')
    .option('--lr', 'lay out left to right')
    .option('--ascii', 'ASCII-only box drawing')
    .action(async (name, opts) => {
      const paths = projectFor(ctx);
      const model = loadFlowOrActive(paths, name);
      const current = model.name === getActiveFlowName(paths) ? currentStep(paths, model) : undefined;
      const { runFlowView } = await import('../tui/run-flow-view.js');
      await runFlowView(model, {
        current,
        zoom: opts.zoom,
        print: opts.print,
        direction: opts.lr ? 'LR' : 'TB',
        ascii: opts.ascii,
      });
    });
}

interface FlowRow {
  name: string;
  title: string;
  description: string;
  steps: number;
  active: boolean;
  current?: string | undefined;
  done?: boolean | undefined;
  source?: unknown;
  error?: string | undefined;
}

function flowRow(paths: ProjectPaths, name: string, active: boolean): FlowRow {
  let model: FlowModel;
  try {
    model = loadFlow(paths, name);
  } catch (error) {
    return { name, title: name, description: '', steps: 0, active, error: errorMessage(error) };
  }
  const row: FlowRow = {
    name,
    title: model.title,
    description: model.description,
    steps: skillSteps(model).length,
    active,
    source: model.def.source,
  };
  try {
    const state = loadRuntimeState(paths, model);
    row.current = state.current;
    row.done = state.done;
  } catch (error) {
    row.error = errorMessage(error);
  }
  return row;
}

function currentStep(paths: ProjectPaths, model: FlowModel): string | undefined {
  try {
    return loadRuntimeState(paths, model).current;
  } catch {
    return undefined;
  }
}

function requireFlow(paths: ProjectPaths, name: string): void {
  if (flowExists(paths, name)) return;
  const flows = listFlows(paths);
  throw new DflError(`Flow "${name}" not found.`, {
    hint: flows.length > 0 ? `Flows: ${flows.join(', ')}.` : 'This project has no flows yet: run `dfl install` or `dfl flow create <name>`.',
    code: 'FLOW_NOT_FOUND',
  });
}

/** Issue with a project-relative `file` for output. */
function relIssue(paths: ProjectPaths, issue: ValidationIssue): ValidationIssue {
  return issue.file ? { ...issue, file: relPosix(paths.root, issue.file) } : issue;
}

function printValidation(flow: string, issues: readonly ValidationIssue[]): void {
  const errors = issues.filter((issue) => issue.level === 'error').length;
  const warnings = issues.length - errors;
  if (errors > 0) {
    print(`${c.red(sym.fail)} Flow ${c.bold(flow)} is invalid ${c.dim(`(${plural(errors, 'error')}, ${plural(warnings, 'warning')})`)}`);
  } else {
    print(`${c.green(sym.ok)} Flow ${c.bold(flow)} is valid${warnings > 0 ? c.dim(` (${plural(warnings, 'warning')})`) : ''}`);
  }
  printLines(issueLines(issues, '  '));
}
