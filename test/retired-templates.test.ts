/**
 * The default template "dev" and the templates dfl no longer ships (feature, bugfix, quick). Uses the
 * real templates dir of the package: retired names are only retired while the package lacks them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DflError } from '../src/core/errors.js';
import {
  RETIRED_FLOW_TEMPLATES,
  copyFlowFromDir,
  createFlow,
  getFlowTemplate,
  listFlowTemplates,
  readFlowDefinition,
  retiredTemplateReplacement,
} from '../src/core/flow.js';
import { retiredTemplateFlows, templateUpdates } from '../src/core/import.js';
import { packageVersion, projectPaths } from '../src/core/paths.js';
import type { ProjectPaths } from '../src/core/types.js';
import { runCli } from '../src/run.js';
import { FIXTURE_FLOWS_DIR } from './helpers/fixture-templates.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

/** Makes the CLI interactive on demand and records the questions it asks (answers: the defaults). */
const prompts = vi.hoisted(() => ({ interactive: false, asked: [] as string[] }));
vi.mock('../src/ui/prompts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/prompts.js')>();
  const ask = (message: string): void => void prompts.asked.push(message);
  return {
    ...actual,
    isInteractive: (options: { yes?: boolean | undefined } = {}) => prompts.interactive && options.yes !== true,
    multiselect: async (options: { message: string; initialValues?: string[] }) => (ask(options.message), options.initialValues ?? []),
    select: async (options: { message: string; initialValue?: string }) => (ask(options.message), options.initialValue),
    confirm: async (options: { message: string; initialValue?: boolean }) => (ask(options.message), options.initialValue ?? false),
    text: async (options: { message: string }) => (ask(options.message), ''),
    intro: () => {},
    outro: (message: string) => void process.stdout.write(`${message}\n`),
    logMessage: (lines: readonly string[]) => void process.stdout.write(`${lines.join('\n')}\n`),
    logWarning: (message: string) => void process.stderr.write(`${message}\n`),
    spinner: () => ({ start: () => {}, stop: () => {}, error: () => {}, message: () => {} }),
  };
});

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

async function ok(root: string, ...args: string[]): Promise<RunResult> {
  const result = await dfl(root, ...args);
  if (result.code !== 0) throw new Error(`dfl ${args.join(' ')} exited ${result.code}\n${result.stderr}\n${result.stdout}`);
  return result;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
}

const RETIRED_MESSAGE = 'dfl no longer ships the flow template "feature"; it was replaced by "dev".';

/** A project with flow `name` created from the retired "feature" template by an earlier dfl (source and digests recorded). */
function projectWithRetiredFlow(name = 'feature', paths: ProjectPaths = makeTempProject()): ProjectPaths {
  copyFlowFromDir(paths, path.join(FIXTURE_FLOWS_DIR, 'feature'), name, { type: 'template', ref: 'feature' });
  return paths;
}

/** Makes the project run dfl through its own dependency (`npx --no-install dfl`). */
function pinDfl(root: string): void {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { '@vishin-pavel/dfl': '^0.1.0' } }));
}

const NOTICE =
  'Flow "feature" was created from the template "feature", which dfl no longer ships (replaced by "dev"). ' +
  'The flow keeps working unchanged; to try the new default flow run `dfl flow create dev --from dev`.';

beforeEach(() => {
  vi.stubEnv('CI', '1');
  vi.stubEnv('DFL_ROOT', '');
  prompts.interactive = false;
  prompts.asked = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirs();
});

