import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMcpEnabled, setSelectedAgents } from '../src/core/config.js';
import { currentBranch } from '../src/core/git.js';
import { PROJECT_LOCK_FILE } from '../src/core/lock.js';
import { syncProject } from '../src/core/sync.js';
import type { ProjectPaths } from '../src/core/types.js';
import { SERVER_INSTRUCTIONS, createDflMcpServer } from '../src/mcp/server.js';
import { describeFlow, describeStatus } from '../src/mcp/tools.js';
import { createFakeJira, credentialEnv, type FakeJira, type FakeJiraOptions, type FakeRoute } from './helpers/fake-jira.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, any>;
}

interface Session {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Calls a tool and fails the test on an error result; returns structuredContent. */
  ok(name: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
  /** Calls a tool that must fail; returns structuredContent ({ error, code, hint }). */
  fail(name: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
}

const BRANCH = 'ABC-1-export-orders-as-csv';
const MAPPING = { plan: 'In Progress', build: 'In Progress', review: 'In Review', done: 'Done' };

const closers: Array<() => Promise<void>> = [];
let jira: FakeJira | undefined;

beforeEach(() => {
  // Isolate from the developer's git config, dfl credentials and environment.
  const home = makeTempDir('dfl-git-home-');
  fs.writeFileSync(path.join(home, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(home, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('DFL_CONFIG_DIR', makeTempDir('dfl-config-'));
  vi.stubEnv('DFL_ROOT', '');
  for (const name of ['DFL_JIRA_URL', 'DFL_JIRA_EMAIL', 'DFL_JIRA_TOKEN', 'DFL_TRACKER_TIMEOUT_MS', 'DFL_DEBUG']) vi.stubEnv(name, undefined);
});

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  vi.unstubAllEnvs();
  await jira?.close();
  jira = undefined;
  cleanupTempDirs();
});

async function connect(paths: ProjectPaths, clientName = 'test'): Promise<Session> {
  const server: McpServer = createDflMcpServer({ root: paths.root });
  const client = new Client({ name: clientName, version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return {
    client,
    call,
    async ok(name, args) {
      const result = await call(name, args);
      if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
      expect(JSON.parse(result.content[0]!.text!)).toEqual(result.structuredContent);
      return result.structuredContent!;
    },
    async fail(name, args) {
      const result = await call(name, args);
      expect(result.isError, `${name} should fail`).toBe(true);
      return result.structuredContent!;
    },
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=dfl', '-c', 'user.email=dfl@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeTracker(paths: ProjectPaths, fake: FakeJira, overrides: Record<string, unknown> = {}): void {
  const config = {
    version: 1,
    provider: 'jira',
    jira: { baseUrl: fake.url, projectKeys: ['ABC'], defaultProjectKey: 'ABC' },
    branch: { from: 'main' },
    fields: { branch: 'customfield_10042', specPath: 'customfield_10077' },
    flows: { sample: { statuses: MAPPING } },
    ...overrides,
  };
  fs.writeFileSync(paths.trackerFile, `${JSON.stringify(config, null, 2)}\n`);
}

/** A git repository on main (everything committed) with the sample flow tracked in a fake Jira. */
async function trackedProject(
  options: { tracker?: Record<string, unknown>; jira?: FakeJiraOptions; credentials?: boolean; tracked?: boolean } = {},
): Promise<{ paths: ProjectPaths; jira: FakeJira }> {
  jira = await createFakeJira({
    issues: [
      { key: 'ABC-1', id: '10231', summary: 'Export orders as CSV' },
      { key: 'ABC-2', id: '10232', summary: 'Second ticket' },
    ],
    ...options.jira,
  });
  const paths = makeTempProject();
  writeSampleFlow(paths);
  if (options.tracked !== false) writeTracker(paths, jira, options.tracker);
  git(paths.root, 'init', '-q', '-b', 'main');
  git(paths.root, 'add', '-A');
  git(paths.root, 'commit', '-q', '-m', 'init');
  if (options.credentials !== false) for (const [name, value] of Object.entries(credentialEnv(jira))) vi.stubEnv(name, value);
  return { paths, jira };
}

function routes(fake: FakeJira): Array<FakeRoute | undefined> {
  return fake.requests.map((r) => r.route);
}

function recordOf(fake: FakeJira, key = 'ABC-1'): Record<string, any> {
  return fake.issue(key).properties['dfl.run'] as Record<string, any>;
}

function holdLock(paths: ProjectPaths): string {
  const file = path.join(paths.dfDir, PROJECT_LOCK_FILE);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'another-process' }));
  return file;
}

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const readStateText = (paths: ProjectPaths): string | undefined => (fs.existsSync(paths.stateFile) ? fs.readFileSync(paths.stateFile, 'utf8') : undefined);

// ---------------------------------------------------------------------------

describe('tracker tools: schema', () => {
  it('registers start_task and the task arguments with open-world annotations', async () => {
    const { paths } = await trackedProject();
    const { client } = await connect(paths);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const props = (name: string): Record<string, { description?: string }> =>
      (byName.get(name)!.inputSchema.properties ?? {}) as Record<string, { description?: string }>;

    const start = byName.get('start_task')!;
    expect(start.title).toBe('Start task');
    expect(start.inputSchema.required).toEqual(['task']);
    expect(Object.keys(props('start_task')).sort()).toEqual(['branch', 'flow', 'slug', 'step', 'task']);
    expect(JSON.stringify(props('start_task')['branch'])).toContain('"create"');
    expect(start.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(start.description).toMatch(/only call it when the user asked/i);

    expect(Object.keys(props('get_status')).sort()).toEqual(['flow', 'task']);
    expect(byName.get('get_status')!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    for (const name of ['transition', 'complete_step', 'goto_step']) {
      expect(props(name), name).toHaveProperty('task');
      expect(props(name), name).toHaveProperty('params');
      expect(props(name)['task']!.description, name).toMatch(/task\.key you got from get_status/);
      expect(byName.get(name)!.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    }
    // Tools that never touch Jira keep a closed world.
    expect(byName.get('get_flow')!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(byName.get('add_step')!.annotations).toMatchObject({ openWorldHint: false });

    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).toMatch(/tracked in Jira, get_status returns a "task" with "instructions".*start_task only when the user asks/);
    expect(SERVER_INSTRUCTIONS).toMatch(/Every tool except list_flows, sync and get_authoring_guide accepts an optional "flow"/);
  });
});

describe('tracker tools: untracked flows', () => {
  it('return byte-identical results without a tracker, and say when a ticket was not used', async () => {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    const { ok, call } = await connect(paths);

    const status = await call('get_status');
    expect(status.content[0]!.text).toBe(JSON.stringify(describeStatus(paths), null, 2));
    expect(status.structuredContent).not.toHaveProperty('task');
    const flow = await call('get_flow');
    expect(flow.content[0]!.text).toBe(JSON.stringify(describeFlow(paths), null, 2));
    expect(flow.structuredContent).not.toHaveProperty('tracked');

    const moved = await ok('transition', { from: 'plan' });
    expect(moved).toEqual({ from: 'plan', to: 'build', event: 'NEXT', done: false, next: { id: 'build', title: 'Build', command: '/build' } });
    expect(await ok('complete_step', { step: 'build' })).not.toHaveProperty('task');
    expect(await ok('goto_step', { step: 'plan' })).not.toHaveProperty('task');
    // An event without "from" is fine for untracked flows.
    expect(await ok('transition')).toMatchObject({ from: 'plan', to: 'build' });

    const note = { tracked: false, message: 'No tracker is configured for flow "sample"; the ticket was not used.' };
    expect((await ok('get_status', { task: 'ABC-1' }))['task']).toEqual(note);
    const completed = await ok('complete_step', { step: 'build', task: 'ABC-1', params: { specPath: 'x.md' } });
    expect(completed).toMatchObject({ from: 'build', to: 'review', task: note });
    expect((await ok('goto_step', { step: 'build', task: 'ABC-1' }))['task']).toEqual(note);
    expect((await ok('transition', { task: 'ABC-1' }))['task']).toEqual(note);
    expect(JSON.parse(readStateText(paths)!).flows['sample'].current).toBe('review');

    const start = await call('start_task', { task: 'ABC-1' });
    expect(start.isError).toBe(true);
    expect(start.structuredContent).toMatchObject({ code: 'TRACKER_NOT_CONFIGURED', hint: expect.stringContaining('`dfl tracker init`') });
  });

  it('leave a flow the tracker config does not track alone, without network', async () => {
    const { paths, jira: fake } = await trackedProject();
    writeSampleFlow(paths, sampleFlowDefinition('other'));
    const { ok, call } = await connect(paths);
    const status = await call('get_status', { flow: 'other' });
    expect(status.content[0]!.text).toBe(JSON.stringify(describeStatus(paths, 'other'), null, 2));
    expect(await ok('complete_step', { step: 'plan', flow: 'other' })).not.toHaveProperty('task');
    expect((await ok('get_status', { flow: 'other', task: 'ABC-1' }))['task']).toMatchObject({ tracked: false });
    expect((await ok('get_flow', { flow: 'other' }))).not.toHaveProperty('tracked');
    expect(fake.requests).toEqual([]);
  });

  it('use the local state for a tracked flow that does not require a ticket when none is bound', async () => {
    const { paths, jira: fake } = await trackedProject({ tracker: { flows: { sample: { requireTask: false, statuses: MAPPING } } } });
    const { ok, call } = await connect(paths);
    const status = await call('get_status');
    expect(status.content[0]!.text).toBe(JSON.stringify(describeStatus(paths), null, 2));
    expect(await ok('complete_step', { step: 'plan' })).toEqual({
      from: 'plan',
      to: 'build',
      event: 'NEXT',
      done: false,
      next: { id: 'build', title: 'Build', command: '/build' },
    });
    expect(JSON.parse(readStateText(paths)!).flows['sample'].current).toBe('build');
    expect(fake.requests).toEqual([]);
  });
});

describe('tracker tools: tracked flows', () => {
  it('start_task, get_status and complete_step drive the ticket end to end', async () => {
    const { paths, jira: fake } = await trackedProject();
    const { ok } = await connect(paths);
    const stateBefore = readStateText(paths);

    // On main without a ticket: the initial step and what to do, without network.
    const required = await ok('get_status');
    expect(required).toMatchObject({ flow: 'sample', current: { id: 'plan', command: '/plan' }, done: false, history: [] });
    expect(required['task']).toEqual({
      provider: 'jira',
      key: null,
      started: false,
      required: true,
      warnings: [],
      instructions: expect.stringContaining('run /init-task <ticket> (or call start_task with it)'),
    });
    expect(fake.requests).toEqual([]);

    const started = await ok('start_task', { task: '#1' });
    expect(started).toMatchObject({
      flow: 'sample',
      flowTitle: 'Sample flow',
      current: { id: 'plan', title: 'Plan', command: '/plan', final: false },
      done: false,
      events: [{ event: 'NEXT', target: 'build', targetCommand: '/build' }],
      history: [{ from: '', to: 'plan', event: 'START' }],
      skills: { installed: false, upToDate: false },
      branch: { name: BRANCH, action: 'created' },
    });
    expect(started['task']).toMatchObject({
      provider: 'jira',
      key: 'ABC-1',
      url: `${fake.url}/browse/ABC-1`,
      title: 'Export orders as CSV',
      started: true,
      step: 'plan',
      status: { actual: 'In Progress', expected: 'In Progress', inSync: true },
      params: { branch: BRANCH, slug: 'export-orders-as-csv' },
      branch: BRANCH,
      via: 'arg',
      warnings: [],
    });
    expect(started['task']['instructions']).toContain('call complete_step with "task": "ABC-1"');
    expect(currentBranch(paths.root)).toBe(BRANCH);
    expect(fake.issue('ABC-1').status).toBe('In Progress');

    // The key comes from the branch now.
    const status = await ok('get_status');
    expect(status['current']['id']).toBe('plan');
    expect(status['task']).toMatchObject({ key: 'ABC-1', started: true, step: 'plan', via: 'branch', status: { inSync: true } });
    expect(status['task']['instructions']).toContain('`dfl next NEXT --from plan --task ABC-1`');

    fake.requests.splice(0);
    const completed = await ok('complete_step', { step: 'plan', task: 'ABC-1', params: { specPath: 'docs/specs/x.md' } });
    expect(completed).toEqual({
      from: 'plan',
      to: 'build',
      event: 'NEXT',
      done: false,
      next: { id: 'build', title: 'Build', command: '/build' },
      task: {
        key: 'ABC-1',
        status: { before: 'In Progress', after: 'In Progress', expected: 'In Progress' },
        params: { branch: BRANCH, slug: 'export-orders-as-csv', specPath: 'docs/specs/x.md' },
        warnings: [],
      },
    });
    // Same mapped status: the record and the mapped field only.
    expect(routes(fake)).toEqual(['getIssue', 'putProperty', 'editIssue']);
    expect(fake.issue('ABC-1').fields['customfield_10077']).toBe('docs/specs/x.md');

    fake.requests.splice(0);
    const reviewed = await ok('complete_step', { step: 'build' });
    expect(reviewed).toMatchObject({ from: 'build', to: 'review', task: { status: { before: 'In Progress', after: 'In Review', expected: 'In Review' } } });
    expect(routes(fake)).toEqual(['getIssue', 'putProperty', 'getTransitions', 'transition']);
    expect(fake.issue('ABC-1').status).toBe('In Review');
    expect(recordOf(fake)).toMatchObject({ step: 'review', params: { specPath: 'docs/specs/x.md' } });

    // A retried call (lost response) is answered from the record.
    fake.requests.splice(0);
    const replayed = await ok('complete_step', { step: 'build' });
    expect(replayed).toMatchObject({ from: 'build', to: 'review', event: 'NEXT', replayed: true, task: { key: 'ABC-1' } });
    expect(routes(fake)).toEqual(['getIssue']);

    const history = (await ok('get_status'))['history'].map((h: { event: string; to: string }) => `${h.event}→${h.to}`);
    expect(history).toEqual(['START→plan', 'NEXT→build', 'NEXT→review']);
    // The local state is neither read nor written for tracked flows.
    expect(readStateText(paths)).toBe(stateBefore);

    // goto_step moves the task too.
    expect(await ok('goto_step', { step: 'build', params: { specPath: null } })).toMatchObject({
      from: 'review',
      to: 'build',
      event: 'GOTO',
      task: { params: { branch: BRANCH, slug: 'export-orders-as-csv' }, status: { after: 'In Progress' } },
    });
    expect(fake.issue('ABC-1').fields['customfield_10077']).toBeNull();
  });

  it('refuses events without "from" and moves that are not allowed', async () => {
    const { paths } = await trackedProject();
    const { ok, fail } = await connect(paths);
    await ok('start_task', { task: 'ABC-1' });
    expect(await fail('transition')).toMatchObject({ code: 'TASK_FROM_REQUIRED', hint: expect.stringContaining('complete_step') });
    expect(await ok('transition', { from: 'plan' })).toMatchObject({ from: 'plan', to: 'build', task: { key: 'ABC-1' } });
    // The same move again is a retry (answered from the record); any other step is not current.
    expect(await ok('complete_step', { step: 'plan' })).toMatchObject({ to: 'build', replayed: true });
    expect(await fail('complete_step', { step: 'plan', event: 'BACK' })).toMatchObject({ code: 'NOT_CURRENT' });
    expect(await fail('complete_step', { step: 'review' })).toMatchObject({ code: 'NOT_CURRENT' });
    expect(await fail('complete_step', { step: 'build', event: 'NOPE' })).toMatchObject({ code: 'EVENT_NOT_ALLOWED' });
    expect(await fail('complete_step', { step: 'nope' })).toMatchObject({ code: 'STEP_NOT_FOUND' });
    expect(await fail('complete_step', { step: 'build', params: { apiToken: 'x' } })).toMatchObject({ code: 'TASK_PARAM_INVALID' });
  });

  it('complete_step names stale skills on tracked flows too', async () => {
    const { paths } = await trackedProject();
    setSelectedAgents(paths, ['claude']);
    setMcpEnabled(paths, false);
    await syncProject(paths);
    const { ok, fail } = await connect(paths);
    await ok('start_task', { task: 'ABC-1' });
    expect((await ok('get_status'))['skills']).toEqual({ installed: true, upToDate: true });
    fs.appendFileSync(path.join(paths.stepDir('sample', 'build'), 'SKILL.md.hbs'), '\nMore.\n');
    expect(await fail('complete_step', { step: 'review' })).toMatchObject({
      code: 'NOT_CURRENT',
      hint: expect.stringMatching(/The skill you ran may be stale\..*`dfl flow-update`/s),
    });
    expect(await fail('complete_step', { step: 'renamed-away' })).toMatchObject({ code: 'STEP_NOT_FOUND', hint: expect.stringMatching(/stale/) });
  });

  it('get_flow says that the flow is tracked instead of trusting the local step', async () => {
    const { paths, jira: fake } = await trackedProject();
    const { ok } = await connect(paths);
    const onMain = await ok('get_flow');
    expect(onMain).toMatchObject({ name: 'sample', current: 'plan', tracked: true });
    expect(onMain['note']).toMatch(/^Tracked in Jira; no ticket on this branch\. "current" is the local position .*call get_status/);
    git(paths.root, 'switch', '-q', '-c', BRANCH);
    expect((await ok('get_flow'))['note']).toMatch(/^Tracked in Jira \(ABC-1\): "current" is the local position/);
    expect(fake.requests).toEqual([]);
  });

  it('uses $init-task for Codex and suggests the ticket of the previous branch', async () => {
    const { paths } = await trackedProject();
    const codex = await connect(paths, 'codex-mcp-client');
    expect((await codex.ok('get_status'))['task']['instructions']).toContain('run $init-task <ticket>');
    await codex.ok('start_task', { task: 'ABC-1' });
    git(paths.root, 'switch', '-q', 'main');
    const status = await codex.ok('get_status');
    expect(status['task']).toMatchObject({ key: null, required: true, suggested: 'ABC-1' });
    expect(status['task']['instructions']).toContain('pass "task": "ABC-1"');
  });

  it('resumes a started task and reports branch choices', async () => {
    const { paths } = await trackedProject();
    const { ok, fail } = await connect(paths);
    await ok('start_task', { task: 'ABC-1' });
    git(paths.root, 'switch', '-q', 'main');
    git(paths.root, 'switch', '-q', '-c', 'some-feature');
    const choice = await fail('start_task', { task: 'ABC-2' });
    expect(choice).toMatchObject({ code: 'TASK_BRANCH_CHOICE', hint: expect.stringContaining('branch "create"') });
    const created = await ok('start_task', { task: 'ABC-2', branch: 'create', slug: 'second' });
    expect(created['branch']).toEqual({ name: 'ABC-2-second', action: 'created' });

    const resumed = await ok('start_task', { task: 'ABC-1' });
    expect(resumed['branch']).toEqual({ name: BRANCH, action: 'switch-needed' });
    expect(resumed['task']['warnings']).toEqual([`Switch to ${BRANCH} (git switch ${BRANCH}) to continue ABC-1.`]);
  });
});

describe('tracker tools: errors', () => {
  it('TASK_REQUIRED and TASK_NOT_STARTED point MCP agents at start_task', async () => {
    const { paths, jira: fake } = await trackedProject();
    const { fail } = await connect(paths);
    const required = await fail('complete_step', { step: 'plan' });
    expect(required).toMatchObject({ code: 'TASK_REQUIRED', error: expect.stringMatching(/no ticket is bound to the current branch/) });
    expect(required['hint']).toContain('/init-task <ticket>');
    expect(required['hint']).toContain('(CLI: `dfl task start <ticket>`)');
    expect(required['hint']).toMatch(/Over MCP: call start_task with the ticket the user names\.$/);
    expect(fake.requests).toEqual([]);

    const notStarted = await fail('complete_step', { step: 'plan', task: 'ABC-2' });
    expect(notStarted).toMatchObject({ code: 'TASK_NOT_STARTED', hint: expect.stringMatching(/Over MCP: call start_task/) });
    expect(fake.requestsTo('putProperty')).toEqual([]);
  });

  it('TASK_STEP_UNKNOWN points at goto_step, which repairs the task', async () => {
    const { paths, jira: fake } = await trackedProject();
    const { ok, fail } = await connect(paths);
    await ok('start_task', { task: 'ABC-1' });
    // The record names a step the flow no longer has (renamed upstream).
    recordOf(fake)['step'] = 'ghost';

    const status = await ok('get_status');
    expect(status['current']['id']).toBe('plan');
    expect(status['repaired']).toMatch(/"ghost"/);
    expect(status['task']).toMatchObject({ stepUnknown: 'ghost', started: true });
    expect(status['task']['instructions']).toContain('call goto_step');

    const unknown = await fail('complete_step', { step: 'plan' });
    expect(unknown).toMatchObject({ code: 'TASK_STEP_UNKNOWN', hint: expect.stringMatching(/Over MCP: call goto_step with task and the right step\./) });
    expect(await ok('goto_step', { step: 'build' })).toMatchObject({ from: 'ghost', to: 'build', event: 'GOTO' });
    expect(recordOf(fake)['step']).toBe('build');
  });

  it('TRACKER_AUTH_MISSING tells the user to log in themselves, with the project launcher', async () => {
    const { paths, jira: fake } = await trackedProject({ credentials: false });
    fs.writeFileSync(path.join(paths.root, 'package.json'), JSON.stringify({ name: 'app', devDependencies: { '@vishin-pavel/dfl': '^0.1.0' } }));
    const { ok, fail } = await connect(paths);
    // Without a ticket nothing needs Jira.
    expect((await ok('get_status'))['task']).toMatchObject({ required: true });

    for (const [tool, args] of [
      ['get_status', { task: 'ABC-1' }],
      ['start_task', { task: 'ABC-1' }],
      ['complete_step', { step: 'plan', task: 'ABC-1' }],
    ] as const) {
      const error = await fail(tool, args);
      expect(error, tool).toMatchObject({ code: 'TRACKER_AUTH_MISSING', error: `No Jira credentials for ${fake.origin}.` });
      expect(error['hint'], tool).toContain('Run `npx --no-install dfl tracker login` in your own terminal');
      expect(error['hint'], tool).toContain('Never paste a token into a chat.');
      expect(error['hint'], tool).toMatch(/No dfl tool can do this: ask the user to do it themselves\.$/);
    }
    expect(currentBranch(paths.root)).toBe('main');
    expect(fake.requests).toEqual([]);
  });

  it('reports Jira errors as tool errors without writing', async () => {
    const { paths, jira: fake } = await trackedProject();
    const { ok, fail } = await connect(paths);
    await ok('start_task', { task: 'ABC-1' });
    // A revoked token: Jira Cloud answers as for an anonymous user (404 + X-Seraph-LoginReason), not 401.
    vi.stubEnv('DFL_JIRA_TOKEN', 'revoked-token');
    const auth = await fail('get_status');
    expect(auth).toMatchObject({ code: 'TRACKER_AUTH', hint: expect.stringMatching(/tracker login.*No dfl tool can do this/s) });
    expect(fake.requests.at(-1)).toMatchObject({ route: 'getIssue', status: 404 });
    vi.stubEnv('DFL_JIRA_TOKEN', credentialEnv(fake).DFL_JIRA_TOKEN);
    fake.setFailure('putProperty', 500);
    expect(await fail('complete_step', { step: 'plan' })).toMatchObject({ code: 'TRACKER_HTTP' });
    expect(recordOf(fake)['step']).toBe('plan');
  });

  it('an invalid tracker config fails tool calls of the flows it names with its own code', async () => {
    const { paths } = await trackedProject();
    fs.writeFileSync(paths.trackerFile, '{ "version": 1, "provider": "jira", "flows": { "sample": {} } }\n');
    const { ok, fail } = await connect(paths);
    expect(await fail('get_status')).toMatchObject({ code: 'TRACKER_CONFIG_INVALID', hint: expect.stringContaining('`dfl tracker check`') });
    expect(await fail('complete_step', { step: 'plan' })).toMatchObject({ code: 'TRACKER_CONFIG_INVALID' });
    fs.writeFileSync(paths.trackerFile, '{ "version": 2, "flows": { "sample": {} } }\n');
    expect(await fail('get_status')).toMatchObject({ code: 'TRACKER_CONFIG_NEWER' });
    fs.writeFileSync(paths.trackerFile, '{ "version": 1, "provider": "jira", "flows": {');
    expect(await fail('get_status')).toMatchObject({ code: 'TRACKER_CONFIG_INVALID' });

    // A broken file that does not name the flow leaves it untracked: the local state works.
    fs.writeFileSync(paths.trackerFile, '{ "version": 1, "provider": "jira", "flows": { "other": { "statuses": 5 } } }\n');
    expect(await ok('get_status')).toMatchObject({ flow: 'sample', current: { id: 'plan' } });
    expect(await ok('complete_step', { step: 'plan' })).toMatchObject({ from: 'plan', to: 'build' });
    fs.writeFileSync(paths.trackerFile, '{ "version": 2 }\n');
    expect(await ok('get_status')).toMatchObject({ flow: 'sample', current: { id: 'build' } });
  });
});

describe('tracker tools: project lock', () => {
  it('start_task does its git work and reads outside the project lock and writes under it', async () => {
    const { paths, jira: fake } = await trackedProject();
    const { ok } = await connect(paths);
    const lock = holdLock(paths);
    let done = false;
    const starting = ok('start_task', { task: 'ABC-1' }).then((result) => {
      done = true;
      return result;
    });
    await waitFor(() => currentBranch(paths.root) === BRANCH);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toBe(false);
    expect(fake.requestsTo('putProperty')).toEqual([]);
    fs.unlinkSync(lock);
    expect((await starting)['branch']).toEqual({ name: BRANCH, action: 'created' });
    expect(recordOf(fake)['step']).toBe('plan');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('tracked moves run entirely under the project lock (no re-entrant deadlock)', async () => {
    const { paths, jira: fake } = await trackedProject();
    const { ok } = await connect(paths);
    await ok('start_task', { task: 'ABC-1' });
    fake.requests.splice(0);
    const lock = holdLock(paths);
    const completing = ok('complete_step', { step: 'plan' });
    // Reads do not wait for the lock.
    expect((await ok('get_status'))['task']['step']).toBe('plan');
    const reads = fake.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.requests.length).toBe(reads);
    // Nothing of the move ran while the lock was held (a move outside the lock would have written by now).
    expect(fake.requestsTo('putProperty')).toEqual([]);
    expect(recordOf(fake)['step']).toBe('plan');
    fs.unlinkSync(lock);
    expect(await completing).toMatchObject({ from: 'plan', to: 'build' });
    expect(fs.existsSync(lock)).toBe(false);
  });
});
