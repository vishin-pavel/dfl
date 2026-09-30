import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlow } from '../src/core/flow.js';
import { packageVersion, projectPaths } from '../src/core/paths.js';
import { runCli } from '../src/run.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, writeSampleFlow } from './helpers/project.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const ANSI_RE = /\u001B\[[0-9;]*m/g;

/** Runs `dfl --root <root> --no-color ...args` in-process, capturing stdout/stderr. */
async function dfl(root: string, ...args: string[]): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const capture =
    (sink: (text: string) => void) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
      callback?.();
      return true;
    };
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture((text) => (stdout += text)) as never);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture((text) => (stderr += text)) as never);
  try {
    const code = await runCli(['node', 'dfl', '--root', root, '--no-color', ...args]);
    return { code, stdout: stdout.replace(ANSI_RE, ''), stderr: stderr.replace(ANSI_RE, '') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

/** Like `dfl` but fails the test (showing stderr) on a non-zero exit code. */
async function ok(root: string, ...args: string[]): Promise<RunResult> {
  const result = await dfl(root, ...args);
  if (result.code !== 0) throw new Error(`dfl ${args.join(' ')} exited ${result.code}\n${result.stderr}\n${result.stdout}`);
  return result;
}

async function json<T = any>(root: string, ...args: string[]): Promise<T> {
  return JSON.parse((await ok(root, ...args, '--json')).stdout) as T;
}

const has = (root: string, rel: string): boolean => fs.existsSync(path.join(root, ...rel.split('/')));
const readJsonFile = (root: string, rel: string): any => JSON.parse(fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'));

/** A project installed with the prebuilt feature flow for Claude Code and Codex. */
async function installedProject(): Promise<string> {
  const root = makeTempDir();
  await ok(root, 'install', '--yes', '--agents', 'claude,codex', '--flow', 'feature');
  return root;
}

beforeEach(() => {
  // Never prompt, whatever terminal the tests run in.
  vi.stubEnv('CI', '1');
  vi.stubEnv('DFL_ROOT', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirs();
});

describe('dfl install', () => {
  it('installs the feature flow for several agents non-interactively', async () => {
    const root = makeTempDir();
    const { stdout } = await ok(root, 'install', '--yes', '--agents', 'claude,codex', '--flow', 'feature');

    expect(has(root, '.df/feature/flow.json')).toBe(true);
    expect(has(root, '.claude/skills/spec-feature/SKILL.md')).toBe(true);
    expect(has(root, '.agents/skills/spec-feature/SKILL.md')).toBe(true);
    expect(has(root, '.claude/skills/add-flow-step/SKILL.md')).toBe(true);
    expect(readJsonFile(root, '.mcp.json').mcpServers.dfl).toBeDefined();
    expect(fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.dfl]');
    expect(readJsonFile(root, '.df/config.json').activeFlow).toBe('feature');
    expect(readJsonFile(root, '.df/local.json').agents).toEqual(['claude', 'codex']);
    expect(readJsonFile(root, '.df/config.json').agents).toBeUndefined();

    expect(stdout).toContain('Claude Code');
    expect(stdout).toContain('.claude/skills/');
    expect(stdout).toContain('/spec-feature');
    expect(stdout).toContain('$spec-feature');
    expect(stdout).toContain('/add-flow-step');
    expect(stdout).toContain('.mcp.json');
    expect(stdout).toMatch(/Next: run .*\/spec-feature.* in your agent/);
  });

  it('defaults to the feature template and claude, and honours --no-mcp and --project-agents', async () => {
    const root = makeTempDir();
    await ok(root, 'install', '--yes', '--no-mcp', '--project-agents');
    expect(has(root, '.df/feature/flow.json')).toBe(true);
    expect(has(root, '.claude/skills/spec-feature/SKILL.md')).toBe(true);
    expect(has(root, '.mcp.json')).toBe(false);
    expect(readJsonFile(root, '.df/config.json').agents).toEqual(['claude']);
  });

  it('activates an existing flow given with --flow and re-running is idempotent', async () => {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    createFlow(paths, 'other', { steps: ['one', 'two'] });
    await ok(paths.root, 'install', '--yes', '--agents', 'claude', '--flow', 'other', '--no-mcp');
    expect(has(paths.root, '.claude/skills/one/SKILL.md')).toBe(true);
    expect(has(paths.root, '.claude/skills/plan/SKILL.md')).toBe(false);
    const again = await ok(paths.root, 'install', '--yes', '--no-mcp');
    expect(again.stdout).toContain('Active flow');
    expect(readJsonFile(paths.root, '.df/local.json').agents).toEqual(['claude']);
  });

  it('fails for an unknown flow or template and an unknown agent', async () => {
    const root = makeTempDir();
    const flow = await dfl(root, 'install', '--yes', '--flow', 'nope');
    expect(flow.code).toBe(1);
    expect(flow.stderr).toContain('✖ Unknown flow or template "nope".');
    expect(flow.stderr).toContain('Templates: ');

    const agent = await dfl(root, 'install', '--yes', '--agents', 'claude,vim');
    expect(agent.code).toBe(1);
    expect(agent.stderr).toContain('Unknown agent "vim"');
  });
});

describe('status, next, goto, reset', () => {
  it('shows the progress chain, the current step and its events', async () => {
    const root = await installedProject();
    const { stdout } = await ok(root, 'status');
    expect(stdout).toContain('Feature development (feature)');
    expect(stdout).toMatch(/● Spec → ○ Plan → ○ Implement/);
    expect(stdout).toContain('step 1 of 6');
    expect(stdout).toContain('/spec-feature (Claude Code) · $spec-feature (OpenAI Codex)');
    expect(stdout).toContain('Events');
    expect(stdout).toMatch(/NEXT\s+→ plan-feature\s+Plan/);
  });

  it('moves through the flow and persists the state', async () => {
    const root = await installedProject();
    const next = await ok(root, 'next');
    expect(next.stdout).toContain('✔ Spec → Plan (NEXT)');
    expect(readJsonFile(root, '.df/state.json').flows.feature.current).toBe('plan-feature');

    await ok(root, 'next', 'BACK');
    expect((await json(root, 'status')).current).toBe('spec-feature');

    const bad = await dfl(root, 'next', 'NOPE');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Event "NOPE" is not allowed');
    expect(bad.stderr).toContain('Allowed events: NEXT → plan-feature');

    const notCurrent = await dfl(root, 'next', '--from', 'plan-feature');
    expect(notCurrent.code).toBe(1);
    expect(notCurrent.stderr).toContain('is not the current step');

    const moved = await ok(root, 'goto', 'review-feature');
    expect(moved.stdout).toContain('(GOTO)');
    const status = await json(root, 'status');
    expect(status.current).toBe('review-feature');
    expect(status.step).toMatchObject({ id: 'review-feature', title: 'Review', commands: ['/review-feature', '$review-feature'] });
    expect(status.steps.map((s: { status: string }) => s.status)).toEqual(['done', 'done', 'done', 'done', 'current', 'upcoming']);
    expect(status.events.map((e: { event: string }) => e.event)).toContain('NEXT');
    expect(status.history.at(-1)).toMatchObject({ from: 'spec-feature', to: 'review-feature', event: 'GOTO' });

    const reset = await ok(root, 'reset', '--yes');
    expect(reset.stdout).toContain('Reset flow "feature" to Spec');
    expect((await json(root, 'status')).current).toBe('spec-feature');
  });

  it('reports a finished flow', async () => {
    const root = await installedProject();
    await ok(root, 'goto', 'ship-feature');
    const last = await ok(root, 'next');
    expect(last.stdout).toContain('is complete');
    const { stdout } = await ok(root, 'status');
    expect(stdout).toContain('Flow complete');
    expect((await json(root, 'status')).done).toBe(true);
    const again = await dfl(root, 'next');
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already complete');
  });

  it('notes a repaired state', async () => {
    const root = await installedProject();
    fs.writeFileSync(
      path.join(root, '.df/state.json'),
      JSON.stringify({ version: 1, flows: { feature: { current: 'gone', history: [], updatedAt: new Date().toISOString() } } }),
    );
    const { stdout, stderr } = await ok(root, 'status');
    expect(stderr).toContain('no longer exists');
    expect(stdout).toContain('● Spec');
  });
});

describe('dfl step', () => {
  it('adds, edits, rewires and removes steps with a sync', async () => {
    const root = await installedProject();
    const add = await ok(root, 'step', 'add', 'write-docs', '--after', 'verify-feature', '--title', 'Docs', '--description', 'Write the docs');
    expect(add.stdout).toContain('Added step write-docs (Docs) to flow "feature" after "verify-feature"');
    expect(add.stdout).toMatch(/↻ Synced \d+ skills of flow "feature" for Claude Code, OpenAI Codex \(\+2 −0\)/);
    expect(has(root, '.claude/skills/write-docs/SKILL.md')).toBe(true);
    expect(has(root, '.agents/skills/write-docs/SKILL.md')).toBe(true);

    const list = await json(root, 'step', 'list');
    const ids = list.steps.map((s: { id: string }) => s.id);
    expect(ids.indexOf('write-docs')).toBe(ids.indexOf('verify-feature') + 1);
    expect(list.steps.find((s: { id: string }) => s.id === 'verify-feature').transitions).toContainEqual({ event: 'NEXT', target: 'write-docs' });

    await ok(root, 'step', 'edit', 'write-docs', '--rename', 'document-feature', '--title', 'Document');
    expect(has(root, '.claude/skills/document-feature/SKILL.md')).toBe(true);
    expect(has(root, '.claude/skills/write-docs')).toBe(false);

    await ok(root, 'step', 'transition', 'document-feature', 'BACK', 'implement-feature');
    const rewired = await json(root, 'step', 'list');
    expect(rewired.steps.find((s: { id: string }) => s.id === 'document-feature').transitions).toContainEqual({
      event: 'BACK',
      target: 'implement-feature',
    });
    await ok(root, 'step', 'transition', 'document-feature', 'BACK', '--remove');

    const refused = await dfl(root, 'step', 'remove', 'document-feature');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('confirmation required');
    expect(refused.stderr).toContain('--yes');

    await ok(root, 'step', 'remove', 'document-feature', '--yes');
    expect(has(root, '.claude/skills/document-feature')).toBe(false);
    expect(has(root, '.df/feature/steps/document-feature')).toBe(false);
  });

  it('prints a table and honours --no-sync and --template-file', async () => {
    const root = await installedProject();
    const table = await ok(root, 'step', 'list');
    expect(table.stdout).toMatch(/●\s+1\s+spec-feature\s+Spec\s+\/spec-feature/);
    expect(table.stdout).toContain('(final)');

    const template = path.join(root, 'tpl.md.hbs');
    fs.writeFileSync(template, '# Custom {{step.title}}\n');
    const add = await ok(root, 'step', 'add', 'extra-step', '--template-file', template, '--no-sync');
    expect(add.stdout).not.toContain('Synced');
    expect(fs.readFileSync(path.join(root, '.df/feature/steps/extra-step/SKILL.md.hbs'), 'utf8')).toBe('# Custom {{step.title}}\n');
    expect(has(root, '.claude/skills/extra-step')).toBe(false);

    const nothing = await dfl(root, 'step', 'edit', 'extra-step');
    expect(nothing.code).toBe(1);
    expect(nothing.stderr).toContain('Nothing to change');

    const missingTarget = await dfl(root, 'step', 'transition', 'extra-step', 'NEXT');
    expect(missingTarget.code).toBe(1);
    expect(missingTarget.stderr).toContain('Missing the target step');
  });
});

describe('dfl flow', () => {
  it('creates, uses, lists and deletes flows', async () => {
    const root = await installedProject();
    const created = await ok(root, 'flow', 'create', 'tiny', '--steps', 'draft-it,check-it', '--title', 'Tiny');
    expect(created.stdout).toContain('Created flow tiny (2 steps) in .df/tiny/');
    expect(has(root, '.df/tiny/steps/draft-it/SKILL.md.hbs')).toBe(true);

    const used = await ok(root, 'flow', 'use', 'tiny');
    expect(used.stdout).toContain('Active flow: tiny');
    expect(used.stdout).toMatch(/Synced .* \(\+\d+ −\d+\)/);
    expect(readJsonFile(root, '.df/local.json').activeFlow).toBe('tiny');
    expect(has(root, '.claude/skills/draft-it/SKILL.md')).toBe(true);
    expect(has(root, '.claude/skills/spec-feature')).toBe(false);

    const flows = await json<Array<{ name: string; active: boolean; steps: number; current: string }>>(root, 'flow', 'list');
    expect(flows.map((f) => [f.name, f.active])).toEqual([
      ['feature', false],
      ['tiny', true],
    ]);
    expect(flows[1]).toMatchObject({ steps: 2, current: 'draft-it' });
    expect((await ok(root, 'flow', 'list')).stdout).toMatch(/●\s+tiny\s+Tiny\s+2\s+draft-it/);

    const refused = await dfl(root, 'flow', 'delete', 'tiny');
    expect(refused.code).toBe(1);
    expect(has(root, '.df/tiny')).toBe(true);

    await ok(root, 'flow', 'delete', 'tiny', '--yes');
    expect(has(root, '.df/tiny')).toBe(false);
    // The team default takes over again and its skills are reinstalled.
    expect(has(root, '.claude/skills/spec-feature/SKILL.md')).toBe(true);
    expect(has(root, '.claude/skills/draft-it')).toBe(false);
  });

  it('removes installed skills when the deleted flow was the last one', async () => {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    await ok(paths.root, 'install', '--yes', '--agents', 'claude');
    expect(has(paths.root, '.claude/skills/plan/SKILL.md')).toBe(true);
    const { stdout } = await ok(paths.root, 'flow', 'delete', 'sample', '--yes');
    expect(stdout).toContain('Removed');
    expect(has(paths.root, '.claude/skills/plan')).toBe(false);
    expect(has(paths.root, '.mcp.json')).toBe(false);
  });

  it('lists templates', async () => {
    const root = makeTempDir();
    const templates = await json<Array<{ name: string; steps: number }>>(root, 'flow', 'templates');
    expect(templates.map((t) => t.name)).toContain('feature');
    expect(templates.find((t) => t.name === 'feature')!.steps).toBe(6);
    expect((await ok(root, 'flow', 'templates')).stdout).toMatch(/feature\s+Feature development\s+6/);
  });

  it('creates a flow from a template with --use', async () => {
    const root = await installedProject();
    await ok(root, 'flow', 'create', 'fixes', '--from', 'bugfix', '--use');
    expect(readJsonFile(root, '.df/fixes/flow.json').source).toMatchObject({ type: 'template', ref: 'bugfix' });
    expect(readJsonFile(root, '.df/local.json').activeFlow).toBe('fixes');
    expect(has(root, '.claude/skills/reproduce-bug/SKILL.md')).toBe(true);
  });

  it('imports a flow from a local directory', async () => {
    const root = await installedProject();
    const source = makeTempProject();
    writeSampleFlow(source);
    const { stdout } = await ok(root, 'flow', 'import', source.flowDir('sample'), '--name', 'imported', '--use');
    expect(stdout).toContain('Imported flow imported (3 steps)');
    expect(has(root, '.claude/skills/plan/SKILL.md')).toBe(true);
  });

  it('validates flows with exit code 1 on errors', async () => {
    const root = await installedProject();
    const valid = await ok(root, 'flow', 'validate');
    expect(valid.stdout).toContain('✔ Flow feature is valid');
    expect((await json(root, 'flow', 'validate', 'feature')).valid).toBe(true);

    fs.rmSync(path.join(root, '.df/feature/steps/plan-feature/SKILL.md.hbs'));
    const invalid = await dfl(root, 'flow', 'validate');
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toContain('✖ Flow feature is invalid');
    expect(invalid.stdout).toContain('has no template');

    const asJson = await dfl(root, 'flow', 'validate', '--json');
    expect(asJson.code).toBe(1);
    const parsed = JSON.parse(asJson.stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.issues[0]).toMatchObject({ level: 'error', step: 'plan-feature', file: '.df/feature/steps/plan-feature/SKILL.md.hbs' });
  });

  it('prints the flow graph with --print', async () => {
    const root = await installedProject();
    await ok(root, 'next');
    const { stdout } = await ok(root, 'flow', 'view', '--print');
    for (const title of ['Spec', 'Plan', 'Implement', 'Verify', 'Review', 'Ship']) expect(stdout).toContain(title);
    const ascii = await ok(root, 'flow', 'view', 'feature', '--print', '--ascii', '--lr', '--zoom', '1');
    expect(ascii.stdout).toContain('Spec');
    expect(ascii.stdout).not.toMatch(/[┌┏─━]/);

    const badZoom = await dfl(root, 'flow', 'view', '--print', '--zoom', 'x');
    expect(badZoom.code).toBe(1);
    expect(badZoom.stderr).toContain('--zoom');
  });

  it('fails with a message for unknown flows', async () => {
    const root = await installedProject();
    for (const args of [
      ['flow', 'use', 'nope'],
      ['flow', 'delete', 'nope', '--yes'],
      ['status', '--flow', 'nope'],
      ['step', 'list', '--flow', 'nope'],
    ]) {
      const result = await dfl(root, ...args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr, args.join(' ')).toMatch(/✖ Flow "nope" not found/);
    }
  });
});

describe('dfl vars', () => {
  it('sets, lists and unsets variables in their scopes', async () => {
    const root = await installedProject();
    const set = await ok(root, 'vars', 'set', 'reviewer', 'octocat');
    expect(set.stdout).toContain('Set reviewer = "octocat" (.df/local.json)');
    expect(set.stdout).toContain('Synced');
    expect(readJsonFile(root, '.df/local.json').vars.reviewer).toBe('octocat');

    await ok(root, 'vars', 'set', 'mainBranch', 'develop');
    expect(readJsonFile(root, '.df/config.json').vars.mainBranch).toBe('develop');
    await ok(root, 'vars', 'set', 'mainBranch', 'trunk', '--personal');
    await ok(root, 'vars', 'set', 'extra', 'x', '--no-sync');

    const { flow, vars } = await json(root, 'vars', 'list');
    expect(flow).toBe('feature');
    const byName = Object.fromEntries(vars.map((v: { name: string }) => [v.name, v]));
    expect(byName.reviewer).toMatchObject({ value: 'octocat', source: 'local', scope: 'personal', declared: true });
    expect(byName.mainBranch).toMatchObject({ value: 'trunk', source: 'local', scope: 'project' });
    expect(byName.testCommand).toMatchObject({ value: 'npm test', source: 'default' });
    expect(byName.extra).toMatchObject({ value: 'x', source: 'project', declared: false });

    const table = await ok(root, 'vars');
    expect(table.stdout).toMatch(/reviewer\s+"octocat"\s+local\.json\s+personal/);

    await ok(root, 'vars', 'unset', 'reviewer');
    expect(readJsonFile(root, '.df/local.json').vars.reviewer).toBeUndefined();
    const nothing = await ok(root, 'vars', 'unset', 'reviewer');
    expect(nothing.stdout).toContain('nothing changed');
  });

  it('marks missing required variables', async () => {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    const install = await ok(paths.root, 'install', '--yes', '--agents', 'claude', '--no-mcp');
    expect(install.stderr).toContain('Required variable "reviewer" has no value');
    const { vars } = await json(paths.root, 'vars', 'list');
    expect(vars.find((v: { name: string }) => v.name === 'reviewer')).toMatchObject({ missing: true, required: true });
    expect((await ok(paths.root, 'vars', 'list')).stdout).toMatch(/✖ reviewer\s+\(missing\)/);
    vi.stubEnv('DFL_VAR_REVIEWER', 'from-env');
    const fromEnv = await json(paths.root, 'vars', 'list');
    expect(fromEnv.vars.find((v: { name: string }) => v.name === 'reviewer')).toMatchObject({ value: 'from-env', source: 'env', missing: false });
  });
});

describe('dfl agents, flow-update, uninstall', () => {
  it('lists agents as JSON and as a table', async () => {
    const root = await installedProject();
    const { agents } = await json<{ agents: Array<{ id: string; selected: boolean; detected: boolean; mcpFile?: string; skillsDir: string }> }>(
      root,
      'agents',
    );
    expect(agents).toHaveLength(9);
    const claude = agents.find((a) => a.id === 'claude')!;
    expect(claude).toMatchObject({ selected: true, detected: true, skillsDir: '.claude/skills', mcpFile: '.mcp.json' });
    expect(agents.find((a) => a.id === 'cursor')).toMatchObject({ selected: false, detected: false });
    const table = await ok(root, 'agents');
    expect(table.stdout).toMatch(/●\s+claude\s+Claude Code\s+\.claude\/skills\//);
    expect(table.stdout).toContain('Notes');
  });

  it('works outside a dfl project', async () => {
    const root = makeTempDir();
    const { agents } = await json(root, 'agents');
    expect(agents.every((a: { selected: boolean }) => !a.selected)).toBe(true);
  });

  it('re-syncs with flow-update / update and uninstalls', async () => {
    const root = await installedProject();
    fs.rmSync(path.join(root, '.claude/skills/spec-feature'), { recursive: true });
    const update = await ok(root, 'flow-update');
    expect(update.stdout).toMatch(/↻ Synced \d+ skills of flow "feature" for Claude Code, OpenAI Codex/);
    expect(has(root, '.claude/skills/spec-feature/SKILL.md')).toBe(true);

    const dry = await ok(root, 'update', '--dry-run');
    expect(dry.stdout).toContain('Would sync');

    const uninstall = await ok(root, 'uninstall', '--yes');
    expect(uninstall.stdout).toContain('Uninstalled dfl');
    expect(has(root, '.claude/skills/spec-feature')).toBe(false);
    expect(has(root, '.mcp.json')).toBe(false);
    expect(has(root, '.df/feature/flow.json')).toBe(true);
  });
});

describe('runCli', () => {
  it('prints the version and help with exit code 0', async () => {
    const root = makeTempDir();
    const version = await dfl(root, '--version');
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(packageVersion());
    expect((await dfl(root, '-v')).stdout.trim()).toBe(packageVersion());

    const help = await dfl(root, '--help');
    expect(help.code).toBe(0);
    for (const command of ['install', 'flow-update|update', 'status', 'next', 'goto', 'reset', 'flow', 'step', 'vars', 'agents', 'mcp']) {
      expect(help.stdout).toContain(command);
    }
    expect((await dfl(root, 'step', '--help')).stdout).toContain('transition');
  });

  it('returns commander exit codes for usage errors', async () => {
    const root = makeTempDir();
    const unknown = await dfl(root, 'frobnicate');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown command 'frobnicate'");
    const missing = await dfl(root, 'goto');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("missing required argument 'step'");
  });

  it('reports a missing project with a hint', async () => {
    const root = makeTempDir();
    const status = await dfl(root, 'status');
    expect(status.code).toBe(1);
    expect(status.stderr).toContain('✖ This project has no flows yet.');
    expect(status.stderr).toContain('dfl install');
    expect(status.stdout).toBe('');
  });

  it('finds the project from DFL_ROOT', async () => {
    const root = await installedProject();
    vi.stubEnv('DFL_ROOT', root);
    let stdout = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    try {
      expect(await runCli(['node', 'dfl', '--no-color', 'status', '--json'])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(stdout).flow).toBe('feature');
  });

  it('accepts global options after the subcommand and a default vars subcommand', async () => {
    const root = await installedProject();
    let stdout = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    try {
      expect(await runCli(['node', 'dfl', 'status', '--json', '--root', root, '--no-color'])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(stdout).current).toBe('spec-feature');
    expect((await json(root, 'vars')).flow).toBe('feature');
  });

  it('reports unexpected errors with a debug hint and prints the stack with DFL_DEBUG=1', async () => {
    const root = await installedProject();
    fs.rmSync(path.join(root, '.df/local.json'));
    fs.mkdirSync(path.join(root, '.df/local.json'));
    const plain = await dfl(root, 'status');
    expect(plain.code).toBe(1);
    expect(plain.stderr).toContain('✖ Unexpected error: EISDIR');
    expect(plain.stderr).toContain('DFL_DEBUG=1');
    expect(plain.stderr).not.toMatch(/\n\s+at /);

    vi.stubEnv('DFL_DEBUG', '1');
    const debug = await dfl(root, 'status');
    expect(debug.code).toBe(1);
    expect(debug.stderr).toMatch(/\n\s+at /);
  });

  it('handles projects created through the core API', async () => {
    const paths = projectPaths(makeTempDir());
    fs.mkdirSync(paths.dfDir);
    writeSampleFlow(paths);
    const { steps } = await json(paths.root, 'step', 'list');
    expect(steps.map((s: { id: string }) => s.id)).toEqual(['plan', 'build', 'review', 'done']);
  });
});
