import { afterEach, describe, expect, it, vi } from 'vitest';
import { DflError } from '../src/core/errors.js';
import { TrackerError, jiraErrorDetails, trackerDeadline, trackerTimeoutMs } from '../src/core/tracker/http.js';
import { createJiraClient, historyMetadata, type JiraClient } from '../src/core/tracker/jira.js';
import { DEFAULT_ACCOUNT, createFakeJira, credentialEnv, type FakeJira, type FakeJiraOptions } from './helpers/fake-jira.js';

let jira: FakeJira | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await jira?.close();
  jira = undefined;
});

async function start(options: FakeJiraOptions = {}): Promise<FakeJira> {
  jira = await createFakeJira({
    issues: [
      { key: 'ABC-1', id: '10231', summary: 'Export orders as CSV', issueType: 'Story' },
      { key: 'ABC-2', summary: 'Second', status: 'In Progress', properties: { 'dfl.run': { schema: 1 } } },
    ],
    ...options,
  });
  return jira;
}

function client(fake: FakeJira, credential: { email: string; token: string } = DEFAULT_ACCOUNT, signal?: AbortSignal): JiraClient {
  return createJiraClient({ baseUrl: `${fake.url}/ignored/path`, credential, signal });
}

async function failure(promise: Promise<unknown>): Promise<TrackerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DflError);
    return error as TrackerError;
  }
  throw new Error('expected a DflError');
}

const META = historyMetadata('plan', 'NEXT', 'build');

describe('jira client', () => {
  it('reads the account, issues and their properties', async () => {
    const fake = await start();
    const jiraClient = client(fake);
    expect(jiraClient.origin).toBe(fake.url);
    expect(await jiraClient.myself()).toEqual({ accountId: DEFAULT_ACCOUNT.accountId, displayName: 'Dev Eloper', emailAddress: 'dev@example.com' });

    const issue = await jiraClient.getIssue('ABC-1', { properties: ['dfl.run'] });
    expect(issue).toMatchObject({
      id: '10231',
      key: 'ABC-1',
      fields: {
        summary: 'Export orders as CSV',
        status: { id: '10000', name: 'To Do', statusCategory: { key: 'new' } },
        issuetype: { name: 'Story' },
        project: { key: 'ABC' },
      },
      properties: {},
    });
    expect(fake.requestsTo('getIssue')[0]!.query).toEqual({ fields: 'summary,status,issuetype,project', properties: 'dfl.run' });
    expect((await jiraClient.getIssue('ABC-2', { properties: ['dfl.run'] })).properties).toEqual({ 'dfl.run': { schema: 1 } });
    expect((await jiraClient.getIssue('ABC-2', { fields: ['customfield_10042'] })).fields['customfield_10042']).toBeNull();
  });

  it('writes properties, transitions and edits fields with history metadata', async () => {
    const fake = await start({ workflow: { 'To Do': ['In Progress', { to: 'Done', id: 'tr-close', name: 'Close', requires: ['resolution'] }], Done: ['In Progress'] } });
    const jiraClient = client(fake);
    await jiraClient.putProperty('ABC-1', 'dfl.run', { schema: 1, step: 'plan' });
    expect(fake.issue('ABC-1').properties['dfl.run']).toEqual({ schema: 1, step: 'plan' });
    expect(fake.requestsTo('putProperty')[0]).toMatchObject({ method: 'PUT', path: '/issue/ABC-1/properties/dfl.run', status: 201 });

    const transitions = await jiraClient.getTransitions('ABC-1');
    expect(transitions).toEqual([
      { id: 'tr-3', name: 'To In Progress', to: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } }, hasScreen: false },
      { id: 'tr-close', name: 'Close', to: { id: '10001', name: 'Done', statusCategory: { key: 'done' } }, hasScreen: true },
    ]);
    await jiraClient.transition('ABC-1', 'tr-close', { fields: { resolution: { name: 'Done' } }, historyMetadata: META });
    expect(fake.issue('ABC-1')).toMatchObject({ status: 'Done', fields: { resolution: { name: 'Done' } } });
    expect(fake.requestsTo('transition')[0]!.body).toEqual({
      transition: { id: 'tr-close' },
      fields: { resolution: { name: 'Done' } },
      historyMetadata: { type: 'dfl', description: 'dfl: plan NEXT → build' },
    });
    await jiraClient.transition('ABC-1', 'tr-3', { historyMetadata: META });
    expect(fake.requestsTo('transition')[1]!.body).not.toHaveProperty('fields');

    await jiraClient.editIssue('ABC-1', { fields: { customfield_10042: 'feature/ABC-1-x' }, historyMetadata: META });
    expect(fake.issue('ABC-1').fields['customfield_10042']).toBe('feature/ABC-1-x');
  });

  it('lists project statuses (unique) and fields', async () => {
    const fake = await start({ projectStatuses: { ABC: ['To Do', 'In Progress', 'Done'] } });
    const jiraClient = client(fake);
    expect(await jiraClient.projectStatuses('ABC')).toEqual([
      { id: '10000', name: 'To Do', categoryKey: 'new' },
      { id: '3', name: 'In Progress', categoryKey: 'indeterminate' },
      { id: '10001', name: 'Done', categoryKey: 'done' },
    ]);
    const fields = await jiraClient.listFields();
    expect(fields).toContainEqual({
      id: 'customfield_10077',
      name: 'Pull request',
      custom: true,
      schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:url' },
    });
  });

  it('encodes path segments', async () => {
    const fake = await start();
    await failure(client(fake).getIssue('ABC-1/../../myself'));
    // The 404 is followed by the GET /myself check of the credentials.
    expect(fake.requests.map((r) => r.path)).toEqual(['/issue/ABC-1%2F..%2F..%2Fmyself', '/myself']);
  });

  it('caps the history description at 255 characters', () => {
    expect(historyMetadata('', 'START', 'spec')).toEqual({ type: 'dfl', description: 'dfl: (start) START → spec' });
    expect(historyMetadata('a'.repeat(200), 'NEXT', 'b'.repeat(200)).description).toHaveLength(255);
  });
});

