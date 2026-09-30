import fs from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadLocalConfig, loadProjectConfig, setActiveFlow } from '../src/core/config.js';
import { DflError } from '../src/core/errors.js';
import { createFlow, writeFlowDefinition } from '../src/core/flow.js';
import { DF_GITIGNORE_CONTENT } from '../src/core/gitignore.js';
import { readManifest, syncProject, uninstallProject, writeManifest } from '../src/core/sync.js';
import { AGENT_IDS, type FlowDefinition, type FlowVarDef, type ProjectPaths } from '../src/core/types.js';
import { setVar } from '../src/core/vars.js';
import { cleanupTempDirs, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

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

/** Lines of the managed block in the root .gitignore. */
function managedBlock(paths: ProjectPaths): string[] {
  const text = fs.existsSync(paths.rootGitignoreFile) ? fs.readFileSync(paths.rootGitignoreFile, 'utf8') : '';
  const match = /# >>> dfl \(managed\) >>>\n([\s\S]*?)# <<< dfl \(managed\) <<</.exec(text);
  return match ? match[1]!.split('\n').filter(Boolean) : [];
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
  it('installs step and built-in skills, MCP entries, gitignore block and manifest for claude, cursor and codex', async () => {
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
      { file: '.mcp.json', agents: ['claude'], changed: true },
      { file: '.cursor/mcp.json', agents: ['cursor'], changed: true },
      { file: '.codex/config.toml', agents: ['codex'], changed: true },
    ]);
    expect(report.mcpManual).toEqual([]);

    expect(managedBlock(paths)).toEqual([...dirs].sort().map((dir) => `${dir}/`));
    expect(read(paths, '.df/.gitignore')).toBe(DF_GITIGNORE_CONTENT);

    const manifest = readManifest(paths);
    expect(manifest.flow).toBe('sample');
    expect(manifest.agents).toEqual(['claude', 'cursor', 'codex']);
    expect(manifest.skills.map((entry) => entry.dir)).toEqual(dirs);
    expect(manifest.skills[0]).toEqual({ agents: ['claude'], name: 'plan', dir: '.claude/skills/plan', files: ['SKILL.md'] });
    expect(manifest.mcp).toEqual([
      { agents: ['claude'], file: '.mcp.json', server: 'dfl' },
      { agents: ['cursor'], file: '.cursor/mcp.json', server: 'dfl' },
      { agents: ['codex'], file: '.codex/config.toml', server: 'dfl' },
    ]);
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
    expect(report.mcp.map((entry) => entry.changed)).toEqual([false, false]);
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
    expect(managedBlock(paths)).not.toContain('.claude/skills/build/');

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
    expect(managedBlock(paths)).toContain('.claude/skills/alpha/');
    expect(managedBlock(paths)).not.toContain('.claude/skills/plan/');
  });

  it('removes skills and MCP entries of deselected agents but keeps MCP files still in use', async () => {
    const paths = sampleProject();
    write(paths, '.cursor/rules/keep.mdc', 'user rule');
    await syncProject(paths, { agents: ['claude', 'cursor', 'copilot'] });
    expect(readConfig(paths, '.mcp.json')['mcpServers']['dfl']).toBeDefined();

    const report = await syncProject(paths, { agents: ['claude'] });
    expect(report.removed).toContain('.cursor/skills/plan');
    expect(report.removed).toContain('.github/skills/add-flow-step');
    expect(has(paths, '.cursor/skills')).toBe(false);
    expect(has(paths, '.github')).toBe(false);
    expect(has(paths, '.cursor/mcp.json')).toBe(false);
    expect(read(paths, '.cursor/rules/keep.mdc')).toBe('user rule');
    // .mcp.json is still needed by claude (copilot shared it).
    expect(readConfig(paths, '.mcp.json')['mcpServers']['dfl']).toBeDefined();
    expect(readManifest(paths).mcp).toEqual([{ agents: ['claude'], file: '.mcp.json', server: 'dfl' }]);

    const none = await syncProject(paths, { agents: [] });
    expect(none.warnings.join('\n')).toMatch(/no agents selected/i);
    expect(has(paths, '.claude')).toBe(false);
    expect(has(paths, '.mcp.json')).toBe(false);
    expect(has(paths, '.gitignore')).toBe(false);
    expect(readManifest(paths)).toMatchObject({ agents: [], skills: [], mcp: [] });
  });

  it('keeps unrelated MCP servers and .gitignore content', async () => {
    const paths = sampleProject();
    write(paths, '.mcp.json', '{\n  // mine\n  "mcpServers": { "other": { "command": "other" } }\n}\n');
    write(paths, '.gitignore', 'node_modules/\n');
    await syncProject(paths, { agents: ['claude'] });
    const config = readConfig(paths, '.mcp.json');
    expect(config['mcpServers']['other']).toEqual({ command: 'other' });
    expect(config['mcpServers']['dfl']).toBeDefined();
    expect(read(paths, '.mcp.json')).toContain('// mine');
    expect(read(paths, '.gitignore').startsWith('node_modules/\n\n# >>> dfl (managed) >>>\n')).toBe(true);
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
    expect(managedBlock(paths)).not.toContain('.claude/skills/plan/');
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

  it('ignores manifest paths outside the project skill dirs', async () => {
    const paths = sampleProject();
    write(paths, 'outside/SKILL.md', 'keep');
    writeManifest(paths, {
      version: 1,
      agents: ['claude'],
      skills: [
        { agents: ['claude'], name: 'x', dir: '../outside', files: [] },
        { agents: ['claude'], name: 'y', dir: '.df/sample', files: [] },
      ],
      mcp: [],
    });
    const report = await syncProject(paths, { agents: ['claude'] });
    expect(report.removed).toEqual([]);
    expect(report.warnings.filter((w) => w.includes('suspicious'))).toHaveLength(2);
    expect(has(paths, '.df/sample/flow.json')).toBe(true);
    expect(has(paths, 'outside/SKILL.md')).toBe(true);
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

  it('leaves MCP configs alone with mcp: false but keeps tracking earlier entries', async () => {
    const paths = sampleProject();
    const report = await syncProject(paths, { agents: ['claude'], mcp: false });
    expect(report.mcp).toEqual([]);
    expect(has(paths, '.mcp.json')).toBe(false);
    expect(readManifest(paths).mcp).toEqual([]);

    await syncProject(paths);
    await syncProject(paths, { mcp: false });
    expect(readManifest(paths).mcp).toEqual([{ agents: ['claude'], file: '.mcp.json', server: 'dfl' }]);
    uninstallProject(paths);
    expect(has(paths, '.mcp.json')).toBe(false);
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
      { file: '.mcp.json', agents: ['claude'], changed: true },
      { file: '.codex/config.toml', agents: ['codex'], changed: true },
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
  it('removes installed skills, MCP entries, the gitignore block and the manifest', async () => {
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
      mcp: [{ agents: ['claude' as const], file: '.mcp.json', server: 'dfl' }],
    };
    writeManifest(paths, manifest);
    expect(readManifest(paths)).toEqual(manifest);
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
