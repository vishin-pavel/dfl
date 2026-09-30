import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Client, type Transport } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveFlow, setSelectedAgents } from '../src/core/config.js';
import { readFlowDefinition, writeFlowDefinition } from '../src/core/flow.js';
import type { ProjectPaths, StateFile } from '../src/core/types.js';
import { AUTHORING_GUIDE } from '../src/mcp/guide.js';
import { createDflMcpServer, runMcpServer, type DflMcpOptions } from '../src/mcp/server.js';
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
  'sync',
  'transition',
  'update_step',
  'validate_flow',
];

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

/** The sample flow (plan → build → review → done), installed for Claude Code. */
function sampleProject(): ProjectPaths {
  const paths = makeTempProject();
  writeSampleFlow(paths);
  setSelectedAgents(paths, ['claude']);
  return paths;
}

const has = (paths: ProjectPaths, rel: string): boolean => fs.existsSync(path.join(paths.root, ...rel.split('/')));
const readState = (paths: ProjectPaths): StateFile => JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as StateFile;

beforeEach(() => {
  vi.stubEnv('DFL_ROOT', '');
});

afterEach(async () => {
  while (sessions.length > 0) {
    const session = sessions.pop()!;
    await session.client.close();
    await session.server.close();
  }
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
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('get_flow')!.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('get_step')!.inputSchema.required).toEqual(['step']);
    expect(byName.get('delete_step')!.annotations?.destructiveHint).toBe(true);
    expect(byName.get('add_step')!.annotations?.destructiveHint).toBe(false);
    expect(client.getInstructions()).toMatch(/get_status/);
    expect(client.getInstructions()).toMatch(/complete_step/);
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

  it('get_status returns the current step, its events and history', async () => {
    const { ok } = await connect({ root: sampleProject().root });
    expect(await ok('get_status')).toEqual({
      flow: 'sample',
      flowTitle: 'Sample flow',
      current: { id: 'plan', title: 'Plan', description: 'Plan the work', skillName: 'plan', command: '/plan', final: false },
      done: false,
      events: [{ event: 'NEXT', target: 'build', targetTitle: 'Build', targetCommand: '/build' }],
      history: [],
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
  });

  it('the example template of the guide renders into a valid skill', async () => {
    const example = /```handlebars\n([\s\S]*?)```/.exec(AUTHORING_GUIDE)![1]!;
    const { ok } = await connect({ root: sampleProject().root });
    const result = await ok('add_step', { id: 'check-change', after: 'build', template: example });
    expect(result['sync']).not.toBeNull();
    const rendered = result['step']['rendered'] as string;
    expect(rendered).toContain('git diff main...HEAD');
    expect(rendered).toContain('## Flow context');
    expect(rendered).not.toMatch(/\$ARGUMENTS|\$\d|^!`|@\w/m);
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
    expect((await call('transition')).structuredContent).toMatchObject({ code: 'FLOW_DONE' });
  });
});

describe('authoring tools', () => {
  it('add_step, update_step and delete_step edit flow.json, the step dir and the installed skills', async () => {
    const paths = sampleProject();
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
    expect(deleted).toMatchObject({ deleted: 'verify', sync: { removed: ['.claude/skills/verify'] } });
    def = readFlowDefinition(paths, 'sample');
    expect(def.machine.states['build']!.on!['NEXT']).toBe('review');
    expect(def.machine.states['verify']).toBeUndefined();
    expect(has(paths, '.df/sample/steps/verify')).toBe(false);
    expect(has(paths, '.claude/skills/verify')).toBe(false);
    expect(has(paths, '.claude/skills/build/SKILL.md')).toBe(true);
  });

  it('reports a deleted current step and refuses unsafe changes', async () => {
    const paths = sampleProject();
    const { ok, call } = await connect({ root: paths.root });
    await ok('goto_step', { step: 'build' });

    const deleted = await ok('delete_step', { step: 'build' });
    expect(deleted['warnings']).toEqual(expect.arrayContaining([expect.stringMatching(/Step "build" no longer exists/)]));
    expect((await ok('get_status'))['repaired']).toMatch(/falling back to the initial step "plan"/);
    expect(readFlowDefinition(paths, 'sample').machine.states['plan']!.on).toEqual({ NEXT: 'review' });

    await ok('update_step', { step: 'review', on: { NEXT: null } });
    const refused = await call('delete_step', { step: 'review' });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: 'CANNOT_REWIRE' });
    expect(has(paths, '.df/sample/steps/review/SKILL.md.hbs')).toBe(true);
    await ok('delete_step', { step: 'review', force: true });
    expect(readFlowDefinition(paths, 'sample').machine.states['plan']!.on).toBeUndefined();

    const invalid = await call('update_step', { step: 'plan', on: { NEXT: 'nowhere' } });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ code: 'STEP_NOT_FOUND' });
  });

  it('does not sync a flow that is not active', async () => {
    const paths = sampleProject();
    writeSampleFlow(paths, sampleFlowDefinition('other'));
    setActiveFlow(paths, 'sample');
    const { ok } = await connect({ root: paths.root });
    const result = await ok('add_step', { id: 'extra', flow: 'other' });
    expect(result['sync']).toBeNull();
    expect(result['warnings']).toEqual([expect.stringMatching(/Flow "other" is not the active flow \(active: "sample"\)/)]);
    expect(readFlowDefinition(paths, 'other').machine.states['extra']).toBeDefined();
    expect(has(paths, '.claude/skills/extra')).toBe(false);
  });

  it('returns the mutation result with a warning when the sync fails', async () => {
    const paths = sampleProject();
    const { ok } = await connect({ root: paths.root });
    const result = await ok('add_step', { id: 'broken', template: '# Broken {{#if}}\n' });
    expect(result['sync']).toBeNull();
    expect(result['warnings']).toEqual([expect.stringMatching(/re-installing the skills failed: Cannot render/)]);
    expect(readFlowDefinition(paths, 'sample').machine.states['broken']).toBeDefined();
  });

  it('validate_flow reports issues', async () => {
    const paths = sampleProject();
    const { ok } = await connect({ root: paths.root });
    const clean = await ok('validate_flow');
    expect(clean['valid']).toBe(true);
    expect(clean['issues'].map((issue: { level: string }) => issue.level)).toEqual(['warning', 'warning']);
    expect(clean['issues'][0]).toMatchObject({ step: 'plan', file: '.df/sample/flow.json', message: expect.stringMatching(/\/plan/) });

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

  it('reports a missing project', async () => {
    const { call } = await connect({ cwd: makeTempDir() });
    const result = await call('get_status');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/No dfl project found/);
    expect(result.structuredContent).toMatchObject({ code: 'NO_PROJECT' });
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
    expect((step.contents[0] as { text: string }).text).toBe(
      fs.readFileSync(path.join(paths.stepDir('sample', 'build'), 'SKILL.md.hbs'), 'utf8'),
    );
    await expect(client.readResource({ uri: 'dfl://steps/nope' })).rejects.toThrow(/does not exist/);
    await expect(client.readResource({ uri: 'dfl://steps/done' })).rejects.toThrow(/final state/);
  });
});

describe('project root resolution', () => {
  function rootsClient(roots: () => string[]): Client {
    const client = new Client({ name: 'roots-test', version: '0.0.0' }, { capabilities: { roots: { listChanged: true } } });
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

  it('serves 2026-era clients (no roots push API) from the working directory', async () => {
    const paths = sampleProject();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const running = runMcpServer({ cwd: paths.root, stdin, stdout });

    const client = new Client(
      { name: 'modern-test', version: '0.0.0' },
      { capabilities: { roots: {} }, versionNegotiation: { mode: 'auto' } },
    );
    client.setRequestHandler('roots/list', async () => ({ roots: [] }));
    await client.connect(new StreamClientTransport(stdout, stdin));
    expect(client.getProtocolEra()).toBe('modern');
    const result = (await client.callTool({ name: 'get_status', arguments: {} })) as ToolResult;
    expect(result.structuredContent).toMatchObject({ flow: 'sample', current: { id: 'plan' } });

    await client.close();
    await expect(running).resolves.toBeUndefined();
  });
});