describe('error mapping', () => {
  it('401 → TRACKER_AUTH naming the email, never the token', async () => {
    const fake = await start();
    const error = await failure(client(fake, { email: 'dev@example.com', token: 'wrong-token-123' }).myself());
    expect(error.code).toBe('TRACKER_AUTH');
    expect(error.status).toBe(401);
    expect(error.message).toBe(`Jira rejected the credentials for ${fake.url} (authenticated as dev@example.com).`);
    expect(error.hint).toMatch(/expired.*scoped token.*`dfl tracker login` in your own terminal.*never paste a token/s);
    expect(`${error.message} ${error.hint}`).not.toContain('wrong-token-123');
    expect(fake.requests[0]!.account).toBeUndefined();
  });

  it('a CAPTCHA lock-out → TRACKER_AUTH with a browser hint', async () => {
    const fake = await start();
    fake.setFailure('myself', { status: 403, headers: { 'X-Seraph-LoginReason': 'AUTHENTICATED_FAILED,AUTHENTICATION_DENIED' }, body: '' });
    const error = await failure(client(fake).myself());
    expect(error.code).toBe('TRACKER_AUTH');
    expect(error.hint).toContain('in a browser');
  });

  it('403 → TRACKER_FORBIDDEN with the needed permissions', async () => {
    const fake = await start({ accounts: [{ ...DEFAULT_ACCOUNT, permissions: { edit: false } }] });
    const jiraClient = client(fake);
    const error = await failure(jiraClient.putProperty('ABC-1', 'dfl.run', {}));
    expect(error.code).toBe('TRACKER_FORBIDDEN');
    expect(error.message).toContain('You do not have permission to edit issues');
    expect(error.hint).toMatch(/Browse projects, Edit issues and Transition issues/);
    // Transition without Edit still works.
    await jiraClient.transition('ABC-1', 'tr-3', { historyMetadata: META });
    expect(fake.issue('ABC-1').status).toBe('In Progress');
  });

  it('404 → TASK_NOT_FOUND for issues, TRACKER_PROJECT_NOT_FOUND for projects', async () => {
    const fake = await start();
    const notFound = await failure(client(fake).getIssue('ABC-404'));
    expect(notFound.code).toBe('TASK_NOT_FOUND');
    expect(notFound.message).toBe('ABC-404 does not exist or is not visible to dev@example.com.');
    expect((await failure(client(fake).projectStatuses('XYZ'))).code).toBe('TRACKER_PROJECT_NOT_FOUND');
    const hidden = await createFakeJira({ issues: [{ key: 'ABC-1' }], accounts: [{ ...DEFAULT_ACCOUNT, permissions: { browse: false } }] });
    expect((await failure(client(hidden).getIssue('ABC-1'))).code).toBe('TASK_NOT_FOUND');
    await hidden.close();
  });

  it('429 → TRACKER_RATE_LIMITED with Retry-After', async () => {
    const fake = await start();
    fake.setFailure('getIssue', { status: 429, headers: { 'Retry-After': '7' }, times: 1 });
    const error = await failure(client(fake).getIssue('ABC-1'));
    expect(error.code).toBe('TRACKER_RATE_LIMITED');
    expect(error.hint).toContain('Wait 7 s');
    await expect(client(fake).getIssue('ABC-1')).resolves.toMatchObject({ key: 'ABC-1' });
  });

  it('other errors → TRACKER_HTTP with Jira messages (truncated)', async () => {
    const fake = await start();
    const unknownField = await failure(client(fake).editIssue('ABC-1', { fields: { customfield_1: 'x' }, historyMetadata: META }));
    expect(unknownField.code).toBe('TRACKER_HTTP');
    expect(unknownField.status).toBe(400);
    expect(unknownField.message).toContain("customfield_1: Field 'customfield_1' cannot be set");

    fake.setFailure('transition', { status: 500, body: { errorMessages: ['x'.repeat(2000)] } });
    const long = await failure(client(fake).transition('ABC-1', 'tr-3', { historyMetadata: META }));
    expect(long.code).toBe('TRACKER_HTTP');
    expect(long.message.length).toBeLessThan(700);
    expect(long.message).toContain('...');

    const required = await createFakeJira({
      issues: [{ key: 'ABC-1' }],
      workflow: { 'To Do': [{ to: 'Done', name: 'Close', requires: ['resolution'] }] },
    });
    const closeError = await failure(client(required).transition('ABC-1', 'tr-10001', { historyMetadata: META }));
    expect(closeError.message).toContain('resolution: Resolution is required.');
    await required.close();
  });

  it('extracts Jira error details', () => {
    expect(jiraErrorDetails('{"errorMessages":["A","  "],"errors":{"f":"B"}}')).toBe('A; f: B');
    expect(jiraErrorDetails('{"message":"C"}')).toBe('C');
    expect(jiraErrorDetails('<html>')).toBe('');
    expect(jiraErrorDetails('null')).toBe('');
  });

  it('does not follow redirects', async () => {
    const fake = await start();
    fake.setFailure('myself', { status: 302, headers: { Location: 'https://login.example.com/sso' }, body: '' });
    const error = await failure(client(fake).myself());
    expect(error.code).toBe('TRACKER_HTTP');
    expect(error.message).toContain('redirect (302 to https://login.example.com)');
    expect(fake.requests).toHaveLength(1);
  });

  it('a non-JSON success body → TRACKER_HTTP', async () => {
    const fake = await start();
    fake.setFailure('myself', { status: 200, body: '<html>login</html>' });
    const error = await failure(client(fake).myself());
    expect(error.code).toBe('TRACKER_HTTP');
    expect(error.message).toContain('non-JSON');
  });

  it('an unexpected JSON shape → TRACKER_HTTP', async () => {
    const fake = await start();
    fake.setFailure('getTransitions', { status: 200, body: { nope: true } });
    expect((await failure(client(fake).getTransitions('ABC-1'))).code).toBe('TRACKER_HTTP');
  });

  it('the shared deadline → TRACKER_TIMEOUT ("repeating is safe")', async () => {
    vi.stubEnv('DFL_TRACKER_TIMEOUT_MS', '400');
    expect(trackerTimeoutMs()).toBe(400);
    const fake = await start();
    fake.setFailure('getIssue', { delayMs: 5000 });
    const signal = trackerDeadline();
    const jiraClient = client(fake, DEFAULT_ACCOUNT, signal);
    await jiraClient.myself(); // fast requests share the deadline
    const error = await failure(jiraClient.getIssue('ABC-1'));
    expect(error.code).toBe('TRACKER_TIMEOUT');
    expect(error.message).toContain('within 400 ms');
    expect(error.hint).toContain('repeating the command is safe');
    // A move holds the project lock for up to the deadline; other dfl processes wait 15 s for it.
    expect(error.hint).toContain('DFL_TRACKER_TIMEOUT_MS (milliseconds; at 15000 or more, other dfl commands that wait for a move may fail with LOCKED)');
    // Once the deadline passed, every further request of the operation fails at once.
    expect((await failure(jiraClient.myself())).code).toBe('TRACKER_TIMEOUT');
  });

  it('defaults the deadline to 10 s', () => {
    vi.stubEnv('DFL_TRACKER_TIMEOUT_MS', '');
    expect(trackerTimeoutMs()).toBe(10_000);
    vi.stubEnv('DFL_TRACKER_TIMEOUT_MS', 'abc');
    expect(trackerTimeoutMs()).toBe(10_000);
  });

  it('a network failure → TRACKER_UNREACHABLE with proxy hints', async () => {
    const fake = await start();
    const url = fake.url;
    await fake.close();
    jira = undefined;
    const error = await failure(createJiraClient({ baseUrl: url, credential: DEFAULT_ACCOUNT }).myself());
    expect(error.code).toBe('TRACKER_UNREACHABLE');
    expect(error.message).toContain(`Cannot reach Jira at ${url}`);
    expect(error.hint).toContain('NODE_USE_ENV_PROXY');
    expect(error.hint).toMatch(/sandbox/);
  });

  it('DFL_DEBUG=1 logs method, path, status and time to stderr – never credentials or query values', async () => {
    const fake = await start();
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    vi.stubEnv('DFL_DEBUG', '1');
    await client(fake).getIssue('ABC-1', { properties: ['dfl.run'] });
    await failure(client(fake, { email: 'dev@example.com', token: 'bad-token' }).myself());
    vi.stubEnv('DFL_DEBUG', '');
    await client(fake).myself();
    expect(writes).toEqual([
      expect.stringMatching(/^dfl jira: GET \/issue\/ABC-1 → 200 \(\d+ ms\)\n$/),
      expect.stringMatching(/^dfl jira: GET \/myself → 401 \(\d+ ms\)\n$/),
    ]);
    const all = writes.join('');
    expect(all).not.toMatch(/test-token|bad-token|Basic|dfl\.run|summary/);
  });
});

describe('fake jira helpers', () => {
  it('provides credential env vars and records requests without secrets', async () => {
    const fake = await start();
    expect(credentialEnv(fake)).toEqual({ DFL_JIRA_URL: fake.url, DFL_JIRA_EMAIL: 'dev@example.com', DFL_JIRA_TOKEN: 'test-token' });
    await client(fake).myself();
    expect(JSON.stringify(fake.requests)).not.toContain('test-token');
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/myself', route: 'myself', account: 'dev@example.com', status: 200 });
    fake.issue('ABC-1').status = 'Blocked';
    expect((await client(fake).getIssue('ABC-1')).fields.status.name).toBe('Blocked');
    expect(() => fake.issue('NOPE-1')).toThrow(/no issue/);
  });
});
