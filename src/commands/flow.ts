/**
 * `dfl flow list | templates | use | create | import | delete | validate | view`.
 */
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import { getActiveFlowName, getSelectedAgents, loadProjectConfig } from '../core/config.js';
import { DflError, errorMessage, isDflError } from '../core/errors.js';
import { createFlow, deleteFlow, flowExists, listFlowTemplates, listFlows, loadFlow, loadFlowOrActive, skillSteps } from '../core/flow.js';
import { relPosix } from '../core/fsx.js';
import { assertValidFlowName } from '../core/ids.js';
import { packageVersion } from '../core/paths.js';
import { importFlows, pullFlow, type FlowReplacement, type PullResult, type RecordedFlowSource } from '../core/import.js';
import { loadRuntimeState } from '../core/machine.js';
import { isInstalledForUser, readManifest, uninstallProject, writeManifest } from '../core/sync.js';
import type { FlowModel, ProjectPaths, ValidationIssue } from '../core/types.js';
import { validateFlow } from '../core/validate.js';
import { c } from '../ui/colors.js';
import { CliExit } from '../ui/exit.js';
import { issueLines } from '../ui/format.js';
import { plural, print, printJson, printLines, success, sym, terminalWidth, warning } from '../ui/output.js';
import { isInteractive } from '../ui/prompts.js';
import { table } from '../ui/table.js';
import {
  confirmDestructive,
  locked,
  lockedSwitchActiveFlow,
  lockedSyncAfterChange,
  parseInteger,
  printAfterChange,
  projectFor,
  syncAfterChange,
  type AfterChange,
  type CliContext,
} from './shared.js';

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
      // Validated before anything is written; a failed sync restores the previous active flow.
      // Missing variables are asked for before the lock is taken.
      const result = await lockedSwitchActiveFlow(paths, name, opts.project ? 'project' : 'local', {
        sync: opts.sync,
        interactive: isInteractive(),
      });
      success(`Active flow: ${c.bold(name)} ${c.dim(opts.project ? '(team default, .df/config.json)' : '(personal, .df/local.json)')}`);
      printAfterChange(paths, result);
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
      const model = await locked(paths, () =>
        createFlow(paths, name, { from: opts.from, title: opts.title, description: opts.description, steps }),
      );
      success(
        `Created flow ${c.bold(model.name)} ${c.dim(`(${plural(skillSteps(model).length, 'step')}${opts.from ? `, from template "${opts.from}"` : ''})`)} in ${relPosix(paths.root, model.dir)}/`,
      );
      if (opts.use) {
        const result = await lockedSwitchActiveFlow(paths, model.name, 'local', { sync: opts.sync, interactive: isInteractive() });
        success(`Active flow: ${c.bold(model.name)}`);
        printAfterChange(paths, result);
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
      const models = await locked(paths, () => importFlows(paths, source, { name: opts.name, flows: opts.flow, force: opts.force }));
      for (const model of models) {
        success(`Imported flow ${c.bold(model.name)} ${c.dim(`(${plural(skillSteps(model).length, 'step')})`)}`);
        printLines([...keptLines(model), ...currentMoveLines(model, false)]);
      }
      const active = getActiveFlowName(paths);
      if (opts.use && models[0]) {
        const first = models[0].name;
        let result: AfterChange;
        try {
          result = await lockedSwitchActiveFlow(paths, first, 'local', { sync: opts.sync, interactive: isInteractive() });
        } catch (error) {
          if (!isDflError(error) || error.code !== 'INVALID_FLOW') throw error;
          // The flow stays imported but inactive: the active flow and the installed skills are unchanged.
          throw new DflError(`${error.message}\nThe flow was imported but not activated.`, {
            hint: `Fix it, then run \`dfl flow use ${first}\`${active ? ` (the active flow is still "${active}")` : ''}.`,
            code: 'INVALID_FLOW',
          });
        }
        success(`Active flow: ${c.bold(first)}`);
        if (models.length > 1) print(c.dim(`Switch with \`dfl flow use <name>\` (${models.map((m) => m.name).join(', ')}).`));
        printAfterChange(paths, result);
      } else if (active && models.some((model) => model.name === active)) {
        await lockedSyncAfterChange(paths, { sync: opts.sync, flow: active, interactive: isInteractive() });
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
      const wasTeamDefault = loadProjectConfig(paths).activeFlow === name;
      const ok = await confirmDestructive(`Delete flow "${name}" (.df/${name}/ and its state)?`, opts);
      if (!ok) {
        print(c.dim('Nothing changed.'));
        return;
      }
      await locked(paths, () => deleteAndResync(paths, name, { wasActive, wasTeamDefault }));
    });

  flow
    .command('pull')
    .description('Update a flow from the source it was created from (template, git or local directory)')
    .argument('[name]', 'flow name (default: the active flow)')
    .option('--rev <ref>', 'git sources: branch, tag or commit to pull instead of the recorded one')
    .option('--dry-run', 'only show what would change')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--no-sync', 'do not re-install skills')
    .action(async (name, opts) => {
      const paths = projectFor(ctx);
      if (name !== undefined) requireFlow(paths, name);
      const flowName = name ?? loadFlowOrActive(paths).name;
      let result: PullResult;
      if (opts.yes && !opts.dryRun) {
        result = await locked(paths, () => pullFlow(paths, flowName, { rev: opts.rev }));
      } else {
        // Show what would change first (git sources are fetched twice: preview, then pull).
        const preview = await pullFlow(paths, flowName, { rev: opts.rev, dryRun: true });
        if (changeCount(preview) === 0) {
          success(`Flow ${c.bold(flowName)} is up to date with ${describeSource(preview.source)}`);
          return;
        }
        print(`Changes to flow ${c.bold(flowName)} from ${describeSource(preview.source)}:`);
        printLines([...changeLines(preview), ...currentMoveLines(preview, true)]);
        if (opts.dryRun) return;
        const ok = await confirmDestructive(
          `Replace the files of flow "${flowName}" with ${describeSource(preview.source)} (local edits in .df/${flowName}/ are lost)?`,
          opts,
        );
        if (!ok) {
          print(c.dim('Nothing changed.'));
          return;
        }
        result = await locked(paths, () => pullFlow(paths, flowName, { rev: opts.rev }));
      }
      if (changeCount(result) === 0) {
        success(`Flow ${c.bold(flowName)} is up to date with ${describeSource(result.source)}`);
        return;
      }
      success(`Pulled flow ${c.bold(flowName)} from ${describeSource(result.source)} ${c.dim(`(${plural(changeCount(result), 'file')} changed)`)}`);
      if (opts.yes) printLines(changeLines(result));
      printLines(currentMoveLines(result, false));
      await lockedSyncAfterChange(paths, { sync: opts.sync, flow: flowName, interactive: isInteractive() });
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
      // One JSON shape whatever the project state: { valid, flows: [{ flow, valid, issues }] }.
      if (opts.json) printJson({ valid: results.every((result) => result.valid), flows: results });
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
        // Zoom-3 cards show how the selected agents invoke each skill (`/name`, `$name` for Codex).
        agents: getSelectedAgents(paths),
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

/** `flow delete` after the confirmation: deletes the flow and re-syncs (or removes its skills when no flow is left active). */
async function deleteAndResync(
  paths: ProjectPaths,
  name: string,
  { wasActive, wasTeamDefault }: { wasActive: boolean; wasTeamDefault: boolean },
): Promise<void> {
  deleteFlow(paths, name);
  success(`Deleted flow ${c.bold(name)}`);
  const left = listFlows(paths);
  if (wasTeamDefault && left.length > 1) {
    warning(`No team default flow is set any more: choose one with \`dfl flow use <name> --project\` (${left.join(', ')}).`);
  }
  if (!wasActive || !isInstalledForUser(paths)) return;
  const next = getActiveFlowName(paths);
  if (next) {
    print(c.dim(`Active flow is now "${next}".`));
    await syncAfterChange(paths, { sync: true });
    return;
  }
  // No flow is active any more: remove the deleted flow's installed skills, but stay installed (a
  // manifest without skills), so activating another flow later installs its skills again. The MCP
  // entries are committed team config and stay (only `dfl uninstall` removes them).
  const previous = readManifest(paths);
  const report = uninstallProject(paths, { keepMcp: true });
  const deletedPrefix = `.df/${name}/`;
  writeManifest(paths, {
    version: 1,
    agents: previous.agents,
    skills: [],
    mcp: previous.mcp,
    rendered: (previous.rendered ?? []).filter((rel) => !rel.startsWith(deletedPrefix)),
    createdDirs: previous.createdDirs,
    // No flow and no skills: `dfl status` reports "no flow's skills are installed yet", not an old dfl.
    dflVersion: packageVersion(),
  });
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
}

function requireFlow(paths: ProjectPaths, name: string): void {
  if (flowExists(paths, name)) return;
  assertValidFlowName(name);
  const flows = listFlows(paths);
  const template = listFlowTemplates().some((t) => t.name === name)
    ? `"${name}" is a prebuilt template: create a flow from it with \`dfl flow create ${name} --from ${name} --use\`.`
    : undefined;
  throw new DflError(`Flow "${name}" not found.`, {
    hint: [
      template,
      flows.length > 0 ? `Flows: ${flows.join(', ')}.` : 'This project has no flows yet: run `dfl install` or `dfl flow create <name>`.',
    ]
      .filter(Boolean)
      .join(' '),
    code: 'FLOW_NOT_FOUND',
  });
}

/** `template "feature"`, `github.com/acme/flows.git@v2`, `../shared-flows`. */
function describeSource(source: RecordedFlowSource): string {
  const sub = source.path ? `//${source.path}` : '';
  switch (source.type) {
    case 'template':
      return `template "${source.ref ?? '?'}"`;
    case 'git':
      return `${source.ref ?? '?'}${sub}${source.rev ? `#${source.rev}` : ''}`;
    default:
      return `${source.ref ?? '?'}${sub}`;
  }
}

function changeCount(result: PullResult): number {
  return result.added.length + result.removed.length + result.changed.length;
}

/** Changed files of a pull, flow-relative, and the hand-written files it keeps. */
function changeLines(result: PullResult): string[] {
  return [
    ...result.added.map((rel) => `  ${c.green(sym.added)} ${rel}`),
    ...result.changed.map((rel) => `  ${c.yellow('~')} ${rel}`),
    ...result.removed.map((rel) => `  ${c.red(sym.removed)} ${rel}`),
    ...keptLines(result),
  ];
}

/** `= steps/plan/notes.md (hand-written, kept)` for each hand-written file a replacement keeps. */
function keptLines(replacement: FlowReplacement): string[] {
  return replacement.kept.map((rel) => `  = ${rel} ${c.dim('(hand-written, kept)')}`);
}

/** Where the developer's position went (or would go) because the current step is not in the new version. */
function currentMoveLines(replacement: FlowReplacement, preview: boolean): string[] {
  if (!replacement.currentMoved) return [];
  const { from, to } = replacement.currentMoved;
  return [
    c.dim(
      preview
        ? `  "${from}" (your current step) is not in the new version; you would continue at "${to}".`
        : `  "${from}" was your current step and is not in the new version; the flow continues at "${to}".`,
    ),
  ];
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
