/**
 * `dfl flow list | templates | use | create | export | import | pull | delete | validate | view`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import { BUNDLE_EXTENSION, backupFlow, bundleFlows, serializeBundle } from '../core/bundle.js';
import { getActiveFlowName, getSelectedAgents, loadProjectConfig } from '../core/config.js';
import { DflError, errorMessage, isDflError } from '../core/errors.js';
import {
  createFlow,
  deleteFlow,
  flowExists,
  listFlowTemplates,
  listFlows,
  loadActiveFlow,
  loadFlow,
  loadFlowOrActive,
  skillSteps,
} from '../core/flow.js';
import { isDir, relPosix, writeText } from '../core/fsx.js';
import { assertValidFlowName } from '../core/ids.js';
import { packageVersion } from '../core/paths.js';
import {
  handWrittenFlowFiles,
  hasChanges,
  localChangeLabel,
  localLosses,
  prepareImport,
  preparePull,
  type FileChange,
  type FlowDiff,
  type FlowReplacement,
  type ImportedFlow,
  type PullResult,
  type RecordedFlowSource,
} from '../core/import.js';
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
  trackedViewNote,
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
            // Tracked flows: the task's step lives in Jira, the local one is stale.
            row.error ? { text: row.error, style: c.red } : row.note !== undefined ? { text: row.note, style: c.dim } : row.done ? c.green('done') : (row.current ?? ''),
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
    .command('export')
    .description('Write flows to one file, as a backup or to share; `dfl flow import <file>` restores them')
    .argument('[names...]', 'flows to export (default: the active flow)')
    .option('--all', 'export every flow of the project')
    .option('-o, --output <file>', `file or directory to write, \`-\` for stdout (default: <flow>${BUNDLE_EXTENSION} here)`)
    .option('--force', 'overwrite an existing file')
    .action(async (names, opts) => {
      const paths = projectFor(ctx);
      if (opts.all && names.length > 0) throw new DflError('Give flow names or --all, not both.', { code: 'INVALID_OPTIONS' });
      for (const name of names) requireFlow(paths, name);
      const flows = opts.all ? listFlows(paths) : names.length > 0 ? [...new Set(names)] : [activeFlowName(paths)];
      if (flows.length === 0) {
        throw new DflError('This project has no flows to export.', { hint: 'Create one with `dfl flow create <name>`.', code: 'NO_ACTIVE_FLOW' });
      }
      const target = opts.output === '-' ? undefined : exportTarget(paths, opts.output, flows, opts.force === true);
      // Read under the lock, so a concurrent pull or step edit is never half exported.
      const bundle = await locked(paths, () => bundleFlows(paths, flows));
      for (const flow of flows) warnNotExported(paths, flow);
      const content = serializeBundle(bundle);
      if (target === undefined) {
        process.stdout.write(content);
        return;
      }
      writeText(target, content);
      const shown = displayFile(target);
      const files = bundle.flows.reduce((sum, flow) => sum + flow.files.length, 0);
      success(
        flows.length === 1
          ? `Exported flow ${c.bold(flows[0]!)} ${c.dim(`(${stepsAndFiles(paths, flows[0]!, files)})`)} to ${shown}`
          : `Exported ${plural(flows.length, 'flow')} ${c.dim(`(${flows.join(', ')}; ${plural(files, 'file')})`)} to ${shown}`,
      );
      print(c.dim(`Import it with \`dfl flow import ${shown}\` (in this or another project).`));
    });

  flow
    .command('import')
    .description('Import flows from a `dfl flow export` file, git (URL or github:owner/repo[/path][#ref]) or a local directory')
    .argument('<source>', 'export file, git URL, github:owner/repo[/path][#ref] or directory')
    .option('--name <name>', 'name for the imported flow (single flow only)')
    .option('--flow <names...>', 'import only these flows from the source')
    .option('--force', 'replace existing flows with the same name (shows the changes and asks first; a backup is saved)')
    .option('--dry-run', 'only show what would be imported or replaced')
    .option('-y, --yes', 'with --force: replace without asking')
    .option('--use', 'make the (first) imported flow active')
    .option('--no-sync', 'do not re-install skills')
    .action(async (source, opts) => {
      const paths = projectFor(ctx);
      // Fetched and staged without the lock (a clone can take a while); nothing in the project changes yet.
      const prepared = await prepareImport(paths, source, { name: opts.name, flows: opts.flow, force: opts.force });
      let models: ImportedFlow[];
      try {
        const replacing = prepared.flows.filter((preview) => preview.diff !== undefined && hasChanges(preview.diff));
        if (opts.dryRun) {
          for (const preview of prepared.flows) {
            if (!preview.diff) print(`${c.green(sym.added)} Would import flow ${c.bold(preview.name)} ${c.dim(`(${plural(skillSteps(preview.model).length, 'step')})`)}`);
            else if (!hasChanges(preview.diff)) print(`= Flow ${c.bold(preview.name)} is the same as the imported version`);
            else {
              print(`Changes to flow ${c.bold(preview.name)}:`);
              printLines([...diffLines(preview.diff), ...keptLines(preview), ...currentMoveLines(preview, true)]);
            }
          }
          return;
        }
        for (const preview of replacing) {
          print(`Changes to flow ${c.bold(preview.name)}:`);
          printLines([...diffLines(preview.diff!), ...keptLines(preview), ...currentMoveLines(preview, true)]);
        }
        if (replacing.length > 0 && !opts.yes) {
          const list = replacing.map((preview) => `"${preview.name}"`).join(', ');
          const ok = await confirmDestructive(
            `Replace flow${replacing.length > 1 ? 's' : ''} ${list} with the imported version (a backup is saved first)?`,
            opts,
          );
          if (!ok) {
            print(c.dim('Nothing changed.'));
            return;
          }
        }
        models = await locked(paths, () => prepared.apply());
      } finally {
        prepared.discard();
      }
      for (const model of models) {
        if (model.unchanged) {
          success(`Flow ${c.bold(model.name)} is the same as the imported version ${c.dim('(nothing replaced)')}`);
          continue;
        }
        success(`${model.replaced ? 'Replaced' : 'Imported'} flow ${c.bold(model.name)} ${c.dim(`(${plural(skillSteps(model).length, 'step')})`)}`);
        if (model.backup) print(backupLine(model.backup, true));
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
      } else if (active && models.some((model) => model.name === active && !model.unchanged)) {
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
      const ok = await confirmDestructive(`Delete flow "${name}" (.df/${name}/ and its state; a backup is saved first)?`, opts);
      if (!ok) {
        print(c.dim('Nothing changed.'));
        return;
      }
      await locked(paths, () => deleteAndResync(paths, name, { wasActive, wasTeamDefault }));
    });

  flow
    .command('pull')
    .description('Update a flow from the source it was created from (template, git or local directory), after showing the changes')
    .argument('[name]', 'flow name (default: the active flow)')
    .option('--rev <ref>', 'git sources: branch, tag or commit to pull instead of the recorded one')
    .option('--dry-run', 'only show what would change')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--discard-local', 'with --yes: also replace changes made to the flow in this project (a backup is saved first)')
    .option('--no-sync', 'do not re-install skills')
    .action(async (name, opts) => {
      const paths = projectFor(ctx);
      if (name !== undefined) requireFlow(paths, name);
      const flowName = name ?? loadFlowOrActive(paths).name;
      // Fetched and staged without the lock; `apply` replaces exactly what was shown, or refuses.
      const pull = await preparePull(paths, flowName, { rev: opts.rev });
      let result: PullResult;
      try {
        if (!hasChanges(pull)) {
          success(`Flow ${c.bold(flowName)} is up to date with ${describeSource(pull.source)}`);
          return;
        }
        print(`Changes to flow ${c.bold(flowName)} from ${describeSource(pull.source)}:`);
        printLines([...diffLines(pull), ...keptLines(pull), ...currentMoveLines(pull, true)]);
        if (opts.dryRun) return;
        const losses = localLosses(pull);
        if (opts.yes && losses.length > 0 && !opts.discardLocal) {
          throw new DflError(`Flow "${flowName}" was not updated: ${lossSummary(pull, losses)}.`, {
            hint: 'Keep your version, or re-run with --yes --discard-local to replace it (a backup of the flow is saved first).',
            code: 'LOCAL_CHANGES',
          });
        }
        if (!opts.yes) {
          const question =
            losses.length > 0
              ? `Update flow "${flowName}" and discard ${pull.baseline ? 'your edits to' : 'any edits made here to'} ${plural(losses.length, 'file')} (a backup is saved first)?`
              : `Update flow "${flowName}" from ${describeSource(pull.source)} (a backup is saved first)?`;
          const ok = await confirmDestructive(question, { ...opts, flag: losses.length > 0 ? '--yes --discard-local' : '--yes' });
          if (!ok) {
            print(c.dim('Nothing changed.'));
            return;
          }
        }
        // Answering yes to the question above (it names the discarded files) is the explicit consent.
        result = await locked(paths, () => pull.apply({ discardLocal: !opts.yes || opts.discardLocal === true }));
      } finally {
        pull.discard();
      }
      const count = result.changes.length;
      success(
        `Pulled flow ${c.bold(flowName)} from ${describeSource(result.source)} ${c.dim(count > 0 ? `(${plural(count, 'file')} changed)` : '(recorded source updated)')}`,
      );
      if (result.backup) print(backupLine(result.backup, true));
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
      // A flow tracked in Jira: the local current step is stale, so none is highlighted.
      const tracked = trackedViewNote(paths, model.name);
      const current = !tracked && model.name === getActiveFlowName(paths) ? currentStep(paths, model) : undefined;
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
      if (tracked && (opts.print || !process.stdin.isTTY || !process.stdout.isTTY)) print(c.dim(`${capitalize(tracked.note)}.`));
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
  /** Tracked in Jira: `current`/`done` are this checkout's local position, not a task's. */
  tracked?: true | undefined;
  /** With `tracked`: shown instead of the local current step (e.g. `tracked in Jira (ABC-1): run \`dfl status\``). */
  note?: string | undefined;
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
  const tracked = trackedViewNote(paths, name);
  if (tracked) {
    row.tracked = true;
    row.note = tracked.note;
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
  // Without a backup nothing is deleted: a flow that is not committed yet would be gone for good.
  const backup = backupFlow(paths, name);
  deleteFlow(paths, name);
  success(`Deleted flow ${c.bold(name)}`);
  print(backupLine(backup, false));
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

/**
 * The files a replacement adds (`+`), changes (`~`) or removes (`−`), flow-relative, in path order.
 * A change that discards work done in this project says so in yellow; without a recorded version a
 * note says that dfl cannot tell.
 */
function diffLines(diff: FlowDiff): string[] {
  const mark = (change: FileChange): string =>
    change.change === 'added' ? c.green(sym.added) : change.change === 'removed' ? c.red(sym.removed) : c.yellow('~');
  const lines = diff.changes.map((change) =>
    change.local === 'none' || change.local === 'unknown'
      ? `  ${mark(change)} ${change.path}`
      : `  ${mark(change)} ${change.path} ${c.yellow(`${sym.warn} ${localChangeLabel(change)}`)}`,
  );
  if (diff.sourceChanged && !diff.changes.some((change) => change.path === 'flow.json')) {
    lines.push(`  ${c.yellow('~')} flow.json ${c.dim('(recorded source only)')}`);
  }
  const losses = localLosses(diff);
  if (losses.length > 0) lines.push(c.yellow(`  ${sym.warn} ${capitalize(lossSummary(diff, losses))}.`));
  return lines;
}

/** `it would discard 2 changes made in this project` (or, without a recorded version, that dfl cannot tell). */
function lossSummary(diff: FlowDiff, losses: readonly FileChange[]): string {
  return diff.baseline
    ? `it would discard edits made in this project to ${plural(losses.length, 'file')} (marked above)`
    : 'this flow has no record of the version it came from (older dfl versions did not keep one), so dfl cannot tell ' +
        'whether the files above hold edits made in this project; any such edit would be replaced';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `  Backup: .df/.dfl-backups/x.dfl.json (restore with `dfl flow import … --force`)` */
function backupLine(backup: string, replaced: boolean): string {
  return c.dim(`  Backup: ${backup} (restore with \`dfl flow import ${backup}${replaced ? ' --force' : ''}\`)`);
}

/** The active flow's name, else the NO_ACTIVE_FLOW error of loadActiveFlow (a broken active flow can still be exported). */
function activeFlowName(paths: ProjectPaths): string {
  return getActiveFlowName(paths) ?? loadActiveFlow(paths).name;
}

/**
 * Where `dfl flow export` writes: `<flow>.dfl.json` (`flows.dfl.json` for several) in the current
 * directory or in `output` when that is a directory, else `output`. Refuses an existing file without
 * `force`, and any place inside a flow directory (the file would become part of the flow).
 */
function exportTarget(paths: ProjectPaths, output: string | undefined, flows: readonly string[], force: boolean): string {
  const fileName = `${flows.length === 1 ? flows[0]! : 'flows'}${BUNDLE_EXTENSION}`;
  const given = output === undefined ? process.cwd() : path.resolve(output);
  // `-o exports/` names a directory even before it exists (path.resolve drops the slash).
  const dirGiven = output === undefined || /[/\\]$/.test(output) || isDir(given);
  const file = dirGiven ? path.join(given, fileName) : given;
  const real = realpathOrSelf(file);
  for (const name of listFlows(paths)) {
    const rel = path.relative(realpathOrSelf(paths.flowDir(name)), real);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new DflError(`Cannot write the export into .df/${name}/: it would become part of flow "${name}".`, {
        hint: 'Write it somewhere else with -o <file>.',
        code: 'INVALID_OPTIONS',
      });
    }
  }
  if (fs.existsSync(file)) {
    if (isDir(file)) throw new DflError(`${displayFile(file)} is a directory.`, { code: 'INVALID_OPTIONS' });
    if (!force) throw new DflError(`${displayFile(file)} already exists.`, { hint: 'Pass --force to overwrite it, or -o <file>.', code: 'FILE_EXISTS' });
  }
  return file;
}

function realpathOrSelf(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(realpathOrSelf(parent), path.basename(file));
  }
}

/** A path for messages: relative to the current directory when inside it. */
function displayFile(file: string): string {
  const rel = path.relative(process.cwd(), file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

/** `6 steps, 7 files` (only the file count when the flow does not load). */
function stepsAndFiles(paths: ProjectPaths, flow: string, files: number): string {
  try {
    return `${plural(skillSteps(loadFlow(paths, flow)).length, 'step')}, ${plural(files, 'file')}`;
  } catch {
    return plural(files, 'file');
  }
}

/** Warns about what an export of `flow` leaves out or carries over as is. */
function warnNotExported(paths: ProjectPaths, flow: string): void {
  const handWritten = handWrittenFlowFiles(paths, flow);
  if (handWritten.length > 0) {
    warning(
      `Not exported from flow "${flow}": ${handWritten.join(', ')} (hand-written .md files under steps/ are not part of the flow; ` +
        'rename one to <name>.md.hbs to make it a template of the flow).',
    );
  }
  const errors = validateFlow(paths, flow).filter((issue) => issue.level === 'error').length;
  if (errors > 0) warning(`Flow "${flow}" has ${plural(errors, 'validation error')}; it is exported as is (see \`dfl flow validate ${flow}\`).`);
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
