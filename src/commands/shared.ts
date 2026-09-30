/**
 * Shared plumbing for command modules: project resolution from the global `--root` option,
 * sync with added/removed reporting, active-flow switches that roll back on failure,
 * confirmations for destructive commands.
 */
import path from 'node:path';
import { InvalidArgumentError } from '@commander-js/extra-typings';
import type { z } from 'zod';
import { dflLauncher } from '../agents/mcp-config.js';
import {
  getActiveFlowName,
  loadLocalConfig,
  loadProjectConfig,
  localConfigSchema,
  projectConfigSchema,
  saveLocalConfig,
  saveProjectConfig,
  setActiveFlow,
} from '../core/config.js';
import { DflError, errorMessage } from '../core/errors.js';
import { loadFlow } from '../core/flow.js';
import { exists, isFile, readText, readTextIfExists, removePath, writeText } from '../core/fsx.js';
import { withProjectLock } from '../core/lock.js';
import { loadRuntimeState } from '../core/machine.js';
import { findProjectRoot, projectPaths, resolveProjectRoot } from '../core/paths.js';
import { isInstalledForUser, readManifest, syncProject, type SyncOptions } from '../core/sync.js';
import type { FlowDefinition, FlowVarDef, ProjectPaths, SyncReport, VarScope } from '../core/types.js';
import { assertFlowValid, validateFlow } from '../core/validate.js';
import { resolveVars, setVar, varScope } from '../core/vars.js';
import { c } from '../ui/colors.js';
import { syncSummaryLine } from '../ui/format.js';
import { print, sym, warning } from '../ui/output.js';
import { confirm, isInteractive, text } from '../ui/prompts.js';

/** What command modules need from the program. */
export interface CliContext {
  /** Value of the global `--root` option (undefined when not given). */
  rootOption(): string | undefined;
}

/**
 * Project paths for `--root` / `DFL_ROOT` / the nearest `.df/` (install: git root or cwd).
 *
 * The implicit `.df/` search never crosses into an enclosing git repository: when a separate
 * repository (a directory with `.git`, e.g. a nested clone or a submodule) lies between the cwd and
 * the nearest `.df/`, `install` (and `agents`) use that repository's root, and every other command
 * fails with NO_PROJECT naming the outer project (reachable with `--root`).
 */
export function projectFor(ctx: CliContext, options: { forInstall?: boolean } = {}): ProjectPaths {
  const root = ctx.rootOption();
  if (root === undefined && !process.env['DFL_ROOT']) {
    const cwd = process.cwd();
    const found = findProjectRoot(cwd);
    const repo = found === undefined ? undefined : nestedRepoRoot(cwd, found);
    if (found !== undefined && repo !== undefined) {
      if (options.forInstall) return projectPaths(repo);
      throw new DflError(`No dfl project in this git repository (${repo}).`, {
        hint:
          `The dfl project at ${found} belongs to an enclosing repository: pass \`--root ${found}\` to use it, ` +
          'or run `dfl install` to set up dfl in this repository.',
        code: 'NO_PROJECT',
      });
    }
  }
  return projectPaths(resolveProjectRoot({ root, forInstall: options.forInstall }));
}

/**
 * The nearest directory from `cwd` (inclusive) up to `projectRoot` (exclusive) that holds a `.git`
 * entry (a directory, or a file for submodules and worktrees): a separate repository nested in the project.
 */
