import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { getMcpEnabled, loadLocalConfig, loadProjectConfig, saveProjectConfig, setActiveFlow, setMcpEnabled } from '../src/core/config.js';
import { DflError } from '../src/core/errors.js';
import { createFlow, writeFlowDefinition } from '../src/core/flow.js';
import { DF_GITIGNORE_CONTENT, SKILL_DIR_GITIGNORE_CONTENT } from '../src/core/gitignore.js';
import { packageVersion } from '../src/core/paths.js';
import {
  NOT_INSTALLED_MESSAGE,
  checkSyncState,
  computeSyncFingerprint,
  isInstalledForUser,
  loadManifest,
  readManifest,
  syncProject,
  uninstallProject,
  writeManifest,
} from '../src/core/sync.js';
import { AGENT_IDS, type FlowDefinition, type FlowVarDef, type ProjectPaths } from '../src/core/types.js';
import { setVar } from '../src/core/vars.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

afterEach(cleanupTempDirs);

const abs = (paths: ProjectPaths, rel: string): string => path.join(paths.root, ...rel.split('/'));
const has = (paths: ProjectPaths, rel: string): boolean => fs.existsSync(abs(paths, rel));
const read = (paths: ProjectPaths, rel: string): string => fs.readFileSync(abs(paths, rel), 'utf8');

