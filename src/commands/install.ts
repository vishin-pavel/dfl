/**
 * `dfl install`, `dfl uninstall`, `dfl flow-update` (alias `update`).
 */
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import { AGENTS, detectAgents, getAgent, parseAgentList } from '../agents/registry.js';
import {
  getActiveFlowName,
  getMcpEnabled,
  initProject,
  loadLocalConfig,
  loadProjectConfig,
  setActiveFlow,
  setMcpEnabled,
  setSelectedAgents,
} from '../core/config.js';
import { DflError } from '../core/errors.js';
import { createFlow, flowExists, listFlowTemplates, listFlows, loadFlow } from '../core/flow.js';
import { loadRuntimeState } from '../core/machine.js';
import { readManifest, uninstallProject } from '../core/sync.js';
import { AGENT_IDS, type AgentId, type FlowModel, type ProjectPaths } from '../core/types.js';
import { assertFlowValid } from '../core/validate.js';
import { resolveVars, setVar, varScope } from '../core/vars.js';
import { c } from '../ui/colors.js';
import { agentNames, skillCommand, syncSummaryLine } from '../ui/format.js';
import { plural, print, printLines, success, sym, terminalWidth, warning, wrapItems } from '../ui/output.js';
import {
  confirm,
  intro,
  isInteractive,
  logMessage,
  logWarning,
  multiselect,
  outro,
  select,
  spinner,
} from '../ui/prompts.js';
import {
  askMissingVars,
  confirmDestructive,
  locked,
  mcpChangeLine,
  projectFor,
  promptVarInteractive,
  storeVarAnswers,
  syncWithDiff,
  templateUpdateLines,
  warnRepairedState,
  type CliContext,
  type SyncRun,
} from './shared.js';

/** Template installed when nothing else is chosen. */
const DEFAULT_TEMPLATE = 'feature';

export function registerInstallCommands(program: CommandUnknownOpts, ctx: CliContext): void {
  program
    .command('install')
    .description('Set up dfl in this project: flows, agent skills and the MCP server')
    .option('-a, --agents <list>', `agents to install for, comma-separated (${AGENT_IDS.join(', ')})`)
    .option('-f, --flow <name>', 'flow template to create, or existing flow to activate')
    .option('-y, --yes', 'accept the defaults, never prompt')
    .option('--mcp', 'register the dfl MCP server in the agents\' project MCP configs (remembered)')
    .option('--no-mcp', 'do not register the dfl MCP server (remembered for later syncs)')
    .option('--project-agents', 'save the agent selection as the team default in .df/config.json')
    .action(async (opts) => {
      await install(ctx, opts);
    });

  program
    .command('uninstall')
    .description('Remove the installed skills and the dfl MCP entries (flows in .df/ are kept)')
    .option('--purge', 'also delete .df/local.json, .df/state.json and rendered skill files')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (opts) => {
      const paths = projectFor(ctx);
      // Like `flow delete` and `step remove`: without a terminal to ask, --yes is required.
      const ok = await confirmDestructive(
        opts.purge
          ? 'Remove installed skills and MCP entries, and delete personal config, state and rendered files?'
          : 'Remove installed skills and MCP entries?',
        opts,
      );
      if (!ok) {
        print(c.dim('Nothing changed.'));
        return;
      }
      const report = await locked(paths, () => uninstallProject(paths, { purge: opts.purge }));
      success(`Uninstalled dfl from ${paths.root} ${c.dim(`(${plural(report.removed.length, 'path')} removed)`)}`);
      for (const rel of report.removed) print(`  ${c.red(sym.removed)} ${rel}`);
      for (const entry of report.mcp) if (entry.changed) print(`  ${c.red(sym.removed)} dfl MCP server in ${entry.file}`);
      for (const message of report.warnings) warning(message);
      if (report.manifestKept) {
        print(c.dim('.df/installed.json still lists the MCP entries that could not be removed; run `dfl uninstall` again after fixing them.'));
      }
      print(c.dim('Flows in .df/ were kept. Run `dfl install` to install again.'));
    });

  program
    .command('flow-update')
    .alias('update')
    .description('Re-render and re-install the active flow skills (after git pull or edits); never changes the flows in .df/')
    .option('--mcp', 'register the dfl MCP server this time, whatever your saved preference')
    .option('--no-mcp', 'do not touch MCP configs this time')
    .option('--dry-run', 'show what would change without writing')
    .option('-y, --yes', 'never prompt for missing variables')
    .action(async (opts) => {
      const paths = projectFor(ctx);
      // Missing required variables are asked for before the lock is taken (a dry run asks nothing).
      const answers = await askMissingVars(paths, { interactive: isInteractive(opts), sync: opts.dryRun !== true, always: true });
      // Without --mcp/--no-mcp the saved preference (`dfl install --no-mcp`) applies.
      const run = await locked(paths, () => {
        storeVarAnswers(paths, answers);
        return syncWithDiff(paths, { mcp: opts.mcp, dryRun: opts.dryRun });
      });
      printLines([...compactSyncLines(run, opts.dryRun === true), ...templateUpdateLines(paths)]);
      for (const message of run.report.warnings) warning(message);
      warnRepairedState(paths, run.report.flow);
    });
}

