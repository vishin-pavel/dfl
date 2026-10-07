/**
 * Regression tests for the Jira API review findings: bad credentials that Jira Cloud serves as an
 * anonymous user (404 / empty data instead of 401), status and issue-type names in each user's
 * Jira language, transitions with and without a screen, and what `dfl tracker check` can and
 * cannot verify about mapped fields.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DflError } from '../src/core/errors.js';
import { loadFlow } from '../src/core/flow.js';
import { withProjectLock } from '../src/core/lock.js';
import { checkTracker, findStatus, mappingName } from '../src/core/tracker/check.js';
import type { NormalizedStatus } from '../src/core/tracker/config.js';
import { TrackerError } from '../src/core/tracker/http.js';
import { createJiraClient, historyMetadata, type JiraTransition } from '../src/core/tracker/jira.js';
import { chooseTransition, nameMatches, statusMatches } from '../src/core/tracker/projection.js';
import { startTask, taskMove, taskStatus, type TaskWriteOptions } from '../src/core/tracker/runtime.js';
import type { FlowModel, ProjectPaths } from '../src/core/types.js';
import { createDflMcpServer } from '../src/mcp/server.js';
import { runCli } from '../src/run.js';
import { DEFAULT_ACCOUNT, createFakeJira, credentialEnv, type FakeJira, type FakeJiraOptions } from './helpers/fake-jira.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, writeSampleFlow } from './helpers/project.js';

let jira: FakeJira | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  // Isolate from the developer's git config, dfl credentials and environment.
  vi.stubEnv('CI', '1');
  vi.stubEnv('DFL_ROOT', '');
  const home = makeTempDir('dfl-git-home-');
  fs.writeFileSync(path.join(home, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(home, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('DFL_CONFIG_DIR', makeTempDir('dfl-config-'));
  for (const name of ['DFL_JIRA_URL', 'DFL_JIRA_EMAIL', 'DFL_JIRA_TOKEN', 'DFL_TRACKER_TIMEOUT_MS', 'DFL_DEBUG']) vi.stubEnv(name, undefined);
});

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await jira?.close();
  jira = undefined;
  cleanupTempDirs();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAPPING = { plan: 'In Progress', build: 'In Progress', review: 'In Review', done: 'Done' };
const ANSI_RE = /\u001B\[[0-9;]*m/g;
const META = historyMetadata('review', 'NEXT', 'done');
const REVOKED = { email: DEFAULT_ACCOUNT.email, token: 'revoked-token' };
/** A German Jira profile. */
const GERMAN = { 'To Do': 'Zu erledigen', 'In Progress': 'In Arbeit', 'In Review': 'In Prüfung', Done: 'Fertig', Bug: 'Fehler', Task: 'Aufgabe' };

interface Setup {
  paths: ProjectPaths;
  jira: FakeJira;
  model: FlowModel;
  opts: TaskWriteOptions;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=dfl', '-c', 'user.email=dfl@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A git repository (on main, everything committed) with the sample flow tracked in a fake Jira. */
async function setup(options: { tracker?: Record<string, unknown>; jira?: FakeJiraOptions; credential?: { email: string; token: string } } = {}): Promise<Setup> {
  await jira?.close();
  jira = await createFakeJira({
    issues: [
      { key: 'ABC-1', id: '10231', summary: 'Export orders as CSV' },
      { key: 'ABC-2', id: '10232', summary: 'Login fails', issueType: 'Bug' },
    ],
    ...options.jira,
  });
  const paths = makeTempProject();
  writeSampleFlow(paths);
  const tracker = {
    version: 1,
    provider: 'jira',
    jira: { baseUrl: jira.url, projectKeys: ['ABC'], defaultProjectKey: 'ABC' },
    branch: { from: 'main' },
    fields: { branch: 'customfield_10042', prUrl: 'customfield_10077' },
    flows: { sample: { statuses: MAPPING } },
    ...options.tracker,
  };
  fs.writeFileSync(paths.trackerFile, `${JSON.stringify(tracker, null, 2)}\n`);
  git(paths.root, 'init', '-q', '-b', 'main');
  git(paths.root, 'add', '-A');
  git(paths.root, 'commit', '-q', '-m', 'init');
  for (const [name, value] of Object.entries(credentialEnv(jira, { ...DEFAULT_ACCOUNT, ...options.credential }))) vi.stubEnv(name, value);
  return { paths, jira, model: loadFlow(paths, 'sample'), opts: { withLock: (fn) => withProjectLock(paths, fn) } };
}

function useToken(fake: FakeJira, token: string): void {
  vi.stubEnv('DFL_JIRA_URL', fake.url);
  vi.stubEnv('DFL_JIRA_EMAIL', DEFAULT_ACCOUNT.email);
  vi.stubEnv('DFL_JIRA_TOKEN', token);
}

function recordOf(fake: FakeJira, key = 'ABC-1'): Record<string, any> | undefined {
  return fake.issue(key).properties['dfl.run'] as Record<string, any> | undefined;
}

async function failure(promise: Promise<unknown>): Promise<DflError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DflError);
    return error as DflError;
  }
  throw new Error('expected a DflError');
}