function write(paths: ProjectPaths, rel: string, content: string): void {
  const file = abs(paths, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readConfig(paths: ProjectPaths, rel: string): Record<string, any> {
  const text = read(paths, rel);
  return (rel.endsWith('.toml') ? parseToml(text) : parseJsonc(text)) as Record<string, any>;
}

/** Parsed frontmatter and body of a SKILL.md. */
function splitSkill(text: string): { data: Record<string, any>; body: string } {
  const match = /^---\n([\s\S]*?)---\n\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`no frontmatter in:\n${text}`);
  return { data: parseYaml(match[1]!) as Record<string, any>, body: match[2]! };
}

/** True when the skill dir holds dfl's self-ignoring `.gitignore` marker. */
function hasMarker(paths: ProjectPaths, dir: string): boolean {
  return has(paths, `${dir}/.gitignore`) && read(paths, `${dir}/.gitignore`) === SKILL_DIR_GITIGNORE_CONTENT;
}

const symlinks = process.platform !== 'win32';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(paths: ProjectPaths, ...args: string[]): string {
  return execFileSync('git', args, { cwd: paths.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Runs `fn` with PATH pointing at an empty dir (no `dfl` executable). */
async function withoutDflOnPath<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env['PATH'];
  process.env['PATH'] = makeTempDir();
  try {
    return await fn();
  } finally {
    process.env['PATH'] = saved;
  }
}

/** Every file and directory under the project with file contents (for "nothing written" checks). */
function snapshot(paths: ProjectPaths): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(paths.root, { recursive: true, encoding: 'utf8' }).sort()) {
    const file = path.join(paths.root, rel);
    out[rel] = fs.statSync(file).isDirectory() ? '<dir>' : fs.readFileSync(file, 'utf8');
  }
  return out;
}

/** A project with the sample flow (plan → build → review → done) and its required var set. */
function sampleProject(): ProjectPaths {
  const paths = makeTempProject();
  writeSampleFlow(paths);
  setVar(paths, 'reviewer', 'octocat', 'personal');
  return paths;
}

/** The sample flow without the `build` step. */
function withoutBuild(): FlowDefinition {
  const def = sampleFlowDefinition();
  const { build: _, ...states } = def.machine.states;
  states['plan'] = { ...states['plan'], on: { NEXT: 'review' } };
  states['review'] = { ...states['review'], on: { NEXT: 'done', CHANGES_REQUESTED: 'plan' } };
  return { ...def, machine: { ...def.machine, states } };
}

const BUILTINS = ['add-flow-step', 'delete-flow-step', 'edit-flow-step'];

describe('syncProject', () => {
  it('installs step and built-in skills, ignore markers, MCP entries and manifest for claude, cursor and codex', async () => {
    const paths = sampleProject();
    const report = await syncProject(paths, { agents: ['codex', 'claude', 'cursor', 'claude'] });

    expect(report.flow).toBe('sample');
    expect(report.agents).toEqual(['claude', 'cursor', 'codex']);
    expect(loadLocalConfig(paths).agents).toEqual(['claude', 'cursor', 'codex']);
    expect(report.removed).toEqual([]);
    expect(report.warnings.join('\n')).not.toMatch(/reviewer|No agents/);

    const plan = splitSkill(read(paths, '.claude/skills/plan/SKILL.md'));
    expect(plan.data).toEqual({
      name: 'plan',
      description: 'Plan the work',
      metadata: { 'dfl-flow': 'sample', 'dfl-step': 'plan' },
    });
    expect(plan.body).toContain('# Plan');
    for (const dir of ['.agents/skills', '.cursor/skills']) {
      expect(read(paths, `${dir}/plan/SKILL.md`)).toBe(read(paths, '.claude/skills/plan/SKILL.md'));
    }
    // Rendered copy inside .df, no skill for the final state.
    expect(read(paths, '.df/sample/steps/plan/SKILL.md')).toBe(read(paths, '.claude/skills/plan/SKILL.md'));
    expect(has(paths, '.claude/skills/done')).toBe(false);

    const builtin = splitSkill(read(paths, '.claude/skills/add-flow-step/SKILL.md'));
    expect(builtin.data['name']).toBe('add-flow-step');
    expect(builtin.data['metadata']).toEqual({ 'dfl-builtin': 'true' });

    const skillNames = ['plan', 'build', 'review', ...BUILTINS];
    const dirs = ['.claude/skills', '.cursor/skills', '.agents/skills'].flatMap((dir) => skillNames.map((name) => `${dir}/${name}`));
    expect(report.skills.map((skill) => skill.dir)).toEqual(dirs);
    expect(report.skills.find((skill) => skill.dir === '.agents/skills/plan')).toEqual({
      name: 'plan',
      dir: '.agents/skills/plan',
      agents: ['codex'],
      kind: 'step',
    });
    expect(report.skills.find((skill) => skill.dir === '.claude/skills/edit-flow-step')?.kind).toBe('builtin');

    const stdio = { type: 'stdio', command: 'dfl', args: ['mcp'] };
    expect(readConfig(paths, '.mcp.json')['mcpServers']['dfl']).toEqual(stdio);
    expect(readConfig(paths, '.cursor/mcp.json')['mcpServers']['dfl']).toEqual(stdio);
    expect(readConfig(paths, '.codex/config.toml')['mcp_servers']['dfl']).toEqual({ command: 'dfl', args: ['mcp'] });
    expect(report.mcp).toEqual([
      { file: '.mcp.json', agents: ['claude'], changed: true, status: 'added' },
      { file: '.cursor/mcp.json', agents: ['cursor'], changed: true, status: 'added' },
      { file: '.codex/config.toml', agents: ['codex'], changed: true, status: 'added' },
    ]);
    expect(report.mcpManual).toEqual([]);

    // Every skill dir ignores itself; the committed root .gitignore is never written (F11/F41).
    for (const dir of dirs) expect(hasMarker(paths, dir)).toBe(true);
    expect(has(paths, '.gitignore')).toBe(false);
    expect(read(paths, '.df/.gitignore')).toBe(DF_GITIGNORE_CONTENT);

    const manifest = readManifest(paths);
    expect(manifest.flow).toBe('sample');
    expect(manifest.agents).toEqual(['claude', 'cursor', 'codex']);
    expect(manifest.skills.map((entry) => entry.dir)).toEqual(dirs);
    expect(manifest.skills[0]).toEqual({ agents: ['claude'], name: 'plan', dir: '.claude/skills/plan', files: ['SKILL.md'] });
    const created = { server: 'dfl', createdFile: true, createdContainer: true };
    expect(manifest.mcp).toEqual([
      { agents: ['claude'], file: '.mcp.json', ...created },
      { agents: ['cursor'], file: '.cursor/mcp.json', ...created },
      // TOML has no servers container to drop.
      { agents: ['codex'], file: '.codex/config.toml', ...created, createdContainer: false },
    ]);
    expect(manifest.rendered).toEqual([
      '.df/sample/steps/build/SKILL.md',
      '.df/sample/steps/plan/SKILL.md',
      '.df/sample/steps/review/SKILL.md',
    ]);
    expect(manifest.dflVersion).toBe(packageVersion());
    expect(manifest.fingerprint).toBe(computeSyncFingerprint(paths));
  });

  it('installs a prebuilt flow template for every supported agent', async () => {
    const paths = makeTempProject();
    createFlow(paths, 'feature', { from: 'feature' });
    const report = await syncProject(paths, { agents: [...AGENT_IDS] });
    const dirs = new Set(report.skills.map((skill) => skill.dir.split('/').slice(0, -1).join('/')));
    expect([...dirs]).toEqual([
      '.claude/skills',
      '.cursor/skills',
      '.agents/skills',
      '.gemini/skills',
      '.github/skills',
      '.devin/skills',
      '.opencode/skills',
      '.kiro/skills',
    ]);
    for (const dir of dirs) expect(has(paths, `${dir}/plan-feature/SKILL.md`)).toBe(true);
    expect(report.mcp.map((entry) => entry.file)).toEqual([
      '.mcp.json',
      '.cursor/mcp.json',
      '.agents/mcp_config.json',
      '.codex/config.toml',
      '.gemini/settings.json',
      '.devin/mcp_config.json',
      'opencode.json',
      '.kiro/settings/mcp.json',
    ]);
    uninstallProject(paths);
    expect(fs.readdirSync(paths.root).sort()).toEqual(['.df']);
  });

  it('is idempotent and uses the persisted agent selection', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude', 'codex'] });
    const before = snapshot(paths);
    const report = await syncProject(paths);
    expect(report.agents).toEqual(['claude', 'codex']);
    expect(report.mcp.map((entry) => entry.status)).toEqual(['unchanged', 'unchanged']);
    expect(report.removed).toEqual([]);
    expect(snapshot(paths)).toEqual(before);
  });

  it('shares one skills dir / MCP file between agents that use the same one', async () => {
    const paths = sampleProject();
    const report = await syncProject(paths, { agents: ['antigravity', 'codex', 'claude', 'copilot'] });
    expect(report.skills.filter((skill) => skill.dir === '.agents/skills/plan')).toEqual([
      { name: 'plan', dir: '.agents/skills/plan', agents: ['antigravity', 'codex'], kind: 'step' },
    ]);
    expect(report.mcp.find((entry) => entry.file === '.mcp.json')?.agents).toEqual(['claude', 'copilot']);
    expect(readConfig(paths, '.agents/mcp_config.json')['mcpServers']['dfl']).toEqual({ command: 'dfl', args: ['mcp'] });
  });

  it('copies static files and extra templates and removes files it no longer produces', async () => {
    const paths = sampleProject();
    write(paths, '.df/sample/steps/build/scripts/check.sh', '#!/bin/sh\necho ok\n');
    fs.chmodSync(abs(paths, '.df/sample/steps/build/scripts/check.sh'), 0o755);
    write(paths, '.df/sample/steps/build/reference.md.hbs', 'Target branch: {{vars.mainBranch}}\n');
    await syncProject(paths, { agents: ['claude'] });

    expect(read(paths, '.claude/skills/build/reference.md')).toBe('Target branch: main\n');
    expect(read(paths, '.claude/skills/build/scripts/check.sh')).toBe('#!/bin/sh\necho ok\n');
    expect(fs.statSync(abs(paths, '.claude/skills/build/scripts/check.sh')).mode & 0o111).not.toBe(0);
    expect(readManifest(paths).skills.find((entry) => entry.name === 'build')?.files).toEqual([
      'SKILL.md',
      'reference.md',
      'scripts/check.sh',
    ]);

    write(paths, '.claude/skills/build/notes.txt', 'my notes');
    fs.rmSync(abs(paths, '.df/sample/steps/build/scripts'), { recursive: true });
    fs.rmSync(abs(paths, '.df/sample/steps/build/reference.md.hbs'));
    await syncProject(paths);

    expect(has(paths, '.claude/skills/build/SKILL.md')).toBe(true);
    expect(has(paths, '.claude/skills/build/reference.md')).toBe(false);
    expect(has(paths, '.claude/skills/build/scripts')).toBe(false);
    expect(read(paths, '.claude/skills/build/notes.txt')).toBe('my notes');
    expect(readManifest(paths).skills.find((entry) => entry.name === 'build')?.files).toEqual(['SKILL.md']);
  });

  it('removes skill dirs of deleted steps and of the previous flow after switching flows', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude', 'codex'] });

    writeFlowDefinition(paths, withoutBuild());
    fs.rmSync(paths.stepDir('sample', 'build'), { recursive: true });
    const afterRemove = await syncProject(paths);
    expect(afterRemove.removed).toEqual(['.agents/skills/build', '.claude/skills/build']);
    expect(has(paths, '.claude/skills/build')).toBe(false);
    expect(has(paths, '.agents/skills/build')).toBe(false);
    expect(has(paths, '.claude/skills/plan/SKILL.md')).toBe(true);

    createFlow(paths, 'other', { steps: ['alpha', 'beta'] });
    setActiveFlow(paths, 'other');
    const afterSwitch = await syncProject(paths);
    expect(afterSwitch.flow).toBe('other');
    expect(afterSwitch.removed).toEqual([
      '.agents/skills/plan',
      '.agents/skills/review',
      '.claude/skills/plan',
      '.claude/skills/review',
    ]);
    expect(splitSkill(read(paths, '.claude/skills/alpha/SKILL.md')).data['metadata']).toEqual({
      'dfl-flow': 'other',
      'dfl-step': 'alpha',
    });
    for (const name of BUILTINS) expect(has(paths, `.claude/skills/${name}/SKILL.md`)).toBe(true);
    expect(readManifest(paths).flow).toBe('other');
    expect(hasMarker(paths, '.claude/skills/alpha')).toBe(true);
    expect(has(paths, '.claude/skills/plan')).toBe(false);
    expect(has(paths, '.gitignore')).toBe(false);
  });

  it('removes skills of deselected agents but keeps their MCP entries (committed team config, F42)', async () => {
    const paths = sampleProject();
    write(paths, '.cursor/rules/keep.mdc', 'user rule');
    await syncProject(paths, { agents: ['claude', 'cursor', 'copilot'] });
    expect(readConfig(paths, '.mcp.json')['mcpServers']['dfl']).toBeDefined();
    const cursorConfig = read(paths, '.cursor/mcp.json');

    const report = await syncProject(paths, { agents: ['claude'] });
    expect(report.removed).toContain('.cursor/skills/plan');
    expect(report.removed).toContain('.github/skills/add-flow-step');
    expect(has(paths, '.cursor/skills')).toBe(false);
    expect(has(paths, '.github')).toBe(false);
    expect(read(paths, '.cursor/rules/keep.mdc')).toBe('user rule');
    expect(read(paths, '.cursor/mcp.json')).toBe(cursorConfig);
    expect(report.mcp.map((entry) => entry.file)).toEqual(['.mcp.json']);
    expect(readConfig(paths, '.mcp.json')['mcpServers']['dfl']).toBeDefined();
    // Still tracked, so `dfl uninstall` removes them.
    expect(readManifest(paths).mcp.map((entry) => entry.file)).toEqual(['.mcp.json', '.cursor/mcp.json']);

    const none = await syncProject(paths, { agents: [] });
    expect(none.warnings.join('\n')).toMatch(/no agents selected/i);
    expect(has(paths, '.claude')).toBe(false);
    expect(has(paths, '.mcp.json')).toBe(true);
    expect(has(paths, '.gitignore')).toBe(false);
    expect(readManifest(paths)).toMatchObject({ agents: [], skills: [] });

    uninstallProject(paths);
    expect(has(paths, '.mcp.json')).toBe(false);
    expect(has(paths, '.cursor/mcp.json')).toBe(false);
    expect(read(paths, '.cursor/rules/keep.mdc')).toBe('user rule');
  });

  it('keeps a committed MCP entry a teammate wrote when this developer drops the agent (F42)', async () => {
    const paths = sampleProject();
    const team = '{\n  "mcpServers": {\n    "dfl": { "type": "stdio", "command": "dfl", "args": ["mcp"] }\n  }\n}\n';
    write(paths, '.cursor/mcp.json', team);
    const first = await syncProject(paths, { agents: ['claude', 'cursor'] });
    expect(first.mcp.find((entry) => entry.file === '.cursor/mcp.json')?.status).toBe('unchanged');
    expect(readManifest(paths).mcp.find((entry) => entry.file === '.cursor/mcp.json')).toMatchObject({
      createdFile: false,
      createdContainer: false,
    });
    const report = await syncProject(paths, { agents: ['claude'] });
    expect(read(paths, '.cursor/mcp.json')).toBe(team);
    expect(report.mcp.map((entry) => entry.file)).toEqual(['.mcp.json']);
  });

  it('keeps unrelated MCP servers and never touches the root .gitignore', async () => {
    const paths = sampleProject();
    write(paths, '.mcp.json', '{\n  // mine\n  "mcpServers": { "other": { "command": "other" } }\n}\n');
    write(paths, '.gitignore', 'node_modules/\n');
    await syncProject(paths, { agents: ['claude'] });
    const config = readConfig(paths, '.mcp.json');
    expect(config['mcpServers']['other']).toEqual({ command: 'other' });
    expect(config['mcpServers']['dfl']).toBeDefined();
    expect(read(paths, '.mcp.json')).toContain('// mine');
    expect(read(paths, '.gitignore')).toBe('node_modules/\n');
  });

  it('never overwrites or deletes a user-authored skill with the same name', async () => {
    const paths = sampleProject();
    const mine = '---\nname: plan\ndescription: My own planning skill\n---\n\nMine.\n';
    write(paths, '.claude/skills/plan/SKILL.md', mine);
    // A dfl skill left behind without a manifest entry (e.g. deleted installed.json) is adopted.
    write(paths, '.claude/skills/build/SKILL.md', '---\nname: build\nmetadata:\n  dfl-flow: sample\n---\nold\n');

    const report = await syncProject(paths, { agents: ['claude', 'cursor'] });
    expect(read(paths, '.claude/skills/plan/SKILL.md')).toBe(mine);
    expect(report.warnings.some((w) => w.includes('.claude/skills/plan/'))).toBe(true);
    expect(report.skills.map((skill) => skill.dir)).not.toContain('.claude/skills/plan');
    expect(report.skills.map((skill) => skill.dir)).toContain('.cursor/skills/plan');
    expect(readManifest(paths).skills.map((entry) => entry.dir)).not.toContain('.claude/skills/plan');
    expect(has(paths, '.claude/skills/plan/.gitignore')).toBe(false);
    expect(read(paths, '.claude/skills/build/SKILL.md')).toContain('# Build');

    // A dir dfl installed that the user replaced with their own skill is kept as well.
    write(paths, '.cursor/skills/review/SKILL.md', '---\nname: review\n---\nMy review.\n');
    writeFlowDefinition(paths, { ...sampleFlowDefinition(), skillPrefix: 'x-' });
    const renamed = await syncProject(paths);
    expect(read(paths, '.cursor/skills/review/SKILL.md')).toContain('My review.');
    expect(renamed.removed).not.toContain('.cursor/skills/review');
    expect(renamed.removed).toContain('.cursor/skills/plan');
    expect(renamed.warnings.some((w) => w.includes('.cursor/skills/review/'))).toBe(true);

    uninstallProject(paths);
    expect(read(paths, '.claude/skills/plan/SKILL.md')).toBe(mine);
    expect(has(paths, '.claude/skills/x-plan')).toBe(false);
  });

  it('ignores manifest entries that are not `<agent skills dir>/<id>` (F23, F24)', async () => {
    const paths = sampleProject();
    write(paths, 'outside/SKILL.md', 'keep');
    write(paths, 'src/index.ts', 'export {};');
    write(paths, 'node_modules/x/index.js', '');
    write(paths, '.claude/skills/mine/SKILL.md', '---\nname: mine\n---\nMine.\n');
    write(paths, '.claude/skills/a/b/SKILL.md', 'nested');
    const bogus = ['../outside', '.df/sample', 'src', 'node_modules', '.claude/skills', '.claude/skills/a/b', '/etc', '.claude/skills/Bad'];
    writeManifest(paths, {
      version: 1,
      agents: ['claude'],
      skills: bogus.map((dir) => ({ agents: ['claude' as const], name: 'x', dir, files: ['SKILL.md', 'index.ts'] })),
      mcp: [],
    });
    expect(loadManifest(paths).manifest.skills).toEqual([]);
    const report = await syncProject(paths, { agents: ['claude'] });
    expect(report.removed).toEqual([]);
    expect(report.warnings.filter((w) => w.includes('suspicious'))).toHaveLength(bogus.length);
    expect(has(paths, '.df/sample/flow.json')).toBe(true);
    expect(has(paths, 'outside/SKILL.md')).toBe(true);
    expect(has(paths, 'src/index.ts')).toBe(true);

    writeManifest(paths, {
      version: 1,
      agents: ['claude'],
      skills: bogus.map((dir) => ({ agents: ['claude' as const], name: 'x', dir, files: [] })),
      mcp: [],
    });
    uninstallProject(paths);
    expect(has(paths, 'src/index.ts')).toBe(true);
    expect(has(paths, 'node_modules/x/index.js')).toBe(true);
    expect(read(paths, '.claude/skills/mine/SKILL.md')).toContain('Mine.');
    expect(has(paths, '.claude/skills/a/b/SKILL.md')).toBe(true);
  });

  it('keeps a manifest skill dir without SKILL.md or marker that holds other files (F24)', async () => {
    const paths = sampleProject();
    write(paths, '.claude/skills/old/notes.md', 'mine');
    writeManifest(paths, {
      version: 1,
      agents: ['claude'],
      skills: [{ agents: ['claude'], name: 'old', dir: '.claude/skills/old', files: ['SKILL.md'] }],
      mcp: [],
    });
    const report = await syncProject(paths, { agents: ['claude'] });
    expect(report.removed).not.toContain('.claude/skills/old');
    expect(report.warnings.some((w) => w.startsWith('Kept .claude/skills/old/'))).toBe(true);
    expect(read(paths, '.claude/skills/old/notes.md')).toBe('mine');

    // Positive control: a stale dfl skill listed in files is removed.
    write(paths, '.claude/skills/gone/SKILL.md', '---\nname: gone\nmetadata:\n  dfl-flow: sample\n---\nx\n');
    writeManifest(paths, {
      ...readManifest(paths),
      skills: [...readManifest(paths).skills, { agents: ['claude'], name: 'gone', dir: '.claude/skills/gone', files: ['SKILL.md'] }],
    });
    const again = await syncProject(paths);
    expect(again.removed).toEqual(['.claude/skills/gone']);
    expect(has(paths, '.claude/skills/gone')).toBe(false);
  });

  it('prompts for missing required vars and stores them in their scope', async () => {
    const paths = makeTempProject();
    const def = sampleFlowDefinition();
    def.vars = { ...def.vars, team: { description: 'Team', required: true } };
    writeSampleFlow(paths, def);
    const promptVar = vi.fn(async (name: string, _def: FlowVarDef) => `${name}-value`);

    const report = await syncProject(paths, { agents: ['claude'], promptVar });
    expect(promptVar.mock.calls.map(([name, varDef]) => [name, varDef.scope])).toEqual([
      ['reviewer', 'personal'],
      ['team', undefined],
    ]);
    expect(loadLocalConfig(paths).vars).toEqual({ reviewer: 'reviewer-value' });
    expect(loadProjectConfig(paths).vars).toEqual({ team: 'team-value' });
    expect(report.warnings.join('\n')).not.toMatch(/Required variable/);

    // Already stored: no prompt the second time.
    await syncProject(paths, { promptVar });
    expect(promptVar).toHaveBeenCalledTimes(2);
  });

  it('warns about missing required vars without a prompt', async () => {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    const skipped = vi.fn(async () => undefined);
    const report = await syncProject(paths, { agents: ['claude'], promptVar: skipped });
    expect(skipped).toHaveBeenCalledOnce();
    expect(report.warnings.filter((w) => /Required variable "reviewer"/.test(w))).toHaveLength(1);
    expect(report.warnings.join('\n')).toContain('--personal');
    expect(has(paths, '.claude/skills/plan/SKILL.md')).toBe(true);
  });

  it('aborts on an invalid flow before writing anything outside .df', async () => {
    const paths = makeTempProject();
    const def = sampleFlowDefinition();
    def.machine.states['plan'] = { ...def.machine.states['plan'], on: { NEXT: 'missing' } };
    writeSampleFlow(paths, def);
    setVar(paths, 'reviewer', 'octocat', 'personal');
    const error = await syncProject(paths, { agents: ['claude'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DflError);
    expect((error as DflError).code).toBe('INVALID_FLOW');
    expect(has(paths, '.claude')).toBe(false);
    expect(has(paths, '.mcp.json')).toBe(false);
    expect(has(paths, '.df/installed.json')).toBe(false);
    expect(loadLocalConfig(paths).agents).toBeUndefined();
  });

  it('fails with a DflError when there is no active flow', async () => {
    const paths = makeTempProject();
    await expect(syncProject(paths, { agents: ['claude'] })).rejects.toMatchObject({ code: 'NO_ACTIVE_FLOW' });
  });

  it('only renders into .df when no agents are selected', async () => {
    const paths = sampleProject();
    const report = await syncProject(paths);
    expect(report.agents).toEqual([]);
    expect(report.skills).toEqual([]);
    expect(report.mcp).toEqual([]);
    expect(report.warnings.join('\n')).toMatch(/no agents selected/i);
    expect(has(paths, '.df/sample/steps/plan/SKILL.md')).toBe(true);
    expect(fs.readdirSync(paths.root).sort()).toEqual(['.df']);
  });

  it('respects the stored MCP preference in later syncs and keeps tracking earlier entries (F17, D5)', async () => {
    const paths = sampleProject();
    // `dfl install --no-mcp` (or answering No) stores the preference; the sync itself does not.
    setMcpEnabled(paths, false);
    expect(getMcpEnabled(paths)).toBe(false);
    const report = await syncProject(paths, { agents: ['claude', 'codex'], mcp: false });
    expect(report.mcp).toEqual([]);
    expect(has(paths, '.mcp.json')).toBe(false);
    expect(readManifest(paths).mcp).toEqual([]);

    // Any later sync without the option (step add, vars set, MCP tools) respects it.
    const later = await syncProject(paths);
    expect(later.mcp).toEqual([]);
    expect(has(paths, '.mcp.json')).toBe(false);
    expect(has(paths, '.codex')).toBe(false);

    // An explicit option applies to that run only.
    await syncProject(paths, { mcp: true });
    expect(loadLocalConfig(paths).mcp).toBe(false);
    expect(readConfig(paths, '.mcp.json')['mcpServers']['dfl']).toBeDefined();
    fs.rmSync(abs(paths, '.mcp.json'));
    await syncProject(paths);
    expect(has(paths, '.mcp.json')).toBe(false);
    // Entries written earlier stay tracked, so uninstall still removes them.
    expect(readManifest(paths).mcp.map((entry) => entry.file)).toEqual(['.mcp.json', '.codex/config.toml']);
    uninstallProject(paths);
    expect(has(paths, '.codex')).toBe(false);

    // Opting in again (dfl install / answering Yes) stores true.
    setMcpEnabled(paths, true);
    await syncProject(paths);
    expect(readConfig(paths, '.mcp.json')['mcpServers']['dfl']).toBeDefined();
  });

  it('never stores the MCP preference itself', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude'], mcp: false });
    await syncProject(paths, { agents: ['claude'], mcp: true, dryRun: true });
    expect(loadLocalConfig(paths).mcp).toBeUndefined();
  });

  it('dryRun computes the report without writing anything', async () => {
    const paths = sampleProject();
    const promptVar = vi.fn(async () => 'x');
    fs.rmSync(paths.localFile);
    const before = snapshot(paths);
    const report = await syncProject(paths, { agents: ['claude', 'codex'], dryRun: true, promptVar });
    expect(snapshot(paths)).toEqual(before);
    expect(promptVar).not.toHaveBeenCalled();
    expect(report.warnings.join('\n')).toMatch(/Required variable "reviewer"/);
    expect(report.skills).toHaveLength(12);
    expect(report.mcp).toEqual([
      { file: '.mcp.json', agents: ['claude'], changed: true, status: 'added' },
      { file: '.codex/config.toml', agents: ['codex'], changed: true, status: 'added' },
    ]);

    setVar(paths, 'reviewer', 'octocat', 'personal');
    await syncProject(paths, { agents: ['claude'] });
    writeFlowDefinition(paths, withoutBuild());
    fs.rmSync(paths.stepDir('sample', 'build'), { recursive: true });
    const beforeDry = snapshot(paths);
    const dry = await syncProject(paths, { dryRun: true, agents: [] });
    expect(snapshot(paths)).toEqual(beforeDry);
    expect(dry.removed).toContain('.claude/skills/build');
    expect(dry.removed).toContain('.claude/skills/plan');
    expect(loadLocalConfig(paths).agents).toEqual(['claude']);
  });
});