interface InstallOptions {
  agents?: string | undefined;
  flow?: string | undefined;
  yes?: boolean | undefined;
  /** `--mcp` (true) / `--no-mcp` (false); undefined: ask, or use the saved preference. */
  mcp?: boolean | undefined;
  projectAgents?: boolean | undefined;
}

async function install(ctx: CliContext, opts: InstallOptions): Promise<void> {
  const paths = projectFor(ctx, { forInstall: true });
  const interactive = isInteractive(opts);
  const agentsFlag = opts.agents !== undefined ? parseAgentList(opts.agents) : undefined;
  if (agentsFlag && agentsFlag.length === 0) {
    throw new DflError('No agents given to --agents.', { hint: `Valid agents: ${AGENT_IDS.join(', ')}.`, code: 'UNKNOWN_AGENT' });
  }

  if (interactive) {
    intro(c.inverse(' dfl install '));
    logMessage([`Project: ${c.bold(paths.root)}`]);
  } else {
    print(`${c.bold('dfl install')} ${c.dim(paths.root)}`);
  }

  // Every question is asked before anything is written, so cancelling leaves the project untouched.
  // Flows: --flow, or templates when the project has none yet.
  let toCreate: string[] = [];
  let preferred: string | undefined;
  if (opts.flow !== undefined) {
    preferred = opts.flow;
    if (!flowExists(paths, opts.flow)) toCreate = [templateOrThrow(paths, opts.flow)];
  } else if (listFlows(paths).length === 0) {
    toCreate = await chooseTemplates(interactive);
  }
  const current = getActiveFlowName(paths);
  const active = preferred ?? current ?? (await chooseActiveFlow(paths, toCreate, interactive));
  // The committed team default is only set when it is missing and the choice is not arbitrary: flows
  // created now, --flow, a flow picked in the wizard or the project's only flow. A personal choice
  // (local.json) never becomes the team default.
  const teamFlow =
    loadProjectConfig(paths).activeFlow === undefined &&
    (preferred !== undefined || current === undefined || loadLocalConfig(paths).activeFlow !== current);

  // Agents.
  const detected = detectAgents(paths.root);
  const config = loadProjectConfig(paths);
  const initialAgents =
    agentsFlag ?? nonEmpty(loadLocalConfig(paths).agents) ?? nonEmpty(config.agents) ?? nonEmpty(detected) ?? ['claude'];
  const agents =
    interactive && !agentsFlag
      ? await multiselect<AgentId>({
          message: 'Install the skills for which agents?',
          options: AGENTS.map((agent) => ({
            value: agent.id,
            label: detected.includes(agent.id) ? `${agent.name} ${c.dim('(detected)')}` : agent.name,
            hint: agent.skillsDir,
          })),
          initialValues: initialAgents,
          required: true,
        })
      : initialAgents;

  // Remembered per developer (local.json `mcp`): later syncs follow it until the next `dfl install --mcp`.
  const mcp =
    opts.mcp ??
    (interactive
      ? await confirm({
          message: 'Register the dfl MCP server in the project MCP config of these agents?',
          initialValue: getMcpEnabled(paths),
        })
      : getMcpEnabled(paths));

  // Team default.
  let saveTeam = opts.projectAgents === true;
  if (!saveTeam && interactive && !sameSet(agents, config.agents ?? [])) {
    saveTeam = await confirm({ message: 'Save this agent selection as the team default in .df/config.json?', initialValue: false });
  }

  // Writes start here.
  initProject(paths);
  for (const name of toCreate) createFlow(paths, name, { from: name });
  if (teamFlow) setActiveFlow(paths, active, 'project');
  else if (getActiveFlowName(paths) !== active) setActiveFlow(paths, active, 'local');
  const model = loadFlow(paths, active);

  // Missing required vars are asked for before the spinner starts (an invalid flow asks nothing).
  assertFlowValid(paths, model.name);
  if (interactive) {
    for (const { name, def } of resolveVars(paths, model.def).missing) {
      const value = await promptVarInteractive(name, def);
      if (value !== undefined && value !== '') setVar(paths, name, value, varScope(model.def, name));
    }
  }

  // Saved before the sync: the install fingerprint covers the MCP preference.
  setMcpEnabled(paths, mcp);
  const spin = interactive ? spinner() : undefined;
  spin?.start(`Installing the "${model.name}" flow for ${agentNames(agents)}`);
  let run: SyncRun;
  try {
    run = await locked(paths, () => syncWithDiff(paths, { agents, mcp }));
  } catch (error) {
    spin?.error('Install failed');
    throw error;
  }
  const skillCount = new Set(run.report.skills.map((skill) => skill.name)).size;
  spin?.stop(`Installed ${plural(skillCount, 'skill')}`);

  if (saveTeam) setSelectedAgents(paths, agents, 'project');

  const manifest = readManifest(paths);
  // Agents whose skills dir is a symbolic link got no skills (sync warns; `dfl status` keeps reporting it).
  const skippedDirs = new Set(manifest.skippedDirs ?? []);
  const lines = installSummary(model, run, {
    created: toCreate,
    saveTeam,
    teamFlow,
    mcp,
    mcpKept: mcp ? [] : manifest.mcp.map((entry) => entry.file),
    skippedDirs,
  });
  const ready = agents.filter((id) => !skippedDirs.has(getAgent(id).skillsDir));
  const next =
    agents.length > 0 && ready.length === 0
      ? c.yellow(`${sym.warn} No skills were installed for ${agentNames(agents)}: see the warning about the symbolic link.`)
      : nextLine(paths, model, ready.length > 0 ? ready : agents);
  const repaired = loadRuntimeState(paths, model).repaired;
  const warnings = [...run.report.warnings, ...(repaired ? [repaired] : [])];
  const updates = templateUpdateLines(paths);
  if (updates.length > 0) lines.push('', ...updates);
  if (interactive) {
    logMessage(lines);
    for (const message of warnings) logWarning(message);
    outro(next);
  } else {
    printLines(lines);
    for (const message of warnings) warning(message);
    print(next);
  }
}

