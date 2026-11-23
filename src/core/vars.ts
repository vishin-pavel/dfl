/**
 * Template variables.
 * Precedence (low → high): def.default < config.json vars < local.json vars < env `DFL_VAR_<UPPER_SNAKE_NAME>`.
 * Templates see only allow-listed environment variables: `DFL_ENV_<NAME>` as `env.<NAME>`.
 */
import { loadLocalConfig, loadProjectConfig, saveLocalConfig, saveProjectConfig } from './config.js';
import { DflError } from './errors.js';
import { exists } from './fsx.js';
import type { FlowDefinition, FlowVarDef, ProjectPaths, VarScope } from './types.js';

export interface ResolvedVars {
  values: Record<string, unknown>;
  /** Declared `required` vars that have no value from any source. */
  missing: Array<{ name: string; def: FlowVarDef }>;
}

/** Prefix of environment variables that override template variables. */
export const ENV_VAR_PREFIX = 'DFL_VAR_';

/** Prefix of environment variables exposed to templates as `env.<NAME>` (the rest of the environment is not). */
export const TEMPLATE_ENV_PREFIX = 'DFL_ENV_';

/** Variable names usable as `{{vars.<name>}}` in templates. */
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Resolves variable values for a flow. Undeclared keys found in config.json / local.json are
 * included too; env overrides apply to every known name (declared or stored). Empty env values
 * are ignored (treated as unset).
 */
export function resolveVars(paths: ProjectPaths, def: FlowDefinition | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedVars {
  const declared = def?.vars ?? {};
  const values: Record<string, unknown> = {};
  for (const [name, varDef] of Object.entries(declared)) {
    if (varDef.default !== undefined) values[name] = varDef.default;
  }
  Object.assign(values, loadProjectConfig(paths).vars, loadLocalConfig(paths).vars);

  for (const name of new Set([...Object.keys(declared), ...Object.keys(values)])) {
    const fromEnv = env[envVarName(name)];
    if (fromEnv !== undefined && fromEnv !== '') values[name] = fromEnv;
  }

  const missing = Object.entries(declared)
    .filter(([name, varDef]) => varDef.required === true && isEmptyValue(values[name]))
    .map(([name, varDef]) => ({ name, def: varDef }));
  return { values, missing };
}

/**
 * The `env` object templates see: every `DFL_ENV_<NAME>` variable as `<NAME>` (non-empty values only).
 * The rest of the process environment (tokens, API keys, …) is never exposed, so a template cannot
 * copy it into a rendered skill or an MCP tool result.
 */
export function templateEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith(TEMPLATE_ENV_PREFIX) || key.length === TEMPLATE_ENV_PREFIX.length) continue;
    const value = env[key];
    if (value !== undefined && value !== '') out[key.slice(TEMPLATE_ENV_PREFIX.length)] = value;
  }
  return out;
}

/** Scope of a declared var (`project` when undeclared or unspecified). */
export function varScope(def: FlowDefinition | undefined, name: string): VarScope {
  return def?.vars?.[name]?.scope ?? 'project';
}

/** Stores a value in config.json (`project`) or local.json (`personal`). */
export function setVar(paths: ProjectPaths, name: string, value: unknown, scope: VarScope): void {
  assertValidVarName(name);
  if (scope === 'personal') {
    const local = loadLocalConfig(paths);
    saveLocalConfig(paths, { ...local, vars: { ...local.vars, [name]: value } });
  } else {
    const config = loadProjectConfig(paths);
    saveProjectConfig(paths, { ...config, vars: { ...config.vars, [name]: value } });
  }
}

/** Removes a value from both config files. Returns true if something was removed. */
export function unsetVar(paths: ProjectPaths, name: string): boolean {
  let removed = false;
  const config = loadProjectConfig(paths);
  if (Object.hasOwn(config.vars, name)) {
    const { [name]: _, ...rest } = config.vars;
    saveProjectConfig(paths, { ...config, vars: rest });
    removed = true;
  }
  if (exists(paths.localFile)) {
    const local = loadLocalConfig(paths);
    if (Object.hasOwn(local.vars, name)) {
      const { [name]: _, ...rest } = local.vars;
      saveLocalConfig(paths, { ...local, vars: rest });
      removed = true;
    }
  }
  return removed;
}

/** `reviewer-name` / `reviewerName` → `DFL_VAR_REVIEWER_NAME` */
export function envVarName(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return `${ENV_VAR_PREFIX}${snake}`;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function assertValidVarName(name: string): void {
  if (!VAR_NAME_RE.test(name)) {
    throw new DflError(`Invalid variable name "${name}".`, {
      hint: 'Use letters, digits, "_" and "-", starting with a letter or "_" (e.g. "mainBranch").',
      code: 'INVALID_NAME',
    });
  }
}
