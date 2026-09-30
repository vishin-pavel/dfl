/**
 * Install/sync orchestrator – the only code path that writes outside `.df/` (OWNER: sync agent).
 * See docs/ARCHITECTURE.md §5.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveMcpServerSpec } from '../agents/mcp-config.js';
import { AGENTS, getAgent, mcpConfigFile } from '../agents/registry.js';
import type { AgentAdapter, McpTarget } from '../agents/types.js';
import { getSelectedAgents, setSelectedAgents } from './config.js';
import { DflError, errorMessage } from './errors.js';
import { buildFlowModel, listFlows, loadActiveFlow } from './flow.js';
import {
  copyDir,
  copyFile,
  exists,
  isDir,
  isFile,
  readJsonIfExists,
  readTextIfExists,
  removeEmptyDirsUpTo,
  removePath,
  walkFiles,
  writeJson,
  writeText,
} from './fsx.js';
import { upsertManagedBlock, writeDfGitignore } from './gitignore.js';
import { renderBuiltinSkills, renderFlowSkills } from './render.js';
import { AGENT_IDS } from './types.js';
import type {
  AgentId,
  FlowModel,
  FlowVarDef,
  Manifest,
  ProjectPaths,
  RenderedSkill,
  SyncReport,
} from './types.js';
import { assertFlowValid } from './validate.js';
import { resolveVars, setVar, varScope } from './vars.js';

export interface SyncOptions {
  /** Agents to install for; default: getSelectedAgents(). Persisted to local.json when given. */
  agents?: AgentId[] | undefined;
  /** Write MCP config entries (default true). */
  mcp?: boolean | undefined;
  /** Called for each missing required var; the value is stored in its scope. Without it missing vars become warnings. */
  promptVar?: ((name: string, def: FlowVarDef) => Promise<unknown>) | undefined;
  /** Compute the report without writing anything. */
  dryRun?: boolean | undefined;
}

const SKILL_FILE = 'SKILL.md';
/** Skill metadata keys dfl writes start with this prefix (`dfl-flow`, `dfl-step`, `dfl-builtin`). */
const DFL_METADATA_PREFIX = 'dfl-';

type SkillManifestEntry = Manifest['skills'][number];
type McpManifestEntry = Manifest['mcp'][number];

/** Agents that share one skills directory. */
interface SkillsDirGroup {
  dir: string;
  agents: AgentId[];
}

/** Agents that share one MCP config file. */
interface McpFileGroup {
  file: string;
  target: McpTarget;
  agents: AgentId[];
}

/**
 * 1. Resolves active flow (DflError when none) and agents. 2. Resolves vars (prompting via promptVar).
 * 3. Validates the flow (errors abort). 4. Renders flow skills (into .df) and built-in skills.
 * 5. Writes each skill into every distinct agent skills dir. 6. Removes dirs from the previous
 * manifest that are no longer produced. 7. Upserts MCP entries. 8. Writes .df/.gitignore, the managed
 * block in <root>/.gitignore (installed skill dirs) and the new manifest.
 *
 * The flow is validated before vars are prompted for, so an invalid flow never asks questions.
 * `dryRun` renders into a temporary copy of the flow and never prompts.
 */