describe('uninstallProject', () => {
  it('removes installed skills, MCP entries and the manifest', async () => {
    const paths = sampleProject();
    write(paths, '.gitignore', 'node_modules/\n');
    write(paths, '.mcp.json', '{\n  "mcpServers": {\n    "other": { "command": "other" }\n  }\n}\n');
    await syncProject(paths, { agents: ['claude', 'codex'] });

    const report = uninstallProject(paths);
    expect(report.removed).toContain('.claude/skills/plan');
    expect(report.removed).toContain('.agents/skills/add-flow-step');
    expect(report.mcp).toEqual([
      { file: '.mcp.json', changed: true },
      { file: '.codex/config.toml', changed: true },
    ]);
    expect(report.warnings).toEqual([]);
    expect(report.manifestKept).toBeUndefined();
    expect(has(paths, '.claude')).toBe(false);
    expect(has(paths, '.agents')).toBe(false);
    expect(has(paths, '.codex')).toBe(false);
    expect(readConfig(paths, '.mcp.json')['mcpServers']).toEqual({ other: { command: 'other' } });
    expect(read(paths, '.gitignore')).toBe('node_modules/\n');
    expect(has(paths, '.df/installed.json')).toBe(false);
    // Flows, rendered files and personal config stay without --purge.
    expect(has(paths, '.df/sample/flow.json')).toBe(true);
    expect(has(paths, '.df/sample/steps/plan/SKILL.md')).toBe(true);
    expect(has(paths, '.df/local.json')).toBe(true);

    // Nothing left to do the second time.
    expect(uninstallProject(paths)).toEqual({ removed: [], mcp: [], warnings: [] });
  });

  it('purge also deletes personal config, runtime state and rendered files', async () => {
    const paths = sampleProject();
    write(paths, '.df/state.json', '{ "version": 1, "flows": {} }\n');
    write(paths, '.df/sample/steps/build/docs/guide.md.hbs', 'Guide for {{step.title}}');
    await syncProject(paths, { agents: ['claude'] });
    expect(has(paths, '.df/sample/steps/build/docs/guide.md')).toBe(true);
    // Written after the sync (rendering deletes .md files without a template).
    write(paths, '.df/sample/steps/plan/notes.md', 'hand-written');

    const report = uninstallProject(paths, { purge: true });
    expect(report.removed).toEqual(
      expect.arrayContaining(['.df/local.json', '.df/state.json', '.df/sample/steps/build/docs/guide.md', '.df/sample/steps/plan/SKILL.md']),
    );
    expect(has(paths, '.df/local.json')).toBe(false);
    expect(has(paths, '.df/state.json')).toBe(false);
    expect(has(paths, '.df/sample/steps/plan/SKILL.md')).toBe(false);
    expect(has(paths, '.df/sample/steps/build/docs/guide.md')).toBe(false);
    expect(has(paths, '.df/sample/steps/build/docs/guide.md.hbs')).toBe(true);
    expect(has(paths, '.df/sample/steps/plan/SKILL.md.hbs')).toBe(true);
    expect(read(paths, '.df/sample/steps/plan/notes.md')).toBe('hand-written');
    expect(has(paths, '.df/config.json')).toBe(true);
    expect(has(paths, '.claude')).toBe(false);
  });
});