describe('the default template', () => {
  it('dfl ships the single template "dev", and none of the retired ones', () => {
    expect(listFlowTemplates().map((template) => template.name)).toEqual(['dev']);
    for (const [name, replacement] of Object.entries(RETIRED_FLOW_TEMPLATES)) {
      expect(fs.existsSync(path.join(FIXTURE_FLOWS_DIR, name, 'flow.json')), name).toBe(true);
      expect(replacement).toBe('dev');
    }
  });

  it('install without flows creates "dev" and makes it the team default', async () => {
    const root = makeTempDir();
    const install = await ok(root, 'install', '--yes', '--agents', 'claude', '--no-mcp');
    const paths = projectPaths(root);
    const def = readFlowDefinition(paths, 'dev');
    expect(def.source).toMatchObject({ type: 'template', ref: 'dev' });
    expect(JSON.parse(fs.readFileSync(paths.configFile, 'utf8')).activeFlow).toBe('dev');
    expect(fs.existsSync(path.join(root, '.claude/skills', def.machine.initial, 'SKILL.md'))).toBe(true);
    expect(install.stdout).toContain('– created from template');
  });

  it('an interactive install uses the only template without asking which flows to start with', async () => {
    const root = makeTempDir();
    prompts.interactive = true;
    vi.stubEnv('CI', '');
    await ok(root, 'install', '--agents', 'claude', '--no-mcp');
    expect(prompts.asked.some((message) => message.includes('Which flows'))).toBe(false);
    expect(prompts.asked.some((message) => message.includes('Which flow should be active'))).toBe(false);
    expect(readFlowDefinition(projectPaths(root), 'dev').source).toMatchObject({ type: 'template', ref: 'dev' });
  });

  it('flow templates lists "dev"; an unknown template names it', async () => {
    const root = makeTempProject().root;
    const templates = JSON.parse((await ok(root, 'flow', 'templates', '--json')).stdout) as Array<{ name: string }>;
    expect(templates.map((template) => template.name)).toEqual(['dev']);
    const unknown = await dfl(root, 'flow', 'create', 'x', '--from', 'nope');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('✖ Unknown flow template "nope".');
    expect(unknown.stderr).toContain('Available templates: dev');
    const install = await dfl(makeTempDir(), 'install', '--yes', '--flow', 'nope');
    expect(install.stderr).toContain('✖ Unknown flow or template "nope".');
    expect(install.stderr).toContain('Templates: dev');
  });
});

