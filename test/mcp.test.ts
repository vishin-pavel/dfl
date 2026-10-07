import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveFlow, setMcpEnabled, setSelectedAgents } from '../src/core/config.js';
import { readFlowDefinition, writeFlowDefinition } from '../src/core/flow.js';
import { readManifest, syncProject } from '../src/core/sync.js';
import type { ProjectPaths, StateFile } from '../src/core/types.js';
import { setVar } from '../src/core/vars.js';
import { AUTHORING_GUIDE, authoringGuide } from '../src/mcp/guide.js';
import { PROJECT_LOCK_FILE, withProjectLock } from '../src/core/lock.js';
import { createDflMcpServer, runMcpServer, type DflMcpOptions } from '../src/mcp/server.js';
import { commandPrefixForClient, describeFlow, describeStatus, localizeCli } from '../src/mcp/tools.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

const TOOL_NAMES = [
  'add_step',
  'complete_step',
  'delete_step',
  'get_authoring_guide',
  'get_flow',
  'get_status',
  'get_step',
  'goto_step',
  'list_flows',
  'start_task',
  'sync',
  'transition',
  'update_step',
  'validate_flow',
];

const NOT_INSTALLED = 'Skills not installed for you yet; run `dfl install`.';

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, any>;
}

interface Session {
  client: Client;
  server: McpServer;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Calls a tool and fails the test on an error result; returns structuredContent. */
  ok(name: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
}

const sessions: Session[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

async function connect(options: DflMcpOptions, client = new Client({ name: 'test', version: '0.0.0' })): Promise<Session> {
  const server = createDflMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const session: Session = {
    client,
    server,
    call,
    async ok(name, args) {
      const result = await call(name, args);
      if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
      expect(JSON.parse(result.content[0]!.text!)).toEqual(result.structuredContent);
      return result.structuredContent!;
    },
  };
  sessions.push(session);
  return session;
}

/** The sample flow (plan → build → review → done) with Claude Code selected, not installed (no .df/installed.json). */
function sampleProject(): ProjectPaths {
  const paths = makeTempProject();
  writeSampleFlow(paths);
  setSelectedAgents(paths, ['claude']);
  return paths;
}

/** sampleProject after `dfl install` (skills installed, MCP registration off unless `mcp`). */
async function installedProject(options: { mcp?: boolean } = {}): Promise<ProjectPaths> {
  const paths = sampleProject();
  setMcpEnabled(paths, options.mcp ?? false);
  await syncProject(paths);
  return paths;
}

/** Makes `<root>/package.json` depend on dfl, so the project runs it as `npx --no-install dfl`. */
function dependOnDfl(paths: ProjectPaths): void {
  fs.writeFileSync(path.join(paths.root, 'package.json'), JSON.stringify({ name: 'app', devDependencies: { '@vishin-pavel/dfl': '^0.1.0' } }));
}

const has = (paths: ProjectPaths, rel: string): boolean => fs.existsSync(path.join(paths.root, ...rel.split('/')));
const readState = (paths: ProjectPaths): StateFile => JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as StateFile;
const templateOf = (paths: ProjectPaths, step: string): string => path.join(paths.stepDir('sample', step), 'SKILL.md.hbs');

beforeEach(() => {
  vi.stubEnv('DFL_ROOT', '');
});

afterEach(async () => {
  while (sessions.length > 0) {
    const session = sessions.pop()!;
    await session.client.close();
    await session.server.close();
  }
  while (cleanups.length > 0) await cleanups.pop()!();
  vi.unstubAllEnvs();
  cleanupTempDirs();
});

describe('tool list', () => {
  it('registers every tool with described inputs, annotations and instructions', async () => {
    const { client } = await connect({ root: sampleProject().root });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [key, schema] of Object.entries(properties)) expect(schema.description, `${tool.name}.${key}`).toBeTruthy();
      // Every tool that writes says explicitly whether it only adds or also overwrites/deletes.
      if (tool.annotations?.readOnlyHint !== true) expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('get_flow')!.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('get_step')!.inputSchema.required).toEqual(['step']);
    expect(byName.get('delete_step')!.annotations?.destructiveHint).toBe(true);
    expect(byName.get('update_step')!.annotations?.destructiveHint).toBe(true);
    expect(byName.get('sync')!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(byName.get('add_step')!.annotations?.destructiveHint).toBe(false);
    expect(byName.get('transition')!.annotations?.destructiveHint).toBe(false);
    expect(client.getInstructions()).toMatch(/get_status/);
    expect(client.getInstructions()).toMatch(/complete_step/);
    expect(client.getInstructions()).not.toMatch(/slash command/);
  });

  it('accepts transition descriptions in the add_step and update_step schemas', async () => {
    const { client } = await connect({ root: sampleProject().root });
    const { tools } = await client.listTools();
    const on = (name: string): string => JSON.stringify((tools.find((tool) => tool.name === name)!.inputSchema.properties as Record<string, unknown>)['on']);
    expect(on('add_step')).toContain('"target"');
    expect(on('add_step')).toContain('"description"');
    expect(on('update_step')).toContain('"target"');
    expect(on('update_step')).toContain('null');
  });
});

describe('read tools', () => {
  it('get_flow returns steps in order, transitions, vars and the current step', async () => {
    const { ok } = await connect({ root: sampleProject().root });
    const flow = await ok('get_flow');
    expect(flow).toMatchObject({ name: 'sample', title: 'Sample flow', initial: 'plan', active: true, current: 'plan' });
    expect(flow['steps'].map((s: { id: string }) => s.id)).toEqual(['plan', 'build', 'review', 'done']);
    expect(flow['steps'][2]).toEqual({
      id: 'review',
      skillName: 'review',
      title: 'Review',
      description: 'Review it',
      final: false,
      index: 2,
      transitions: [
        { event: 'NEXT', target: 'done' },
        { event: 'CHANGES_REQUESTED', target: 'build', description: 'Reviewer asked for changes' },
      ],
    });
    expect(flow['steps'][3]).toMatchObject({ id: 'done', final: true, transitions: [] });
    expect(flow['vars']).toEqual([
      { name: 'mainBranch', description: 'Main branch', scope: 'project', required: false, hasValue: true },
      { name: 'reviewer', description: 'Reviewer handle', scope: 'personal', required: true, hasValue: false },
    ]);
    expect(flow['skills']).toEqual({ installed: false, upToDate: false, reason: 'skills not installed for you yet; run `dfl install`', warning: NOT_INSTALLED });
    expect(flow).not.toHaveProperty('problem');
  });

  it('list_flows lists every flow and the active one', async () => {
    const paths = sampleProject();
    writeSampleFlow(paths, sampleFlowDefinition('other'));
    setActiveFlow(paths, 'other');
    const { ok } = await connect({ root: paths.root });
    expect(await ok('list_flows')).toEqual({
      active: 'other',
      flows: [
        { name: 'other', title: 'Sample flow', description: 'A sample flow for tests.', steps: 3 },
        { name: 'sample', title: 'Sample flow', description: 'A sample flow for tests.', steps: 3 },
      ],
    });
  });

  it('get_status returns the current step, its events, history and the install state', async () => {
    const { ok } = await connect({ root: sampleProject().root });
    expect(await ok('get_status')).toEqual({
      flow: 'sample',
      flowTitle: 'Sample flow',
      current: { id: 'plan', title: 'Plan', description: 'Plan the work', skillName: 'plan', command: '/plan', final: false },
      done: false,
      events: [{ event: 'NEXT', target: 'build', targetTitle: 'Build', targetCommand: '/build' }],
      history: [],
      skills: { installed: false, upToDate: false, reason: 'skills not installed for you yet; run `dfl install`', warning: NOT_INSTALLED },
    });
  });

  it('get_step returns metadata, template, files and the rendered skill after a sync', async () => {
    const paths = sampleProject();
    const { ok } = await connect({ root: paths.root });
    const step = await ok('get_step', { step: 'build' });
    expect(step).toMatchObject({
      id: 'build',
      skillName: 'build',
      title: 'Build',
      final: false,
      transitions: [
        { event: 'NEXT', target: 'review' },
        { event: 'BACK', target: 'plan' },
      ],
      incoming: [
        { event: 'NEXT', source: 'plan' },
        { event: 'CHANGES_REQUESTED', source: 'review', description: 'Reviewer asked for changes' },
      ],
      templatePath: '.df/sample/steps/build/SKILL.md.hbs',
      rendered: null,
      files: ['SKILL.md.hbs'],
    });
    expect(step['template']).toContain('{{> flow-context}}');

    await ok('sync');
    const synced = await ok('get_step', { step: 'build' });
    expect(synced['rendered']).toMatch(/^---\nname: build\n/);
    expect(synced['rendered']).toContain('## Flow context');
    expect(synced['files']).toEqual(['SKILL.md', 'SKILL.md.hbs']);

    const final = await ok('get_step', { step: 'done' });
    expect(final).toMatchObject({ final: true, templatePath: null, template: null, rendered: null });
  });

  it('get_authoring_guide returns the guide as markdown text and structured content', async () => {
    const { call } = await connect({ root: sampleProject().root });
    const result = await call('get_authoring_guide');
    expect(result.content).toEqual([{ type: 'text', text: AUTHORING_GUIDE }]);
    const guide = result.structuredContent!['guide'] as string;
    expect(guide).toBe(AUTHORING_GUIDE);
    for (const topic of ['{{> flow-context}}', 'vars.', 'step.next', '$ARGUMENTS', 'CHANGES_REQUESTED', 'SKILL.md.hbs', 'allowed-tools']) {
      expect(guide, topic).toContain(topic);
    }
    expect(guide).toContain('\\{{vars.x}}');
    expect(guide).toContain('`dfl vars set');
  });

  it('get_authoring_guide works without a project', async () => {
    const { call } = await connect({ cwd: makeTempDir() });
    const result = await call('get_authoring_guide');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!['guide']).toBe(AUTHORING_GUIDE);
  });

  it('the example template of the guide renders into a valid skill', async () => {
    const example = /```handlebars\n([\s\S]*?)```/.exec(AUTHORING_GUIDE)![1]!;
    expect(example).toBe(/```handlebars\n([\s\S]*?)```/.exec(authoringGuide('npx --no-install dfl'))![1]!);
    const { ok } = await connect({ root: (await installedProject()).root });
    const result = await ok('add_step', { id: 'check-change', after: 'build', template: example });
    expect(result['sync']).not.toBeNull();
    const rendered = result['step']['rendered'] as string;
    expect(rendered).toContain('git diff main...HEAD');
    expect(rendered).toContain('## Flow context');
    expect(rendered).not.toMatch(/\$ARGUMENTS|\$\d|^!`|@\w/m);
  });
});

describe('broken flows', () => {
  function breakTransition(paths: ProjectPaths): void {
    const def = readFlowDefinition(paths, 'sample');
    def.machine.states['plan']!.on = { NEXT: 'ghost-step' };
    writeFlowDefinition(paths, def);
  }

  it('get_flow still describes a flow that is not a valid state machine, and it can be repaired over MCP', async () => {
    const paths = sampleProject();
    breakTransition(paths);
    const { ok, call } = await connect({ root: paths.root });

    const flow = await ok('get_flow');
    expect(flow).toMatchObject({ name: 'sample', current: null });
    expect(flow['steps'][0]).toMatchObject({ id: 'plan', transitions: [{ event: 'NEXT', target: 'ghost-step' }] });
    expect(flow['problem']).toMatch(/ghost-step/);
    expect(flow['problem']).toMatch(/validate_flow/);
    expect(flow['issues']).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: 'error', step: 'plan', message: expect.stringMatching(/"ghost-step"/) })]),
    );

    const status = await call('get_status');
    expect(status.isError).toBe(true);
    expect(status.structuredContent).toMatchObject({ code: 'INVALID_FLOW', hint: expect.stringMatching(/validate_flow.*update_step/) });

    await ok('update_step', { step: 'plan', on: { NEXT: 'build' } });
    const repaired = await ok('get_flow');
    expect(repaired['current']).toBe('plan');
    expect(repaired).not.toHaveProperty('problem');
  });

  it('describeFlow reports the problem and rethrows other errors', () => {
    const paths = sampleProject();
    breakTransition(paths);
    const view = describeFlow(paths);
    expect(view.current).toBeNull();
    expect(view.issues?.length).toBeGreaterThan(0);
    expect(() => describeFlow(paths, 'missing-flow')).toThrow(/not found/);
    expect(() => describeStatus(paths)).toThrow(/not a valid state machine/);
  });
});

describe('runtime tools', () => {
  it('transition, complete_step and goto_step move the flow and persist state.json', async () => {
    const paths = sampleProject();
    const { ok, call } = await connect({ root: paths.root });

    expect(await ok('transition')).toEqual({
      from: 'plan',
      to: 'build',
      event: 'NEXT',
      done: false,
      next: { id: 'build', title: 'Build', command: '/build' },
    });
    expect(readState(paths).flows['sample']!.current).toBe('build');

    const notCurrent = await call('complete_step', { step: 'plan' });
    expect(notCurrent.isError).toBe(true);
    expect(notCurrent.content[0]!.text).toMatch(/not the current step/);
    expect(notCurrent.content[0]!.text).toMatch(/\nHint: /);
    expect(notCurrent.structuredContent).toMatchObject({ code: 'NOT_CURRENT' });

    expect(await ok('complete_step', { step: 'build', event: 'BACK' })).toMatchObject({ from: 'build', to: 'plan', event: 'BACK' });
    expect(await ok('goto_step', { step: 'review' })).toMatchObject({ from: 'plan', to: 'review', event: 'GOTO' });
    expect(readState(paths).flows['sample']!.current).toBe('review');

    const wrongFrom = await call('transition', { from: 'plan' });
    expect(wrongFrom.structuredContent).toMatchObject({ code: 'NOT_CURRENT' });
    const badEvent = await call('transition', { event: 'NOPE' });
    expect(badEvent.isError).toBe(true);
    expect(badEvent.content[0]!.text).toMatch(/Allowed events: NEXT → done, CHANGES_REQUESTED → build/);

    expect(await ok('complete_step', { step: 'review' })).toEqual({
      from: 'review',
      to: 'done',
      event: 'NEXT',
      done: true,
      next: { id: 'done', title: 'Done', command: null },
    });
    const status = await ok('get_status');
    expect(status).toMatchObject({ done: true, current: { id: 'done', command: null, final: true }, events: [] });
    expect(status['history'].map((h: { event: string }) => h.event)).toEqual(['NEXT', 'BACK', 'GOTO', 'NEXT']);
    const done = await call('transition');
    expect(done.structuredContent).toMatchObject({ code: 'FLOW_DONE', hint: expect.stringMatching(/goto_step/) });
  });

  it('uses $name commands for Codex clients and /name for others', async () => {
    const paths = sampleProject();
    const codex = await connect({ root: paths.root }, new Client({ name: 'codex-mcp-client', version: '0.0.0' }));
    expect(await codex.ok('get_status')).toMatchObject({
      current: { command: '$plan' },
      events: [{ event: 'NEXT', targetCommand: '$build' }],
    });
    expect((await codex.ok('transition'))['next']).toEqual({ id: 'build', title: 'Build', command: '$build' });
    expect((await codex.ok('complete_step', { step: 'build' }))['next']).toMatchObject({ command: '$review' });
    expect((await codex.ok('goto_step', { step: 'plan' }))['next']).toMatchObject({ command: '$plan' });

    const claude = await connect({ root: paths.root }, new Client({ name: 'claude-code', version: '0.0.0' }));
    expect((await claude.ok('get_status'))['current']['command']).toBe('/plan');

    expect(commandPrefixForClient('Codex')).toBe('$');
    expect(commandPrefixForClient(undefined)).toBe('/');
  });
});

describe('installed skills state', () => {
  it('get_status and get_flow report missing, stale and current skills', async () => {
    const paths = await installedProject();
    writeSampleFlow(paths, sampleFlowDefinition('other'));
    setActiveFlow(paths, 'sample');
    const { ok, call } = await connect({ root: paths.root });
    expect((await ok('get_status'))['skills']).toEqual({ installed: true, upToDate: true });
    expect((await ok('get_flow'))['skills']).toEqual({ installed: true, upToDate: true });

    fs.appendFileSync(templateOf(paths, 'build'), '\nOne more line.\n');
    const stale = (await ok('get_status'))['skills'];
    expect(stale).toMatchObject({ installed: true, upToDate: false });
    expect(stale['warning']).toMatch(/out of date/);
    expect(stale['warning']).toMatch(/`dfl flow-update` \(or call the sync tool\)/);
    expect((await ok('get_flow'))['skills']).toEqual(stale);

    // A skill of a step that no longer exists (renamed upstream) is told why it fails.
    const ghost = await call('complete_step', { step: 'renamed-away' });
    expect(ghost.structuredContent).toMatchObject({ code: 'STEP_NOT_FOUND', hint: expect.stringMatching(/stale.*flow-update/) });
    const notCurrent = await call('complete_step', { step: 'build' });
    expect(notCurrent.structuredContent).toMatchObject({ code: 'NOT_CURRENT', hint: expect.stringMatching(/flow-update/) });

    await ok('sync');
    expect((await ok('get_status'))['skills']).toEqual({ installed: true, upToDate: true });

    const other = (await ok('get_status', { flow: 'other' }))['skills'];
    expect(other).toMatchObject({ installed: true, upToDate: false, warning: expect.stringMatching(/not the active flow.*`dfl flow use other`/) });
  });
});

describe('authoring tools', () => {
  it('add_step, update_step and delete_step edit flow.json, the step dir and the installed skills', async () => {
    const paths = await installedProject();
    const { ok } = await connect({ root: paths.root });

    const added = await ok('add_step', {
      id: 'test-it',
      title: 'Test',
      description: 'Run the tests after building.',
      after: 'build',
      on: { FAILED: 'build' },
      template: '# Test it\n\nRun {{vars.mainBranch}} tests.\n\n{{> flow-context}}\n',
    });
    let def = readFlowDefinition(paths, 'sample');
    expect(def.machine.states['build']!.on!['NEXT']).toBe('test-it');
    expect(def.machine.states['test-it']).toEqual({
      description: 'Run the tests after building.',
      meta: { title: 'Test' },
      on: { NEXT: 'review', FAILED: 'build' },
    });
    expect(added['step']).toMatchObject({
      id: 'test-it',
      title: 'Test',
      index: 2,
      transitions: [
        { event: 'NEXT', target: 'review' },
        { event: 'FAILED', target: 'build' },
      ],
      incoming: [{ event: 'NEXT', source: 'build' }],
      templatePath: '.df/sample/steps/test-it/SKILL.md.hbs',
    });
    expect(added['step']['rendered']).toContain('Run main tests.');
    expect(added['sync']).toMatchObject({ flow: 'sample', agents: ['claude'] });
    expect(added['sync']['skills']).toEqual(expect.arrayContaining(['plan', 'build', 'test-it', 'review']));
    expect(added['warnings']).toEqual(expect.arrayContaining([expect.stringMatching(/Required variable "reviewer"/)]));
    expect(has(paths, '.df/sample/steps/test-it/SKILL.md.hbs')).toBe(true);
    expect(fs.readFileSync(path.join(paths.root, '.claude/skills/test-it/SKILL.md'), 'utf8')).toContain('Run main tests.');

    const updated = await ok('update_step', {
      step: 'test-it',
      rename: 'verify',
      title: 'Verify',
      template: '# Verify\n\n{{> flow-context}}\n',
      on: { FAILED: null },
    });
    def = readFlowDefinition(paths, 'sample');
    expect(Object.keys(def.machine.states)).toEqual(['plan', 'build', 'verify', 'review', 'done']);
    expect(def.machine.states['build']!.on!['NEXT']).toBe('verify');
    expect(def.machine.states['verify']).toMatchObject({ meta: { title: 'Verify' }, on: { NEXT: 'review' } });
    expect(updated['step']).toMatchObject({ id: 'verify', title: 'Verify', template: '# Verify\n\n{{> flow-context}}\n' });
    expect(updated['sync']['removed']).toEqual(['.claude/skills/test-it']);
    expect(has(paths, '.df/sample/steps/test-it')).toBe(false);
    expect(has(paths, '.claude/skills/test-it')).toBe(false);
    expect(has(paths, '.claude/skills/verify/SKILL.md')).toBe(true);

    const deleted = await ok('delete_step', { step: 'verify' });
    expect(deleted).toMatchObject({
      deleted: 'verify',
      rewired: [{ source: 'build', event: 'NEXT', to: 'review' }],
      dropped: [],
      sync: { removed: ['.claude/skills/verify'] },
    });
    def = readFlowDefinition(paths, 'sample');
    expect(def.machine.states['build']!.on!['NEXT']).toBe('review');
    expect(def.machine.states['verify']).toBeUndefined();
    expect(has(paths, '.df/sample/steps/verify')).toBe(false);
    expect(has(paths, '.claude/skills/verify')).toBe(false);
    expect(has(paths, '.claude/skills/build/SKILL.md')).toBe(true);
  });

  it('sets, keeps and removes transition descriptions', async () => {
    const paths = await installedProject();
    const { ok, call } = await connect({ root: paths.root });

    const added = await ok('add_step', {
      id: 'qa-check',
      after: 'build',
      on: { FAILED: { target: 'build', description: 'QA checklist failed' }, BACK: { target: 'plan' } },
      template: '# QA\n\n{{> flow-context}}\n',
    });
    let states = readFlowDefinition(paths, 'sample').machine.states;
    expect(states['qa-check']!.on).toEqual({ NEXT: 'review', FAILED: { target: 'build', description: 'QA checklist failed' }, BACK: 'plan' });
    expect(added['step']['transitions']).toContainEqual({ event: 'FAILED', target: 'build', description: 'QA checklist failed' });
    const rendered = fs.readFileSync(path.join(paths.root, '.claude/skills/qa-check/SKILL.md'), 'utf8');
    expect(rendered).toMatch(/`FAILED` → .*: QA checklist failed/);

    // A plain string retargets and keeps the description; an object replaces it; null removes the event.
    await ok('update_step', { step: 'qa-check', on: { FAILED: 'plan' } });
    states = readFlowDefinition(paths, 'sample').machine.states;
    expect(states['qa-check']!.on!['FAILED']).toEqual({ target: 'plan', description: 'QA checklist failed' });
    await ok('update_step', { step: 'qa-check', on: { FAILED: { target: 'build', description: 'Tests failed' } } });
    states = readFlowDefinition(paths, 'sample').machine.states;
    expect(states['qa-check']!.on!['FAILED']).toEqual({ target: 'build', description: 'Tests failed' });
    await ok('update_step', { step: 'qa-check', on: { FAILED: null, BACK: null } });
    expect(readFlowDefinition(paths, 'sample').machine.states['qa-check']!.on).toEqual({ NEXT: 'review' });

    const bad = await call('update_step', { step: 'qa-check', on: { FAILED: { target: 'nowhere', description: 'x' } } });
    expect(bad.structuredContent).toMatchObject({ code: 'STEP_NOT_FOUND' });
  });

  it('reports a deleted current step and refuses unsafe changes', async () => {
    const paths = sampleProject();
    const { ok, call } = await connect({ root: paths.root });
    await ok('goto_step', { step: 'build' });

    const deleted = await ok('delete_step', { step: 'build' });
    expect(deleted['warnings']).toEqual(expect.arrayContaining([expect.stringMatching(/"build" was the current step; the flow now continues at "review"/)]));
    expect((await ok('get_status'))['current']['id']).toBe('review');
    expect(readFlowDefinition(paths, 'sample').machine.states['plan']!.on).toEqual({ NEXT: 'review' });

    await ok('update_step', { step: 'review', on: { NEXT: null } });
    const refused = await call('delete_step', { step: 'review' });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: 'CANNOT_REWIRE' });
    expect(has(paths, '.df/sample/steps/review/SKILL.md.hbs')).toBe(true);
    const forced = await ok('delete_step', { step: 'review', force: true });
    expect(forced['dropped']).toEqual([{ source: 'plan', event: 'NEXT', reason: 'no-next' }]);
    expect(forced['warnings']).toEqual(expect.arrayContaining([expect.stringMatching(/Removed the transition plan —NEXT→ review/)]));
    expect(readFlowDefinition(paths, 'sample').machine.states['plan']!.on).toBeUndefined();

    const invalid = await call('update_step', { step: 'plan', on: { NEXT: 'nowhere' } });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ code: 'STEP_NOT_FOUND' });
  });

  it('does not sync a flow that is not active', async () => {
    const paths = await installedProject();
    writeSampleFlow(paths, sampleFlowDefinition('other'));
    setActiveFlow(paths, 'sample');
    const { ok } = await connect({ root: paths.root });
    const result = await ok('add_step', { id: 'extra', flow: 'other' });
    expect(result['sync']).toBeNull();
    expect(result['warnings']).toEqual([
      expect.stringMatching(/Flow "other" is not the active flow \(active: "sample"\).*Run `dfl flow use other`/),
    ]);
    expect(readFlowDefinition(paths, 'other').machine.states['extra']).toBeDefined();
    expect(has(paths, '.claude/skills/extra')).toBe(false);
  });

  it('never installs skills for a developer who did not run dfl install', async () => {
    const paths = sampleProject();
    const { ok } = await connect({ root: paths.root });
    for (const result of [
      await ok('add_step', { id: 'extra', after: 'build' }),
      await ok('update_step', { step: 'extra', title: 'Extra' }),
      await ok('delete_step', { step: 'extra' }),
    ]) {
      expect(result['sync']).toBeNull();
      expect(result['warnings']).toContain('The change was saved, but no skills were synced (skills not installed for you yet; run `dfl install`).');
    }
    expect(has(paths, '.claude')).toBe(false);
    expect(has(paths, '.mcp.json')).toBe(false);
    expect(fs.existsSync(paths.manifestFile)).toBe(false);
    expect(readFlowDefinition(paths, 'sample').machine.states['extra']).toBeUndefined();
  });

  it('refuses a template that does not compile and reports a sync failure as a warning', async () => {
    const paths = await installedProject();
    const { ok, call } = await connect({ root: paths.root });
    const refused = await call('add_step', { id: 'broken', template: '# Broken {{#if}}\n' });
    expect(refused.isError).toBe(true);
    expect(readFlowDefinition(paths, 'sample').machine.states['broken']).toBeUndefined();
    expect(has(paths, '.df/sample/steps/broken')).toBe(false);

    // Compiles, but fails at render time: the change is kept and the failed sync is a warning.
    const result = await ok('add_step', { id: 'runtime-broken', template: '# Broken\n\n{{#with}}x{{/with}}\n' });
    expect(result['sync']).toBeNull();
    expect(result['warnings']).toEqual([expect.stringMatching(/re-installing the skills failed: .*with requires exactly one argument/s)]);
    expect(readFlowDefinition(paths, 'sample').machine.states['runtime-broken']).toBeDefined();
  });

  it('validate_flow reports issues', async () => {
    const paths = sampleProject();
    const { ok } = await connect({ root: paths.root });
    const clean = await ok('validate_flow');
    expect(clean['valid']).toBe(true);
    expect(clean['issues'].every((issue: { level: string }) => issue.level === 'warning')).toBe(true);
    expect(clean['issues']).toEqual(
      expect.arrayContaining([expect.objectContaining({ step: 'plan', file: '.df/sample/flow.json', message: expect.stringMatching(/\/plan/) })]),
    );

    const def = readFlowDefinition(paths, 'sample');
    def.machine.states['plan']!.on = { NEXT: 'missing' };
    writeFlowDefinition(paths, def);
    const result = await ok('validate_flow');
    expect(result['valid']).toBe(false);
    expect(result['issues']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', step: 'plan', file: '.df/sample/flow.json', message: expect.stringMatching(/"missing"/) }),
      ]),
    );
  });
});

describe('personal MCP opt-out', () => {
  it('mutating tools never write MCP configs for a developer who installed with --no-mcp', async () => {
    const paths = await installedProject({ mcp: false });
    expect(readManifest(paths).mcp).toEqual([]);
    const { ok } = await connect({ root: paths.root });
    await ok('add_step', { id: 'extra', after: 'build' });
    await ok('update_step', { step: 'extra', title: 'Extra' });
    await ok('delete_step', { step: 'extra' });
    const report = await ok('sync');
    expect(report['mcp']).toEqual([]);
    expect(has(paths, '.mcp.json')).toBe(false);
    expect(readManifest(paths).mcp).toEqual([]);
  });

  it('leaves a hand-written dfl entry alone', async () => {
    const paths = await installedProject({ mcp: false });
    const mcpJson = `${JSON.stringify(
      {
        mcpServers: {
          dfl: { command: 'node', args: ['/opt/dfl-dev/dist/cli.mjs', 'mcp'], env: { DFL_DEBUG: '1' } },
          other: { command: 'other' },
        },
      },
      null,
      2,
    )}\n`;
    fs.writeFileSync(path.join(paths.root, '.mcp.json'), mcpJson);
    const { ok } = await connect({ root: paths.root });
    await ok('update_step', { step: 'plan', title: 'Plan it' });
    await ok('sync');
    expect(fs.readFileSync(path.join(paths.root, '.mcp.json'), 'utf8')).toBe(mcpJson);
    expect(readManifest(paths).mcp).toEqual([]);
  });
});

describe('per-project dfl (npx)', () => {
  it('names CLI commands the way the project runs dfl', async () => {
    const paths = await installedProject();
    dependOnDfl(paths);
    writeSampleFlow(paths, sampleFlowDefinition('other'));
    setActiveFlow(paths, 'sample');
    const { ok, call } = await connect({ root: paths.root });

    const guide = (await call('get_authoring_guide')).structuredContent!['guide'] as string;
    expect(guide).toContain('`npx --no-install dfl vars set');
    expect(guide).toContain('`npx --no-install dfl flow-update');
    expect(guide).not.toMatch(/`dfl (vars|flow|install|step)/);

    const other = await ok('add_step', { id: 'extra', flow: 'other' });
    expect(other['warnings']).toEqual([expect.stringContaining('Run `npx --no-install dfl flow use other`')]);

    const synced = await ok('sync');
    expect(synced['warnings']).toEqual(expect.arrayContaining([expect.stringContaining('`npx --no-install dfl vars set reviewer <value> --personal`')]));
    expect((await ok('get_status'))['skills']).toEqual({ installed: true, upToDate: true });
    fs.appendFileSync(templateOf(paths, 'plan'), '\nMore.\n');
    expect((await ok('get_status'))['skills']['warning']).toContain('`npx --no-install dfl flow-update`');

    await ok('goto_step', { step: 'done' });
    const done = await call('transition');
    expect(done.structuredContent!['hint']).toContain('`npx --no-install dfl reset`');
    expect(done.content[0]!.text).not.toMatch(/`dfl /);
  });

  it('keeps plain dfl for a global install', async () => {
    const paths = await installedProject();
    const { ok, call } = await connect({ root: paths.root });
    expect((await call('get_authoring_guide')).structuredContent!['guide']).toContain('`dfl vars set');
    await ok('goto_step', { step: 'done' });
    expect((await call('transition')).structuredContent!['hint']).toContain('`dfl reset`');
    expect(localizeCli('Run `dfl install` or `dfl`.', 'npx --no-install dfl')).toBe('Run `npx --no-install dfl install` or `dfl`.');
  });
});

describe('errors', () => {
  it('returns an error result with message and hint for an unknown step', async () => {
    const { call } = await connect({ root: sampleProject().root });
    const result = await call('get_step', { step: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Step "nope" does not exist in flow "sample".\nHint: Steps: plan, build, review, done');
    expect(result.structuredContent).toEqual({
      error: 'Step "nope" does not exist in flow "sample".',
      code: 'STEP_NOT_FOUND',
      hint: 'Steps: plan, build, review, done',
    });
  });

  it('reports a missing project with the searched directory and the MCP remedies', async () => {
    const dir = makeTempDir();
    const { call } = await connect({ cwd: dir });
    const result = await call('get_status');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/No dfl project found/);
    expect(result.structuredContent).toMatchObject({ code: 'NO_PROJECT' });
    expect(result.structuredContent!['error']).toContain(dir);
    expect(result.structuredContent!['error']).toMatch(/does not support roots/);
    expect(result.structuredContent!['hint']).toMatch(/--root/);
    expect(result.structuredContent!['hint']).toMatch(/DFL_ROOT/);
    await expect(sessions.at(-1)!.client.readResource({ uri: 'dfl://flow' })).rejects.toThrow(dir);
  });

  it('names the client roots it searched', async () => {
    const cwd = makeTempDir();
    const other = makeTempDir();
    const client = new Client({ name: 'roots-test', version: '0.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler('roots/list', async () => ({ roots: [{ uri: pathToFileURL(other).href }] }));
    const { call } = await connect({ cwd }, client);
    const result = await call('get_status');
    expect(result.structuredContent).toMatchObject({ code: 'NO_PROJECT' });
    expect(result.structuredContent!['error']).toContain(cwd);
    expect(result.structuredContent!['error']).toContain(other);
  });

  it('picks up file changes between calls', async () => {
    const paths = sampleProject();
    const { ok } = await connect({ root: paths.root });
    expect((await ok('get_flow'))['title']).toBe('Sample flow');
    writeFlowDefinition(paths, { ...readFlowDefinition(paths, 'sample'), title: 'Renamed' });
    expect((await ok('get_flow'))['title']).toBe('Renamed');
  });
});

describe('resources', () => {
  it('serves the active flow.json and step templates', async () => {
    const paths = sampleProject();
    const { client } = await connect({ root: paths.root });

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(['dfl://flow', 'dfl://steps/plan', 'dfl://steps/build', 'dfl://steps/review']);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(['dfl://steps/{id}']);

    const flow = await client.readResource({ uri: 'dfl://flow' });
    expect(flow.contents[0]).toMatchObject({ uri: 'dfl://flow', mimeType: 'application/json' });
    expect(JSON.parse((flow.contents[0] as { text: string }).text)).toEqual(readFlowDefinition(paths, 'sample'));

    const step = await client.readResource({ uri: 'dfl://steps/build' });
    expect((step.contents[0] as { text: string }).text).toBe(fs.readFileSync(templateOf(paths, 'build'), 'utf8'));
    await expect(client.readResource({ uri: 'dfl://steps/nope' })).rejects.toThrow(/does not exist/);
    await expect(client.readResource({ uri: 'dfl://steps/done' })).rejects.toThrow(/final state/);
  });

  it('notifies resources/list_changed after successful step list changes only', async () => {
    const paths = sampleProject();
    const client = new Client({ name: 'notify-test', version: '0.0.0' });
    const changed = vi.fn();
    client.setNotificationHandler('notifications/resources/list_changed', changed);
    const { ok, call } = await connect({ root: paths.root }, client);

    await ok('add_step', { id: 'new-one', after: 'plan' });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    await ok('get_status');
    await ok('transition');
    await ok('goto_step', { step: 'plan' });
    expect((await call('add_step', { id: 'new-one' })).isError).toBe(true);
    await ok('update_step', { step: 'new-one', rename: 'renamed-one' });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    await ok('delete_step', { step: 'renamed-one' });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
    await ok('sync');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(4));
    expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain('dfl://steps/renamed-one');
  });
});

describe('project root resolution', () => {
  function rootsClient(roots: () => string[], name = 'roots-test'): Client {
    const client = new Client({ name, version: '0.0.0' }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler('roots/list', async () => ({
      roots: roots().map((dir) => ({ uri: pathToFileURL(dir).href, name: path.basename(dir) })),
    }));
    return client;
  }

  it('uses the first client root that contains .df/ and refreshes on roots/list_changed', async () => {
    const paths = sampleProject();
    const elsewhere = makeTempDir();
    let roots = [makeTempDir(), paths.root];
    const listed = vi.fn(() => roots);
    const client = rootsClient(listed);
    const { ok, call } = await connect({ cwd: elsewhere }, client);

    expect(await ok('get_flow')).toMatchObject({ name: 'sample' });
    await ok('get_status');
    expect(listed).toHaveBeenCalledTimes(1);

    roots = [elsewhere];
    await client.sendRootsListChanged();
    await vi.waitFor(async () => {
      expect((await call('get_status')).structuredContent).toMatchObject({ code: 'NO_PROJECT' });
    });
    expect(listed).toHaveBeenCalledTimes(2);
  });

  it('finds the project from a client root inside it', async () => {
    const paths = sampleProject();
    const sub = path.join(paths.root, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const { ok } = await connect({ cwd: makeTempDir() }, rootsClient(() => [sub]));
    expect(await ok('get_status')).toMatchObject({ flow: 'sample' });
  });

  it('prefers --root and DFL_ROOT over client roots', async () => {
    const paths = sampleProject();
    const other = makeTempProject();
    writeSampleFlow(other, sampleFlowDefinition('second'));
    const { ok } = await connect({ root: other.root }, rootsClient(() => [paths.root]));
    expect((await ok('get_flow'))['name']).toBe('second');

    vi.stubEnv('DFL_ROOT', other.root);
    const env = await connect({ cwd: makeTempDir() }, rootsClient(() => [paths.root]));
    expect((await env.ok('get_flow'))['name']).toBe('second');
  });

  it('falls back to the working directory', async () => {
    const paths = sampleProject();
    const { ok } = await connect({ cwd: path.join(paths.root, '.df') });
    expect((await ok('get_flow'))['name']).toBe('sample');
  });

  it('names --root and DFL_ROOT when an explicit root has no project', async () => {
    const { call } = await connect({ root: makeTempDir() });
    const result = await call('get_status');
    expect(result.structuredContent).toMatchObject({ code: 'NO_PROJECT', hint: expect.stringMatching(/--root.*DFL_ROOT/) });
  });
});

describe('project lock', () => {
  function holdLock(paths: ProjectPaths, info: Record<string, unknown>): string {
    const file = path.join(paths.dfDir, PROJECT_LOCK_FILE);
    fs.writeFileSync(file, JSON.stringify(info));
    return file;
  }

  /** A pid that is certainly not running any more. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    return Number(child.stdout);
  }

  it('waits for a lock held by a live process and releases its own', async () => {
    const paths = sampleProject();
    const file = holdLock(paths, { pid: process.pid, host: os.hostname(), token: 'someone-else' });
    const order: string[] = [];
    const released = new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push('released');
        fs.unlinkSync(file);
        resolve();
      }, 150),
    );
    await withProjectLock(paths, () => {
      order.push('ran');
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ pid: process.pid });
    });
    await released;
    expect(order).toEqual(['released', 'ran']);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('takes over an abandoned lock and gives up on a live one after the timeout', async () => {
    const paths = sampleProject();
    const file = holdLock(paths, { pid: deadPid(), host: os.hostname(), token: 'dead' });
    await expect(withProjectLock(paths, () => 'done', { timeoutMs: 1000 })).resolves.toBe('done');
    expect(fs.existsSync(file)).toBe(false);

    holdLock(paths, { pid: process.pid, host: os.hostname(), token: 'busy' });
    await expect(withProjectLock(paths, () => 'never', { timeoutMs: 50 })).rejects.toMatchObject({ code: 'LOCKED' });
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(file, old, old);
    await expect(withProjectLock(paths, () => 'stolen', { timeoutMs: 50 })).resolves.toBe('stolen');

    fs.mkdirSync(file);
    await expect(withProjectLock(paths, () => 'never')).rejects.toMatchObject({ code: 'LOCKED', message: expect.stringMatching(/not a regular file/) });
  });

  it('MCP mutations wait for the lock of another process; reads do not', async () => {
    const paths = sampleProject();
    const file = holdLock(paths, { pid: process.pid, host: os.hostname(), token: 'other-process' });
    const { ok } = await connect({ root: paths.root });
    let added = false;
    const adding = ok('add_step', { id: 'extra', after: 'build' }).then((result) => {
      added = true;
      return result;
    });
    expect((await ok('get_status'))['current']['id']).toBe('plan');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(added).toBe(false);
    expect(readFlowDefinition(paths, 'sample').machine.states['extra']).toBeUndefined();
    fs.unlinkSync(file);
    expect((await adding)['step']['id']).toBe('extra');
    expect(fs.existsSync(file)).toBe(false);
  });

  /** The source can run in a child process through Node's type stripping plus a `.js` → `.ts` resolve hook. */
  const canRunTs = Boolean((process.features as { typescript?: unknown }).typescript) && 'registerHooks' in nodeModule;

  it.skipIf(!canRunTs)('serializes mutations of two dfl mcp processes on one project', async () => {
    const paths = await installedProject();
    const loader = path.join(makeTempDir(), 'ts-loader.mjs');
    fs.writeFileSync(
      loader,
      [
        "import fs from 'node:fs';",
        "import { registerHooks } from 'node:module';",
        "import { fileURLToPath } from 'node:url';",
        'registerHooks({',
        '  resolve(specifier, context, next) {',
        "    if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {",
        "      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);",
        '      if (fs.existsSync(fileURLToPath(url))) return next(url.href, context);',
        '    }',
        '    return next(specifier, context);',
        '  },',
        '});',
      ].join('\n'),
    );
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const start = async (): Promise<Client> => {
      const client = new Client({ name: 'race', version: '0.0.0' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--no-warnings', '--import', pathToFileURL(loader).href, cli, 'mcp'],
          cwd: paths.root,
          env: { ...getDefaultEnvironment(), DFL_ROOT: '' },
          stderr: 'pipe',
        }),
      );
      cleanups.push(() => client.close());
      return client;
    };
    const [a, b] = await Promise.all([start(), start()]);
    const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
      (await client.callTool({ name, arguments: args })) as ToolResult;

    for (let i = 0; i < 5; i++) {
      const results = await Promise.all([
        call(a, 'add_step', { id: `a-${i}`, after: 'plan' }),
        call(b, 'add_step', { id: `b-${i}`, after: 'plan' }),
      ]);
      for (const result of results) expect(result.isError, result.content[0]?.text).toBeFalsy();
    }
    const states = Object.keys(readFlowDefinition(paths, 'sample').machine.states);
    for (let i = 0; i < 5; i++) expect(states).toEqual(expect.arrayContaining([`a-${i}`, `b-${i}`]));
    const validation = (await call(a, 'validate_flow', {})).structuredContent!;
    expect(JSON.stringify(validation['issues'])).not.toMatch(/does not belong to any step/);

    await Promise.all([call(a, 'update_step', { step: 'build', title: 'Build A' }), call(b, 'update_step', { step: 'review', title: 'Review B' })]);
    const def = readFlowDefinition(paths, 'sample');
    expect(def.machine.states['build']!.meta?.title).toBe('Build A');
    expect(def.machine.states['review']!.meta?.title).toBe('Review B');

    const completions = await Promise.all([call(a, 'complete_step', { step: 'plan' }), call(b, 'complete_step', { step: 'plan' })]);
    expect(completions.filter((result) => !result.isError)).toHaveLength(1);
    expect(completions.filter((result) => result.isError)[0]!.structuredContent).toMatchObject({ code: 'NOT_CURRENT' });
    expect(readState(paths).flows['sample']!.history).toHaveLength(1);
  });
});

describe('runMcpServer', () => {
  /** Newline-delimited JSON-RPC over a pair of streams (the client side of stdio). */
  class StreamClientTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: Transport['onmessage'];
    readonly input: PassThrough;
    readonly output: PassThrough;
    #buffer = '';

    constructor(input: PassThrough, output: PassThrough) {
      this.input = input;
      this.output = output;
    }

    async start(): Promise<void> {
      this.input.on('data', (chunk: Buffer) => {
        this.#buffer += chunk.toString('utf8');
        let index: number;
        while ((index = this.#buffer.indexOf('\n')) >= 0) {
          const line = this.#buffer.slice(0, index);
          this.#buffer = this.#buffer.slice(index + 1);
          if (line.trim()) this.onmessage?.(JSON.parse(line));
        }
      });
    }

    async send(message: Parameters<Transport['send']>[0]): Promise<void> {
      this.output.write(`${JSON.stringify(message)}\n`);
    }

    async close(): Promise<void> {
      this.output.end();
      this.onclose?.();
    }
  }

  interface Served {
    client: Client;
    close(): Promise<void>;
  }

  async function serve(options: DflMcpOptions, client: Client): Promise<Served> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const running = runMcpServer({ ...options, stdin, stdout });
    await client.connect(new StreamClientTransport(stdout, stdin));
    return {
      client,
      async close() {
        await client.close();
        await expect(running).resolves.toBeUndefined();
      },
    };
  }

  /** A 2026-07-28 client that answers roots requests with `roots()`. */
  function modernClient(roots: () => string[], name = 'modern-test'): Client {
    const client = new Client({ name, version: '0.0.0' }, { capabilities: { roots: { listChanged: true } }, versionNegotiation: { mode: 'auto' } });
    client.setRequestHandler('roots/list', async () => ({ roots: roots().map((dir) => ({ uri: pathToFileURL(dir).href })) }));
    return client;
  }

  it('serves over stdio streams and resolves when stdin ends', async () => {
    const paths = sampleProject();
    const signalListeners = process.listenerCount('SIGTERM');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const running = runMcpServer({ root: paths.root, stdin, stdout });
    expect(process.listenerCount('SIGTERM')).toBe(signalListeners + 1);

    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(new StreamClientTransport(stdout, stdin));
    const result = (await client.callTool({ name: 'get_status', arguments: {} })) as ToolResult;
    expect(result.structuredContent).toMatchObject({ flow: 'sample', current: { id: 'plan' } });

    await client.close();
    await expect(running).resolves.toBeUndefined();
    expect(process.listenerCount('SIGTERM')).toBe(signalListeners);
  });

  it('serves 2026-era clients from the working directory', async () => {
    const paths = sampleProject();
    const served = await serve({ cwd: paths.root }, modernClient(() => []));
    expect(served.client.getProtocolEra()).toBe('modern');
    const result = (await served.client.callTool({ name: 'get_status', arguments: {} })) as ToolResult;
    expect(result.structuredContent).toMatchObject({ flow: 'sample', current: { id: 'plan' } });
    await served.close();
  });

  it('asks 2026-era clients for their roots (input_required) and keeps them for the connection', async () => {
    const paths = sampleProject();
    const listed = vi.fn(() => [makeTempDir(), paths.root]);
    const served = await serve({ cwd: makeTempDir() }, modernClient(listed));
    expect(served.client.getProtocolEra()).toBe('modern');

    const status = (await served.client.callTool({ name: 'get_status', arguments: {} })) as ToolResult;
    expect(status.isError, status.content[0]?.text).toBeFalsy();
    expect(status.structuredContent).toMatchObject({ flow: 'sample', current: { id: 'plan' } });
    expect(listed).toHaveBeenCalledTimes(1);

    const flow = await served.client.readResource({ uri: 'dfl://flow' });
    expect(JSON.parse((flow.contents[0] as { text: string }).text)).toEqual(readFlowDefinition(paths, 'sample'));
    expect((await served.client.listResources()).resources.map((r) => r.uri)).toContain('dfl://steps/build');
    expect(listed).toHaveBeenCalledTimes(1);
    await served.close();
  });

  it('reads resources and finds a project above a client root for 2026-era clients', async () => {
    const paths = sampleProject();
    const sub = path.join(paths.root, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const served = await serve({ cwd: makeTempDir() }, modernClient(() => [sub]));
    const step = await served.client.readResource({ uri: 'dfl://steps/build' });
    expect((step.contents[0] as { text: string }).text).toBe(fs.readFileSync(templateOf(paths, 'build'), 'utf8'));
    await served.close();
  });

  it('reports the searched roots to 2026-era clients without a project', async () => {
    const cwd = makeTempDir();
    const other = makeTempDir();
    const served = await serve({ cwd }, modernClient(() => [other]));
    const result = (await served.client.callTool({ name: 'get_status', arguments: {} })) as ToolResult;
    expect(result.structuredContent).toMatchObject({ code: 'NO_PROJECT' });
    expect(result.structuredContent!['error']).toContain(other);
    await served.close();
  });

  it('uses $name commands for a 2026-era Codex client', async () => {
    const paths = sampleProject();
    const served = await serve({ root: paths.root }, modernClient(() => [], 'codex-mcp-client'));
    const result = (await served.client.callTool({ name: 'get_status', arguments: {} })) as ToolResult;
    expect(result.structuredContent).toMatchObject({ current: { command: '$plan' } });
    await served.close();
  });
});

describe('guide', () => {
  it('spells CLI commands with the given launcher', () => {
    const guide = authoringGuide('npx --no-install dfl');
    expect(guide).toContain('`npx --no-install dfl vars set');
    expect(guide).toContain('`npx --no-install dfl flow-update');
    expect(guide).not.toMatch(/(^|[^x] )`dfl (vars|flow)/m);
    expect(AUTHORING_GUIDE).toBe(authoringGuide('dfl'));
    expect(AUTHORING_GUIDE).toContain('"description": "Tests failed"');
  });

  it('explains flows tracked in Jira: task data arrives at runtime and is never templated', () => {
    const guide = authoringGuide('npx --no-install dfl');
    const start = guide.indexOf('\n## 10. Flows tracked in Jira\n');
    expect(start).toBeGreaterThan(guide.indexOf('\n## 9. Workflow\n'));
    const section = guide.slice(start).replace(/\s+/g, ' ');
    expect(section).toContain('`get_status` returns it in `task`');
    expect(section).toContain('There is no `task` in the template context: never template it.');
    expect(section).toContain('records it with `params` of `complete_step`');
    expect(section).toContain('`npx --no-install dfl next <EVENT> --from <step> --task <key> --set specPath=docs/specs/csv-export.md`');
    expect(section).toContain('`start_task` (the built-in `/init-task` skill, CLI `npx --no-install dfl task start <ticket>`)');
    expect(section).toContain('"If `get_status` returned a task with a branch, you are already on the working branch: skip this step."');
    expect(section).toContain('`npx --no-install dfl tracker map`');
    // The guide's only Handlebars example stays the one of section 8.
    expect(guide.match(/```handlebars/g)).toHaveLength(1);
  });
});

describe('integration fixes', () => {
  it('add_step reports where an auto-placed step went', async () => {
    const paths = sampleProject();
    const s = await connect({ root: paths.root });
    const added = await s.ok('add_step', { id: 'qa', title: 'QA' });
    expect(added['placement']).toMatchObject({ event: 'NEXT', after: 'review', auto: true, initial: false, rewired: ['review'] });
    const explicit = await s.ok('add_step', { id: 'lint', after: 'build' });
    expect(explicit['placement']).toMatchObject({ after: 'build', auto: false });
  });

  it('rejects flow arguments that are not flow names before touching the disk', async () => {
    const paths = sampleProject();
    const s = await connect({ root: paths.root });
    for (const flow of ['../sample', 'Sample', 'a/b']) {
      const result = await s.call('get_flow', { flow });
      expect(result.isError, flow).toBe(true);
    }
    expect((await s.ok('get_flow', { flow: 'sample' }))['name']).toBe('sample');
  });

  it('transition results say when the stored step was repaired first', async () => {
    const paths = sampleProject();
    fs.writeFileSync(
      paths.stateFile,
      JSON.stringify({ version: 1, flows: { sample: { current: 'gone', history: [], updatedAt: new Date().toISOString() } } }),
    );
    const s = await connect({ root: paths.root });
    const moved = await s.ok('transition', {});
    expect(moved).toMatchObject({ from: 'plan', to: 'build' });
    expect(moved['repaired']).toMatch(/gone/);
    const again = await s.ok('transition', {});
    expect(again['repaired']).toBeUndefined();
  });
});

describe('recheck fixes', () => {
  it('gives flow.json load errors their own hint: get_flow and update_step cannot repair them (engine-mcp-4)', async () => {
    const paths = sampleProject();
    setActiveFlow(paths, 'sample', 'project');
    fs.cpSync(paths.flowDir('sample'), paths.flowDir('sample2'), { recursive: true }); // flow.json name "sample" ≠ dir
    const { call } = await connect({ root: paths.root });
    for (const [tool, args] of [
      ['get_flow', { flow: 'sample2' }],
      ['get_status', { flow: 'sample2' }],
      ['update_step', { flow: 'sample2', step: 'plan', title: 'x' }],
      ['complete_step', { flow: 'sample2', step: 'plan' }],
    ] as const) {
      const result = await call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.structuredContent, tool).toMatchObject({ code: 'INVALID_FLOW' });
      const hint = String(result.structuredContent!['hint']);
      expect(hint, tool).toMatch(/Set "name": "sample2" in \.df\/sample2\/flow\.json/);
      expect(hint, tool).toMatch(/edit \.df\/sample2\/flow\.json directly/);
      expect(hint, tool).not.toMatch(/get_flow still shows/);
    }

    // A schema error in the active flow: sync gets the file hint too.
    fs.writeFileSync(paths.flowFile('sample'), JSON.stringify({ name: 'sample', machine: { initial: 'plan' } }));
    const sync = await call('sync');
    expect(sync.structuredContent).toMatchObject({ code: 'INVALID_FLOW', hint: expect.stringMatching(/edit \.df\/sample\/flow\.json directly/) });
  });

  it('get_status of a skill of the previous flow says its skills are the installed ones (cli-content-tui-1)', async () => {
    const paths = await installedProject();
    writeSampleFlow(paths, sampleFlowDefinition('other'));
    setActiveFlow(paths, 'other', 'project'); // the team default changed with a git pull
    const { ok } = await connect({ root: paths.root });
    const skills = (await ok('get_status', { flow: 'sample' }))['skills'];
    expect(skills).toMatchObject({
      installed: true,
      upToDate: false,
      reason: 'the installed skills are for flow "sample" but the active flow is "other"',
    });
    expect(skills['warning']).toMatch(/`dfl flow-update` to install the skills of "other", or `dfl flow use sample`/);
    expect(skills['warning']).not.toMatch(/not installed/);
    // A flow whose skills are not installed keeps the "not the active flow" answer.
    writeSampleFlow(paths, sampleFlowDefinition('third'));
    expect((await ok('get_status', { flow: 'third' }))['skills']['warning']).toMatch(/not the active flow.*`dfl flow use third`/);
  });

  it('a sync without selected agents does not make the skills count as installed (engine-mcp-3)', async () => {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    const { ok } = await connect({ root: paths.root });
    const report = await ok('sync');
    expect(report['agents']).toEqual([]);
    expect(fs.existsSync(paths.manifestFile)).toBe(true);
    expect((await ok('get_status'))['skills']).toMatchObject({ installed: false, upToDate: false, warning: NOT_INSTALLED });
    const added = await ok('add_step', { id: 'extra', after: 'build' });
    expect(added['sync']).toBeNull();
  });

  it('get_status tells how to recover from an unreadable manifest (safety-4)', async () => {
    const paths = await installedProject();
    fs.writeFileSync(paths.manifestFile, '{"skills": [');
    const { ok, call } = await connect({ root: paths.root });
    const skills = (await ok('get_status'))['skills'];
    expect(skills).toMatchObject({ installed: true, upToDate: false });
    expect(skills['warning']).toMatch(/Delete \.df\/installed\.json and run `dfl install` again\.$/);
    const sync = await call('sync');
    expect(sync.structuredContent).toMatchObject({ code: 'INVALID_MANIFEST', hint: expect.stringMatching(/Delete the file and run `dfl install`/) });
  });
});