export async function syncProject(paths: ProjectPaths, options: SyncOptions = {}): Promise<SyncReport> {
  const dryRun = options.dryRun === true;
  const root = paths.root;
  const warnings: string[] = [];

  // 1. Flow and agents.
  const model = loadActiveFlow(paths);
  const agents = sortAgents(options.agents ?? getSelectedAgents(paths));
  const adapters = agents.map((id) => getAgent(id));

  // 3. Validation – before 2. so an invalid flow never prompts.
  for (const issue of assertFlowValid(paths, model.name)) warnings.push(issue.message);

  // 2. Vars.
  let resolved = resolveVars(paths, model.def);
  if (resolved.missing.length > 0 && options.promptVar && !dryRun) {
    for (const { name, def } of resolved.missing) {
      const value = await options.promptVar(name, def);
      if (value !== undefined && value !== null && value !== '') setVar(paths, name, value, varScope(model.def, name));
    }
    resolved = resolveVars(paths, model.def);
  }
  for (const { name } of resolved.missing) {
    const personal = varScope(model.def, name) === 'personal';
    warnings.push(
      `Required variable "${name}" has no value; templates render it empty. ` +
        `Set it with \`dfl vars set ${name} <value>${personal ? ' --personal' : ''}\`.`,
    );
  }

  // 4. Render.
  const stepSkills = dryRun ? renderFlowSkillsDry(paths, model, resolved.values) : renderFlowSkills(paths, model, resolved.values);
  const taken = new Set(stepSkills.map((skill) => skill.name));
  // A step skill wins over a built-in skill with the same name (validateFlow warns about it).
  const builtinSkills = renderBuiltinSkills(paths, model, resolved.values).filter((skill) => !taken.has(skill.name));
  const skills = [...stepSkills, ...builtinSkills];

  if (agents.length === 0) {
    warnings.push(
      'No agents selected: skills were only rendered into .df/. Select agents with `dfl install --agents <list>`.',
    );
  }
  if (options.agents && !dryRun) setSelectedAgents(paths, agents);

  const previous = readManifest(paths);
  const previousSkills = new Map(previous.skills.map((entry) => [entry.dir, entry]));

  // 5. Skills into every distinct skills dir.
  const installed: SkillManifestEntry[] = [];
  const reportSkills: SyncReport['skills'] = [];
  for (const group of groupBySkillsDir(adapters)) {
    for (const skill of skills) {
      const dir = `${group.dir}/${skill.name}`;
      const absDir = absPath(root, dir);
      const before = previousSkills.get(dir);
      if (skillDirOwner(absDir, before !== undefined) === 'user') {
        warnings.push(
          `Skipped ${dir}/: it holds a skill dfl did not install. Rename or remove it to install the "${skill.name}" skill there.`,
        );
        continue;
      }
      if (!dryRun) writeSkill(absDir, skill, before?.files ?? []);
      installed.push({ agents: [...group.agents], name: skill.name, dir, files: skill.files.map((file) => file.path) });
      reportSkills.push({ name: skill.name, dir, agents: [...group.agents], kind: skill.kind });
    }
  }

  // 6. Stale skill dirs.
  const produced = new Set(installed.map((entry) => entry.dir));
  const removed: string[] = [];
  for (const entry of previous.skills) {
    if (produced.has(entry.dir)) continue;
    const result = removeSkillDir(root, entry.dir, dryRun);
    if (result.removed) removed.push(entry.dir);
    if (result.warning) warnings.push(result.warning);
  }
  removed.sort(compare);

  // 7. MCP entries.
  const mcpReport: SyncReport['mcp'] = [];
  const mcpManual: SyncReport['mcpManual'] = [];
  const mcpEntries: McpManifestEntry[] = [];
  const mcpGroups = groupByMcpFile(adapters, root);
  const neededFiles = new Set(mcpGroups.map((group) => group.file));
  for (const entry of previous.mcp) {
    if (neededFiles.has(entry.file) || dryRun) continue;
    try {
      mcpTargetFor(entry)?.remove(root, entry.server);
    } catch (error) {
      warnings.push(`Could not remove the ${entry.server} MCP server from ${entry.file}: ${errorMessage(error)}`);
    }
  }
  if (options.mcp !== false) {
    const spec = resolveMcpServerSpec(paths);
    for (const group of mcpGroups) {
      try {
        const changed = dryRun ? !group.target.has(root, spec.name) : group.target.upsert(root, spec);
        mcpReport.push({ file: group.file, agents: [...group.agents], changed });
        mcpEntries.push({ agents: [...group.agents], file: group.file, server: spec.name });
      } catch (error) {
        warnings.push(`Could not add the ${spec.name} MCP server to ${group.file}: ${errorMessage(error)}`);
        const kept = previous.mcp.find((entry) => entry.file === group.file);
        if (kept) mcpEntries.push({ ...kept, agents: [...group.agents] });
      }
    }
    for (const adapter of adapters) {
      if (adapter.mcp) continue;
      mcpManual.push({
        agent: adapter.id,
        instructions:
          adapter.mcpNote ??
          `${adapter.name} has no project-level MCP config: add a stdio server "${spec.name}" running \`${[spec.command, ...spec.args].join(' ')}\` to its global MCP settings.`,
      });
    }
  } else {
    // --no-mcp: leave MCP configs alone but keep tracking the entries dfl wrote earlier.
    for (const group of mcpGroups) {
      const kept = previous.mcp.find((entry) => entry.file === group.file);
      if (kept) mcpEntries.push({ ...kept, agents: [...group.agents] });
    }
  }

  // 8. Gitignore files and manifest.
  if (!dryRun) {
    writeDfGitignore(paths);
    updateRootGitignore(paths, gitignoreLines(installed));
    writeManifest(paths, { version: 1, flow: model.name, agents, skills: installed, mcp: mcpEntries });
  }

  return { flow: model.name, agents, skills: reportSkills, removed, mcp: mcpReport, mcpManual, warnings };
}

