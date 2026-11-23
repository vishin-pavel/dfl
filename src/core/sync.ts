/**
 * Install/sync orchestrator – the only code path that writes outside `.df/`.
 * See docs/ARCHITECTURE.md §5.
 *
 * Safety rules:
 * - `.df/installed.json` is untrusted input (it can be hand-edited or force-committed): only skill dirs
 *   of the form `<adapter skillsDir>/<valid id>`, plain relative file names, known MCP config files and
 *   the `dfl` server name are accepted.
 * - Nothing is written or deleted through a symbolic link: every path component below the project root
 *   is lstat'ed first; a symlink makes dfl skip that path with a warning.
 * - A skill dir is dfl's when its SKILL.md carries `metadata.dfl-*` keys, or (without SKILL.md) when it
 *   holds dfl's `.gitignore` marker. dfl only ever deletes the files it wrote (plus the marker) and
 *   removes a dir only once it is empty.
 * - Rendered skills are git-ignored by the `.gitignore` marker inside each skill dir (never by the
 *   committed root `.gitignore`, which must not depend on personal agent/flow choices).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  MCP_SERVER_NAME,
  dflLauncher,
  isCommandOnPath,
  isDflLauncher,
  localInstallPrefix,
  resolveMcpServerSpec,
} from '../agents/mcp-config.js';
import { AGENTS, getAgent, isKnownMcpFile, mcpConfigFile, mcpTargetForFile } from '../agents/registry.js';
import type { AgentAdapter, McpTarget, McpUpsertStatus } from '../agents/types.js';
import {
  getActiveFlowName,
  getMcpEnabled,
  getSelectedAgents,
  loadProjectConfig,
  setSelectedAgents,
} from './config.js';
import { DflError, errorMessage, isDflError } from './errors.js';
import { buildFlowModel, flowExists, listFlows, loadActiveFlow } from './flow.js';
import { copyDir, exists, isFile, readJsonIfExists, removeEmptyDirsUpTo, removePath, walkFiles, writeJson } from './fsx.js';
import { SKILL_DIR_GITIGNORE_CONTENT, SKILL_DIR_GITIGNORE_FILE, removeLegacyGitignoreBlock, writeDfGitignore } from './gitignore.js';
import { isValidId } from './ids.js';
import { PACKAGE_NAME, packageVersion } from './paths.js';
import {
  firstSymlinkBetween,
  isRenderedOutputPath,
  listTree,
  renderBuiltinSkills,
  renderFlow,
  type RenderFlowOptions,
  type RenderFlowResult,
} from './render.js';
import { AGENT_IDS } from './types.js';
import type {
  AgentId,
  FlowModel,
  FlowVarDef,
  Manifest,
  McpManifestEntry,
  ProjectPaths,
  RenderedFile,
  SkillManifestEntry,
  SyncReport,
} from './types.js';
import { assertFlowValid } from './validate.js';
import { resolveVars, setVar, varScope } from './vars.js';

export interface SyncOptions {
  /** Agents to install for; default: getSelectedAgents(). Persisted to local.json when given. */
  agents?: AgentId[] | undefined;
  /**
   * Register the dfl MCP server in agent MCP configs for this run. Default: the personal preference
   * in local.json (`mcp`, default true; `dfl install` stores it with `setMcpEnabled`). Not persisted.
   */
  mcp?: boolean | undefined;
  /** Called for each missing required var; the value is stored in its scope. Without it missing vars become warnings. */
  promptVar?: ((name: string, def: FlowVarDef) => Promise<unknown>) | undefined;
  /** Compute the report without writing anything. */
  dryRun?: boolean | undefined;
}

const SKILL_FILE = 'SKILL.md';
/** Skill metadata keys dfl writes start with this prefix (`dfl-flow`, `dfl-step`, `dfl-builtin`). */
const DFL_METADATA_PREFIX = 'dfl-';

/** Marker file dfl writes into every skill dir it installs: git-ignores the whole dir (itself included). */
const SKILL_GITIGNORE_FILE = SKILL_DIR_GITIGNORE_FILE;
const SKILL_MARKER_FIRST_LINE = SKILL_DIR_GITIGNORE_CONTENT.split('\n')[0]!;

/** Message used when a mutation cannot auto-sync because this developer never ran `dfl install`. */
export const NOT_INSTALLED_MESSAGE = 'skills not installed for you yet; run `dfl install`';

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

/** Ordered, de-duplicated warning list. */
class Warnings {
  private readonly items: string[] = [];
  push(...messages: string[]): void {
    for (const message of messages) if (!this.items.includes(message)) this.items.push(message);
  }
  list(): string[] {
    return [...this.items];
  }
}

/**
 * 1. Resolves active flow (DflError when none) and agents. 2. Resolves vars (prompting via promptVar).
 * 3. Validates the flow (errors abort). 4. Renders flow skills (into .df) and built-in skills.
 * 5. Writes each skill (plus the `.gitignore` marker) into every distinct agent skills dir. 6. Removes
 * the files of skill dirs from the previous manifest that are no longer produced. 7. Upserts MCP entries
 * (deselected agents keep theirs: MCP configs are committed team config). 8. Writes .df/.gitignore,
 * drops a legacy managed block from <root>/.gitignore and writes the new manifest (with fingerprint).
 *
 * The flow is validated before vars are prompted for, so an invalid flow never asks questions.
 * `dryRun` renders into a temporary copy of the flow and never prompts.
 */
