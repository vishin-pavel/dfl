import { z } from 'zod';
import { DflError } from './errors.js';
import { exists, ensureDir, listDirs, readJsonIfExists, writeJson } from './fsx.js';
import { writeDfGitignore } from './gitignore.js';
import { AGENT_IDS, type AgentId, type LocalConfig, type ProjectConfig, type ProjectPaths } from './types.js';

const agentIdSchema = z.enum(AGENT_IDS);

export const projectConfigSchema = z.object({
  version: z.literal(1).default(1),
  activeFlow: z.string().optional(),
  agents: z.array(agentIdSchema).optional(),
  vars: z.record(z.string(), z.unknown()).default({}),
  mcp: z.object({ command: z.string().min(1), args: z.array(z.string()).default([]) }).optional(),
});

export const localConfigSchema = z.object({
  version: z.literal(1).default(1),
  activeFlow: z.string().optional(),
  agents: z.array(agentIdSchema).optional(),
  vars: z.record(z.string(), z.unknown()).default({}),
});

function parseWith<T>(schema: z.ZodType<T>, data: unknown, file: string): T {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new DflError(`Invalid config in ${file}: ${details}`, { code: 'INVALID_CONFIG' });
  }
  return result.data;
}

export function loadProjectConfig(paths: ProjectPaths): ProjectConfig {
  return parseWith(projectConfigSchema, readJsonIfExists(paths.configFile), paths.configFile) as ProjectConfig;
}

export function saveProjectConfig(paths: ProjectPaths, config: ProjectConfig): void {
  writeJson(paths.configFile, stripUndefined(config));
}

export function loadLocalConfig(paths: ProjectPaths): LocalConfig {
  return parseWith(localConfigSchema, readJsonIfExists(paths.localFile), paths.localFile) as LocalConfig;
}

export function saveLocalConfig(paths: ProjectPaths, config: LocalConfig): void {
  writeJson(paths.localFile, stripUndefined(config));
}

/** True when `.df/config.json` exists. */
export function isInitialized(paths: ProjectPaths): boolean {
  return exists(paths.configFile);
}

/** Creates `.df/`, a default `config.json` (if missing) and `.df/.gitignore`. Idempotent. */
export function initProject(paths: ProjectPaths): void {
  ensureDir(paths.dfDir);
  if (!exists(paths.configFile)) saveProjectConfig(paths, { version: 1, vars: {} });
  writeDfGitignore(paths);
}

/** Flow directories under `.df/` that contain a flow.json (sorted). */
function flowDirNames(paths: ProjectPaths): string[] {
  return listDirs(paths.dfDir).filter((name) => exists(paths.flowFile(name)));
}

/**
 * Effective active flow: `local.activeFlow` → `config.activeFlow` → the only flow
 * when exactly one exists. Names that no longer exist on disk are skipped.
 */
export function getActiveFlowName(paths: ProjectPaths): string | undefined {
  const flows = new Set(flowDirNames(paths));
  const local = loadLocalConfig(paths).activeFlow;
  if (local && flows.has(local)) return local;
  const project = loadProjectConfig(paths).activeFlow;
  if (project && flows.has(project)) return project;
  if (flows.size === 1) return [...flows][0];
  return undefined;
}

export function setActiveFlow(paths: ProjectPaths, name: string, scope: 'local' | 'project' = 'local'): void {
  if (scope === 'project') {
    const config = loadProjectConfig(paths);
    saveProjectConfig(paths, { ...config, activeFlow: name });
    const local = loadLocalConfig(paths);
    if (local.activeFlow && local.activeFlow !== name && exists(paths.localFile)) {
      saveLocalConfig(paths, { ...local, activeFlow: undefined });
    }
    return;
  }
  const local = loadLocalConfig(paths);
  saveLocalConfig(paths, { ...local, activeFlow: name });
}

/** `local.agents` → `config.agents` → `[]`. */
export function getSelectedAgents(paths: ProjectPaths): AgentId[] {
  return loadLocalConfig(paths).agents ?? loadProjectConfig(paths).agents ?? [];
}

export function setSelectedAgents(paths: ProjectPaths, agents: AgentId[], scope: 'local' | 'project' = 'local'): void {
  const unique = [...new Set(agents)];
  if (scope === 'project') {
    saveProjectConfig(paths, { ...loadProjectConfig(paths), agents: unique });
  } else {
    saveLocalConfig(paths, { ...loadLocalConfig(paths), agents: unique });
  }
}

function stripUndefined<T extends object>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