describe('manifest', () => {
  it('reads an empty manifest when none exists and round-trips', () => {
    const paths = makeTempProject();
    expect(readManifest(paths)).toEqual({ version: 1, agents: [], skills: [], mcp: [] });
    const manifest = {
      version: 1 as const,
      flow: 'sample',
      agents: ['claude' as const],
      skills: [{ agents: ['claude' as const], name: 'plan', dir: '.claude/skills/plan', files: ['SKILL.md'] }],
      mcp: [{ agents: ['claude' as const], file: '.mcp.json', server: 'dfl', createdFile: true, createdContainer: false }],
      rendered: ['.df/sample/steps/plan/SKILL.md'],
      dflVersion: '1.2.3',
      fingerprint: 'abc',
    };
    writeManifest(paths, manifest);
    expect(readManifest(paths)).toEqual(manifest);
  });

  it('drops suspicious file, MCP and rendered entries with warnings (D4)', () => {
    const paths = makeTempProject();
    write(
      paths,
      '.df/installed.json',
      JSON.stringify({
        version: 1,
        skills: [{ dir: '.claude/skills/plan', files: ['SKILL.md', '../x', '/etc/passwd', 'a\\b', 'refs/./x.md', 'refs/ok.md'] }],
        mcp: [
          { agents: ['claude'], file: 'nothing.json', server: 'github' },
          { agents: ['claude'], file: '.mcp.json', server: 'github' },
          { agents: ['claude'], file: '../.mcp.json', server: 'dfl' },
          { agents: ['claude'], file: '.mcp.json', server: 'dfl' },
          { agents: ['claude'], file: '.mcp.json', server: 'dfl' },
        ],
        rendered: ['.df/sample/steps/plan/SKILL.md', '../../etc/x.md', 'src/x.md'],
      }),
    );
    const { manifest, warnings } = loadManifest(paths);
    expect(manifest.skills[0]!.files).toEqual(['SKILL.md', 'refs/ok.md']);
    expect(manifest.mcp).toEqual([{ agents: ['claude'], file: '.mcp.json', server: 'dfl' }]);
    expect(manifest.rendered).toEqual(['.df/sample/steps/plan/SKILL.md']);
    expect(warnings).toHaveLength(5);
  });

  it('drops unknown agent ids and rejects malformed manifests', () => {
    const paths = makeTempProject();
    write(paths, '.df/installed.json', JSON.stringify({ version: 1, agents: ['claude', 'vim'], skills: [], mcp: [] }));
    expect(readManifest(paths).agents).toEqual(['claude']);
    write(paths, '.df/installed.json', JSON.stringify({ version: 1, skills: [{ name: 'x' }] }));
    expect(() => readManifest(paths)).toThrow(DflError);
    write(paths, '.df/installed.json', JSON.stringify({ version: 2 }));
    expect(() => readManifest(paths)).toThrow(/unsupported version/);
  });
});

