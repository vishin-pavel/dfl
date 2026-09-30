/**
 * `dfl vars list | set | unset`: template variables of the active flow.
 * Values: defaults < .df/config.json (project) < .df/local.json (personal) < DFL_VAR_<NAME> env.
 */
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import { getActiveFlowName, loadLocalConfig, loadProjectConfig } from '../core/config.js';
import { DflError } from '../core/errors.js';
import { loadFlow } from '../core/flow.js';
import type { FlowDefinition, FlowVarDef, ProjectPaths, VarScope } from '../core/types.js';
import { envVarName, resolveVars, setVar, unsetVar, varScope } from '../core/vars.js';
import { c } from '../ui/colors.js';
import { print, printJson, printLines, success, sym, terminalWidth, truncate } from '../ui/output.js';
import { isInteractive } from '../ui/prompts.js';
import { table } from '../ui/table.js';
import { locked, projectFor, syncAfterChange, type CliContext } from './shared.js';

type VarSource = 'env' | 'local' | 'project' | 'default' | 'none';

interface VarRow {
  name: string;
  value: unknown;
  source: VarSource;
  scope: VarScope;
  declared: boolean;
  required: boolean;
  missing: boolean;
  description?: string | undefined;
  default?: string | number | boolean | undefined;
}

export function registerVarsCommands(program: CommandUnknownOpts, ctx: CliContext): void {
  const vars = program.command('vars').description('Template variables of the active flow');

  vars
    .command('list', { isDefault: true })
    .alias('ls')
    .description('List variables: declared ones, effective values and where they come from')
    .option('--json', 'print JSON')
    .action((opts) => {
      const paths = projectFor(ctx);
      const def = activeDefinition(paths);
      const rows = varRows(paths, def);
      if (opts.json) {
        printJson({ flow: def?.name, vars: rows });
        return;
      }
      if (def) print(`${c.bold('Variables')} ${c.dim(`of flow "${def.name}"`)}`);
      if (rows.length === 0) {
        print(c.dim(def ? 'This flow declares no variables.' : 'No variables set.'));
        return;
      }
      printLines(
        table(
          rows.map((row) => [
            row.missing ? c.red(`${sym.fail} ${row.name}`) : row.declared ? row.name : c.dim(row.name),
            row.missing ? c.red('(missing)') : row.source === 'none' ? c.dim('–') : truncate(formatValue(row.value), 40),
            c.dim(sourceLabel(row)),
            row.scope,
            { text: row.description ?? (row.declared ? '' : 'not declared by the flow'), style: c.dim },
          ]),
          { head: ['NAME', 'VALUE', 'SOURCE', 'SCOPE', 'DESCRIPTION'], maxWidth: terminalWidth() },
        ),
      );
      if (rows.some((row) => row.missing)) {
        print();
        print(c.dim('Set missing values with `dfl vars set <name> <value>`.'));
      }
    });

  vars
    .command('set')
    .description('Set a variable (stored in its declared scope unless --personal/--project)')
    .argument('<name>', 'variable name')
    .argument('<value>', 'value')
    .option('--personal', 'store in .df/local.json (only for you)')
    .option('--project', 'store in .df/config.json (committed, whole team)')
    .option('--no-sync', 'do not re-install skills')
    .action(async (name, value, opts) => {
      if (opts.personal && opts.project) {
        throw new DflError('Use either --personal or --project, not both.', { code: 'INVALID_OPTIONS' });
      }
      const paths = projectFor(ctx);
      await locked(paths, async () => {
        const def = activeDefinition(paths);
        const scope: VarScope = opts.personal ? 'personal' : opts.project ? 'project' : varScope(def, name);
        const declared = def?.vars?.[name];
        setVar(paths, name, coerce(value, declared), scope);
        success(`Set ${c.bold(name)} = ${formatValue(coerce(value, declared))} ${c.dim(`(${scopeFile(scope)})`)}`);
        if (def && !declared) print(c.dim(`  Note: flow "${def.name}" does not declare "${name}"; templates can still use {{vars.${name}}}.`));
        const env = process.env[envVarName(name)];
        if (env) print(c.dim(`  Note: ${envVarName(name)} is set in the environment and overrides this value.`));
        await syncAfterChange(paths, { sync: opts.sync, interactive: isInteractive() });
      });
    });

  vars
    .command('unset')
    .description('Remove a variable value from .df/config.json and .df/local.json')
    .argument('<name>', 'variable name')
    .option('--no-sync', 'do not re-install skills')
    .action(async (name, opts) => {
      const paths = projectFor(ctx);
      await locked(paths, async () => {
        if (!unsetVar(paths, name)) {
          print(c.dim(`"${name}" has no stored value; nothing changed.`));
          return;
        }
        const def = activeDefinition(paths);
        const fallback = def?.vars?.[name]?.default;
        success(`Unset ${c.bold(name)}${fallback !== undefined ? c.dim(` (default: ${formatValue(fallback)})`) : ''}`);
        await syncAfterChange(paths, { sync: opts.sync, interactive: isInteractive() });
      });
    });
}

function activeDefinition(paths: ProjectPaths): FlowDefinition | undefined {
  const name = getActiveFlowName(paths);
  return name ? loadFlow(paths, name).def : undefined;
}

function varRows(paths: ProjectPaths, def: FlowDefinition | undefined): VarRow[] {
  const declared = def?.vars ?? {};
  const projectVars = loadProjectConfig(paths).vars;
  const localVars = loadLocalConfig(paths).vars;
  const resolved = resolveVars(paths, def);
  const missing = new Set(resolved.missing.map((m) => m.name));
  const undeclared = [...new Set([...Object.keys(projectVars), ...Object.keys(localVars)])]
    .filter((name) => !Object.hasOwn(declared, name))
    .sort();

  const row = (name: string, varDef: FlowVarDef | undefined): VarRow => {
    const env = process.env[envVarName(name)];
    const source: VarSource =
      env !== undefined && env !== ''
        ? 'env'
        : Object.hasOwn(localVars, name)
          ? 'local'
          : Object.hasOwn(projectVars, name)
            ? 'project'
            : varDef?.default !== undefined
              ? 'default'
              : 'none';
    const scope: VarScope = varDef ? varScope(def, name) : Object.hasOwn(localVars, name) ? 'personal' : 'project';
    return {
      name,
      value: resolved.values[name],
      source,
      scope,
      declared: varDef !== undefined,
      required: varDef?.required === true,
      missing: missing.has(name),
      description: varDef?.description,
      default: varDef?.default,
    };
  };
  return [...Object.entries(declared).map(([name, varDef]) => row(name, varDef)), ...undeclared.map((name) => row(name, undefined))];
}

/** Keeps the declared default's type for booleans and numbers (`true`, `3`); strings otherwise. */
function coerce(value: string, def: FlowVarDef | undefined): unknown {
  if (typeof def?.default === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  if (typeof def?.default === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
}

function sourceLabel(row: VarRow): string {
  switch (row.source) {
    case 'env':
      return envVarName(row.name);
    case 'local':
      return 'local.json';
    case 'project':
      return 'config.json';
    case 'default':
      return 'default';
    default:
      return '–';
  }
}

function scopeFile(scope: VarScope): string {
  return scope === 'personal' ? '.df/local.json' : '.df/config.json';
}
