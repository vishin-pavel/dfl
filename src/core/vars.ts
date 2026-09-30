/**
 * Template variables (OWNER: render agent).
 * Precedence (low → high): def.default < config.json vars < local.json vars < env `DFL_VAR_<UPPER_SNAKE_NAME>`.
 */
import type { FlowDefinition, FlowVarDef, ProjectPaths, VarScope } from './types.js';

export interface ResolvedVars {
  values: Record<string, unknown>;
  /** Declared `required` vars that have no value from any source. */
  missing: Array<{ name: string; def: FlowVarDef }>;
}

export function resolveVars(paths: ProjectPaths, def: FlowDefinition | undefined, env?: NodeJS.ProcessEnv): ResolvedVars {
  throw new Error('not implemented');
}

/** Scope of a declared var (`project` when undeclared or unspecified). */
export function varScope(def: FlowDefinition | undefined, name: string): VarScope {
  throw new Error('not implemented');
}

/** Stores a value in config.json (`project`) or local.json (`personal`). */
export function setVar(paths: ProjectPaths, name: string, value: unknown, scope: VarScope): void {
  throw new Error('not implemented');
}

/** Removes a value from both config files. Returns true if something was removed. */
export function unsetVar(paths: ProjectPaths, name: string): boolean {
  throw new Error('not implemented');
}

/** `reviewer-name` / `reviewerName` → `DFL_VAR_REVIEWER_NAME` */
export function envVarName(name: string): string {
  throw new Error('not implemented');
}