describe('per-developer ignores (F11, F41, D2)', () => {
  it('never changes the committed root .gitignore with the agent or flow choice', async () => {
    const paths = sampleProject();
    write(paths, '.gitignore', 'node_modules/\n');
    await syncProject(paths, { agents: ['claude'] });
    const before = read(paths, '.gitignore');
    await syncProject(paths, { agents: ['cursor'] });
    expect(read(paths, '.gitignore')).toBe(before);

    // A personal flow override changes no committed file either.
    createFlow(paths, 'other', { steps: ['alpha'] });
    const config = read(paths, '.df/config.json');
    setActiveFlow(paths, 'other', 'local');
    await syncProject(paths);
    expect(read(paths, '.gitignore')).toBe(before);
    expect(read(paths, '.df/config.json')).toBe(config);
    expect(hasMarker(paths, '.cursor/skills/alpha')).toBe(true);
  });

  it.skipIf(!hasGit())('keeps rendered skills ignored whatever a teammate commits to the root .gitignore', async () => {
    const paths = sampleProject();
    git(paths, 'init', '-q');
    await syncProject(paths, { agents: ['claude'] });
    // What another developer (other agents) would commit: nothing about .claude.
    write(paths, '.gitignore', 'node_modules/\n.cursor/skills/plan/\n');
    execFileSync('git', ['check-ignore', '-q', '.claude/skills/plan/SKILL.md'], { cwd: paths.root });
    execFileSync('git', ['check-ignore', '-q', '.claude/skills/plan/.gitignore'], { cwd: paths.root });
    const status = git(paths, 'status', '--porcelain', '--untracked-files=all');
    expect(status).not.toContain('.claude/');
    expect(status).toContain('.gitignore');
  });

  it('uninstall removes the markers and never removes user-authored skill dirs', async () => {
    const paths = sampleProject();
    write(paths, '.claude/skills/mine/SKILL.md', '---\nname: mine\n---\nMine.\n');
    await syncProject(paths, { agents: ['claude'] });
    expect(hasMarker(paths, '.claude/skills/plan')).toBe(true);
    uninstallProject(paths);
    expect(has(paths, '.claude/skills/plan')).toBe(false);
    expect(fs.readdirSync(abs(paths, '.claude/skills'))).toEqual(['mine']);
  });

  it('migrates a legacy managed block out of the root .gitignore', async () => {
    const paths = sampleProject();
    write(
      paths,
      '.gitignore',
      'node_modules/\n\n# >>> dfl (managed) >>>\n.claude/skills/plan/\n.claude/skills/build/\n# <<< dfl (managed) <<<\n',
    );
    await syncProject(paths, { agents: ['claude'] });
    expect(read(paths, '.gitignore')).toBe('node_modules/\n');

    // A block that was all the file held: the file goes away.
    write(paths, '.gitignore', '# >>> dfl (managed) >>>\n.claude/skills/plan/\n# <<< dfl (managed) <<<\n');
    await syncProject(paths);
    expect(has(paths, '.gitignore')).toBe(false);

    // A block without its end marker never costs user lines.
    write(paths, '.gitignore', '# >>> dfl (managed) >>>\n.claude/skills/plan/\ndist/\n');
    await syncProject(paths);
    expect(read(paths, '.gitignore')).toContain('dist/');
    expect(read(paths, '.gitignore')).not.toContain('>>> dfl');
  });
});