export interface UninstallOptions {
  /** Also delete `.df/local.json`, `.df/state.json` and rendered `.md` files under `.df`. */
  purge?: boolean | undefined;
}

export interface UninstallReport {
  /** Project-relative paths removed (skill dirs; with `purge` also config/state/rendered files). */
  removed: string[];
  mcp: Array<{ file: string; changed: boolean }>;
  /** Things that were left in place (e.g. a manifest skill dir that now holds a user-authored skill). */
  warnings: string[];
}

/** Removes everything listed in the manifest, dfl MCP entries and the managed .gitignore block. Keeps `.df/` flows. */
export function uninstallProject(paths: ProjectPaths, options: UninstallOptions = {}): UninstallReport {
  const root = paths.root;
  const manifest = readManifest(paths);
  const removed: string[] = [];
  const warnings: string[] = [];

  for (const entry of manifest.skills) {
    const result = removeSkillDir(root, entry.dir, false);
    if (result.removed) removed.push(entry.dir);
    if (result.warning) warnings.push(result.warning);
  }

  const mcp: UninstallReport['mcp'] = [];
  for (const entry of manifest.mcp) {
    try {
      mcp.push({ file: entry.file, changed: mcpTargetFor(entry)?.remove(root, entry.server) ?? false });
    } catch (error) {
      warnings.push(`Could not remove the ${entry.server} MCP server from ${entry.file}: ${errorMessage(error)}`);
      mcp.push({ file: entry.file, changed: false });
    }
  }

  updateRootGitignore(paths, []);
  removePath(paths.manifestFile);

  if (options.purge) {
    for (const file of [paths.localFile, paths.stateFile]) {
      if (!exists(file)) continue;
      removePath(file);
      removed.push(toRel(root, file));
    }
    for (const flow of listFlows(paths)) {
      const stepsDir = paths.stepsDir(flow);
      for (const rel of walkFiles(stepsDir)) {
        const abs = path.join(stepsDir, ...rel.split('/'));
        // Only rendered output: hand-written .md files without a template are kept.
        if (!rel.endsWith('.md') || !isFile(`${abs}.hbs`)) continue;
        removePath(abs);
        removed.push(toRel(root, abs));
      }
    }
  }

  return { removed: removed.sort(compare), mcp, warnings };
}

