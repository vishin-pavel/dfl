/**
 * Shared plumbing for command modules: project resolution from the global `--root` option,
 * sync with added/removed reporting, confirmations for destructive commands.
 */
import path from 'node:path';
import { InvalidArgumentError } from '@commander-js/extra-typings';
import { getActiveFlowName, getSelectedAgents } from '../core/config.js';
import { DflError } from '../core/errors.js';
import { exists, readText } from '../core/fsx.js';
import { projectPaths, resolveProjectRoot } from '../core/paths.js';
import { readManifest, syncProject, type SyncOptions } from '../core/sync.js';
import type { FlowVarDef, ProjectPaths, SyncReport } from '../core/types.js';
import { c } from '../ui/colors.js';
import { syncSummaryLine } from '../ui/format.js';
import { print, warning } from '../ui/output.js';
import { confirm, isInteractive, text } from '../ui/prompts.js';

/** What command modules need from the program. */
export interface CliContext {
  /** Value of the global `--root` option (undefined when not given). */
  rootOption(): string | undefined;
}

/** Project paths for `--root` / `DFL_ROOT` / the nearest `.df/` (install: git root or cwd). */
export function projectFor(ctx: CliContext, options: { forInstall?: boolean } = {}): ProjectPaths {
  return projectPaths(resolveProjectRoot({ root: ctx.rootOption(), forInstall: options.forInstall }));
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

/** True once `dfl install` ran (a manifest exists or agents are selected). */
export function isInstalled(paths: ProjectPaths): boolean {
  return exists(paths.manifestFile) || getSelectedAgents(paths).length > 0;
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

export interface AfterChangeOptions {
  /** `--no-sync` sets this to false. */
  sync: boolean;
  /** The flow that was changed; sync only runs when it is the active flow. */
  flow?: string | undefined;
  /** Prompt for missing required vars (interactive runs). */
  interactive?: boolean | undefined;
}

/**
 * Re-syncs after a mutation when the project is installed and the changed flow is active, then
 * prints a one-line summary (and warnings). Returns the run, or undefined when skipped.
 */
export async function syncAfterChange(paths: ProjectPaths, options: AfterChangeOptions): Promise<SyncRun | undefined> {
  if (!options.sync || !isInstalled(paths)) return undefined;
  const active = getActiveFlowName(paths);
  if (!active || (options.flow !== undefined && options.flow !== active)) return undefined;
  const run = await syncWithDiff(paths, options.interactive ? { promptVar: promptVarInteractive } : {});
  print(syncSummaryLine(run.report, run.added));
  for (const message of run.report.warnings) warning(message);
  return run;
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
  return readText(abs);
}

/** Commander argument parser for integers. */
export function parseInteger(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isInteger(n)) throw new InvalidArgumentError('Not a whole number.');
  return n;
}