describe('removing skill dirs deletes only what dfl wrote (F13, D3)', () => {
  it('keeps user files when an agent is dropped, then re-adds the skill next to them', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude', 'cursor'] });
    write(paths, '.cursor/skills/plan/notes.txt', 'my notes');
    write(paths, '.cursor/skills/plan/scripts/run.sh', 'echo hi');

    const dropped = await syncProject(paths, { agents: ['claude'] });
    expect(has(paths, '.cursor/skills/plan/SKILL.md')).toBe(false);
    expect(has(paths, '.cursor/skills/plan/.gitignore')).toBe(false);
    expect(read(paths, '.cursor/skills/plan/notes.txt')).toBe('my notes');
    expect(read(paths, '.cursor/skills/plan/scripts/run.sh')).toBe('echo hi');
    expect(dropped.warnings.some((w) => /^Kept \.cursor\/skills\/plan\//.test(w))).toBe(true);
    expect(dropped.removed).not.toContain('.cursor/skills/plan');
    expect(dropped.removed).toContain('.cursor/skills/build');

    const readded = await syncProject(paths, { agents: ['claude', 'cursor'] });
    expect(readded.warnings.join('\n')).not.toMatch(/Skipped \.cursor\/skills\/plan/);
    expect(has(paths, '.cursor/skills/plan/SKILL.md')).toBe(true);
    expect(read(paths, '.cursor/skills/plan/notes.txt')).toBe('my notes');
  });

  it('keeps user files of a deleted step and of the previous flow', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude'] });
    write(paths, '.claude/skills/build/notes.md', 'build notes');
    write(paths, '.claude/skills/plan/notes.md', 'plan notes');

    writeFlowDefinition(paths, withoutBuild());
    fs.rmSync(paths.stepDir('sample', 'build'), { recursive: true });
    const afterRemove = await syncProject(paths);
    expect(read(paths, '.claude/skills/build/notes.md')).toBe('build notes');
    expect(has(paths, '.claude/skills/build/SKILL.md')).toBe(false);
    expect(afterRemove.warnings.some((w) => w.startsWith('Kept .claude/skills/build/'))).toBe(true);

    createFlow(paths, 'other', { steps: ['alpha'] });
    setActiveFlow(paths, 'other');
    const afterSwitch = await syncProject(paths);
    expect(read(paths, '.claude/skills/plan/notes.md')).toBe('plan notes');
    expect(afterSwitch.removed).toContain('.claude/skills/review');
    expect(afterSwitch.removed).not.toContain('.claude/skills/plan');
  });

  it('uninstall keeps user files and reports the kept dir', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude'] });
    write(paths, '.claude/skills/plan/my-notes.md', 'mine');
    const report = uninstallProject(paths);
    expect(read(paths, '.claude/skills/plan/my-notes.md')).toBe('mine');
    expect(has(paths, '.claude/skills/plan/SKILL.md')).toBe(false);
    expect(report.warnings.some((w) => w.startsWith('Kept .claude/skills/plan/'))).toBe(true);
    expect(report.removed).not.toContain('.claude/skills/plan');
    expect(report.removed).toContain('.claude/skills/build');
  });

  it('an entry without files still removes the dfl SKILL.md and the emptied dir', async () => {
    const paths = sampleProject();
    write(paths, '.claude/skills/gone/SKILL.md', '---\nname: gone\nmetadata:\n  dfl-flow: sample\n---\nx\n');
    writeManifest(paths, {
      version: 1,
      agents: ['claude'],
      skills: [{ agents: ['claude'], name: 'gone', dir: '.claude/skills/gone', files: [] }],
      mcp: [],
    });
    const report = await syncProject(paths, { agents: ['claude'] });
    expect(report.removed).toEqual(['.claude/skills/gone']);
    expect(has(paths, '.claude/skills/gone')).toBe(false);
  });

  it('dryRun reports the same kept dir without deleting anything', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude', 'cursor'] });
    write(paths, '.cursor/skills/plan/notes.txt', 'my notes');
    const before = snapshot(paths);
    const dry = await syncProject(paths, { agents: ['claude'], dryRun: true });
    expect(snapshot(paths)).toEqual(before);
    expect(dry.warnings.some((w) => /^Kept \.cursor\/skills\/plan\//.test(w))).toBe(true);
    expect(dry.removed).not.toContain('.cursor/skills/plan');
    expect(dry.removed).toContain('.cursor/skills/build');
  });
});

describe('hand-written .md files under steps (F14, C2, D15)', () => {
  it('keeps a hand-written reference file and says so accurately', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude'] });
    write(paths, '.df/sample/steps/plan/references/checklist.md', '# checklist');
    const report = await syncProject(paths);
    expect(read(paths, '.df/sample/steps/plan/references/checklist.md')).toBe('# checklist');
    expect(has(paths, '.claude/skills/plan/references/checklist.md')).toBe(false);
    const messages = report.warnings.filter((w) => w.includes('checklist.md'));
    expect(messages).toEqual([
      'steps/plan/references/checklist.md was not rendered by dfl: it stays in .df/ but is not installed with the skill. Rename it to checklist.md.hbs to install it.',
    ]);
    expect(readManifest(paths).rendered).not.toContain('.df/sample/steps/plan/references/checklist.md');
  });

  it('deletes stale output it rendered and orphan step dirs left by an upstream rename', async () => {
    const paths = sampleProject();
    write(paths, '.df/sample/steps/plan/refs/guide.md.hbs', 'Guide');
    await syncProject(paths, { agents: ['claude'] });
    expect(readManifest(paths).rendered).toContain('.df/sample/steps/plan/refs/guide.md');

    // Upstream: the template was deleted and "build" was renamed (git keeps the ignored SKILL.md).
    fs.rmSync(abs(paths, '.df/sample/steps/plan/refs/guide.md.hbs'));
    const def = sampleFlowDefinition();
    const { build, ...states } = def.machine.states;
    const renamed = {
      ...def,
      machine: {
        ...def.machine,
        states: {
          plan: { ...states['plan']!, on: { NEXT: 'make' } },
          make: build!,
          review: { ...states['review']!, on: { NEXT: 'done', CHANGES_REQUESTED: 'make' } },
          done: states['done']!,
        },
      },
    };
    writeFlowDefinition(paths, renamed);
    fs.mkdirSync(paths.stepDir('sample', 'make'));
    fs.renameSync(abs(paths, '.df/sample/steps/build/SKILL.md.hbs'), abs(paths, '.df/sample/steps/make/SKILL.md.hbs'));

    const report = await syncProject(paths);
    expect(has(paths, '.df/sample/steps/plan/refs')).toBe(false);
    expect(has(paths, '.df/sample/steps/build')).toBe(false);
    expect(report.warnings.join('\n')).not.toMatch(/steps\/build|guide\.md/);
    expect(readManifest(paths).rendered).toEqual([
      '.df/sample/steps/make/SKILL.md',
      '.df/sample/steps/plan/SKILL.md',
      '.df/sample/steps/review/SKILL.md',
    ]);
  });

  it('purge removes rendered files (also orphans) and keeps hand-written ones', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude'] });
    const manifest = readManifest(paths);
    // An orphan rendered file from an earlier flow version.
    write(paths, '.df/sample/steps/old/SKILL.md', 'rendered earlier');
    writeManifest(paths, { ...manifest, rendered: [...(manifest.rendered ?? []), '.df/sample/steps/old/SKILL.md'] });
    write(paths, '.df/sample/steps/plan/notes.md', 'hand-written');
    const report = uninstallProject(paths, { purge: true });
    expect(report.removed).toContain('.df/sample/steps/old/SKILL.md');
    expect(has(paths, '.df/sample/steps/old')).toBe(false);
    expect(read(paths, '.df/sample/steps/plan/notes.md')).toBe('hand-written');
  });
});