/** Runs `dfl --root <root> --no-color ...args` in-process, capturing stdout/stderr. */
async function dfl(root: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const capture =
    (sink: (text: string) => void) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      (rest.find((arg) => typeof arg === 'function') as (() => void) | undefined)?.();
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

/** An MCP session on the project; `fail` returns the error's structuredContent ({ error, code, hint }). */
async function mcp(paths: ProjectPaths): Promise<{ ok(name: string, args?: Record<string, unknown>): Promise<any>; fail(name: string, args?: Record<string, unknown>): Promise<any> }> {
  const server = createDflMcpServer({ root: paths.root });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => client.callTool({ name, arguments: args });
  return {
    async ok(name, args) {
      const result = await call(name, args);
      if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
      return result.structuredContent;
    },
    async fail(name, args) {
      const result = await call(name, args);
      expect(result.isError, `${name} should fail`).toBe(true);
      return result.structuredContent;
    },
  };
}

// ---------------------------------------------------------------------------
// Bad credentials
// ---------------------------------------------------------------------------

describe('an expired or revoked token (Jira answers as for an anonymous user)', () => {
  it('a 404 or 200 marked X-Seraph-LoginReason: AUTHENTICATED_FAILED is TRACKER_AUTH', async () => {
    const fake = (jira = await createFakeJira({ issues: [{ key: 'ABC-1' }] }));
    const client = createJiraClient({ baseUrl: fake.url, credential: REVOKED });

    const issue = (await failure(client.getIssue('ABC-1'))) as TrackerError;
    expect(issue).toMatchObject({ code: 'TRACKER_AUTH', status: 404, message: `Jira rejected the credentials for ${fake.url} (authenticated as dev@example.com).` });
    expect(issue.hint).toMatch(/expired.*revoked.*`dfl tracker login` in your own terminal/s);
    expect(`${issue.message} ${issue.hint}`).not.toContain('revoked-token');
    expect(await failure(client.projectStatuses('ABC'))).toMatchObject({ code: 'TRACKER_AUTH', status: 404 });
    expect(await failure(client.listFields())).toMatchObject({ code: 'TRACKER_AUTH', status: 200 });
    expect(await failure(client.putProperty('ABC-1', 'dfl.run', {}))).toMatchObject({ code: 'TRACKER_AUTH' });
    // The header was enough: no GET /myself check.
    expect(fake.requests.map((r) => [r.route, r.status])).toEqual([
      ['getIssue', 404],
      ['projectStatuses', 404],
      ['listFields', 200],
      ['putProperty', 404],
    ]);
    expect(fake.issue('ABC-1').properties).toEqual({});
  });

  it('without that header, a 404 of an issue or project request asks GET /myself once', async () => {
    const fake = (jira = await createFakeJira({ issues: [{ key: 'ABC-1' }], badAuth: 'anonymous-no-header' }));
    const client = createJiraClient({ baseUrl: fake.url, credential: REVOKED });
    expect(await failure(client.getIssue('ABC-1'))).toMatchObject({ code: 'TRACKER_AUTH', status: 401 });
    expect(await failure(client.getTransitions('ABC-1'))).toMatchObject({ code: 'TRACKER_AUTH' });
    expect(await failure(client.projectCatalog('ABC'))).toMatchObject({ code: 'TRACKER_AUTH' });
    expect(fake.requests.map((r) => r.route)).toEqual(['getIssue', 'myself', 'getTransitions', 'projectStatuses']);
  });

  it('a ticket or project that really does not exist stays TASK_NOT_FOUND / TRACKER_PROJECT_NOT_FOUND', async () => {
    const fake = (jira = await createFakeJira({ issues: [{ key: 'ABC-1' }] }));
    const client = createJiraClient({ baseUrl: fake.url, credential: DEFAULT_ACCOUNT });
    expect(await failure(client.getIssue('ABC-404'))).toMatchObject({ code: 'TASK_NOT_FOUND', message: 'ABC-404 does not exist or is not visible to dev@example.com.' });
    expect(await failure(client.projectStatuses('XYZ'))).toMatchObject({ code: 'TRACKER_PROJECT_NOT_FOUND' });
    // One credential check per client (per operation).
    expect(fake.requests.map((r) => r.route)).toEqual(['getIssue', 'myself', 'projectStatuses']);
  });

  it('a 401 on any route (badAuth "401") is TRACKER_AUTH as before', async () => {
    const fake = (jira = await createFakeJira({ issues: [{ key: 'ABC-1' }], badAuth: '401' }));
    expect(await failure(createJiraClient({ baseUrl: fake.url, credential: REVOKED }).getIssue('ABC-1'))).toMatchObject({ code: 'TRACKER_AUTH', status: 401 });
  });

  for (const badAuth of ['anonymous', 'anonymous-no-header'] as const) {
    it(`MCP tools report TRACKER_AUTH and tell the agent to ask the user (${badAuth})`, async () => {
      const s = await setup({ jira: { badAuth } });
      const session = await mcp(s.paths);
      await session.ok('start_task', { task: 'ABC-1' });
      const before = JSON.stringify(recordOf(s.jira));

      useToken(s.jira, 'revoked-token');
      for (const [tool, args] of [
        ['get_status', {}],
        ['complete_step', { step: 'plan' }],
        ['goto_step', { step: 'review' }],
        ['start_task', { task: 'ABC-2' }],
      ] as const) {
        const error = await session.fail(tool, args);
        expect(error, tool).toMatchObject({ code: 'TRACKER_AUTH', error: `Jira rejected the credentials for ${s.jira.origin} (authenticated as dev@example.com).` });
        expect(error['hint'], tool).toContain('tracker login');
        expect(error['hint'], tool).toMatch(/No dfl tool can do this: ask the user to do it themselves\.$/);
        expect(`${error['error']} ${error['hint']}`, tool).not.toMatch(/does not exist|Check the ticket key/);
      }
      expect(JSON.stringify(recordOf(s.jira))).toBe(before);
      expect(recordOf(s.jira, 'ABC-2')).toBeUndefined();
    });
  }

  it('CLI status and next report the rejected credentials, not a missing ticket', async () => {
    const s = await setup();
    await startTask(s.paths, { task: 'ABC-1' }, s.opts);
    useToken(s.jira, 'revoked-token');
    for (const args of [
      ['status', '--task', 'ABC-1'],
      ['next', '--from', 'plan'],
      ['task', 'start', 'ABC-2'],
    ]) {
      const result = await dfl(s.paths.root, ...args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr, args.join(' ')).toContain(`Jira rejected the credentials for ${s.jira.origin} (authenticated as dev@example.com).`);
      expect(result.stderr, args.join(' ')).toContain('`dfl tracker login` in your own terminal');
      expect(result.stderr, args.join(' ')).not.toContain('does not exist');
    }
    expect(recordOf(s.jira)!['step']).toBe('plan');
  });
});

// ---------------------------------------------------------------------------
// Jira language
// ---------------------------------------------------------------------------

describe("status and issue-type names in the user's Jira language", () => {
  it('every request asks for English names', async () => {
    const s = await setup();
    await startTask(s.paths, { task: 'ABC-1' }, s.opts);
    expect(s.jira.requests.length).toBeGreaterThan(2);
    for (const request of s.jira.requests) {
      expect(request.headers).toMatchObject({ 'accept-language': 'en', 'x-force-accept-language': 'true' });
    }
  });

  it('a teammate with a German Jira profile moves the ticket through the English mapping', async () => {
    const s = await setup({ jira: { language: { names: GERMAN } }, tracker: { flowSelect: { byIssueType: { Bug: 'sample' } } } });
    const started = await startTask(s.paths, { task: 'ABC-2' }, s.opts);
    expect(started.task).toMatchObject({ status: { actual: 'In Progress', inSync: true }, warnings: [] });
    expect(s.jira.issue('ABC-2').status).toBe('In Progress');
    await taskMove(s.paths, s.model, { kind: 'event', from: 'plan', task: 'ABC-2' }, s.opts);
    const review = await taskMove(s.paths, s.model, { kind: 'event', from: 'build', task: 'ABC-2' }, s.opts);
    expect(review?.task).toMatchObject({ status: { before: 'In Progress', after: 'In Review' }, warnings: [] });
    expect(s.jira.issue('ABC-2').status).toBe('In Review');
  });

  it('when Jira translates anyway, untranslatedName still matches statuses and issue types', async () => {
    const s = await setup({
      jira: { language: { names: GERMAN, ignoreForcedLanguage: true } },
      tracker: { flowSelect: { byIssueType: { bug: 'sample' } } },
    });
    // flowSelect.byIssueType.bug matches the issue type "Fehler" (untranslated "Bug").
    const started = await startTask(s.paths, { task: 'ABC-2' }, s.opts);
    expect(started.task).toMatchObject({ status: { actual: 'In Arbeit', inSync: true }, warnings: [] });
    expect(s.jira.issue('ABC-2').status).toBe('In Progress');

    await taskMove(s.paths, s.model, { kind: 'event', from: 'plan', task: 'ABC-2' }, s.opts);
    expect(s.jira.requestsTo('transition')).toHaveLength(1); // plan and build share In Progress
    const review = await taskMove(s.paths, s.model, { kind: 'event', from: 'build', task: 'ABC-2' }, s.opts);
    expect(review?.task).toMatchObject({ status: { before: 'In Arbeit', after: 'In Prüfung' }, warnings: [] });
    expect(s.jira.issue('ABC-2').status).toBe('In Review');
    expect((await taskStatus(s.paths, s.model, { task: 'ABC-2' }))?.task).toMatchObject({ status: { actual: 'In Prüfung', expected: 'In Review', inSync: true } });
  });

  it('name matching and the stored name use untranslatedName', () => {
    const arbeit = { id: '3', name: 'In Arbeit', untranslatedName: 'In Progress' };
    expect(nameMatches('in progress', arbeit)).toBe(true);
    expect(nameMatches('IN ARBEIT', arbeit)).toBe(true);
    expect(nameMatches('In Review', arbeit)).toBe(false);
    expect(nameMatches('Bug', { name: 'Bug' })).toBe(true);
    const byName = (name: string): NormalizedStatus => ({ name, reopen: false });
    expect(statusMatches(byName('In Progress'), arbeit)).toBe(true);
    expect(statusMatches({ id: '4', name: 'In Progress', reopen: false }, arbeit)).toBe(false);
    expect(findStatus([{ id: '1', name: 'Zu erledigen', untranslatedName: 'To Do' }, arbeit], { name: 'in progress' })).toBe(arbeit);
    expect(mappingName(arbeit)).toBe('In Progress');
    expect(mappingName({ name: 'Done' })).toBe('Done');
  });

  it('`dfl tracker map` stores the untranslated name of the status the user typed', async () => {
    const s = await setup({ jira: { language: { names: GERMAN, ignoreForcedLanguage: true } } });
    const mapped = await dfl(s.paths.root, 'tracker', 'map', 'review', 'In Prüfung');
    expect(mapped.code, mapped.stderr).toBe(0);
    const saved = JSON.parse(fs.readFileSync(s.paths.trackerFile, 'utf8'));
    expect(saved.flows.sample.statuses.review).toBe('In Review');

    const checks = await checkTracker(s.paths);
    expect(checks.filter((c) => c.check === 'statuses')).toEqual([
      { check: 'statuses', level: 'ok', message: 'flows.sample: every mapped status exists in Jira (4 steps)' },
    ]);
    const unknown = await dfl(s.paths.root, 'tracker', 'map', 'review', 'In Prufung');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Did you mean "In Prüfung"?');
    expect(unknown.stderr).toContain('Statuses: To Do, In Progress, In Review, Blocked, Done.');
  });
});

// ---------------------------------------------------------------------------
// Transition screens
// ---------------------------------------------------------------------------

describe('transitions with and without a screen', () => {
  const done = { id: '10001', name: 'Done', statusCategory: { key: 'done' } };
  const globalDone: JiraTransition = { id: '41', name: 'Done', to: done, hasScreen: false };
  const resolve: JiraTransition = { id: '51', name: 'Resolve', to: done, hasScreen: true };
  const context = { key: 'ABC-1', actual: 'In Review' };
  const withFields: NormalizedStatus = { name: 'Done', fields: { resolution: { name: 'Done' } }, reopen: false };
  const plain: NormalizedStatus = { name: 'Done', reopen: false };

  it('a mapping with fields prefers a transition with a screen, one without prefers none', () => {
    expect(chooseTransition([globalDone, resolve], withFields, context).transition).toBe(resolve);
    expect(chooseTransition([resolve, globalDone], withFields, context).transition).toBe(resolve);
    expect(chooseTransition([resolve, globalDone], plain, context).transition).toBe(globalDone);
    expect(chooseTransition([globalDone, resolve], { ...plain, fields: {} }, context).transition).toBe(globalDone);
    // Only one kind, or Jira did not say: the first match.
    expect(chooseTransition([globalDone], withFields, context).transition).toBe(globalDone);
    const unknown = [{ ...globalDone, hasScreen: undefined }, { ...resolve, hasScreen: undefined }];
    expect(chooseTransition(unknown, withFields, context).transition).toBe(unknown[0]);
  });

  it('the fake, like Jira, refuses fields that are not on the transition screen', async () => {
    const fake = (jira = await createFakeJira({
      issues: [{ key: 'ABC-1', status: 'In Review' }],
      workflow: { 'In Review': ['Done', { to: 'Done', id: 'tr-resolve', name: 'Resolve', requires: ['resolution'], screen: ['labels'] }] },
    }));
    const client = createJiraClient({ baseUrl: fake.url, credential: DEFAULT_ACCOUNT });
    const screenless = await failure(client.transition('ABC-1', 'tr-10001', { fields: { resolution: { name: 'Done' } }, historyMetadata: META }));
    expect(screenless).toMatchObject({ code: 'TRACKER_HTTP', status: 400 });
    expect(screenless.message).toContain("resolution: Field 'resolution' cannot be set. It is not on the appropriate screen, or unknown.");
    const offScreen = await failure(client.transition('ABC-1', 'tr-resolve', { fields: { resolution: { name: 'Done' }, summary: 'x' }, historyMetadata: META }));
    expect(offScreen.message).toContain("summary: Field 'summary' cannot be set.");
    expect(fake.issue('ABC-1').status).toBe('In Review');
    await client.transition('ABC-1', 'tr-resolve', { fields: { resolution: { name: 'Done' }, labels: ['x'] }, historyMetadata: META });
    expect(fake.issue('ABC-1')).toMatchObject({ status: 'Done', fields: { resolution: { name: 'Done' }, labels: ['x'] } });
  });

  it('a move whose mapping has fields takes the transition with the screen, not the screenless one listed first', async () => {
    const s = await setup({
      jira: {
        workflow: {
          'To Do': ['In Progress'],
          'In Progress': ['In Review'],
          'In Review': [{ to: 'Done', id: 'tr-done', name: 'Done' }, { to: 'Done', id: 'tr-resolve', name: 'Resolve', requires: ['resolution'] }],
        },
      },
      tracker: { flows: { sample: { statuses: { ...MAPPING, done: { status: 'Done', fields: { resolution: { name: 'Done' } } } } } } },
    });
    await startTask(s.paths, { task: 'ABC-1' }, s.opts);
    await taskMove(s.paths, s.model, { kind: 'goto', step: 'review', task: 'ABC-1' }, s.opts);
    const moved = await taskMove(s.paths, s.model, { kind: 'event', from: 'review', task: 'ABC-1' }, s.opts);
    expect(moved?.task).toMatchObject({ status: { before: 'In Review', after: 'Done' }, warnings: [] });
    expect(s.jira.issue('ABC-1')).toMatchObject({ status: 'Done', fields: { resolution: { name: 'Done' } } });
    expect((s.jira.requestsTo('transition').at(-1)!.body as { transition: unknown }).transition).toEqual({ id: 'tr-resolve' });
  });
});

// ---------------------------------------------------------------------------
// tracker check and field writes
// ---------------------------------------------------------------------------

describe('mapped fields', () => {
  it('`tracker check` warns when the branch is not stored in a Jira field', async () => {
    const s = await setup({ tracker: { fields: { prUrl: 'customfield_10077' } } });
    const checks = await checkTracker(s.paths);
    expect(checks).toContainEqual({
      check: 'fields',
      level: 'warn',
      message: 'The branch is not stored in a Jira field; optional: `dfl tracker field branch <field>`.',
      hint: 'Map a single-line text or URL field, so teammates see the task branch on the ticket.',
    });
    expect(checks).toContainEqual({ check: 'fields', level: 'ok', message: 'fields.prUrl → Pull request (customfield_10077): a URL field' });
    expect(checks.filter((c) => c.level === 'fail')).toEqual([]);

    const mapped = await setup();
    const okChecks = await checkTracker(mapped.paths);
    expect(okChecks.some((c) => c.message.startsWith('The branch is not stored'))).toBe(false);
    expect(okChecks).toContainEqual({ check: 'fields', level: 'ok', message: 'fields.branch → Branch (customfield_10042): a single-line text field' });
  });

  it('`tracker check` does not claim a custom field works for every project or issue type', async () => {
    for (const tracker of [
      { jira: { baseUrl: '', projectKeys: ['ABC', 'XYZ'], defaultProjectKey: 'ABC' } },
      { flowSelect: { byIssueType: { Bug: 'sample' } } },
    ]) {
      const s = await setup({ tracker, jira: { projectStatuses: { ABC: ['To Do', 'In Progress', 'In Review', 'Done'], XYZ: ['To Do', 'In Progress', 'In Review', 'Done'] } } });
      if ('jira' in tracker) {
        const config = JSON.parse(fs.readFileSync(s.paths.trackerFile, 'utf8'));
        config.jira.baseUrl = s.jira.url;
        fs.writeFileSync(s.paths.trackerFile, JSON.stringify(config));
      }
      const fieldChecks = (await checkTracker(s.paths)).filter((c) => c.check === 'fields');
      expect(fieldChecks.map((c) => c.level)).toEqual(['warn', 'warn']);
      expect(fieldChecks[0]!.message).toMatch(
        /^fields\.branch → Branch \(customfield_10042\): exists and is a single-line text field, but its field context must include every project \(ABC(, XYZ)?\) and issue type of the tickets dfl tracks; dfl cannot verify that without admin rights\.$/,
      );
      expect(fieldChecks[0]!.hint).toContain('Custom fields');
    }
  });

  it("a refused field write points at the field's context for the ticket's project", async () => {
    const s = await setup();
    s.jira.setFailure('editIssue', {
      status: 400,
      body: { errorMessages: [], errors: { customfield_10042: "Field 'customfield_10042' cannot be set. It is not on the appropriate screen, or unknown." } },
    });
    const started = await startTask(s.paths, { task: 'ABC-1' }, s.opts);
    expect(started.task.warnings).toHaveLength(1);
    expect(started.task.warnings[0]).toContain('dfl could not write branch to the Jira fields of ABC-1');
    expect(started.task.warnings[0]).toContain("field context includes project ABC and this ticket's issue type");
  });
});