/** `.df/installed.json`; an empty manifest when the file does not exist. Unknown agent ids are dropped. */
export function readManifest(paths: ProjectPaths): Manifest {
  const data = readJsonIfExists<unknown>(paths.manifestFile);
  if (data === undefined) return emptyManifest();
  const invalid = (detail: string): DflError =>
    new DflError(`Invalid install manifest ${paths.manifestFile}: ${detail}`, {
      hint: 'Delete the file and run `dfl install` again (dfl then forgets which skill dirs it installed).',
      code: 'INVALID_MANIFEST',
    });
  if (!isRecord(data)) throw invalid('expected a JSON object.');
  if (data['version'] !== undefined && data['version'] !== 1) throw invalid(`unsupported version ${String(data['version'])}.`);

  const skills: SkillManifestEntry[] = [];
  for (const item of arrayOf(data['skills'])) {
    if (!isRecord(item) || typeof item['dir'] !== 'string' || item['dir'] === '') throw invalid('every skill needs a "dir".');
    skills.push({
      agents: manifestAgents(item['agents']),
      name: typeof item['name'] === 'string' ? item['name'] : path.posix.basename(item['dir']),
      dir: item['dir'],
      files: arrayOf(item['files']).filter((file): file is string => typeof file === 'string'),
    });
  }
  const mcp: McpManifestEntry[] = [];
  for (const item of arrayOf(data['mcp'])) {
    if (!isRecord(item) || typeof item['file'] !== 'string' || typeof item['server'] !== 'string') {
      throw invalid('every mcp entry needs "file" and "server".');
    }
    mcp.push({ agents: manifestAgents(item['agents']), file: item['file'], server: item['server'] });
  }
  return {
    version: 1,
    flow: typeof data['flow'] === 'string' ? data['flow'] : undefined,
    agents: manifestAgents(data['agents']),
    skills,
    mcp,
  };
}