describe.skipIf(!symlinks)('symlinks (F19, F23, F25, D4)', () => {
  it('never writes through a symlinked skills dir and never deletes its target (F19)', async () => {
    const paths = sampleProject();
    fs.mkdirSync(abs(paths, '.agents/skills'), { recursive: true });
    fs.mkdirSync(abs(paths, '.claude'));
    fs.symlinkSync('../.agents/skills', abs(paths, '.claude/skills'));

    const both = await syncProject(paths, { agents: ['claude', 'codex'] });
    expect(both.warnings.some((w) => w.startsWith('Left .claude/skills alone: it is a symbolic link'))).toBe(true);
    expect(has(paths, '.agents/skills/plan/SKILL.md')).toBe(true);
    expect(readManifest(paths).skills.every((entry) => entry.dir.startsWith('.agents/skills/'))).toBe(true);

    const claudeOnly = await syncProject(paths, { agents: ['claude'] });
    expect(claudeOnly.warnings.some((w) => w.includes('.claude/skills alone'))).toBe(true);
    // The link target stays (it is in use), so the link never dangles and later syncs work.
    expect(fs.statSync(abs(paths, '.claude/skills')).isDirectory()).toBe(true);
    await expect(syncProject(paths)).resolves.toBeDefined();
    uninstallProject(paths);
    expect(fs.lstatSync(abs(paths, '.claude/skills')).isSymbolicLink()).toBe(true);
  });

  it('survives a dangling skills dir link', async () => {
    const paths = sampleProject();
    fs.mkdirSync(abs(paths, '.claude'));
    fs.symlinkSync('../missing', abs(paths, '.claude/skills'));
    const report = await syncProject(paths, { agents: ['claude'] });
    expect(report.skills).toEqual([]);
    expect(report.warnings.some((w) => w.includes('.claude/skills alone'))).toBe(true);
  });

  it('never deletes outside the project through a manifest entry under a symlink (F23)', async () => {
    const paths = sampleProject();
    const outside = makeTempDir();
    write(paths, '../' + path.basename(outside) + '/plan/f.txt', 'victim');
    fs.mkdirSync(abs(paths, '.cursor'));
    fs.symlinkSync(outside, abs(paths, '.cursor/skills'));
    writeManifest(paths, {
      version: 1,
      agents: ['cursor'],
      skills: [{ agents: ['cursor'], name: 'plan', dir: '.cursor/skills/plan', files: ['f.txt'] }],
      mcp: [],
    });
    const report = await syncProject(paths, { agents: ['claude'] });
    expect(report.removed).toEqual([]);
    expect(fs.readFileSync(path.join(outside, 'plan', 'f.txt'), 'utf8')).toBe('victim');
    writeManifest(paths, { ...readManifest(paths), skills: [{ agents: ['cursor'], name: 'plan', dir: '.cursor/skills/plan', files: [] }] });
    uninstallProject(paths);
    expect(fs.readFileSync(path.join(outside, 'plan', 'f.txt'), 'utf8')).toBe('victim');
  });

  it('never deletes listed files through a symlinked subdirectory (F23 per-file)', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude'] });
    const outside = makeTempDir();
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.symlinkSync(outside, abs(paths, '.claude/skills/plan/lnk'));
    const manifest = readManifest(paths);
    writeManifest(paths, {
      ...manifest,
      skills: manifest.skills.map((entry) => (entry.name === 'plan' ? { ...entry, files: ['SKILL.md', 'lnk/keep.txt'] } : entry)),
    });
    await syncProject(paths);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    uninstallProject(paths);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.lstatSync(abs(paths, '.claude/skills/plan/lnk')).isSymbolicLink()).toBe(true);
  });

  it('never writes a static file through a leaf symlink (F25)', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude'] });
    const outside = path.join(makeTempDir(), '.zshrc');
    fs.writeFileSync(outside, 'export SECRET=1\n', { mode: 0o600 });
    write(paths, '.df/sample/steps/build/helper.sh', 'echo payload\n');
    fs.chmodSync(abs(paths, '.df/sample/steps/build/helper.sh'), 0o755);
    fs.symlinkSync(outside, abs(paths, '.claude/skills/build/helper.sh'));
    const report = await syncProject(paths);
    expect(fs.readFileSync(outside, 'utf8')).toBe('export SECRET=1\n');
    expect(fs.statSync(outside).mode & 0o777).toBe(0o600);
    expect(report.warnings.some((w) => w.includes('.claude/skills/build/helper.sh alone'))).toBe(true);
  });

  it('never creates the target of a dangling leaf symlink (git hook, F25)', async () => {
    const paths = sampleProject();
    fs.mkdirSync(abs(paths, '.git/hooks'), { recursive: true });
    write(paths, '.df/sample/steps/build/helper.sh', 'echo payload\n');
    // A committed dfl-looking skill with a link into .git/hooks (fresh clone: no manifest).
    write(paths, '.claude/skills/build/SKILL.md', '---\nname: build\nmetadata:\n  dfl-flow: sample\n---\nx\n');
    fs.symlinkSync('../../../.git/hooks/post-checkout', abs(paths, '.claude/skills/build/helper.sh'));
    await syncProject(paths, { agents: ['claude'] });
    expect(has(paths, '.git/hooks/post-checkout')).toBe(false);
  });

  it('never writes or deletes through a symlinked subdirectory of a skill (F25)', async () => {
    const paths = sampleProject();
    const outside = makeTempDir();
    write(paths, '.df/sample/steps/build/sub/payload', 'payload');
    write(paths, '.df/sample/steps/build/sub/notes.md.hbs', 'notes');
    await syncProject(paths, { agents: ['claude'] });
    // Replace the installed sub/ with a link to an outside dir holding "payload".
    fs.rmSync(abs(paths, '.claude/skills/build/sub'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'payload'), 'outside');
    fs.symlinkSync(outside, abs(paths, '.claude/skills/build/sub'));
    await syncProject(paths);
    expect(fs.readdirSync(outside)).toEqual(['payload']);
    expect(fs.readFileSync(path.join(outside, 'payload'), 'utf8')).toBe('outside');

    // Stale removal of sub/payload must not follow the link either.
    fs.rmSync(abs(paths, '.df/sample/steps/build/sub'), { recursive: true });
    await syncProject(paths);
    expect(fs.readFileSync(path.join(outside, 'payload'), 'utf8')).toBe('outside');
  });
});