/** `--flow <name>` that is not a flow of the project: it must name a template (created under its own name). */
function templateOrThrow(paths: ProjectPaths, name: string): string {
  const templates = listFlowTemplates();
  if (templates.some((template) => template.name === name)) return name;
  const flows = listFlows(paths);
  throw new DflError(`Unknown flow or template "${name}".`, {
    hint: [
      `Templates: ${templates.map((t) => t.name).join(', ') || '(none)'}`,
      flows.length > 0 ? `flows in this project: ${flows.join(', ')}` : undefined,
    ]
      .filter(Boolean)
      .join('; '),
    code: 'FLOW_NOT_FOUND',
  });
}

async function chooseTemplates(interactive: boolean): Promise<string[]> {
  const templates = listFlowTemplates();
  if (templates.length === 0) {
    throw new DflError('No flow templates found in the dfl package.', {
      hint: 'Create a flow with `dfl flow create <name>` and run `dfl install` again.',
      code: 'TEMPLATE_NOT_FOUND',
    });
  }
  const defaults = [templates.some((t) => t.name === DEFAULT_TEMPLATE) ? DEFAULT_TEMPLATE : templates[0]!.name];
  if (!interactive) return defaults;
  return multiselect({
    message: 'Which flows do you want to start with?',
    options: templates.map((t) => ({ value: t.name, label: `${t.title} ${c.dim(`(${t.name})`)}`, hint: plural(t.steps, 'step') })),
    initialValues: defaults,
    required: true,
  });
}