function nestedRepoRoot(cwd: string, projectRoot: string): string | undefined {
  const stop = path.resolve(projectRoot);
  let current = path.resolve(cwd);
  while (current !== stop) {
    if (exists(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * Runs a read-modify-write of project files under the cross-process project lock (`.df/.lock`), so
 * a CLI command and an MCP server (or two CLI runs) never overwrite each other's changes. Keep
 * confirmations and variable prompts outside (askMissingVars): other dfl processes give up after
 * waiting 15 s for the lock. Never nest.
 */
export function locked<T>(paths: ProjectPaths, fn: () => T | Promise<T>): Promise<T> {
  return withProjectLock(paths, fn);
}

export interface SyncRun {
  report: SyncReport;
  /** Project-relative skill dirs that did not exist in the previous manifest. */
  added: string[];
}

/** `syncProject` plus the list of newly installed skill dirs (removed ones are in the report). */
export async function syncWithDiff(paths: ProjectPaths, options: SyncOptions = {}): Promise<SyncRun> {
  const before = new Set(readManifest(paths).skills.map((skill) => skill.dir));
  const report = await syncProject(paths, options);
  const added = [...new Set(report.skills.map((skill) => skill.dir))].filter((dir) => !before.has(dir));
  return { report, added };
}

/** `Skills not installed for you yet; run `dfl install`` (with the project's dfl launcher). */
export function notInstalledMessage(paths: ProjectPaths): string {
  return `Skills not installed for you yet; run \`${dflLauncher(paths)} install\`.`;
}

/** A value typed at a required-variable prompt (askMissingVars), stored with storeVarAnswers. */
export interface VarAnswer {
  name: string;
  value: unknown;
  scope: VarScope;
}

export interface AskVarsOptions {
  /** Prompts only in interactive runs. */
  interactive: boolean;
  /** False (`--no-sync`): no sync runs, so nothing is asked. */
  sync?: boolean | undefined;
  /** The flow the closing sync installs (default: the active flow). */
  flow?: string | undefined;
  /** `flow` is about to become the active flow (`flow use`, `--use`): ask even though it is not active yet. */
  activating?: boolean | undefined;
  /** Ask even when this developer has not installed dfl (`flow-update` always syncs). */
  always?: boolean | undefined;
  /** Variables not to ask for (e.g. the one `vars unset` just removed). */
  except?: readonly string[] | undefined;
}

/**
 * Asks for the required variables of `flow` that have no value, BEFORE the project lock is taken:
 * a prompt can stay open for minutes, and other dfl processes (CLI or MCP) must not wait for it.
 * Asks nothing when not interactive, when the closing sync would not run (`--no-sync`, not the
 * active flow, not installed for this developer) or when the flow has validation errors (the sync
 * refuses it before asking anything). Store the answers inside the lock with storeVarAnswers; the
 * sync itself then runs without prompting.
 */
export async function askMissingVars(paths: ProjectPaths, options: AskVarsOptions): Promise<VarAnswer[]> {
  if (!options.interactive || options.sync === false) return [];
  let def: FlowDefinition;
  try {
    const active = getActiveFlowName(paths);
    const name = options.flow ?? active;
    if (name === undefined || (name !== active && !options.activating)) return [];
    if (!options.always && !isInstalledForUser(paths)) return [];
    if (validateFlow(paths, name).some((issue) => issue.level === 'error')) return [];
    def = loadFlow(paths, name).def;
  } catch {
    return []; // the command reports the problem itself
  }
  const answers: VarAnswer[] = [];
  for (const { name, def: varDef } of resolveVars(paths, def).missing) {
    if (options.except?.includes(name)) continue;
    const value = await promptVarInteractive(name, varDef);
    if (value !== undefined && value !== null && value !== '') answers.push({ name, value, scope: varScope(def, name) });
  }
  return answers;
}

/** Stores the answers of askMissingVars (call it inside the project lock). */
export function storeVarAnswers(paths: ProjectPaths, answers: readonly VarAnswer[]): void {
  for (const answer of answers) setVar(paths, answer.name, answer.value, answer.scope);
}

/** Interactive prompt for a missing required variable (clack text). */
export function promptVarInteractive(name: string, def: FlowVarDef): Promise<unknown> {
  const fallback = def.default === undefined ? undefined : String(def.default);
  return text({
    message: def.description ? `${name} ${c.dim(`– ${def.description}`)}` : `Value for "${name}"`,
    placeholder: fallback,
    defaultValue: fallback,
  });
}

/** Warns (stderr) when the stored step of the active flow no longer exists and the state fell back. */
export function warnRepairedState(paths: ProjectPaths, flow: string): void {
  try {
    const repaired = loadRuntimeState(paths, loadFlow(paths, flow)).repaired;
    if (repaired) warning(repaired);
  } catch {
    // Reporting only: the command itself already succeeded.
  }
}

export interface AfterChangeOptions {
  /** `--no-sync` sets this to false. */
  sync: boolean;
  /** The flow that was changed; sync only runs when it is the active flow. */
  flow?: string | undefined;
}

/** What `syncIfInstalled` did. */
export type AfterChange =
  | { kind: 'skipped' }
  /** The change concerns the active flow, but this developer never ran `dfl install` (no manifest). */
  | { kind: 'not-installed' }
  | { kind: 'synced'; run: SyncRun };

/**
 * Re-syncs after a mutation when sync is wanted, the changed flow is the active one and this developer
 * installed the skills (`.df/installed.json` exists: `dfl uninstall` sticks until `dfl install`).
 * Never prompts (it runs inside the project lock): missing required vars become warnings, so ask
 * for them first with askMissingVars. Prints nothing; see printAfterChange.
 */
export async function syncIfInstalled(paths: ProjectPaths, options: AfterChangeOptions): Promise<AfterChange> {
  if (!options.sync) return { kind: 'skipped' };
  const active = getActiveFlowName(paths);
  if (!active || (options.flow !== undefined && options.flow !== active)) return { kind: 'skipped' };
  if (!isInstalledForUser(paths)) return { kind: 'not-installed' };
  const run = await syncWithDiff(paths);
  return { kind: 'synced', run };
}

/** One-line sync summary plus warnings, or the "not installed" note. */
export function printAfterChange(paths: ProjectPaths, result: AfterChange): void {
  if (result.kind === 'not-installed') {
    print(c.dim(notInstalledMessage(paths)));
    return;
  }
  if (result.kind !== 'synced') return;
  print(syncSummaryLine(result.run.report, result.run.added));
  // Committed MCP config files are never changed silently.
  for (const entry of result.run.report.mcp) if (entry.changed) print(mcpChangeLine(entry));
  for (const message of result.run.report.warnings) warning(message);
}

/** `  + dfl MCP server in .mcp.json` (added) or `  ~ dfl MCP server in .mcp.json (updated)`. */
export function mcpChangeLine(entry: SyncReport['mcp'][number]): string {
  return entry.status === 'updated'
    ? `  ${c.yellow('~')} dfl MCP server in ${entry.file} ${c.dim('(updated)')}`
    : `  ${c.green(sym.added)} dfl MCP server in ${entry.file}`;
}

/**
 * syncIfInstalled + printAfterChange (call it inside the project lock). Returns the run, or undefined
 * when no sync ran.
 */
export async function syncAfterChange(paths: ProjectPaths, options: AfterChangeOptions): Promise<SyncRun | undefined> {
  const result = await syncIfInstalled(paths, options);
  printAfterChange(paths, result);
  return result.kind === 'synced' ? result.run : undefined;
}

/**
 * The closing sync of a mutation that already ran (and released the lock): asks for missing required
 * variables of the changed flow first, outside the lock (askMissingVars), then stores the answers and
 * syncs under the lock (syncAfterChange).
 */
export async function lockedSyncAfterChange(
  paths: ProjectPaths,
  options: AfterChangeOptions & { interactive: boolean; except?: readonly string[] | undefined },
): Promise<SyncRun | undefined> {
  const answers = await askMissingVars(paths, { interactive: options.interactive, sync: options.sync, flow: options.flow, except: options.except });
  return locked(paths, () => {
    storeVarAnswers(paths, answers);
    return syncAfterChange(paths, { sync: options.sync, flow: options.flow });
  });
}

/**
 * `dfl flow use` and `--use`: asks for the missing required variables of `name` outside the lock
 * (askMissingVars), then, under the lock, stores the answers and runs switchActiveFlow.
 */
export async function lockedSwitchActiveFlow(
  paths: ProjectPaths,
  name: string,
  scope: 'local' | 'project',
  options: { sync: boolean; interactive: boolean },
): Promise<AfterChange> {
  const answers = await askMissingVars(paths, { interactive: options.interactive, sync: options.sync, flow: name, activating: true });
  return locked(paths, () => {
    storeVarAnswers(paths, answers);
    return switchActiveFlow(paths, name, scope, { sync: options.sync });
  });
}

/**
 * Makes `name` the active flow (`scope`) and re-syncs (see syncIfInstalled), all or nothing:
 * the flow is validated before anything is written (DflError INVALID_FLOW), and when the sync fails
 * (render or IO error) the previous active-flow settings of both config.json and local.json are
 * restored before the error propagates. Never prompts (run it inside the lock; see lockedSwitchActiveFlow).
 */
export async function switchActiveFlow(
  paths: ProjectPaths,
  name: string,
  scope: 'local' | 'project',
  options: { sync: boolean },
): Promise<AfterChange> {
  assertFlowValid(paths, name);
  const snapshot = [snapshotConfig(paths.configFile, projectConfigSchema), snapshotConfig(paths.localFile, localConfigSchema)];
  const previous = { project: loadProjectConfig(paths).activeFlow, local: loadLocalConfig(paths).activeFlow };
  setActiveFlow(paths, name, scope);
  try {
    return await syncIfInstalled(paths, { sync: options.sync });
  } catch (error) {
    try {
      for (const item of snapshot) item.restore();
      const project = loadProjectConfig(paths);
      if (project.activeFlow !== previous.project) saveProjectConfig(paths, { ...project, activeFlow: previous.project });
      const local = loadLocalConfig(paths);
      if (exists(paths.localFile) && local.activeFlow !== previous.local) saveLocalConfig(paths, { ...local, activeFlow: previous.local });
    } catch (restoreError) {
      warning(`Could not restore the previous active flow: ${errorMessage(restoreError)}`);
    }
    throw error;
  }
}

interface ConfigSnapshot {
  /** Puts the file back byte for byte when only `activeFlow` changed since the snapshot. */
  restore(): void;
}

/**
 * Raw content of a config file. `restore` rewrites it (or deletes a file that did not exist) only
 * when nothing but `activeFlow` changed in the meantime, so other settings saved meanwhile survive;
 * the caller then puts `activeFlow` back field by field.
 */
function snapshotConfig(file: string, schema: z.ZodType): ConfigSnapshot {
  const raw = readTextIfExists(file);
  const withoutActiveFlow = (text: string | undefined): string | undefined => {
    try {
      const parsed = schema.parse(text === undefined ? {} : JSON.parse(text)) as Record<string, unknown>;
      delete parsed['activeFlow'];
      return JSON.stringify(parsed);
    } catch {
      return undefined;
    }
  };
  return {
    restore(): void {
      const current = readTextIfExists(file);
      if (current === raw) return;
      const before = withoutActiveFlow(raw);
      if (before === undefined || before !== withoutActiveFlow(current)) return;
      if (raw === undefined) removePath(file);
      else writeText(file, raw);
    },
  };
}

/**
 * Confirmation for destructive commands: asks interactively (default no); without a terminal the
 * command requires `--yes` instead of blocking.
 */
export async function confirmDestructive(message: string, options: { yes?: boolean | undefined; flag?: string }): Promise<boolean> {
  if (options.yes) return true;
  if (!isInteractive(options)) {
    throw new DflError(`${message.replace(/\?$/, '')}: confirmation required.`, {
      hint: `Re-run with ${options.flag ?? '--yes'} to confirm (no terminal to ask).`,
      code: 'CONFIRMATION_REQUIRED',
    });
  }
  return confirm({ message, initialValue: false });
}

/** Reads a template file given on the command line (relative to cwd). */
export function readTemplateFile(file: string): string {
  const abs = path.resolve(file);
  if (!exists(abs)) {
    throw new DflError(`Template file ${file} not found.`, { code: 'FILE_NOT_FOUND' });
  }
  if (!isFile(abs)) {
    throw new DflError(`Template file ${file} is not a regular file.`, {
      hint: 'Pass the path to a SKILL.md.hbs template file, not a directory.',
      code: 'INVALID_OPTIONS',
    });
  }
  try {
    return readText(abs);
  } catch (error) {
    throw new DflError(`Cannot read template file ${file}: ${errorMessage(error)}`, { code: 'FILE_READ_ERROR', cause: error });
  }
}

/** Commander argument parser for integers. */
export function parseInteger(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isInteger(n)) throw new InvalidArgumentError('Not a whole number.');
  return n;
}