describe('retired templates (TEMPLATE_RETIRED)', () => {
  it('only names that the package does not ship are retired', () => {
    expect(retiredTemplateReplacement('feature')).toBe('dev');
    expect(retiredTemplateReplacement('quick')).toBe('dev');
    expect(retiredTemplateReplacement('dev')).toBeUndefined();
    expect(retiredTemplateReplacement('nope')).toBeUndefined();
    // A package that ships "feature" again (as the test fixtures do) makes it a template like any other.
    const shipped = [{ name: 'feature', title: 'Feature', description: '', steps: 6, dir: path.join(FIXTURE_FLOWS_DIR, 'feature') }];
    expect(retiredTemplateReplacement('feature', shipped)).toBeUndefined();
    expect(Object.hasOwn(RETIRED_FLOW_TEMPLATES, 'toString')).toBe(false);
    expect(retiredTemplateReplacement('toString')).toBeUndefined();
  });

  it('getFlowTemplate throws TEMPLATE_RETIRED with what still works and what to do instead', () => {
    const error = thrown(() => getFlowTemplate('bugfix'));
    expect(error).toBeInstanceOf(DflError);
    expect(error).toMatchObject({
      code: 'TEMPLATE_RETIRED',
      message: 'dfl no longer ships the flow template "bugfix"; it was replaced by "dev".',
      hint:
        'Flows created from "bugfix" keep working; they only get no template updates. Start the new flow with ' +
        '`dfl flow create dev --from dev`. To reuse a flow made from "bugfix" in another project, run ' +
        '`dfl flow export <flow>` here, and there `dfl flow import <file>` then `dfl flow use <flow> --project` ' +
        '(a project without .df/ needs `mkdir .df` first).',
    });
    expect(thrown(() => getFlowTemplate('nope'))).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  it('the hint says to use the replacement flow when the project already has a flow of that name', async () => {
    const paths = makeTempProject();
    // A project without "dev": create it.
    expect(thrown(() => getFlowTemplate('bugfix', { paths }))).toMatchObject({
      hint: expect.stringContaining('Start the new flow with `dfl flow create dev --from dev`.'),
    });

    createFlow(paths, 'dev', { from: 'dev' });
    expect(thrown(() => getFlowTemplate('bugfix', { paths }))).toMatchObject({
      code: 'TEMPLATE_RETIRED',
      message: 'dfl no longer ships the flow template "bugfix"; it was replaced by "dev".',
      hint:
        'Flows created from "bugfix" keep working; they only get no template updates. Start the new flow with ' +
        '`dfl flow use dev`. To reuse a flow made from "bugfix" in another project, run ' +
        '`dfl flow export <flow>` here, and there `dfl flow import <file>` then `dfl flow use <flow> --project` ' +
        '(a project without .df/ needs `mkdir .df` first).',
    });
    // Without the project's paths the hint cannot know: it keeps `flow create`.
    expect((thrown(() => getFlowTemplate('bugfix')) as DflError).hint).toContain('`dfl flow create dev --from dev`');

    // flow create --from <retired>, with the project's launcher.
    pinDfl(paths.root);
    const create = await dfl(paths.root, 'flow', 'create', 'x', '--from', 'feature');
    expect(create.code).toBe(1);
    expect(create.stderr).toContain('Start the new flow with `npx --no-install dfl flow use dev`.');
    expect(create.stderr).not.toContain('flow create dev');

    // flow pull of a flow from a retired template.
    projectWithRetiredFlow('legacy', paths);
    const pull = await dfl(paths.root, 'flow', 'pull', 'legacy', '--yes');
    expect(pull.code).toBe(1);
    expect(pull.stderr).toContain(
      'Flow "legacy" keeps working; it only gets no template updates. Start the new flow with `npx --no-install dfl flow use dev`. ' +
        'To reuse the flow in another project, run `npx --no-install dfl flow export legacy` here, and there ' +
        '`npx --no-install dfl flow import <file>` then `npx --no-install dfl flow use legacy --project` (a project without .df/ needs `mkdir .df` first).',
    );

    // install --flow <retired> that the project lacks: install starts the new flow, whether or not it exists.
    const install = await dfl(paths.root, 'install', '--yes', '--flow', 'quick');
    expect(install.code).toBe(1);
    expect(install.stderr).toContain('Start the new flow with `npx --no-install dfl install --flow dev`.');
    expect(install.stderr).toContain('`npx --no-install dfl flow export <flow>` here');
  });

  it('flow create --from <retired> fails and creates nothing', async () => {
    const paths = makeTempProject();
    const result = await dfl(paths.root, 'flow', 'create', 'x', '--from', 'feature');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`✖ ${RETIRED_MESSAGE}`);
    expect(result.stderr).toContain('Flows created from "feature" keep working; they only get no template updates.');
    expect(result.stderr).toContain('`dfl flow create dev --from dev`');
    expect(fs.existsSync(path.join(paths.dfDir, 'x'))).toBe(false);
  });

  it('install --flow <retired> fails before writing anything, unless the project has that flow', async () => {
    const root = makeTempDir();
    pinDfl(root);
    const result = await dfl(root, 'install', '--yes', '--flow', 'quick');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('✖ dfl no longer ships the flow template "quick"; it was replaced by "dev".');
    // The hint spells the commands the way this project runs dfl. Without .df/ only install works, and
    // there is no flow to take to another project.
    expect(result.stderr).toContain('Start the new flow with `npx --no-install dfl install --flow dev`.');
    expect(result.stderr).not.toContain('flow create');
    expect(result.stderr).not.toContain('flow export');
    expect(fs.existsSync(path.join(root, '.df'))).toBe(false);

    // The suggested command works here: it creates "dev" and makes it the team default.
    await ok(root, 'install', '--yes', '--flow', 'dev', '--agents', 'claude', '--no-mcp');
    expect(readFlowDefinition(projectPaths(root), 'dev').source).toMatchObject({ type: 'template', ref: 'dev' });
    expect(JSON.parse(fs.readFileSync(projectPaths(root).configFile, 'utf8')).activeFlow).toBe('dev');

    // A flow of the project with that name is simply activated.
    const paths = projectWithRetiredFlow();
    const install = await ok(paths.root, 'install', '--yes', '--flow', 'feature', '--agents', 'claude', '--no-mcp');
    expect(install.stdout).toContain('Active flow');
    expect(fs.existsSync(path.join(paths.root, '.claude/skills/spec-feature/SKILL.md'))).toBe(true);
  });

  it('flow pull of a flow created from a retired template fails and changes nothing; the flow keeps working', async () => {
    const paths = projectWithRetiredFlow('legacy');
    const before = fs.readFileSync(paths.flowFile('legacy'), 'utf8');
    const pull = await dfl(paths.root, 'flow', 'pull', 'legacy', '--yes');
    expect(pull.code).toBe(1);
    expect(pull.stderr).toContain(`✖ ${RETIRED_MESSAGE}`);
    expect(pull.stderr).toContain('Flow "legacy" keeps working; it only gets no template updates.');
    expect(pull.stderr).toContain('run `dfl flow export legacy` here, and there `dfl flow import <file>` then `dfl flow use legacy --project`');
    expect(fs.readFileSync(paths.flowFile('legacy'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(paths.dfDir, '.dfl-backups'))).toBe(false);

    await ok(paths.root, 'flow', 'use', 'legacy');
    expect((await ok(paths.root, 'flow', 'validate', 'legacy')).stdout).toContain('Flow legacy is valid');
    await ok(paths.root, 'install', '--yes', '--agents', 'claude', '--no-mcp');
    expect((await ok(paths.root, 'next')).stdout).toContain('plan-feature');
  });

  it('the hint works: export the flow here, import it in another project and make it the team default', async () => {
    const paths = projectWithRetiredFlow();
    const file = path.join(makeTempDir('dfl-out-'), 'feature.dfl.json');
    await ok(paths.root, 'flow', 'export', 'feature', '-o', file);

    // A project that already uses dfl.
    const other = makeTempProject();
    createFlow(other, 'dev', { from: 'dev' });
    await ok(other.root, 'flow', 'import', file);
    await ok(other.root, 'flow', 'use', 'feature', '--project');
    expect(readFlowDefinition(other, 'feature').source).toMatchObject({ type: 'template', ref: 'feature' });
    expect(JSON.parse(fs.readFileSync(other.configFile, 'utf8')).activeFlow).toBe('feature');
    expect((await dfl(other.root, 'flow', 'pull', 'feature', '--yes')).stderr).toContain(RETIRED_MESSAGE);

    // A project without .df/: `mkdir .df` first; install then keeps the flow instead of creating "dev".
    const fresh = makeTempDir();
    fs.mkdirSync(path.join(fresh, '.df'));
    await ok(fresh, 'flow', 'import', file);
    await ok(fresh, 'flow', 'use', 'feature', '--project');
    await ok(fresh, 'install', '--yes', '--agents', 'claude', '--no-mcp');
    const freshPaths = projectPaths(fresh);
    expect(JSON.parse(fs.readFileSync(freshPaths.configFile, 'utf8')).activeFlow).toBe('feature');
    expect(fs.existsSync(freshPaths.flowFile('dev'))).toBe(false);
    expect(fs.existsSync(path.join(fresh, '.claude/skills/spec-feature/SKILL.md'))).toBe(true);
  });

  it('naming a missing flow after a retired template points to its replacement', async () => {
    const paths = makeTempProject();
    const result = await dfl(paths.root, 'flow', 'use', 'feature');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('✖ Flow "feature" not found.');
    expect(result.stderr).toContain(
      '"feature" was a prebuilt template that dfl no longer ships; it was replaced by "dev": create a flow from that with `dfl flow create dev --from dev --use`.',
    );

    // A project that has "dev" (creating it would fail with FLOW_EXISTS): switch to it.
    createFlow(paths, 'dev', { from: 'dev' });
    const use = await dfl(paths.root, 'flow', 'use', 'bugfix');
    expect(use.code).toBe(1);
    expect(use.stderr).toContain(
      '"bugfix" was a prebuilt template that dfl no longer ships; it was replaced by "dev": switch to it with `dfl flow use dev`. Flows: dev.',
    );
    expect(use.stderr).not.toContain('flow create dev');

    // With the project's launcher, like TEMPLATE_RETIRED (every requireFlow command: use, export, pull, delete).
    pinDfl(paths.root);
    for (const args of [['use', 'feature'], ['export', 'feature'], ['pull', 'quick', '--yes'], ['delete', 'quick', '--yes']]) {
      const result = await dfl(paths.root, 'flow', ...args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr, args.join(' ')).toContain('switch to it with `npx --no-install dfl flow use dev`.');
      expect(result.stderr, args.join(' ')).not.toContain('flow create dev');
    }
  });
});

describe('the notice about flows from retired templates', () => {
  it('lists the flows whose source is a retired template; template updates leave them out', () => {
    const paths = projectWithRetiredFlow();
    projectWithRetiredFlow('second', paths);
    writeSampleFlow(paths, { ...sampleFlowDefinition('custom'), source: { type: 'created' } });
    writeSampleFlow(paths, { ...sampleFlowDefinition('unknown'), source: { type: 'template', ref: 'nope' } });
    copyFlowFromDir(paths, path.join(FIXTURE_FLOWS_DIR, 'quick'), 'imported', { type: 'local', ref: 'x' });
    expect(retiredTemplateFlows(paths)).toEqual([
      { flow: 'feature', template: 'feature', replacement: 'dev' },
      { flow: 'second', template: 'feature', replacement: 'dev' },
    ]);
    expect(templateUpdates(paths)).toEqual([]);
  });

  it('install and flow-update show it on the first sync by this dfl version only', async () => {
    const paths = projectWithRetiredFlow();
    const first = await ok(paths.root, 'install', '--yes', '--flow', 'feature', '--agents', 'claude', '--no-mcp');
    expect(first.stdout).toContain(`· ${NOTICE}`);
    expect(first.stdout).not.toContain('has changed since');
    expect((await ok(paths.root, 'install', '--yes')).stdout).not.toContain('no longer ships');
    expect((await ok(paths.root, 'flow-update')).stdout).not.toContain('no longer ships');

    // Installed by another dfl version (e.g. before an upgrade): shown once more.
    const manifest = JSON.parse(fs.readFileSync(paths.manifestFile, 'utf8'));
    expect(manifest.dflVersion).toBe(packageVersion());
    fs.writeFileSync(paths.manifestFile, JSON.stringify({ ...manifest, dflVersion: '0.0.1' }));
    expect((await ok(paths.root, 'flow-update')).stdout).toContain(NOTICE);
    expect((await ok(paths.root, 'flow-update')).stdout).not.toContain('no longer ships');

    // A teammate's first install (no installed.json yet) shows it too, with the project's launcher.
    fs.rmSync(paths.manifestFile);
    pinDfl(paths.root);
    const teammate = await ok(paths.root, 'install', '--yes');
    expect(teammate.stdout).toContain('to try the new default flow run `npx --no-install dfl flow create dev --from dev`.');
  });

  it('is shown for every such flow, also in an interactive install, and never fails the command', async () => {
    const paths = projectWithRetiredFlow();
    projectWithRetiredFlow('second', paths);
    prompts.interactive = true;
    vi.stubEnv('CI', '');
    const install = await ok(paths.root, 'install', '--flow', 'feature', '--agents', 'claude', '--no-mcp');
    expect(install.stdout).toContain(NOTICE);
    expect(install.stdout).toContain('Flow "second" was created from the template "feature"');

    // An unreadable flow is skipped by the notice; the sync of the active flow is unaffected.
    fs.writeFileSync(paths.manifestFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(paths.manifestFile, 'utf8')), dflVersion: '0.0.1' }));
    fs.writeFileSync(paths.flowFile('second'), '{ not json');
    prompts.interactive = false;
    const update = await ok(paths.root, 'flow-update');
    expect(update.stdout).toContain(NOTICE);
    expect(update.stdout).not.toContain('Flow "second"');
  });

  it('says to use the replacement flow when the project already has a flow of that name', async () => {
    const paths = projectWithRetiredFlow();
    createFlow(paths, 'dev', { from: 'dev' });
    const install = await ok(paths.root, 'install', '--yes', '--flow', 'feature', '--agents', 'claude', '--no-mcp');
    expect(install.stdout).toContain(
      '· Flow "feature" was created from the template "feature", which dfl no longer ships (replaced by "dev"). ' +
        'The flow keeps working unchanged; to try the new default flow run `dfl flow use dev`.',
    );
    expect(install.stdout).not.toContain('flow create dev');

    // flow-update (with the project's launcher) after another dfl version installed.
    fs.writeFileSync(paths.manifestFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(paths.manifestFile, 'utf8')), dflVersion: '0.0.1' }));
    pinDfl(paths.root);
    const update = await ok(paths.root, 'flow-update', '--dry-run');
    expect(update.stdout).toContain('to try the new default flow run `npx --no-install dfl flow use dev`.');
  });
});