/**
 * Active flow when none is set: among the flows about to be created (else the existing ones). Without
 * a terminal, several candidates are an error (nothing is written): the choice would be arbitrary and
 * would become the committed team default.
 */
async function chooseActiveFlow(paths: ProjectPaths, toCreate: string[], interactive: boolean): Promise<string> {
  const candidates = toCreate.length > 0 ? toCreate : listFlows(paths);
  if (candidates.length === 0) {
    throw new DflError('This project has no flows.', { hint: 'Run `dfl flow create <name>` first.', code: 'NO_ACTIVE_FLOW' });
  }
  if (candidates.length === 1) return candidates[0]!;
  if (!interactive) {
    throw new DflError('Several flows and no active flow is selected.', {
      hint: `Pass --flow <name> (flows: ${candidates.join(', ')}), or set the team default with \`dfl flow use <name> --project\`.`,
      code: 'NO_ACTIVE_FLOW',
    });
  }
  const templates = new Map(listFlowTemplates().map((t) => [t.name, t.title]));
  return select({
    message: `Which flow should be active? ${c.dim('(saved as the team default in .df/config.json)')}`,
    options: candidates.map((name) => {
      const title = toCreate.includes(name) ? (templates.get(name) ?? name) : safeTitle(paths, name);
      return { value: name, label: title === name ? name : `${title} ${c.dim(`(${name})`)}` };
    }),
    initialValue: candidates[0],
  });
}