export async function syncProject(paths: ProjectPaths, options: SyncOptions = {}): Promise<SyncReport> {
  const dryRun = options.dryRun === true;
  const root = paths.root;
  const warnings = new Warnings();

  // 1. Flow and agents.
  const model = loadActiveFlow(paths);
  const agents = sortAgents(options.agents ?? getSelectedAgents(paths));
  const adapters = agents.map((id) => getAgent(id));

  // 3. Validation – before 2. so an invalid flow never prompts.
  const issues = assertFlowValid(paths, model.name);

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

  const { manifest: previous, warnings: manifestWarnings } = loadManifest(paths);
  warnings.push(...manifestWarnings);

  // 4. Render.
  const renderOptions: RenderFlowOptions = {
    previouslyRendered: previous.rendered ?? [],
    flowRelDir: toRel(root, paths.flowDir(model.name)),
  };
  const render = dryRun
    ? renderFlowDry(paths, model, resolved.values, renderOptions)
    : renderFlow(paths, model, resolved.values, renderOptions);
  warnings.push(...render.warnings);
  const stepSkills = render.skills;
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
  const mcpEnabled = options.mcp ?? getMcpEnabled(paths);

  const previousSkills = new Map(previous.skills.map((entry) => [entry.dir, entry]));
  const linkWarned = new Set<string>();
  const warnLink = (link: string): void => {
    if (linkWarned.has(link)) return;
    linkWarned.add(link);
    warnings.push(
      `Left ${toRel(root, link)} alone: it is a symbolic link, and dfl never writes or deletes through symlinks. ` +
        'Replace it with a real directory (or file) to let dfl manage it.',
    );
  };

  // Dirs dfl created (earlier or in this run): only these are removed again once empty.
  const createdDirs = new Set((previous.createdDirs ?? []).filter((dir) => isRealDir(absPath(root, dir))));
  const recordCreated = (relDir: string): void => {
    if (!dryRun) for (const dir of missingDirs(root, relDir)) createdDirs.add(dir);
  };

  // 5. Skills into every distinct skills dir.
  const installed: SkillManifestEntry[] = [];
  const reportSkills: SyncReport['skills'] = [];
  /** Dirs not written this run for a reason already reported (never treated as stale). */
  const skipped = new Set<string>();
  /** Skills dirs skipped as a whole because of a symlink: their agents get no skills (manifest `skippedDirs`). */
  const skippedSkillsDirs: string[] = [];
  for (const group of groupBySkillsDir(adapters)) {
    const groupLink = firstSymlinkBetween(root, absPath(root, group.dir));
    if (groupLink) skippedSkillsDirs.push(group.dir);
    for (const skill of skills) {
      const dir = `${group.dir}/${skill.name}`;
      if (groupLink) {
        warnLink(groupLink);
        skipped.add(dir);
        continue;
      }
      const absDir = absPath(root, dir);
      const before = previousSkills.get(dir);
      const files = skill.files.filter((file) => file.path !== SKILL_GITIGNORE_FILE);
      if (files.length !== skill.files.length) {
        warnings.push(
          `The "${skill.name}" skill's own .gitignore is not installed: dfl writes its own .gitignore into every skill dir.`,
        );
      }
      const check = checkSkillTarget(root, absDir, files, before);
      if (check.kind === 'link') {
        warnLink(check.link);
        skipped.add(dir);
        continue;
      }
      if (check.kind === 'user') {
        warnings.push(`Skipped ${dir}/: ${check.reason}. Rename or remove it to install the "${skill.name}" skill there.`);
        skipped.add(dir);
        continue;
      }
      if (!dryRun) {
        recordCreated(group.dir);
        warnings.push(...writeSkill(root, absDir, files, before?.files ?? []));
      }
      installed.push({ agents: [...group.agents], name: skill.name, dir, files: files.map((file) => file.path) });
      reportSkills.push({ name: skill.name, dir, agents: [...group.agents], kind: skill.kind });
    }
  }

  // 6. Stale skill dirs.
  const produced = new Set(installed.map((entry) => entry.dir));
  const removed: string[] = [];
  const linkTargets = skillsDirLinkTargets(root);
  for (const entry of previous.skills) {
    if (produced.has(entry.dir) || skipped.has(entry.dir)) continue;
    const result = removeSkillDir(root, entry, dryRun, linkTargets, createdDirs);
    if (result.link) warnLink(result.link);
    if (result.removed) removed.push(entry.dir);
    if (result.warning) warnings.push(result.warning);
  }
  removed.sort(compare);

  // 7. MCP entries. Entries of deselected agents are kept (committed team config); only `dfl uninstall` removes them.
  const mcpReport: SyncReport['mcp'] = [];
  const mcpManual: SyncReport['mcpManual'] = [];
  const mcpEntries: McpManifestEntry[] = [];
  const previousMcp = new Map(previous.mcp.map((entry) => [entry.file, entry]));
  const handled = new Set<string>();
  const mcpGroups = groupByMcpFile(adapters, root);
  if (mcpEnabled) {
    const override = loadProjectConfig(paths).mcp;
    const spec = resolveMcpServerSpec(paths);
    let changedAny = false;
    for (const group of mcpGroups) {
      handled.add(group.file);
      const before = previousMcp.get(group.file);
      const link = firstSymlinkBetween(root, absPath(root, group.file));
      if (link) {
        warnLink(link);
        if (before) mcpEntries.push({ ...before, agents: [...group.agents] });
        continue;
      }
      try {
        const state = group.target.inspect(root);
        let status: McpUpsertStatus;
        if (dryRun) {
          status = group.target.plan(root, spec);
        } else {
          recordCreated(path.posix.dirname(group.file));
          const had = group.target.has(root, spec.name);
          status = group.target.upsert(root, spec) ? (had ? 'updated' : 'added') : 'unchanged';
        }
        if (status !== 'unchanged') changedAny = true;
        mcpReport.push({ file: group.file, agents: [...group.agents], changed: status !== 'unchanged', status });
        mcpEntries.push({
          agents: [...group.agents],
          file: group.file,
          server: spec.name,
          // Only what dfl created may be deleted again by uninstall (a pre-existing file/container stays).
          createdFile: !state.exists || before?.createdFile === true,
          createdContainer: !state.container || before?.createdContainer === true,
        });
      } catch (error) {
        warnings.push(`Could not add the ${spec.name} MCP server to ${group.file}: ${errorMessage(error)}`);
        if (before) mcpEntries.push({ ...before, agents: [...group.agents] });
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
    if (!override && spec.command === 'npx') {
      for (const adapter of adapters) {
        if (!adapter.mcp || !adapter.mcpCwdOutsideWorkspace) continue;
        mcpManual.push({ agent: adapter.id, instructions: cwdCaveat(adapter, root) });
      }
    }
    if (changedAny && !override && spec.command === 'dfl' && !isCommandOnPath('dfl')) warnings.push(dflNotOnPathWarning(root));
  } else {
    // MCP registration is off for this developer: leave MCP configs alone but keep tracking earlier entries.
    for (const group of mcpGroups) {
      const before = previousMcp.get(group.file);
      if (!before) continue;
      handled.add(group.file);
      mcpEntries.push({ ...before, agents: [...group.agents] });
    }
  }
  for (const entry of previous.mcp) if (!handled.has(entry.file)) mcpEntries.push(entry);

  // 8. Gitignore files and manifest.
  if (!dryRun) {
    writeDfGitignore(paths);
    warnings.push(...removeLegacyGitignoreBlock(paths, legacyGitignoreLines(previous)).warnings);
    writeManifest(paths, {
      version: 1,
      flow: model.name,
      agents,
      skills: installed,
      mcp: mcpEntries,
      rendered: mergeRendered(paths, previous.rendered ?? [], model.name, render.rendered),
      createdDirs: [...createdDirs],
      skippedDirs: skippedSkillsDirs,
      dflVersion: packageVersion(),
      fingerprint: computeSyncFingerprint(paths),
    });
  }

  // Validation warnings about files this sync just cleaned up (stale rendered output, orphan step dirs)
  // are moot, and hand-written .md files get an accurate message: they are kept, not overwritten.
  const handledByRender = [...render.removed, ...render.kept];
  const flowPrefix = `${toRel(root, paths.flowDir(model.name))}/`;
  const validation = [
    ...issues.filter((issue) => !(issue.file && isUnder(toRel(root, issue.file), handledByRender))).map((issue) => issue.message),
    ...render.kept.map((rel) => {
      const name = path.posix.basename(rel);
      return (
        `${rel.startsWith(flowPrefix) ? rel.slice(flowPrefix.length) : rel} was not rendered by dfl: it stays in .df/ ` +
        `but is not installed with the skill. Rename it to ${name}.hbs to install it.`
      );
    }),
  ];
  return {
    flow: model.name,
    agents,
    skills: reportSkills,
    removed,
    mcp: mcpReport,
    mcpManual,
    warnings: [...new Set([...validation, ...warnings.list()])],
  };
}

export interface UninstallOptions {
  /** Also delete `.df/local.json`, `.df/state.json`, `.df/fast-forward.json` and rendered `.md` files under `.df`. */
  purge?: boolean | undefined;
  /**
   * Leave the `dfl` MCP entries alone (they are committed team config), e.g. when the last active flow
   * is deleted: only the installed skills go. The caller keeps tracking them in its new manifest.
   */
  keepMcp?: boolean | undefined;
}

export interface UninstallReport {
  /** Project-relative paths removed (skill dirs; with `purge` also config/state/rendered files). */
  removed: string[];
  mcp: Array<{ file: string; changed: boolean }>;
  /** Things that were left in place (e.g. a manifest skill dir that now holds a user-authored skill). */
  warnings: string[];
  /** True when `.df/installed.json` was kept because some MCP entries could not be removed (retry later). */
  manifestKept?: boolean | undefined;
}

/**
 * Removes the files dfl installed (listed in the manifest), the `dfl` MCP entries (only when their
 * command looks like dfl) and a legacy managed `.gitignore` block. Keeps `.df/` flows. MCP entries that
 * could not be removed (e.g. invalid JSON) stay in the manifest so a later `dfl uninstall` retries.
 */
export function uninstallProject(paths: ProjectPaths, options: UninstallOptions = {}): UninstallReport {
  const root = paths.root;
  const { manifest, warnings: manifestWarnings } = loadManifest(paths);
  const removed: string[] = [];
  const warnings = new Warnings();
  warnings.push(...manifestWarnings);
  const linkWarned = new Set<string>();
  const warnLink = (link: string): void => {
    if (linkWarned.has(link)) return;
    linkWarned.add(link);
    warnings.push(`Left ${toRel(root, link)} alone: it is a symbolic link, and dfl never deletes through symlinks.`);
  };

  const linkTargets = skillsDirLinkTargets(root);
  const createdDirs = new Set(manifest.createdDirs ?? []);
  for (const entry of manifest.skills) {
    const result = removeSkillDir(root, entry, false, linkTargets, createdDirs);
    if (result.link) warnLink(result.link);
    if (result.removed) removed.push(entry.dir);
    if (result.warning) warnings.push(result.warning);
  }

  let override: { command: string; args: string[] } | undefined;
  try {
    override = loadProjectConfig(paths).mcp;
  } catch {
    override = undefined;
  }
  const mcp: UninstallReport['mcp'] = [];
  const failed: McpManifestEntry[] = [];
  const seen = new Set<string>();
  for (const entry of options.keepMcp ? [] : manifest.mcp) {
    if (seen.has(entry.file)) continue;
    seen.add(entry.file);
    const target = mcpTargetForFile(entry.file);
    if (!target) continue;
    const link = firstSymlinkBetween(root, absPath(root, entry.file));
    if (link) {
      warnLink(link);
      mcp.push({ file: entry.file, changed: false });
      continue;
    }
    try {
      const current = target.read(root, MCP_SERVER_NAME, entry.file);
      if (current === undefined) {
        mcp.push({ file: entry.file, changed: false });
        continue;
      }
      if (!isDflLauncher(current, override)) {
        const command = [current.command ?? '?', ...current.args].join(' ');
        warnings.push(`Left the "${MCP_SERVER_NAME}" MCP server in ${entry.file}: its command (\`${command}\`) does not look like dfl.`);
        mcp.push({ file: entry.file, changed: false });
        continue;
      }
      const changed = target.remove(root, MCP_SERVER_NAME, {
        file: entry.file,
        deleteEmptyFile: entry.createdFile === true,
        dropEmptyContainer: entry.createdContainer === true,
        // Only the dirs dfl created go with a deleted file (a pre-existing `.kiro/` stays).
        removeEmptyDirs: false,
      });
      const abs = absPath(root, entry.file);
      if (changed && lstatOrUndefined(abs) === undefined) removeEmptyParents(path.dirname(abs), root, linkTargets, createdDirs);
      mcp.push({ file: entry.file, changed });
    } catch (error) {
      warnings.push(
        `Could not remove the ${MCP_SERVER_NAME} MCP server from ${entry.file}: ${errorMessage(error)} ` +
          'Fix the file and run `dfl uninstall` again (dfl keeps tracking the entry).',
      );
      failed.push(entry);
      mcp.push({ file: entry.file, changed: false });
    }
  }

  warnings.push(...removeLegacyGitignoreBlock(paths, legacyGitignoreLines(manifest)).warnings);
  const rendered = new Set(manifest.rendered ?? []);
  if (failed.length === 0) {
    removePath(paths.manifestFile);
  } else {
    // Kept only so a later `dfl uninstall` retries these entries; `uninstalled` stops auto-syncs.
    writeManifest(paths, {
      version: 1,
      agents: [],
      skills: [],
      mcp: failed,
      rendered: options.purge ? [] : [...rendered],
      createdDirs: [...createdDirs],
      uninstalled: true,
    });
  }

  if (options.purge) {
    for (const file of [paths.localFile, paths.stateFile, paths.fastForwardFile]) {
      if (!exists(file)) continue;
      removePath(file);
      removed.push(toRel(root, file));
    }
    for (const flow of listFlows(paths)) {
      const stepsDir = paths.stepsDir(flow);
      if (firstSymlinkBetween(root, stepsDir) !== undefined) continue;
      for (const entry of listTree(stepsDir)) {
        if (entry.kind !== 'file' || !entry.rel.endsWith('.md')) continue;
        const abs = path.join(stepsDir, ...entry.rel.split('/'));
        const rel = toRel(root, abs);
        // Only rendered output (a sibling template, or rendered by dfl before): hand-written .md files stay.
        if (!isFile(`${abs}.hbs`) && !rendered.has(rel)) continue;
        removePath(abs);
        removeEmptyDirsUpTo(path.dirname(abs), stepsDir);
        removed.push(rel);
      }
    }
  }

  return { removed: removed.sort(compare), mcp, warnings: warnings.list(), ...(failed.length > 0 ? { manifestKept: true } : {}) };
}

/**
 * True once this developer ran `dfl install` (`.df/installed.json` exists and is not the leftover of
 * an incomplete `dfl uninstall`): mutations may auto-sync. A manifest that lists neither agents nor
 * skills does not count: `dfl flow-update` (or the MCP `sync` tool) writes one in a fresh clone where
 * this developer selected no agents yet, and no skill is installed anywhere then.
 */
export function isInstalledForUser(paths: ProjectPaths): boolean {
  if (!exists(paths.manifestFile)) return false;
  try {
    const data = readJsonIfExists<unknown>(paths.manifestFile);
    if (!isRecord(data)) return true; // malformed: sync reports the problem
    if (data['uninstalled'] === true) return false;
    return manifestAgents(data['agents']).length > 0 || arrayOf(data['skills']).length > 0;
  } catch {
    // An unreadable manifest still means dfl was installed; sync reports the problem.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Staleness (fingerprint)
// ---------------------------------------------------------------------------

export interface SyncState {
  /** This developer installed dfl (isInstalledForUser). */
  installed: boolean;
  /** The installed skills match the current flow files, variables and settings. */
  upToDate: boolean;
  /** Why the skills are not installed / not up to date (callers add the `dfl flow-update` hint). */
  reason?: string | undefined;
  /**
   * Set when `dfl flow-update` alone is not the fix: what to do instead (a sentence; CLI commands
   * are spelled `` `dfl …` ``). Callers show it in place of their flow-update hint.
   */
  fix?: string | undefined;
}

/** Hint for an install manifest that cannot be read or is malformed. */
const INVALID_MANIFEST_HINT = 'Delete the file and run `dfl install` again (dfl then forgets which skill dirs it installed).';

/**
 * sha256 over everything the installed skills are rendered from: dfl version, active flow name, every
 * file under `.df/<flow>/` except rendered `.md` outputs (path + content), the stored vars (defaults,
 * config.json, local.json), selected agents, the MCP preference, the dfl CLI launcher, the project root
 * and whether `.df/tracker.json` exists (it adds the built-in `init-task` skill, see renderBuiltinSkills).
 *
 * Process-environment overrides (`DFL_VAR_*`, `DFL_ENV_*`) are left out on purpose: they belong to one
 * shell, so an MCP server or a terminal started without them must not report the skills as stale (and
 * send the user into a `dfl flow-update` that drops the values they set).
 */
export function computeSyncFingerprint(paths: ProjectPaths): string {
  const model = loadActiveFlow(paths);
  const hash = createHash('sha256');
  const field = (name: string, value: string | Buffer): void => {
    hash.update(`${name}:${Buffer.byteLength(value)}:`);
    hash.update(value);
    hash.update('\n');
  };
  field('dfl', packageVersion());
  field('flow', model.name);
  for (const rel of walkFiles(model.dir)) {
    if ((rel.startsWith('steps/') && rel.endsWith('.md')) || DISPOSABLE_FILES.has(path.posix.basename(rel))) continue;
    field('path', rel);
    field('content', fs.readFileSync(path.join(model.dir, ...rel.split('/'))));
  }
  field('vars', stableJson(resolveVars(paths, model.def, {}).values));
  field('agents', sortAgents(getSelectedAgents(paths)).join(','));
  field('mcp', String(getMcpEnabled(paths)));
  field('cli', dflLauncher(paths));
  field('root', realpathOrSelf(paths.root));
  field('tracker', exists(paths.trackerFile) ? '1' : '0');
  return hash.digest('hex');
}

/**
 * Whether this developer's installed skills are current. Cheap enough for every `dfl status` and MCP
 * `get_status` call; never throws.
 */
export function checkSyncState(paths: ProjectPaths): SyncState {
  if (!isInstalledForUser(paths)) return { installed: false, upToDate: false, reason: NOT_INSTALLED_MESSAGE };
  let manifest: Manifest;
  try {
    manifest = readManifest(paths);
  } catch (error) {
    const message = errorMessage(error).replace(/\.$/, '');
    return {
      installed: true,
      upToDate: false,
      reason:
        isDflError(error) && error.code === 'INVALID_MANIFEST'
          ? message.charAt(0).toLowerCase() + message.slice(1)
          : `the install manifest cannot be read (${message})`,
      fix: `Delete ${toRel(paths.root, paths.manifestFile)} and run \`dfl install\` again.`,
    };
  }
  // `dfl flow delete` of the last active flow keeps a manifest without flow and skills.
  if (manifest.flow === undefined && manifest.skills.length === 0) {
    return { installed: true, upToDate: false, reason: "no flow's skills are installed yet" };
  }
  const version = packageVersion();
  if (manifest.dflVersion !== undefined && manifest.dflVersion !== version) {
    return { installed: true, upToDate: false, reason: `the skills were installed by dfl ${manifest.dflVersion} (this is dfl ${version})` };
  }
  if (manifest.fingerprint === undefined) {
    return { installed: true, upToDate: false, reason: 'the skills were installed by an older dfl version' };
  }
  let active: string | undefined;
  try {
    active = getActiveFlowName(paths);
  } catch (error) {
    return { installed: true, upToDate: false, reason: errorMessage(error) };
  }
  if (active === undefined) return { installed: true, upToDate: false, reason: 'no flow is active' };
  if (manifest.flow !== active) {
    return {
      installed: true,
      upToDate: false,
      reason: `the installed skills are for flow "${manifest.flow ?? '?'}" but the active flow is "${active}"`,
    };
  }
  let fingerprint: string;
  try {
    fingerprint = computeSyncFingerprint(paths);
  } catch (error) {
    return { installed: true, upToDate: false, reason: errorMessage(error) };
  }
  if (fingerprint !== manifest.fingerprint) {
    return {
      installed: true,
      upToDate: false,
      reason: `the flow "${active}" (templates, flow.json), variables, install settings or the presence of .df/tracker.json changed since the skills were installed`,
    };
  }
  const skipped = manifest.skippedDirs ?? [];
  if (skipped.length > 0) {
    const agents = manifest.agents.filter((id) => skipped.includes(getAgent(id).skillsDir)).map((id) => getAgent(id).name);
    return {
      installed: true,
      upToDate: false,
      reason:
        `no skills are installed in ${skipped.join(', ')}${agents.length > 0 ? ` (${agents.join(', ')})` : ''}: ` +
        `${skipped.length === 1 ? 'it is a symbolic link' : 'they are symbolic links'}, and dfl never writes through symlinks`,
      fix: `Replace ${skipped.length === 1 ? 'it' : 'them'} with a real directory, then run \`dfl flow-update\`.`,
    };
  }
  return { installed: true, upToDate: true };
}

/**
 * checkSyncState from the point of view of `flowName` (e.g. `dfl status --flow <name>`, or a skill of
 * that flow calling MCP `get_status`): the active flow gets checkSyncState; a flow that is not active
 * but whose skills are the installed ones (the active flow changed, e.g. the team default after a
 * `git pull`) is reported as such; undefined for any other flow (its skills are not installed, nothing
 * to report). Never throws.
 */
export function checkFlowSyncState(paths: ProjectPaths, flowName: string): SyncState | undefined {
  let active: string | undefined;
  try {
    active = getActiveFlowName(paths);
  } catch {
    active = undefined;
  }
  if (active === flowName) return checkSyncState(paths);
  if (!isInstalledForUser(paths)) return undefined;
  let installedFlow: string | undefined;
  try {
    installedFlow = readManifest(paths).flow;
  } catch {
    return undefined;
  }
  if (installedFlow !== flowName) return undefined;
  return {
    installed: true,
    upToDate: false,
    reason:
      active === undefined
        ? `the installed skills are for flow "${flowName}" but no flow is active`
        : `the installed skills are for flow "${flowName}" but the active flow is "${active}"`,
    fix:
      active === undefined
        ? `Run \`dfl flow use ${flowName}\` to keep working on "${flowName}".`
        : `Run \`dfl flow-update\` to install the skills of "${active}", or \`dfl flow use ${flowName}\` to keep working on "${flowName}".`,
  };
}

/** OS junk file names: not hashed into the fingerprint, and disposable when a skill dir is removed. */
const DISPOSABLE_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db']);

/** JSON with object keys sorted at every level (stable across key insertion order). */
function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (isRecord(item)) return Object.fromEntries(Object.keys(item).sort(compare).map((key) => [key, sort(item[key])]));
    return item;
  };
  return JSON.stringify(sort(value)) ?? 'null';
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** `.df/installed.json`; an empty manifest when the file does not exist. Suspicious entries are dropped. */
export function readManifest(paths: ProjectPaths): Manifest {
  return loadManifest(paths).manifest;
}

/**
 * readManifest plus a warning for every dropped entry. The manifest is untrusted input: skill entries
 * must be `<adapter skillsDir>/<valid id>` with plain relative file names, MCP entries must name a
 * known agent MCP config file and the `dfl` server, rendered entries must be `.df/<flow>/steps/…​.md`.
 * Structurally malformed manifests throw DflError `INVALID_MANIFEST`.
 */
export function loadManifest(paths: ProjectPaths): { manifest: Manifest; warnings: string[] } {
  const invalid = (detail: string, cause?: unknown): DflError =>
    new DflError(`Invalid install manifest ${paths.manifestFile}: ${detail}`, {
      hint: INVALID_MANIFEST_HINT,
      code: 'INVALID_MANIFEST',
      ...(cause !== undefined ? { cause } : {}),
    });
  let data: unknown;
  try {
    data = readJsonIfExists<unknown>(paths.manifestFile);
  } catch (error) {
    // Unparsable JSON or an unreadable file: every command that needs the manifest says how to recover.
    const syntax = isDflError(error) && error.code === 'INVALID_JSON' && error.cause instanceof Error ? error.cause.message : undefined;
    throw invalid(syntax !== undefined ? `cannot parse JSON (${syntax}).` : errorMessage(error), error);
  }
  if (data === undefined) return { manifest: emptyManifest(), warnings: [] };
  if (!isRecord(data)) throw invalid('expected a JSON object.');
  if (data['version'] !== undefined && data['version'] !== 1) throw invalid(`unsupported version ${String(data['version'])}.`);
  const warnings: string[] = [];

  const skills: SkillManifestEntry[] = [];
  const skillDirs = new Set<string>();
  for (const item of arrayOf(data['skills'])) {
    if (!isRecord(item) || typeof item['dir'] !== 'string' || item['dir'] === '') throw invalid('every skill needs a "dir".');
    const dir = item['dir'];
    if (!isAllowedSkillDir(dir)) {
      warnings.push(`Ignored suspicious path "${dir}" in the install manifest.`);
      continue;
    }
    if (skillDirs.has(dir)) continue;
    skillDirs.add(dir);
    skills.push({
      agents: manifestAgents(item['agents']),
      name: path.posix.basename(dir),
      dir,
      files: [...new Set(arrayOf(item['files']).filter((file): file is string => typeof file === 'string' && isSafeRelFile(file)))],
    });
  }
  const mcp: McpManifestEntry[] = [];
  for (const item of arrayOf(data['mcp'])) {
    if (!isRecord(item) || typeof item['file'] !== 'string' || typeof item['server'] !== 'string') {
      throw invalid('every mcp entry needs "file" and "server".');
    }
    const file = item['file'];
    const server = item['server'];
    if (server !== MCP_SERVER_NAME || !isKnownMcpFile(file)) {
      warnings.push(`Ignored suspicious MCP entry "${server}" in "${file}" in the install manifest.`);
      continue;
    }
    if (mcp.some((entry) => entry.file === file)) continue;
    mcp.push({
      agents: manifestAgents(item['agents']),
      file,
      server,
      ...(typeof item['createdFile'] === 'boolean' ? { createdFile: item['createdFile'] } : {}),
      ...(typeof item['createdContainer'] === 'boolean' ? { createdContainer: item['createdContainer'] } : {}),
    });
  }
  let rendered: string[] | undefined;
  if (Array.isArray(data['rendered'])) {
    rendered = [];
    for (const rel of data['rendered']) {
      if (typeof rel === 'string' && isRenderedOutputPath(rel)) rendered.push(rel);
      else warnings.push(`Ignored suspicious rendered path "${String(rel)}" in the install manifest.`);
    }
  }
  const dirList = (key: 'createdDirs' | 'skippedDirs', allowed: ReadonlySet<string>): string[] | undefined => {
    if (!Array.isArray(data[key])) return undefined;
    const out: string[] = [];
    for (const dir of data[key]) {
      if (typeof dir === 'string' && allowed.has(dir)) {
        if (!out.includes(dir)) out.push(dir);
      } else {
        warnings.push(`Ignored suspicious directory "${String(dir)}" in the install manifest.`);
      }
    }
    return out;
  };
  const createdDirs = dirList('createdDirs', AGENT_CONFIG_DIRS);
  const skippedDirs = dirList('skippedDirs', SKILLS_DIRS);
  const manifest: Manifest = {
    version: 1,
    flow: typeof data['flow'] === 'string' ? data['flow'] : undefined,
    agents: manifestAgents(data['agents']),
    skills,
    mcp,
  };
  if (rendered !== undefined) manifest.rendered = rendered;
  if (createdDirs !== undefined) manifest.createdDirs = createdDirs;
  if (skippedDirs !== undefined && skippedDirs.length > 0) manifest.skippedDirs = skippedDirs;
  if (typeof data['fingerprint'] === 'string') manifest.fingerprint = data['fingerprint'];
  if (typeof data['dflVersion'] === 'string') manifest.dflVersion = data['dflVersion'];
  if (data['uninstalled'] === true) manifest.uninstalled = true;
  return { manifest, warnings };
}

/**
 * Writes `.df/installed.json`. `createdDirs` keeps only the dirs that still exist (a dir dfl removed,
 * or someone else did, is no longer dfl's once it is created again by someone else).
 */
export function writeManifest(paths: ProjectPaths, manifest: Manifest): void {
  const createdDirs =
    manifest.createdDirs === undefined
      ? undefined
      : [...new Set(manifest.createdDirs)].filter((dir) => isRealDir(absPath(paths.root, dir))).sort(compare);
  writeJson(paths.manifestFile, {
    version: 1,
    ...(manifest.flow !== undefined ? { flow: manifest.flow } : {}),
    agents: manifest.agents,
    skills: manifest.skills,
    mcp: manifest.mcp,
    ...(manifest.rendered !== undefined ? { rendered: manifest.rendered } : {}),
    ...(createdDirs !== undefined ? { createdDirs } : {}),
    ...(manifest.skippedDirs !== undefined && manifest.skippedDirs.length > 0 ? { skippedDirs: manifest.skippedDirs } : {}),
    ...(manifest.dflVersion !== undefined ? { dflVersion: manifest.dflVersion } : {}),
    ...(manifest.fingerprint !== undefined ? { fingerprint: manifest.fingerprint } : {}),
    ...(manifest.uninstalled === true ? { uninstalled: true } : {}),
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

/** True when `rel` equals one of `bases` or lies below one of them. */
function isUnder(rel: string, bases: readonly string[]): boolean {
  return bases.some((base) => rel === base || rel.startsWith(`${base}/`));
}

/** A skill dir dfl may manage: exactly `<known adapter skillsDir>/<valid skill id>`. */
function isAllowedSkillDir(dir: string): boolean {
  if (dir.includes('\\') || path.isAbsolute(dir)) return false;
  const slash = dir.lastIndexOf('/');
  if (slash <= 0) return false;
  return AGENTS.some((adapter) => adapter.skillsDir === dir.slice(0, slash)) && isValidId(dir.slice(slash + 1));
}

/** Every agent skills dir (`.claude/skills`, `.agents/skills`, …). */
const SKILLS_DIRS: ReadonlySet<string> = new Set(AGENTS.map((adapter) => adapter.skillsDir));

/**
 * Dirs dfl may create on the way to a skills dir or an MCP config file (`.claude`, `.claude/skills`,
 * `.kiro`, `.kiro/settings`, …): the only values accepted in the manifest's `createdDirs`.
 */
const AGENT_CONFIG_DIRS: ReadonlySet<string> = new Set(
  AGENTS.flatMap((adapter) => [adapter.skillsDir, ...(adapter.mcp ? [path.posix.dirname(adapter.mcp.file)] : [])]).flatMap(
    (dir) => ancestorsOf(dir),
  ),
);

/** `a/b/c` → `a`, `a/b`, `a/b/c` (nothing for `.`). */
function ancestorsOf(relDir: string): string[] {
  const parts = relDir.split('/').filter((part) => part !== '' && part !== '.');
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** The dirs of `ancestorsOf(relDir)` that do not exist yet (dfl is about to create them). */
function missingDirs(root: string, relDir: string): string[] {
  return ancestorsOf(relDir).filter((rel) => lstatOrUndefined(absPath(root, rel)) === undefined);
}

/** A real directory (not a symlink to one). */
function isRealDir(p: string): boolean {
  return lstatOrUndefined(p)?.isDirectory() === true;
}

/** Relative file path inside a skill dir that is safe to write or delete: no absolute paths, `.` or `..` segments. */
function isSafeRelFile(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || path.isAbsolute(rel) || rel.includes('\\')) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
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

/** mcpManual note for clients that start MCP servers outside the project (per-project npx entry cannot start there). */
function cwdCaveat(adapter: AgentAdapter, root: string): string {
  return (
    `${adapter.name}: the project entry \`npx --no-install dfl mcp\` only starts when the client runs it inside the project. ` +
    'Clients that start MCP servers elsewhere (e.g. the Antigravity Desktop app, or servers from the global ' +
    `~/.gemini/config/mcp_config.json) need a global install (\`npm i -g ${PACKAGE_NAME}\`, entry \`dfl mcp\`) or, in your ` +
    `personal global config, \`npx --prefix ${root} --no-install dfl mcp --root ${root}\`.`
  );
}

/** Warning for a `dfl mcp` entry when no `dfl` executable is on PATH (agents could not start the server). */
function dflNotOnPathWarning(root: string): string {
  let prefix: string | undefined;
  try {
    prefix = localInstallPrefix(root);
  } catch {
    prefix = undefined;
  }
  const fix =
    prefix === undefined
      ? `Install dfl globally (\`npm i -g ${PACKAGE_NAME}\`), add "${PACKAGE_NAME}" to the devDependencies in package.json, or set "mcp" in .df/config.json`
      : prefix === ''
        ? `Add "${PACKAGE_NAME}" to the devDependencies in package.json (dfl then registers \`npx --no-install dfl mcp\`)`
        : `dfl is installed in ${prefix}/: set "mcp": {"command": "npx", "args": ["--no-install", "--prefix", "${prefix}", "dfl", "mcp"]} in .df/config.json`;
  return `\`dfl\` is not on PATH, so agents cannot start the MCP server (\`dfl mcp\`). ${fix}, then run \`dfl flow-update\`.`;
}

// ---------------------------------------------------------------------------
// Skill dirs
// ---------------------------------------------------------------------------

/**
 * Who owns an existing skill dir:
 * - `free`: missing or empty;
 * - `dfl`: its SKILL.md carries `dfl-*` metadata, or it has no SKILL.md but dfl's `.gitignore` marker;
 * - `user`: its SKILL.md has no dfl metadata (a skill the user wrote or put in place of dfl's), or it is
 *   not a plain directory; never overwritten or deleted;
 * - `foreign`: a non-empty dir with neither SKILL.md nor the marker (e.g. files left after dfl removed
 *   its own); dfl may add files that do not exist yet, but never deletes it.
 */
function skillDirOwner(absDir: string): 'free' | 'dfl' | 'user' | 'foreign' {
  const stat = lstatOrUndefined(absDir);
  if (!stat) return 'free';
  if (!stat.isDirectory()) return 'user';
  const skillFile = path.join(absDir, SKILL_FILE);
  const skillStat = lstatOrUndefined(skillFile);
  if (skillStat) return skillStat.isFile() && hasDflMetadata(fs.readFileSync(skillFile, 'utf8')) ? 'dfl' : 'user';
  if (hasSkillMarker(absDir)) return 'dfl';
  // OS junk (.DS_Store, Thumbs.db) does not make a dir someone else's.
  return fs.readdirSync(absDir).every((name) => isDisposableFile(path.join(absDir, name))) ? 'free' : 'foreign';
}

/** OS junk files (.DS_Store, Thumbs.db) that never count as user content and are deleted with an emptied skill dir. */
function isDisposableFile(abs: string): boolean {
  return DISPOSABLE_FILES.has(path.basename(abs)) && lstatOrUndefined(abs)?.isFile() === true;
}

/** True when the dir holds dfl's `.gitignore` marker (a regular file starting with dfl's comment). */
function hasSkillMarker(absDir: string): boolean {
  const file = path.join(absDir, SKILL_GITIGNORE_FILE);
  if (!lstatOrUndefined(file)?.isFile()) return false;
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').startsWith(SKILL_MARKER_FIRST_LINE);
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

type TargetCheck = { kind: 'ok' } | { kind: 'link'; link: string } | { kind: 'user'; reason: string };

/**
 * Whether dfl may write `files` (plus the marker) into `absDir`: no symlink on the way, the dir is
 * free or dfl's (a `foreign` dir only when none of the files exist yet, unless dfl wrote them before),
 * and every existing destination is a regular file.
 */
function checkSkillTarget(root: string, absDir: string, files: RenderedFile[], before: SkillManifestEntry | undefined): TargetCheck {
  const link = firstSymlinkBetween(root, absDir);
  if (link) return { kind: 'link', link };
  const owner = skillDirOwner(absDir);
  if (owner === 'user') return { kind: 'user', reason: 'it holds a skill dfl did not install' };
  if (owner === 'free') return { kind: 'ok' };
  const known = new Set(before?.files ?? []);
  for (const rel of [...files.map((file) => file.path), SKILL_GITIGNORE_FILE]) {
    const dest = path.join(absDir, ...rel.split('/'));
    const inner = firstSymlinkBetween(absDir, dest);
    if (inner) return { kind: 'link', link: inner };
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { kind: 'user', reason: `${rel} cannot be written (${errorMessage(error)})` };
    }
    if (!stat.isFile()) return { kind: 'user', reason: `${rel} is not a regular file` };
    if (owner === 'foreign' && !known.has(rel)) return { kind: 'user', reason: `it already holds ${rel}, which dfl did not write` };
  }
  return { kind: 'ok' };
}

/**
 * Writes `data` to `dest` without following symlinks: a temp file created with O_EXCL, then renamed
 * over the destination. `mode` (permission bits) is applied exactly when given. Returns true if changed.
 */
function writeFileSafely(dest: string, data: Buffer, mode?: number): boolean {
  const stat = lstatOrUndefined(dest);
  if (stat?.isFile() && fs.readFileSync(dest).equals(data)) {
    if (mode === undefined || (stat.mode & 0o777) === mode) return false;
    fs.chmodSync(dest, mode);
    return true;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx', mode: mode ?? 0o666 });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, dest);
  } finally {
    if (lstatOrUndefined(tmp)) fs.rmSync(tmp, { force: true });
  }
  return true;
}

/**
 * Writes a rendered skill (plus dfl's `.gitignore` marker) into `absDir` and deletes files dfl wrote
 * there before but no longer produces. The caller checked the target with checkSkillTarget. Returns warnings.
 */
function writeSkill(root: string, absDir: string, files: RenderedFile[], previousFiles: string[]): string[] {
  const warnings: string[] = [];
  fs.mkdirSync(absDir, { recursive: true });
  writeFileSafely(path.join(absDir, SKILL_GITIGNORE_FILE), Buffer.from(SKILL_DIR_GITIGNORE_CONTENT, 'utf8'));
  const current = new Set<string>([SKILL_GITIGNORE_FILE]);
  for (const file of files) {
    current.add(file.path);
    const dest = path.join(absDir, ...file.path.split('/'));
    if (file.content !== undefined) writeFileSafely(dest, Buffer.from(file.content, 'utf8'));
    else if (file.sourcePath !== undefined) writeFileSafely(dest, fs.readFileSync(file.sourcePath), fs.statSync(file.sourcePath).mode & 0o777);
  }
  for (const rel of previousFiles) {
    if (current.has(rel) || !isSafeRelFile(rel)) continue;
    const abs = path.join(absDir, ...rel.split('/'));
    const link = firstSymlinkBetween(absDir, abs);
    if (link) {
      warnings.push(`Left ${toRel(root, link)} alone: it is a symbolic link, and dfl never writes or deletes through symlinks.`);
      continue;
    }
    if (!lstatOrUndefined(abs)?.isFile()) continue;
    fs.unlinkSync(abs);
    removeEmptyDirsUpTo(path.dirname(abs), absDir);
  }
  return warnings;
}

/**
 * Removes the files dfl wrote into a manifest skill dir (the manifest's `files`, SKILL.md for older
 * manifests without files, and the marker), then the dir and emptied parents once nothing else is left.
 * A dir that still holds other files is kept with a warning; a user-authored skill is never touched.
 */
function removeSkillDir(
  root: string,
  entry: SkillManifestEntry,
  dryRun: boolean,
  keep: ReadonlySet<string>,
  createdDirs: ReadonlySet<string>,
): { removed: boolean; warning?: string; link?: string } {
  const abs = absPath(root, entry.dir);
  const link = firstSymlinkBetween(root, abs);
  if (link) return { removed: false, link };
  const stat = lstatOrUndefined(abs);
  if (!stat) return { removed: false };
  const owner = skillDirOwner(abs);
  if (owner === 'user' || owner === 'foreign') {
    return {
      removed: false,
      warning: `Kept ${entry.dir}/: it no longer holds a dfl skill (remove it yourself if unwanted).`,
    };
  }
  const listed = entry.files.filter(isSafeRelFile);
  const targets = new Set([...(listed.length > 0 ? listed : [SKILL_FILE]), SKILL_GITIGNORE_FILE]);
  const deletable = [...targets].filter((rel) => {
    const file = path.join(abs, ...rel.split('/'));
    if (firstSymlinkBetween(abs, file) !== undefined || lstatOrUndefined(file)?.isFile() !== true) return false;
    // A .gitignore the user put there instead of dfl's marker stays.
    return rel !== SKILL_GITIGNORE_FILE || hasSkillMarker(abs);
  });
  const deletableSet = new Set(deletable);
  const leftovers = listTree(abs)
    .filter(
      (item) =>
        item.kind !== 'dir' && !deletableSet.has(item.rel) && !(item.kind === 'file' && DISPOSABLE_FILES.has(path.posix.basename(item.rel))),
    )
    .map((item) => item.rel);
  if (!dryRun) {
    for (const rel of deletable) {
      const file = path.join(abs, ...rel.split('/'));
      fs.unlinkSync(file);
      removeEmptyDirsUpTo(path.dirname(file), abs);
    }
    if (leftovers.length === 0) {
      // Only (empty) directories and OS junk (.DS_Store) are left.
      fs.rmSync(abs, { recursive: true, force: true });
      removeEmptyParents(path.dirname(abs), root, keep, createdDirs);
    }
  }
  if (leftovers.length > 0) {
    const shown = leftovers.slice(0, 3).join(', ') + (leftovers.length > 3 ? `, … (${leftovers.length} files)` : '');
    return {
      removed: false,
      warning:
        `Kept ${entry.dir}/: it holds files dfl did not write (${shown}). dfl removed its own files; ` +
        'the folder is no longer git-ignored – move or delete it yourself.',
    };
  }
  return { removed: true };
}

/**
 * Real paths of the targets of agent skills dirs that are symbolic links (e.g. `.claude/skills ->
 * ../.agents/skills`): such a target is never removed as an emptied parent, or the link would dangle.
 */
function skillsDirLinkTargets(root: string): Set<string> {
  const targets = new Set<string>();
  for (const dir of new Set(AGENTS.map((adapter) => adapter.skillsDir))) {
    const abs = absPath(root, dir);
    if (!lstatOrUndefined(abs)?.isSymbolicLink()) continue;
    try {
      targets.add(fs.realpathSync.native(abs));
    } catch {
      // dangling link: nothing to protect
    }
  }
  return targets;
}

/**
 * Removes `dir` and its empty ancestors below `root`, stopping at non-directories, at `keep` (real
 * paths) and at every dir dfl did not create (`createdDirs`, project-relative: e.g. a `.kiro/` that
 * existed before `dfl install` stays, also when empty).
 */
function removeEmptyParents(dir: string, root: string, keep: ReadonlySet<string>, createdDirs: ReadonlySet<string>): void {
  let current = path.resolve(dir);
  const stop = path.resolve(root);
  while (current.startsWith(stop + path.sep)) {
    if (!createdDirs.has(toRel(stop, current))) return;
    if (keep.has(realpathOrSelf(current)) || !lstatOrUndefined(current)?.isDirectory()) return;
    try {
      // OS junk (.DS_Store) does not keep a dir dfl created.
      const entries = fs.readdirSync(current);
      if (!entries.every((name) => DISPOSABLE_FILES.has(name) && lstatOrUndefined(path.join(current, name))?.isFile() === true)) return;
      for (const name of entries) fs.unlinkSync(path.join(current, name));
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** The lines older dfl versions wrote into the root `.gitignore` block: the manifest's skill dirs. */
function legacyGitignoreLines(manifest: Manifest): string[] {
  return manifest.skills.map((entry) => `${entry.dir}/`);
}

/** New manifest `rendered` list: this sync's outputs plus earlier entries of other flows that still exist. */
function mergeRendered(paths: ProjectPaths, previous: readonly string[], flow: string, current: readonly string[]): string[] {
  const own = `.df/${flow}/`;
  const kept = previous.filter((rel) => {
    if (rel.startsWith(own)) return false;
    const name = rel.split('/')[1]!;
    return flowExists(paths, name) && exists(absPath(paths.root, rel));
  });
  return [...new Set([...kept, ...current])].sort(compare);
}

/** renderFlow without touching `.df/`: renders a temporary copy of the flow directory. */
function renderFlowDry(
  paths: ProjectPaths,
  model: FlowModel,
  vars: Record<string, unknown>,
  options: RenderFlowOptions,
): RenderFlowResult {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dfl-dry-run-'));
  try {
    const dir = path.join(tmp, model.name);
    copyDir(model.dir, dir);
    return renderFlow(paths, buildFlowModel(model.def, dir), vars, options);
  } finally {
    removePath(tmp);
  }
}