export function writeManifest(paths: ProjectPaths, manifest: Manifest): void {
  writeJson(paths.manifestFile, {
    version: 1,
    ...(manifest.flow !== undefined ? { flow: manifest.flow } : {}),
    agents: manifest.agents,
    skills: manifest.skills,
    mcp: manifest.mcp,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function emptyManifest(): Manifest {
  return { version: 1, agents: [], skills: [], mcp: [] };
}

/** Agent id list from the manifest: known ids only, deduped, in AGENT_IDS order. */
function manifestAgents(value: unknown): AgentId[] {
  const known = new Set<string>(AGENT_IDS);
  return sortAgents(arrayOf(value).filter((id): id is AgentId => typeof id === 'string' && known.has(id)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Code-unit string order (locale independent). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deduped, in AGENT_IDS order. */
function sortAgents(agents: readonly AgentId[]): AgentId[] {
  const selected = new Set(agents);
  return AGENT_IDS.filter((id) => selected.has(id));
}

function absPath(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * True for a project-relative posix path dfl may delete: relative, no `.`/`..` segments and not
 * inside `.df/` or `.git/`. Guards against a hand-edited or corrupted manifest.
 */
function isManagedPath(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || path.isAbsolute(rel) || rel.includes('\\')) return false;
  const parts = rel.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  return parts[0] !== '.df' && parts[0] !== '.git';
}

/** Relative file path inside a skill dir that is safe to delete. */
function isSafeRelFile(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || path.isAbsolute(rel) || rel.includes('\\')) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function groupBySkillsDir(adapters: AgentAdapter[]): SkillsDirGroup[] {
  const groups: SkillsDirGroup[] = [];
  for (const adapter of adapters) {
    const group = groups.find((g) => g.dir === adapter.skillsDir);
    if (group) group.agents.push(adapter.id);
    else groups.push({ dir: adapter.skillsDir, agents: [adapter.id] });
  }
  return groups;
}

function groupByMcpFile(adapters: AgentAdapter[], root: string): McpFileGroup[] {
  const groups: McpFileGroup[] = [];
  for (const adapter of adapters) {
    const file = mcpConfigFile(adapter, root);
    if (!file || !adapter.mcp) continue;
    const group = groups.find((g) => g.file === file);
    if (group) group.agents.push(adapter.id);
    else groups.push({ file, target: adapter.mcp, agents: [adapter.id] });
  }
  return groups;
}

/** The MCP target that owns a manifest entry: one of its agents, else any adapter writing that file. */
function mcpTargetFor(entry: McpManifestEntry): McpTarget | undefined {
  for (const id of entry.agents) {
    const target = getAgent(id).mcp;
    if (target) return target;
  }
  return AGENTS.find((adapter) => adapter.mcp?.file === entry.file)?.mcp;
}

/**
 * Who owns an existing skill dir: `free` (missing or empty), `dfl` (its SKILL.md carries `dfl-*`
 * metadata, or it is in the manifest and has no SKILL.md) or `user` (anything else – a skill with
 * the same name the user wrote or put in place of dfl's; never overwritten or deleted).
 */
function skillDirOwner(absDir: string, inManifest: boolean): 'free' | 'dfl' | 'user' {
  if (!exists(absDir)) return 'free';
  if (!isDir(absDir)) return 'user';
  const text = readTextIfExists(path.join(absDir, SKILL_FILE));
  if (text === undefined) return inManifest ? 'dfl' : fs.readdirSync(absDir).length === 0 ? 'free' : 'user';
  return hasDflMetadata(text) ? 'dfl' : 'user';
}

const FRONTMATTER_RE = /^﻿?(?:[ \t]*\r?\n)*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** True when the SKILL.md frontmatter has a `metadata.dfl-*` key. */
function hasDflMetadata(text: string): boolean {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return false;
  try {
    const data: unknown = parseYaml(match[1] ?? '');
    const metadata = isRecord(data) ? data['metadata'] : undefined;
    return isRecord(metadata) && Object.keys(metadata).some((key) => key.startsWith(DFL_METADATA_PREFIX));
  } catch {
    return false;
  }
}

/** Writes a rendered skill into `absDir` and deletes files dfl wrote there before but no longer produces. */
function writeSkill(absDir: string, skill: RenderedSkill, previousFiles: string[]): void {
  const current = new Set<string>();
  for (const file of skill.files) {
    current.add(file.path);
    const dest = path.join(absDir, ...file.path.split('/'));
    if (file.content !== undefined) writeText(dest, file.content);
    else if (file.sourcePath !== undefined) copyFile(file.sourcePath, dest);
  }
  for (const rel of previousFiles) {
    if (current.has(rel) || !isSafeRelFile(rel)) continue;
    const abs = path.join(absDir, ...rel.split('/'));
    removePath(abs);
    removeEmptyDirsUpTo(path.dirname(abs), absDir);
  }
}

/** Removes a manifest skill dir (and emptied parents) unless it now holds a user-authored skill. */
function removeSkillDir(root: string, dir: string, dryRun: boolean): { removed: boolean; warning?: string } {
  if (!isManagedPath(dir)) return { removed: false, warning: `Ignored suspicious path "${dir}" in the install manifest.` };
  const abs = absPath(root, dir);
  if (!exists(abs)) return { removed: false };
  if (skillDirOwner(abs, true) === 'user') {
    return { removed: false, warning: `Kept ${dir}/: it no longer holds a dfl skill (remove it yourself if unwanted).` };
  }
  if (!dryRun) {
    removePath(abs);
    removeEmptyDirsUpTo(path.dirname(abs), root);
  }
  return { removed: true };
}

/**
 * Upserts (or with no lines removes) the managed block in `<root>/.gitignore`; deletes the file when
 * removing the block left it empty (it then only ever held dfl's block).
 */
function updateRootGitignore(paths: ProjectPaths, lines: string[]): void {
  const changed = upsertManagedBlock(paths.rootGitignoreFile, lines);
  if (changed && lines.length === 0 && readTextIfExists(paths.rootGitignoreFile) === '') removePath(paths.rootGitignoreFile);
}

/** Managed `.gitignore` block lines: installed skill dirs, sorted. */
function gitignoreLines(installed: SkillManifestEntry[]): string[] {
  return installed.map((entry) => `${entry.dir}/`).sort(compare);
}

/** renderFlowSkills without touching `.df/`: renders a temporary copy of the flow directory. */
function renderFlowSkillsDry(paths: ProjectPaths, model: FlowModel, vars: Record<string, unknown>): RenderedSkill[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dfl-dry-run-'));
  try {
    const dir = path.join(tmp, model.name);
    copyDir(model.dir, dir);
    return renderFlowSkills(paths, buildFlowModel(model.def, dir), vars);
  } finally {
    removePath(tmp);
  }
}