function installSummary(
  model: FlowModel,
  run: SyncRun,
  info: { created: string[]; saveTeam: boolean; teamFlow: boolean; mcp: boolean; mcpKept: string[]; skippedDirs: ReadonlySet<string> },
): string[] {
  const { report } = run;
  const width = terminalWidth() - 6;
  const lines: string[] = [];
  const stepCount = model.steps.filter((step) => !step.final).length;
  for (const name of info.created.filter((n) => n !== model.name)) lines.push(`${c.green(sym.ok)} Created flow "${name}"`);
  lines.push(
    `${c.green(sym.ok)} Active flow ${c.bold(model.title)} ${c.dim(`(${model.name}, ${plural(stepCount, 'step')})`)}` +
      (info.created.includes(model.name) ? c.dim(' – created from template') : ''),
  );
  if (info.teamFlow) lines.push(`${c.green(sym.ok)} Saved "${model.name}" as the team default flow in .df/config.json`);

  const order = new Map(model.steps.map((step) => [step.skillName, step.index]));
  for (const id of report.agents) {
    const adapter = getAgent(id);
    const skills = report.skills.filter((skill) => skill.agents.includes(id));
    const steps = skills
      .filter((skill) => skill.kind === 'step')
      .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
      .map((skill) => c.cyan(adapter.invocation(skill.name)));
    const builtins = skills.filter((skill) => skill.kind === 'builtin').map((skill) => adapter.invocation(skill.name));
    lines.push('', `${c.bold(adapter.name)}  ${c.dim(`${adapter.skillsDir}/`)}`);
    if (info.skippedDirs.has(adapter.skillsDir)) {
      lines.push(`  ${c.yellow(sym.warn)} ${c.yellow(`Not installed: ${adapter.skillsDir} is a symbolic link (replace it with a real directory).`)}`);
      continue;
    }
    lines.push(...wrapItems(steps, '  ', width, '  '));
    if (builtins.length > 0) lines.push(...wrapItems([c.dim('built-in:'), ...builtins.map((b) => c.dim(b))], ' ', width, '  '));
  }
  if (report.agents.length === 0) lines.push('', c.dim('No agents selected: skills were only rendered into .df/.'));

  if (report.mcp.length > 0 || report.mcpManual.length > 0) {
    lines.push('', c.bold('MCP server "dfl"'));
    for (const entry of report.mcp) {
      const status = entry.status ?? (entry.changed ? 'added' : 'unchanged');
      lines.push(`  ${c.green(sym.ok)} ${entry.file} ${c.dim(`(${agentNames(entry.agents)}${status === 'added' ? '' : `, ${status}`})`)}`);
    }
    const notes = [
      ...report.mcpManual.map((m) => ({ agent: m.agent, text: m.instructions })),
      ...report.agents
        .map((id) => getAgent(id))
        .filter((adapter) => adapter.mcp && adapter.mcpNote && report.mcp.some((entry) => entry.agents.includes(adapter.id)))
        .map((adapter) => ({ agent: adapter.id, text: adapter.mcpNote! })),
    ];
    for (const note of notes) {
      const name = getAgent(note.agent).name;
      lines.push(`  ${c.yellow(sym.warn)} ${c.dim(note.text.startsWith(name) ? note.text : `${name}: ${note.text}`)}`);
    }
  } else if (!info.mcp && info.mcpKept.length > 0) {
    lines.push(
      '',
      c.dim(
        `MCP server "dfl" left unchanged in ${[...new Set(info.mcpKept)].join(', ')}: registration is off for you ` +
          '(`dfl install --mcp` turns it on; `dfl uninstall` removes the entry).',
      ),
    );
  } else if (!info.mcp && report.agents.length > 0) {
    lines.push('', c.dim('MCP server not registered (run `dfl install --mcp` to add it).'));
  }
  if (run.report.removed.length > 0) {
    lines.push('', c.bold('Removed'));
    for (const dir of run.report.removed) lines.push(`  ${c.red(sym.removed)} ${dir}/`);
  }
  if (info.saveTeam) lines.push('', `${c.green(sym.ok)} Saved ${agentNames(report.agents)} as the team default agents in .df/config.json`);
  return lines;
}

function nextLine(paths: ProjectPaths, model: FlowModel, agents: readonly AgentId[]): string {
  const state = loadRuntimeState(paths, model);
  const step = model.byId.get(state.done ? model.initial : state.current);
  if (!step || step.final) return `Next: run ${c.cyan('dfl status')}`;
  return `Next: run ${c.cyan(skillCommand(step.skillName, agents))} in your agent`;
}

/** `flow-update`: one summary line plus the added/removed skill dirs and changed MCP files. */
function compactSyncLines(run: SyncRun, dryRun: boolean): string[] {
  const lines = [syncSummaryLine(run.report, run.added, dryRun)];
  for (const dir of run.added) lines.push(`  ${c.green(sym.added)} ${dir}/`);
  for (const dir of run.report.removed) lines.push(`  ${c.red(sym.removed)} ${dir}/`);
  for (const entry of run.report.mcp) if (entry.changed) lines.push(mcpChangeLine(entry));
  return lines;
}

function nonEmpty<T>(list: T[] | undefined): T[] | undefined {
  return list && list.length > 0 ? list : undefined;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function safeTitle(paths: ProjectPaths, name: string): string {
  try {
    return loadFlow(paths, name).title;
  } catch {
    return name;
  }
}