describe('MCP entries (F20, F21, F22, F26, F43, F80, F81, F83, F84)', () => {
  it('keeps tracking an entry uninstall could not remove, and retries (F20)', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude'] });
    const good = read(paths, '.mcp.json');
    write(paths, '.mcp.json', good.replace('"mcpServers": {', '"mcpServers": {\n    "mine": {"command": "x"}\n    ,,'));
    const first = uninstallProject(paths);
    expect(first.warnings.join('\n')).toMatch(/Could not remove the dfl MCP server from \.mcp\.json.*run `dfl uninstall` again/);
    expect(first.manifestKept).toBe(true);
    expect(readManifest(paths)).toMatchObject({ skills: [], mcp: [{ file: '.mcp.json' }] });

    write(paths, '.mcp.json', read(paths, '.mcp.json').replace(',,', ','));
    const second = uninstallProject(paths);
    expect(second.warnings).toEqual([]);
    expect(second.mcp).toEqual([{ file: '.mcp.json', changed: true }]);
    expect(readConfig(paths, '.mcp.json')['mcpServers']).toEqual({ mine: { command: 'x' } });
    expect(has(paths, '.df/installed.json')).toBe(false);
  });

  it('dry run reports a rewritten entry as updated and never writes (F21, F83)', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude', 'codex', 'opencode'] });
    const files = ['.mcp.json', '.codex/config.toml', 'opencode.json'];
    const before = files.map((file) => read(paths, file));
    saveProjectConfig(paths, { ...loadProjectConfig(paths), mcp: { command: 'pnpm', args: ['exec', 'dfl', 'mcp'] } });

    const dry = await syncProject(paths, { dryRun: true });
    expect(dry.mcp.map((entry) => [entry.file, entry.status, entry.changed])).toEqual(files.map((file) => [file, 'updated', true]));
    expect(files.map((file) => read(paths, file))).toEqual(before);

    const real = await syncProject(paths);
    expect(real.mcp.map((entry) => entry.status)).toEqual(['updated', 'updated', 'updated']);
    expect(readConfig(paths, '.mcp.json')['mcpServers']['dfl'].command).toBe('pnpm');
    const again = await syncProject(paths, { dryRun: true });
    expect(again.mcp.map((entry) => entry.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  it.each([
    ['kiro' as const, '.kiro/settings/mcp.json', '{"mcpServers": {}}\n'],
    ['claude' as const, '.mcp.json', '{"mcpServers": {}}\n'],
    ['claude' as const, '.mcp.json', '{}\n'],
    ['opencode' as const, 'opencode.jsonc', '{"$schema": "https://opencode.ai/config.json"}\n'],
    ['codex' as const, '.codex/config.toml', '# my codex config\n'],
  ])('keeps a pre-existing %s config (%s) through install, update and uninstall (F22)', async (agent, file, original) => {
    const paths = sampleProject();
    write(paths, file, original);
    await syncProject(paths, { agents: [agent] });
    await syncProject(paths);
    uninstallProject(paths);
    expect(has(paths, file)).toBe(true);
    if (file.endsWith('.toml')) expect(read(paths, file).trim()).toBe(original.trim());
    else expect(parseJsonc(read(paths, file))).toEqual(parseJsonc(original));
  });

  it('still deletes a config file dfl created, also after several syncs (F22)', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['kiro'] });
    await syncProject(paths);
    write(paths, '.kiro/steering/rules.md', '# rules');
    uninstallProject(paths);
    expect(has(paths, '.kiro/settings')).toBe(false);
    expect(has(paths, '.kiro/steering/rules.md')).toBe(true);
  });

  it('only ever removes its own "dfl" server from known files (F26)', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude'] });
    write(paths, '.mcp.json', '{\n  "mcpServers": {\n    "github": { "command": "gh" },\n    "dfl": { "type": "stdio", "command": "dfl", "args": ["mcp"] }\n  }\n}\n');
    const manifest = readManifest(paths);
    writeManifest(paths, {
      ...manifest,
      mcp: [
        ...manifest.mcp,
        { agents: ['claude'], file: 'nothing.json', server: 'github' },
        { agents: ['claude'], file: '.mcp.json', server: 'github' },
      ],
    });
    const report = await syncProject(paths);
    expect(report.warnings.filter((w) => w.includes('suspicious MCP entry'))).toHaveLength(2);
    expect(readConfig(paths, '.mcp.json')['mcpServers']['github']).toEqual({ command: 'gh' });
    const uninstall = uninstallProject(paths);
    expect(uninstall.mcp).toEqual([{ file: '.mcp.json', changed: true }]);
    expect(readConfig(paths, '.mcp.json')['mcpServers']).toEqual({ github: { command: 'gh' } });
  });

  it('matches manifest entries to their own file, never to another agent’s (F26)', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude'] });
    writeManifest(paths, { ...readManifest(paths), mcp: [{ agents: ['claude'], file: '.cursor/mcp.json', server: 'dfl' }] });
    uninstallProject(paths);
    expect(readConfig(paths, '.mcp.json')['mcpServers']['dfl']).toBeDefined();
  });

  it('uninstall leaves a "dfl" entry whose command is not dfl (D5)', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['claude'] });
    write(paths, '.mcp.json', '{ "mcpServers": { "dfl": { "command": "python", "args": ["dfl_other.py"] } } }\n');
    const report = uninstallProject(paths);
    expect(report.warnings.join('\n')).toMatch(/Left the "dfl" MCP server in \.mcp\.json/);
    expect(readConfig(paths, '.mcp.json')['mcpServers']['dfl'].command).toBe('python');
  });

  it('writes the same committed entry whichever dfl binary runs (F43, F80)', async () => {
    const paths = sampleProject();
    write(paths, 'package.json', JSON.stringify({ devDependencies: { '@vishin-pavel/dfl': '^0.1.0' } }));
    await syncProject(paths, { agents: ['claude', 'codex'] });
    expect(readConfig(paths, '.mcp.json')['mcpServers']['dfl']).toEqual({ type: 'stdio', command: 'npx', args: ['--no-install', 'dfl', 'mcp'] });
    const before = [read(paths, '.mcp.json'), read(paths, '.codex/config.toml')];
    // This test process runs dfl from outside the project (like a global install).
    const again = await syncProject(paths);
    expect(again.mcp.map((entry) => entry.status)).toEqual(['unchanged', 'unchanged']);
    expect([read(paths, '.mcp.json'), read(paths, '.codex/config.toml')]).toEqual(before);
    expect(read(paths, '.claude/skills/plan/SKILL.md')).toContain('npx --no-install dfl status');
  });

  it('warns when agents could not start `dfl mcp` because dfl is not on PATH (F81)', async () => {
    const paths = sampleProject();
    const report = await withoutDflOnPath(() => syncProject(paths, { agents: ['claude'] }));
    expect(report.warnings.some((w) => w.startsWith('`dfl` is not on PATH'))).toBe(true);
    // Only when something was written; and never with an override or the npx form.
    const unchanged = await withoutDflOnPath(() => syncProject(paths));
    expect(unchanged.warnings.join('\n')).not.toMatch(/not on PATH/);
    saveProjectConfig(paths, { ...loadProjectConfig(paths), mcp: { command: 'node', args: ['dfl.js', 'mcp'] } });
    const override = await withoutDflOnPath(() => syncProject(paths));
    expect(override.warnings.join('\n')).not.toMatch(/not on PATH/);
  });

  it('explains the per-project entry cannot start where Antigravity runs servers (F84)', async () => {
    const paths = sampleProject();
    write(paths, 'package.json', JSON.stringify({ devDependencies: { '@vishin-pavel/dfl': '^0.1.0' } }));
    const report = await syncProject(paths, { agents: ['antigravity', 'claude'] });
    const notes = report.mcpManual.filter((note) => note.agent === 'antigravity');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.instructions).toContain(`npx --prefix ${paths.root} --no-install dfl mcp --root ${paths.root}`);
    // The committed file never holds the absolute root.
    expect(read(paths, '.agents/mcp_config.json')).not.toContain(paths.root);

    const claudeOnly = await syncProject(paths, { agents: ['claude'] });
    expect(claudeOnly.mcpManual).toEqual([]);
    fs.rmSync(abs(paths, 'package.json'));
    const global = await syncProject(paths, { agents: ['antigravity'] });
    expect(global.mcpManual).toEqual([]);
  });
});

describe('staleness (C0, D7, D8)', () => {
  it('reports not installed, up to date and every kind of drift', async () => {
    const paths = sampleProject();
    expect(isInstalledForUser(paths)).toBe(false);
    expect(checkSyncState(paths)).toEqual({ installed: false, upToDate: false, reason: NOT_INSTALLED_MESSAGE });

    await syncProject(paths, { agents: ['claude'] });
    expect(isInstalledForUser(paths)).toBe(true);
    expect(checkSyncState(paths)).toEqual({ installed: true, upToDate: true });
    // Rendered output does not count.
    write(paths, '.df/sample/steps/plan/SKILL.md', 'touched');
    expect(checkSyncState(paths).upToDate).toBe(true);

    write(paths, '.df/sample/steps/plan/SKILL.md.hbs', '# Plan v2\n');
    const edited = checkSyncState(paths);
    expect(edited.upToDate).toBe(false);
    expect(edited.reason).toMatch(/changed since the skills were installed/);
    await syncProject(paths);
    expect(checkSyncState(paths).upToDate).toBe(true);

    setVar(paths, 'reviewer', 'someone-else', 'personal');
    expect(checkSyncState(paths).upToDate).toBe(false);
    await syncProject(paths);

    createFlow(paths, 'other', { steps: ['alpha'] });
    setActiveFlow(paths, 'other', 'project');
    expect(checkSyncState(paths).reason).toBe('the installed skills are for flow "sample" but the active flow is "other"');
    await syncProject(paths);
    expect(checkSyncState(paths).upToDate).toBe(true);

    writeManifest(paths, { ...readManifest(paths), dflVersion: '0.0.1' });
    expect(checkSyncState(paths).reason).toMatch(/installed by dfl 0\.0\.1/);
    const { fingerprint: _, dflVersion: __, ...legacy } = readManifest(paths);
    writeManifest(paths, legacy);
    expect(checkSyncState(paths).reason).toMatch(/older dfl version/);
  });

  it('does not depend on key order or agent order', async () => {
    const paths = sampleProject();
    await syncProject(paths, { agents: ['cursor', 'claude'] });
    const fingerprint = computeSyncFingerprint(paths);
    const local = JSON.parse(read(paths, '.df/local.json')) as Record<string, unknown>;
    write(paths, '.df/local.json', JSON.stringify({ vars: local['vars'], agents: ['claude', 'cursor'], version: 1 }));
    expect(computeSyncFingerprint(paths)).toBe(fingerprint);
  });
});
