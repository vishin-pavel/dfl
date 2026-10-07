import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveFlow } from '../src/core/config.js';
import { DflError } from '../src/core/errors.js';
import { loadFlow } from '../src/core/flow.js';
import { currentBranch, localBranchExists } from '../src/core/git.js';
import { withProjectLock } from '../src/core/lock.js';
import { saveCredential } from '../src/core/tracker/credentials.js';
import { processOpId } from '../src/core/tracker/record.js';
import {
  isTracked,
  renderBranchName,
  slugify,
  startTask,
  syncTrackedViewNote,
  taskMove,
  taskStatus,
  type TaskWriteOptions,
} from '../src/core/tracker/runtime.js';
import type { FlowModel, ProjectPaths } from '../src/core/types.js';
import {
  DEFAULT_ACCOUNT,
  DEFAULT_STATUSES,
  createFakeJira,
  credentialEnv,
  type FakeJira,
  type FakeJiraOptions,
  type FakeRoute,
} from './helpers/fake-jira.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

let jira: FakeJira | undefined;

beforeEach(() => {
  // Isolate from the developer's git config, dfl credentials and environment.
  const home = makeTempDir('dfl-git-home-');
  fs.writeFileSync(path.join(home, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(home, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('DFL_CONFIG_DIR', makeTempDir('dfl-config-'));
  for (const name of ['DFL_JIRA_URL', 'DFL_JIRA_EMAIL', 'DFL_JIRA_TOKEN', 'DFL_TRACKER_TIMEOUT_MS', 'DFL_DEBUG', 'DFL_ROOT']) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await jira?.close();
  jira = undefined;
  cleanupTempDirs();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BRANCH = 'ABC-1-export-orders-as-csv';
const DEFAULT_MAPPING = { plan: 'In Progress', build: 'In Progress', review: 'In Review', done: 'Done' };

interface Setup {
  paths: ProjectPaths;
  jira: FakeJira;
  model: FlowModel;
  opts: TaskWriteOptions;
  /** Request-log ranges [start, end) covered by each withLock call. */
  windows: Array<[number, number]>;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=dfl', '-c', 'user.email=dfl@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function trackerJson(fake: FakeJira, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    provider: 'jira',
    jira: { baseUrl: fake.url, projectKeys: ['ABC'], defaultProjectKey: 'ABC' },
    branch: { from: 'main' },
    fields: { branch: 'customfield_10042', prUrl: 'customfield_10077' },
    flows: { sample: { statuses: DEFAULT_MAPPING } },
    ...overrides,
  };
}

function writeTracker(paths: ProjectPaths, content: Record<string, unknown> | string): void {
  fs.writeFileSync(paths.trackerFile, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function useEnvCredentials(fake: FakeJira): void {
  for (const [name, value] of Object.entries(credentialEnv(fake))) vi.stubEnv(name, value);
}

/** A git repository (on main, everything committed) with the sample flow tracked in a fake Jira. */
async function setup(
  options: { tracker?: Record<string, unknown>; jira?: FakeJiraOptions; credentials?: boolean; noTracker?: boolean } = {},
): Promise<Setup> {
  // Tests that set up twice: close the first fake (afterEach closes only the last one).
  await jira?.close();
  jira = await createFakeJira({
    issues: [
      { key: 'ABC-1', id: '10231', summary: 'Export orders as CSV' },
      { key: 'ABC-2', id: '10232', summary: 'Second ticket' },
      { key: 'ABC-3', id: '10233', summary: 'Добавить экспорт' },
      { key: 'ABC-5', id: '10235', summary: 'Fix the crash', issueType: 'Bug' },
    ],
    ...options.jira,
  });
  const paths = makeTempProject();
  writeSampleFlow(paths);
  if (!options.noTracker) writeTracker(paths, trackerJson(jira, options.tracker));
  git(paths.root, 'init', '-q', '-b', 'main');
  git(paths.root, 'add', '-A');
  git(paths.root, 'commit', '-q', '-m', 'init');
  if (options.credentials !== false) useEnvCredentials(jira);
  const windows: Array<[number, number]> = [];
  const fake = jira;
  const opts: TaskWriteOptions = {
    withLock: async <T>(fn: () => Promise<T>): Promise<T> => {
      const start = fake.requests.length;
      try {
        return await withProjectLock(paths, fn);
      } finally {
        windows.push([start, fake.requests.length]);
      }
    },
  };
  return { paths, jira: fake, model: loadFlow(paths, 'sample'), opts, windows };
}

/** A record as start_task + one NEXT would leave it (op ids of another process). */
function seededRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const at = new Date().toISOString();
  return {
    schema: 1,
    issueId: '10231',
    key: 'ABC-1',
    flow: 'sample',
    step: 'build',
    params: { branch: BRANCH, slug: 'export-orders-as-csv' },
    history: [
      { from: '', to: 'plan', event: 'START', at, op: 'cafe0001' },
      { from: 'plan', to: 'build', event: 'NEXT', at, op: 'cafe0001' },
    ],
    updatedAt: at,
    dfl: '0.1.0',
    ...overrides,
  };
}

function routes(fake: FakeJira): Array<FakeRoute | undefined> {
  return fake.requests.map((r) => r.route);
}

function recordOf(fake: FakeJira, key = 'ABC-1'): Record<string, unknown> {
  return fake.issue(key).properties['dfl.run'] as Record<string, unknown>;
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

/** Starts ABC-1 from main and clears the request log. */
async function started(s: Setup): Promise<void> {
  await startTask(s.paths, { task: 'ABC-1' }, s.opts);
  s.jira.requests.splice(0);
  s.windows.splice(0);
}

// ---------------------------------------------------------------------------
// Branch names
// ---------------------------------------------------------------------------

describe('slugify / renderBranchName', () => {
  it('derives branch-name slugs from summaries', () => {
    expect(slugify('Export orders as CSV')).toBe('export-orders-as-csv');
    expect(slugify('Crème brûlée: façade & naïve café!')).toBe('creme-brulee-facade-naive-cafe');
    expect(slugify('  --Hello__World--  ')).toBe('hello-world');
    expect(slugify('Добавить экспорт')).toBe('');
    expect(slugify('')).toBe('');
  });

  it('cuts long slugs at a word boundary', () => {
    const slug = slugify('Allow exporting the order history of a customer as a CSV file');
    expect(slug).toBe('allow-exporting-the-order-history-of-a');
    expect(slugify('word '.repeat(7) + 'abcdefghij')).toBe('word-word-word-word-word-word-word');
    expect(slugify('a'.repeat(50))).toBe('a'.repeat(40));
    expect(slugify('Fix it', 3)).toBe('fix');
  });

  it('renders templates and drops an empty slug with its separator', () => {
    expect(renderBranchName('{key}-{slug}', 'ABC-1', 'csv')).toBe('ABC-1-csv');
    expect(renderBranchName('feature/{key}-{slug}', 'ABC-1', '')).toBe('feature/ABC-1');
    expect(renderBranchName('{slug}-{key}', 'ABC-1', '')).toBe('ABC-1');
    expect(renderBranchName('{key}/{slug}', 'ABC-1', '')).toBe('ABC-1');
    expect(renderBranchName('feat/{key}_{slug}', 'ABC-1', 'x')).toBe('feat/ABC-1_x');
  });
});

// ---------------------------------------------------------------------------
// start_task
// ---------------------------------------------------------------------------

describe('startTask', () => {
  it('creates the task branch from a protected branch, records the task and moves the ticket', async () => {
    const s = await setup();
    const result = await startTask(s.paths, { task: '#1' }, s.opts);

    expect(result.branch).toEqual({ name: BRANCH, action: 'created' });
    expect(currentBranch(s.paths.root)).toBe(BRANCH);
    expect(result.state).toMatchObject({ flow: 'sample', current: 'plan', done: false });
    expect(result.state.history).toEqual([expect.objectContaining({ from: '', to: 'plan', event: 'START' })]);
    expect(result.task).toMatchObject({
      provider: 'jira',
      key: 'ABC-1',
      url: `${s.jira.url}/browse/ABC-1`,
      title: 'Export orders as CSV',
      started: true,
      step: 'plan',
      status: { actual: 'In Progress', expected: 'In Progress', inSync: true },
      params: { branch: BRANCH, slug: 'export-orders-as-csv' },
      branch: BRANCH,
      via: 'arg',
      warnings: [],
    });
    expect(result.task.instructions).toContain('You are already on its branch (task.branch)');
    expect(result.task.instructions).not.toContain(BRANCH);
    // tracker.json maps branch to a field: the agent is told which params reach Jira.
    expect(result.task.instructions).toContain('These params are also written to Jira fields: branch, prUrl.');
    expect(result.task.instructions).toContain('dfl next NEXT --from plan --task ABC-1');

    const issue = s.jira.issue('ABC-1');
    expect(issue.status).toBe('In Progress');
    expect(issue.fields['customfield_10042']).toBe(BRANCH);
    expect(recordOf(s.jira)).toMatchObject({
      schema: 1,
      issueId: '10231',
      key: 'ABC-1',
      flow: 'sample',
      step: 'plan',
      params: { branch: BRANCH, slug: 'export-orders-as-csv' },
      history: [{ from: '', to: 'plan', event: 'START', op: processOpId() }],
    });

    // Read, then (under the lock) re-read, record, transition, fields.
    expect(routes(s.jira)).toEqual(['getIssue', 'getIssue', 'putProperty', 'getTransitions', 'transition', 'editIssue']);
    expect(s.windows).toEqual([[1, 6]]);
    expect(s.jira.requestsTo('transition')[0]!.body).toMatchObject({
      transition: { id: 'tr-3' },
      historyMetadata: { type: 'dfl', description: 'dfl: (start) START → plan' },
    });
    expect(s.jira.requestsTo('editIssue')[0]!.body).toEqual({
      fields: { customfield_10042: BRANCH },
      historyMetadata: { type: 'dfl', description: 'dfl: (start) START → plan' },
    });
  });

  it('fetches the base branch from its remote first, and branches from the local ref when that fails', async () => {
    const s = await setup({ tracker: { branch: {} } }); // from: origin/main (the flow's mainBranch)
    const origin = path.join(makeTempDir('dfl-origin-'), 'origin.git');
    git(path.dirname(origin), 'init', '-q', '--bare', '-b', 'main', origin);
    git(s.paths.root, 'remote', 'add', 'origin', origin);
    git(s.paths.root, 'push', '-q', 'origin', 'main');
    git(s.paths.root, 'fetch', '-q', 'origin');
    // A teammate pushes a commit that this clone has not fetched yet.
    const other = makeTempDir('dfl-clone-');
    git(other, 'clone', '-q', origin, '.');
    fs.writeFileSync(path.join(other, 'teammate.txt'), 'x\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'teammate');
    git(other, 'push', '-q', 'origin', 'main');
    const pushed = git(other, 'rev-parse', 'HEAD');

    const result = await startTask(s.paths, { task: 'ABC-1' }, s.opts);
    expect(result.branch.action).toBe('created');
    expect(git(s.paths.root, 'rev-parse', 'HEAD')).toBe(pushed);
    expect(result.task.warnings).toEqual([]);

    git(s.paths.root, 'switch', '-q', 'main');
    git(s.paths.root, 'remote', 'set-url', 'origin', path.join(origin, 'missing'));
    const second = await startTask(s.paths, { task: 'ABC-2' }, s.opts);
    expect(second.branch).toEqual({ name: 'ABC-2-second-ticket', action: 'created' });
    expect(second.task.warnings).toEqual([
      'Could not fetch origin/main; ABC-2-second-ticket was branched from the local origin/main, which may be behind.',
    ]);
  });

  it('uses the checked-out branch when its name contains the key', async () => {
    const s = await setup();
    git(s.paths.root, 'switch', '-q', '-c', 'feature/ABC-1-csv');
    const result = await startTask(s.paths, { task: 'abc-1' }, s.opts);
    expect(result.branch).toEqual({ name: 'feature/ABC-1-csv', action: 'current' });
    expect(result.task.params).toEqual({ branch: 'feature/ABC-1-csv', slug: 'csv' });
    expect(localBranchExists(s.paths.root, BRANCH)).toBe(false);
    expect(s.jira.issue('ABC-1').fields['customfield_10042']).toBe('feature/ABC-1-csv');

    // Without a slug in the branch name, the summary gives it.
    const t = await setup();
    git(t.paths.root, 'switch', '-q', '-c', 'ABC-1');
    expect((await startTask(t.paths, { task: 'ABC-1' }, t.opts)).task.params).toEqual({ branch: 'ABC-1', slug: 'export-orders-as-csv' });
  });

  it('asks before working on another branch', async () => {
    const s = await setup();
    git(s.paths.root, 'switch', '-q', '-c', 'some-work');
    const choice = await failure(startTask(s.paths, { task: 'ABC-1' }, s.opts));
    expect(choice.code).toBe('TASK_BRANCH_CHOICE');
    expect(choice.hint).toContain(`pass branch "create" (CLI: \`dfl task start ABC-1 --branch create\`) to create ${BRANCH} from main`);
    expect(choice.hint).toContain('git branch -m');
    expect((await failure(startTask(s.paths, { task: 'ABC-1', branch: 'current' }, s.opts))).code).toBe('TASK_BRANCH_CHOICE');
    expect(s.jira.requestsTo('putProperty')).toHaveLength(0);
    expect(currentBranch(s.paths.root)).toBe('some-work');

    git(s.paths.root, 'switch', '-q', '-c', 'ABC-2-other');
    const other = await failure(startTask(s.paths, { task: 'ABC-1' }, s.opts));
    expect(other.code).toBe('TASK_BRANCH_CHOICE');
    expect(other.message).toContain('belongs to ABC-2');

    git(s.paths.root, 'switch', '-q', 'main');
    const protectedCurrent = await failure(startTask(s.paths, { task: 'ABC-1', branch: 'current' }, s.opts));
    expect(protectedCurrent.code).toBe('TASK_BRANCH_CHOICE');
    expect(protectedCurrent.message).toContain('main is a protected branch');

    git(s.paths.root, 'switch', '-q', 'some-work');
    const created = await startTask(s.paths, { task: 'ABC-1', branch: 'create' }, s.opts);
    expect(created.branch).toEqual({ name: BRANCH, action: 'created' });
    expect(currentBranch(s.paths.root)).toBe(BRANCH);
  });

  it('refuses a detached HEAD, an existing branch, an invalid name and a missing base before writing', async () => {
    const s = await setup();
    git(s.paths.root, 'switch', '-q', '--detach');
    expect((await failure(startTask(s.paths, { task: 'ABC-1' }, s.opts))).code).toBe('TASK_BRANCH_DETACHED');

    git(s.paths.root, 'switch', '-q', 'main');
    git(s.paths.root, 'branch', BRANCH);
    const exists = await failure(startTask(s.paths, { task: 'ABC-1' }, s.opts));
    expect(exists.code).toBe('TASK_BRANCH_EXISTS');
    expect(exists.hint).toContain(`git switch ${BRANCH}`);

    writeTracker(s.paths, trackerJson(s.jira, { branch: { from: 'main', template: '{key}.lock/{slug}' } }));
    expect((await failure(startTask(s.paths, { task: 'ABC-2' }, s.opts))).code).toBe('TASK_BRANCH_INVALID');

    writeTracker(s.paths, trackerJson(s.jira, { branch: { from: 'origin/main' } }));
    const base = await failure(startTask(s.paths, { task: 'ABC-2' }, s.opts));
    expect(base.code).toBe('TASK_BRANCH_BASE_MISSING');
    expect(base.message).toContain('origin/main');

    expect(s.jira.requestsTo('putProperty')).toHaveLength(0);
    expect(currentBranch(s.paths.root)).toBe('main');
  });

  it('takes the slug option and the flow branch template; an empty slug drops the placeholder', async () => {
    const s = await setup({ tracker: { flows: { sample: { branchTemplate: 'feature/{key}-{slug}', statuses: DEFAULT_MAPPING } } } });
    const custom = await startTask(s.paths, { task: 'ABC-1', slug: 'Custom Slug!' }, s.opts);
    expect(custom.branch.name).toBe('feature/ABC-1-custom-slug');
    expect(custom.task.params).toEqual({ branch: 'feature/ABC-1-custom-slug', slug: 'custom-slug' });

    git(s.paths.root, 'switch', '-q', 'main');
    const cyrillic = await startTask(s.paths, { task: 'ABC-3' }, s.opts);
    expect(cyrillic.branch.name).toBe('feature/ABC-3');
    // No slug in the summary: the lowercase key is recorded, so later steps always find one.
    expect(cyrillic.task.params).toEqual({ branch: 'feature/ABC-3', slug: 'abc-3' });
  });

  it('resumes a started task without writing, and says where its branch is', async () => {
    const s = await setup();
    await started(s);
    const again = await startTask(s.paths, { task: 'ABC-1' }, s.opts);
    expect(again.branch).toEqual({ name: BRANCH, action: 'current' });
    expect(again.task).toMatchObject({ started: true, step: 'plan', warnings: [] });
    expect(routes(s.jira)).toEqual(['getIssue']);
    expect(s.windows).toEqual([]);

    git(s.paths.root, 'switch', '-q', 'main');
    const elsewhere = await startTask(s.paths, { task: 'ABC-1' }, s.opts);
    expect(elsewhere.branch).toEqual({ name: BRANCH, action: 'switch-needed' });
    expect(elsewhere.task.warnings).toEqual([`Switch to ${BRANCH} (git switch ${BRANCH}) to continue ABC-1.`]);
    expect(elsewhere.task.instructions).toContain('ask the user before switching to task.branch');

    const worktree = path.join(makeTempDir('dfl-wt-'), 'wt');
    git(s.paths.root, 'worktree', 'add', '-q', worktree, BRANCH);
    const held = await startTask(s.paths, { task: 'ABC-1' }, s.opts);
    expect(held.branch.action).toBe('switch-needed');
    expect(held.task.warnings[0]).toContain(`checked out in the worktree ${fs.realpathSync(worktree)}`);

    const step = await startTask(s.paths, { task: 'ABC-1', step: 'review' }, s.opts);
    expect(step.state.current).toBe('plan');
    expect(step.task.warnings[0]).toBe('ABC-1 is already started (at step "plan"), so step "review" was ignored: move it with `dfl goto review --task ABC-1`.');
    expect(s.jira.requestsTo('putProperty')).toHaveLength(0);
  });

  it('refuses to restart a done task and an explicit flow other than the record', async () => {
    const s = await setup({ jira: { issues: [{ key: 'ABC-1', id: '10231', summary: 'Done one', status: 'Done' }] } });
    s.jira.issue('ABC-1').properties['dfl.run'] = seededRecord({ step: 'done' });
    const done = await failure(startTask(s.paths, { task: 'ABC-1' }, s.opts));
    expect(done.code).toBe('TASK_DONE');
    expect(done.hint).toContain('`dfl goto plan --task ABC-1`');

    s.jira.issue('ABC-1').properties['dfl.run'] = seededRecord();
    expect((await failure(startTask(s.paths, { task: 'ABC-1', flow: 'other' }, s.opts))).code).toBe('TASK_FLOW_MISMATCH');
  });

  it('chooses the flow by issue type, and requires it to be tracked and active', async () => {
    const s = await setup({
      tracker: {
        flowSelect: { byIssueType: { bug: 'bugfix' }, default: 'sample' },
        flows: { sample: { statuses: DEFAULT_MAPPING }, bugfix: { statuses: { plan: 'In Progress' } } },
      },
    });
    writeSampleFlow(s.paths, sampleFlowDefinition('bugfix'));
    writeSampleFlow(s.paths, sampleFlowDefinition('untracked'));
    setActiveFlow(s.paths, 'sample');

    const notActive = await failure(startTask(s.paths, { task: 'ABC-5' }, s.opts));
    expect(notActive.code).toBe('TASK_FLOW_NOT_ACTIVE');
    expect(notActive.message).toBe(
      'ABC-5 is a Bug, which uses flow "bugfix" (flowSelect.byIssueType in .df/tracker.json), but the active flow is "sample".',
    );
    expect(notActive.hint).toContain('`dfl flow use bugfix`');

    const notMapped = await failure(startTask(s.paths, { task: 'ABC-5', flow: 'untracked' }, s.opts));
    expect(notMapped.code).toBe('TRACKER_FLOW_NOT_MAPPED');
    expect(notMapped.hint).toContain('`dfl tracker map --flow untracked`');

    setActiveFlow(s.paths, 'bugfix');
    const bug = await startTask(s.paths, { task: 'ABC-5' }, s.opts);
    expect(bug.state.flow).toBe('bugfix');
    expect(recordOf(s.jira, 'ABC-5')).toMatchObject({ flow: 'bugfix', step: 'plan' });

    git(s.paths.root, 'switch', '-q', 'main');
    expect((await failure(startTask(s.paths, { task: 'ABC-2' }, s.opts))).code).toBe('TASK_FLOW_NOT_ACTIVE'); // default: sample
  });

  it('needs a tracker config and credentials (env or file, bound to the origin)', async () => {
    const s = await setup({ noTracker: true });
    const none = await failure(startTask(s.paths, { task: 'ABC-1' }, s.opts));
    expect(none.code).toBe('TRACKER_NOT_CONFIGURED');
    expect(none.hint).toContain('`dfl tracker init`');

    writeTracker(s.paths, trackerJson(s.jira));
    vi.stubEnv('DFL_JIRA_URL', 'https://elsewhere.example');
    const missing = await failure(startTask(s.paths, { task: 'ABC-1' }, s.opts));
    expect(missing.code).toBe('TRACKER_AUTH_MISSING');
    expect(missing.message).toContain(s.jira.url);
    expect(missing.hint).toContain(path.join(process.env['DFL_CONFIG_DIR']!, 'credentials.json'));
    expect(missing.hint).toContain('`dfl tracker login`');
    expect(s.jira.requests).toHaveLength(0);

    for (const name of ['DFL_JIRA_URL', 'DFL_JIRA_EMAIL', 'DFL_JIRA_TOKEN']) vi.stubEnv(name, undefined);
    saveCredential(s.jira.url, DEFAULT_ACCOUNT, new Date(Date.now() - 400 * 24 * 60 * 60 * 1000));
    const result = await startTask(s.paths, { task: 'ABC-1' }, s.opts);
    expect(result.task.warnings).toHaveLength(1);
    expect(result.task.warnings[0]).toContain('was saved 400 days ago');
    expect(JSON.stringify(result)).not.toContain(DEFAULT_ACCOUNT.token);
  });

  it('keeps a record another dfl process wrote while this one prepared the branch', async () => {
    const s = await setup();
    const opts: TaskWriteOptions = {
      withLock: async <T>(fn: () => Promise<T>): Promise<T> => {
        s.jira.issue('ABC-1').properties['dfl.run'] = seededRecord({ step: 'plan' });
        return s.opts.withLock(fn);
      },
    };
    const result = await startTask(s.paths, { task: 'ABC-1' }, opts);
    expect(result.branch).toEqual({ name: BRANCH, action: 'current' });
    expect(result.task).toMatchObject({ started: true, step: 'plan' });
    expect(result.task.warnings).toEqual(['ABC-1 was started by another dfl process meanwhile; dfl kept that record.']);
    expect(s.jira.requestsTo('putProperty')).toHaveLength(0);
    expect(recordOf(s.jira)).toMatchObject({ history: [{ op: 'cafe0001' }, { op: 'cafe0001' }] });
  });

  it('treats a record copied from another issue as not started', async () => {
    const s = await setup();
    s.jira.issue('ABC-1').properties['dfl.run'] = seededRecord({ issueId: '99999' });
    const result = await startTask(s.paths, { task: 'ABC-1' }, s.opts);
    expect(result.branch.action).toBe('created');
    expect(result.task.warnings[0]).toContain('copied from another issue');
    expect(recordOf(s.jira)).toMatchObject({ issueId: '10231', step: 'plan' });
  });

  it('starts at a given step and refuses final or unknown steps', async () => {
    const s = await setup();
    expect((await failure(startTask(s.paths, { task: 'ABC-1', step: 'done' }, s.opts))).code).toBe('FINAL_STEP');
    expect((await failure(startTask(s.paths, { task: 'ABC-1', step: 'nope' }, s.opts))).code).toBe('STEP_NOT_FOUND');
    expect(currentBranch(s.paths.root)).toBe('main');

    const result = await startTask(s.paths, { task: 'ABC-1', step: 'review' }, s.opts);
    expect(result.state.current).toBe('review');
    expect(s.jira.issue('ABC-1').status).toBe('In Review');
  });

  it('reports a failed projection as a warning once the task is recorded', async () => {
    const s = await setup();
    s.jira.setFailure('transition', 500);
    s.jira.setFailure('editIssue', { status: 400, body: { errorMessages: [], errors: { customfield_10042: 'Field cannot be set.' } } });
    const result = await startTask(s.paths, { task: 'ABC-1' }, s.opts);
    expect(recordOf(s.jira)).toMatchObject({ step: 'plan' });
    expect(result.task.status).toEqual({ actual: 'To Do', expected: 'In Progress', inSync: false });
    expect(result.task.warnings).toHaveLength(2);
    expect(result.task.warnings[0]).toContain("dfl could not move ABC-1 from 'To Do' to 'In Progress'");
    expect(result.task.warnings[1]).toContain('dfl could not write branch to the Jira fields of ABC-1');
    expect(result.task.warnings[1]).toContain('customfield_10042: Field cannot be set.');
  });
});

// ---------------------------------------------------------------------------
// get_status
// ---------------------------------------------------------------------------

describe('taskStatus', () => {
  it('requires a ticket on a tracked flow, without network', async () => {
    const s = await setup();
    const status = await taskStatus(s.paths, s.model);
    expect(status?.state).toMatchObject({ flow: 'sample', current: 'plan', history: [] });
    expect(status?.task).toEqual({
      provider: 'jira',
      key: null,
      started: false,
      required: true,
      warnings: [],
      instructions: expect.stringContaining('run /init-task <ticket>'),
    });
    const codex = await taskStatus(s.paths, s.model, {}, { commandPrefix: '$' });
    expect(codex?.task.instructions).toContain('run $init-task <ticket>');

    git(s.paths.root, 'switch', '-q', '-c', 'ABC-7-finished');
    git(s.paths.root, 'switch', '-q', 'main');
    const suggested = await taskStatus(s.paths, s.model);
    expect(suggested?.task).toMatchObject({ required: true, suggested: 'ABC-7' });
    expect(suggested?.task.instructions).toContain('The previous branch was for ABC-7');
    expect(s.jira.requests).toHaveLength(0);
  });

  it('is undefined for untracked flows and for optional tasks without a ticket', async () => {
    const s = await setup({ noTracker: true });
    expect(await taskStatus(s.paths, s.model)).toBeUndefined();
    expect(isTracked(s.paths, 'sample')).toBe(false);

    writeTracker(s.paths, trackerJson(s.jira, { flows: { other: { statuses: {} } } }));
    expect(await taskStatus(s.paths, s.model, { task: 'ABC-1' })).toBeUndefined();
    expect(isTracked(s.paths, 'sample')).toBe(false);

    writeTracker(s.paths, trackerJson(s.jira, { flows: { sample: { requireTask: false, statuses: DEFAULT_MAPPING } } }));
    expect(isTracked(s.paths, 'sample')).toBe(true);
    expect(await taskStatus(s.paths, s.model)).toBeUndefined();
    expect(s.jira.requests).toHaveLength(0);

    writeTracker(s.paths, '{ "version": 1, ');
    expect(() => isTracked(s.paths, 'sample')).toThrow(expect.objectContaining({ code: 'TRACKER_CONFIG_INVALID' }));
  });

  it('shows a ticket without a dfl record as not started', async () => {
    const s = await setup();
    git(s.paths.root, 'switch', '-q', '-c', 'ABC-1-x');
    const status = await taskStatus(s.paths, s.model);
    expect(status?.state.current).toBe('plan');
    expect(status?.task).toEqual({
      provider: 'jira',
      key: 'ABC-1',
      url: `${s.jira.url}/browse/ABC-1`,
      title: 'Export orders as CSV',
      started: false,
      status: { actual: 'To Do', expected: null, inSync: true },
      params: {},
      branch: null,
      via: 'branch',
      warnings: [],
      instructions: 'ABC-1 has no dfl task yet. Ask the user whether to start working on it, then call start_task with {"task": "ABC-1"} (CLI: `dfl task start ABC-1`).',
    });
    expect(routes(s.jira)).toEqual(['getIssue']);
    expect(s.jira.requests[0]!.query).toMatchObject({ properties: 'dfl.run' });
  });

  it('shows a started task from its record, and drift from the mapping', async () => {
    const s = await setup();
    await started(s);
    await taskMove(s.paths, s.model, { kind: 'event', from: 'plan', params: { specPath: 'docs/specs/csv.md' } }, s.opts);

    const status = await taskStatus(s.paths, s.model);
    expect(status?.state).toMatchObject({ current: 'build', done: false });
    expect(status?.state.history.map((h) => h.event)).toEqual(['START', 'NEXT']);
    expect(status?.task).toMatchObject({
      key: 'ABC-1',
      started: true,
      step: 'build',
      status: { actual: 'In Progress', expected: 'In Progress', inSync: true },
      params: { branch: BRANCH, slug: 'export-orders-as-csv', specPath: 'docs/specs/csv.md' },
      branch: BRANCH,
      via: 'branch',
      warnings: [],
    });
    expect(status?.task.instructions).toContain('<EVENT> --from build --task ABC-1');

    s.jira.issue('ABC-1').status = 'Blocked';
    const drift = await taskStatus(s.paths, s.model, { task: 'ABC-1' });
    expect(drift?.task).toMatchObject({ via: 'arg', status: { actual: 'Blocked', expected: 'In Progress', inSync: false } });

    const mismatch = await failure(taskStatus(s.paths, s.model, { task: 'ABC-2' }));
    expect(mismatch.code).toBe('TASK_BRANCH_MISMATCH');
  });

  it('refuses a record of another flow and reports a step the flow no longer has', async () => {
    const s = await setup();
    git(s.paths.root, 'switch', '-q', '-c', BRANCH);
    s.jira.issue('ABC-1').properties['dfl.run'] = seededRecord({ flow: 'other' });
    const mismatch = await failure(taskStatus(s.paths, s.model));
    expect(mismatch.code).toBe('TASK_FLOW_MISMATCH');
    expect(mismatch.hint).toContain('`dfl flow use other`');

    s.jira.issue('ABC-1').properties['dfl.run'] = seededRecord({ step: 'gone' });
    const status = await taskStatus(s.paths, s.model);
    expect(status?.state.current).toBe('plan');
    expect(status?.state.repaired).toContain('"gone"');
    expect(status?.task).toMatchObject({ started: true, stepUnknown: 'gone', status: { expected: null, inSync: true } });
    expect(status?.task).not.toHaveProperty('step');
    expect(status?.task.warnings[0]).toContain('`dfl goto <step> --task ABC-1`');
    expect(status?.task.instructions).toContain('call goto_step with "task": "ABC-1"');

    s.jira.issue('ABC-1').properties['dfl.run'] = { schema: 1, issueId: '10231', key: 'ABC-1', flow: 5 };
    expect((await failure(taskStatus(s.paths, s.model))).code).toBe('TASK_RECORD_INVALID');
    s.jira.issue('ABC-1').properties['dfl.run'] = seededRecord({ schema: 2 });
    expect((await failure(taskStatus(s.paths, s.model))).code).toBe('TASK_SCHEMA_NEWER');
  });

  it('fails with the tracker error when Jira does not answer in time', async () => {
    const s = await setup();
    vi.stubEnv('DFL_TRACKER_TIMEOUT_MS', '100');
    s.jira.setFailure('getIssue', { delayMs: 1000 });
    expect((await failure(taskStatus(s.paths, s.model, { task: 'ABC-1' }))).code).toBe('TRACKER_TIMEOUT');
  });
});

// ---------------------------------------------------------------------------
// complete_step / transition / goto_step
// ---------------------------------------------------------------------------

describe('taskMove', () => {
  it('advances the record, and moves the ticket only when the mapped status changes', async () => {
    const s = await setup();
    await started(s);

    const first = await taskMove(s.paths, s.model, { kind: 'event', from: 'plan' }, s.opts);
    expect(first?.result).toMatchObject({ from: 'plan', to: 'build', event: 'NEXT', done: false });
    expect(first?.task).toEqual({
      key: 'ABC-1',
      status: { before: 'In Progress', after: 'In Progress', expected: 'In Progress' },
      params: { branch: BRANCH, slug: 'export-orders-as-csv' },
      warnings: [],
    });
    expect(routes(s.jira)).toEqual(['getIssue', 'putProperty']); // shared status: the record only
    expect(recordOf(s.jira)).toMatchObject({
      step: 'build',
      history: [
        { from: '', to: 'plan', event: 'START' },
        { from: 'plan', to: 'build', event: 'NEXT', op: processOpId() },
      ],
    });

    s.jira.requests.splice(0);
    const second = await taskMove(s.paths, s.model, { kind: 'event', from: 'build' }, s.opts);
    expect(second?.task.status).toEqual({ before: 'In Progress', after: 'In Review', expected: 'In Review' });
    expect(routes(s.jira)).toEqual(['getIssue', 'putProperty', 'getTransitions', 'transition']);
    expect(s.jira.requestsTo('transition')[0]!.body).toMatchObject({ historyMetadata: { description: 'dfl: build NEXT → review' } });
    expect(s.jira.issue('ABC-1').status).toBe('In Review');
    // Every request of a move is made under the lock.
    expect(s.windows).toEqual([
      [0, 2],
      [0, 4],
    ]);
  });

  it('keeps the status at steps mapped to none', async () => {
    const s = await setup({ tracker: { flows: { sample: { statuses: { ...DEFAULT_MAPPING, review: null } } } } });
    await started(s);
    await taskMove(s.paths, s.model, { kind: 'goto', step: 'review' }, s.opts);
    expect(routes(s.jira)).toEqual(['getIssue', 'putProperty']);
    expect(s.jira.issue('ABC-1').status).toBe('In Progress');
    expect((await taskStatus(s.paths, s.model))?.task).toMatchObject({ status: { actual: 'In Progress', expected: null, inSync: true } });
  });

  it('answers a retried event from the record instead of advancing twice', async () => {
    const s = await setup();
    await started(s);
    await taskMove(s.paths, s.model, { kind: 'event', from: 'plan' }, s.opts);
    const retry = await taskMove(s.paths, s.model, { kind: 'event', from: 'plan' }, s.opts);
    expect(retry?.replayed).toBe(true);
    expect(retry?.result).toMatchObject({ from: 'plan', to: 'build', event: 'NEXT' });
    expect(s.jira.requestsTo('putProperty')).toHaveLength(1);

    expect((await failure(taskMove(s.paths, s.model, { kind: 'event', from: 'plan', event: 'OTHER' }, s.opts))).code).toBe('NOT_CURRENT');
    const rec = recordOf(s.jira) as { history: Array<Record<string, unknown>> };
    rec.history.at(-1)!['op'] = 'deadbeef';
    expect((await failure(taskMove(s.paths, s.model, { kind: 'event', from: 'plan' }, s.opts))).code).toBe('NOT_CURRENT');
    rec.history.at(-1)!['op'] = processOpId();
    rec.history.at(-1)!['at'] = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    expect((await failure(taskMove(s.paths, s.model, { kind: 'event', from: 'plan' }, s.opts))).code).toBe('NOT_CURRENT');
    expect(s.jira.requestsTo('putProperty')).toHaveLength(1);
  });

  it('refuses events the current step does not allow, without writing', async () => {
    const s = await setup();
    await started(s);
    expect((await failure(taskMove(s.paths, s.model, { kind: 'event', from: 'review' }, s.opts))).code).toBe('NOT_CURRENT');
    expect((await failure(taskMove(s.paths, s.model, { kind: 'event', from: 'plan', event: 'BACK' }, s.opts))).code).toBe('EVENT_NOT_ALLOWED');
    expect((await failure(taskMove(s.paths, s.model, { kind: 'event', from: 'nope' }, s.opts))).code).toBe('STEP_NOT_FOUND');
    expect(s.jira.requestsTo('putProperty')).toHaveLength(0);
  });

  it('merges params into the record and projects the mapped fields', async () => {
    const s = await setup();
    await started(s);
    const url = 'https://example.test/pr/1';
    const moved = await taskMove(s.paths, s.model, { kind: 'event', from: 'plan', params: { prUrl: url, specPath: 'docs/specs/x.md', count: 3 } }, s.opts);
    expect(moved?.task.params).toEqual({ branch: BRANCH, slug: 'export-orders-as-csv', prUrl: url, specPath: 'docs/specs/x.md', count: '3' });
    expect(recordOf(s.jira)['params']).toEqual(moved?.task.params);
    expect(s.jira.requestsTo('editIssue').map((r) => (r.body as { fields: unknown }).fields)).toEqual([{ customfield_10077: url }]);
    expect(s.jira.issue('ABC-1').fields['customfield_10077']).toBe(url);

    // Deleting a mapped param clears its field; unchanged params are not written again.
    await taskMove(s.paths, s.model, { kind: 'event', from: 'build', params: { prUrl: null, specPath: 'docs/specs/x.md' } }, s.opts);
    expect(s.jira.requestsTo('editIssue').map((r) => (r.body as { fields: unknown }).fields)).toEqual([{ customfield_10077: url }, { customfield_10077: null }]);
    expect(recordOf(s.jira)['params']).not.toHaveProperty('prUrl');

    const before = s.jira.requestsTo('putProperty').length;
    for (const params of [{ apiToken: 'x' }, { specPath: '../outside.md' }, { 'bad name': 'x' }]) {
      expect((await failure(taskMove(s.paths, s.model, { kind: 'goto', step: 'plan', params }, s.opts))).code).toBe('TASK_PARAM_INVALID');
    }
    expect(s.jira.requestsTo('putProperty')).toHaveLength(before);
  });

  it('turns projection failures after the record write into warnings', async () => {
    const s = await setup();
    await started(s);
    await taskMove(s.paths, s.model, { kind: 'event', from: 'plan' }, s.opts);

    s.jira.setFailure('transition', 500);
    s.jira.setFailure('editIssue', { status: 400, body: { errorMessages: ['Field customfield_10077 is not on the screen.'] } });
    const moved = await taskMove(s.paths, s.model, { kind: 'event', from: 'build', params: { prUrl: 'https://example.test/pr/2' } }, s.opts);
    expect(recordOf(s.jira)).toMatchObject({ step: 'review', params: { prUrl: 'https://example.test/pr/2' } });
    expect(moved?.task.status).toEqual({ before: 'In Progress', after: 'In Progress', expected: 'In Review' });
    expect(moved?.task.warnings).toHaveLength(2);
    expect(moved?.task.warnings[0]).toContain("dfl could not move ABC-1 from 'In Progress' to 'In Review': Jira refused POST /issue/ABC-1/transitions (500");
    expect(moved?.task.warnings[1]).toContain('dfl could not write prUrl to the Jira fields of ABC-1: ');
    expect(moved?.task.warnings[1]).toContain('Field customfield_10077 is not on the screen.');

    // A timeout after the record write is a warning too.
    s.jira.clearFailures();
    vi.stubEnv('DFL_TRACKER_TIMEOUT_MS', '800');
    s.jira.setFailure('getTransitions', { delayMs: 2500 });
    const slow = await taskMove(s.paths, s.model, { kind: 'goto', step: 'review' }, s.opts);
    expect((recordOf(s.jira)['history'] as unknown[]).at(-1)).toMatchObject({ from: 'review', to: 'review', event: 'GOTO' });
    // The prUrl field that failed above is written again (it still differs), past the deadline too.
    expect(slow?.task.warnings).toHaveLength(2);
    expect(slow?.task.warnings[0]).toContain('did not answer within 800 ms');
    expect(slow?.task.warnings[0]).toContain('check the ticket');
    expect(slow?.task.warnings[1]).toContain('dfl could not write prUrl to the Jira fields of ABC-1');
  });

  it('fails without writing when the read or the record write fails', async () => {
    const s = await setup();
    await started(s);
    s.jira.setFailure('putProperty', 403);
    expect((await failure(taskMove(s.paths, s.model, { kind: 'event', from: 'plan' }, s.opts))).code).toBe('TRACKER_FORBIDDEN');
    expect(s.jira.requestsTo('getTransitions')).toHaveLength(0);
    expect(recordOf(s.jira)).toMatchObject({ step: 'plan' });

    s.jira.clearFailures();
    vi.stubEnv('DFL_TRACKER_TIMEOUT_MS', '100');
    s.jira.setFailure('getIssue', { delayMs: 1000 });
    expect((await failure(taskMove(s.paths, s.model, { kind: 'event', from: 'plan' }, s.opts))).code).toBe('TRACKER_TIMEOUT');
    expect(recordOf(s.jira)).toMatchObject({ step: 'plan' });
  });

  it('does not reopen a done ticket unless the mapping allows it', async () => {
    const s = await setup();
    await started(s);
    s.jira.issue('ABC-1').status = 'Done';
    const kept = await taskMove(s.paths, s.model, { kind: 'goto', step: 'build' }, s.opts);
    expect(kept?.task.warnings).toEqual(['ABC-1 is Done (done); dfl does not reopen it. Add "reopen": true to the mapping of build to allow it.']);
    expect(s.jira.issue('ABC-1').status).toBe('Done');
    expect(s.jira.requestsTo('transition')).toHaveLength(0);

    writeTracker(s.paths, trackerJson(s.jira, { flows: { sample: { statuses: { ...DEFAULT_MAPPING, plan: { status: 'In Progress', reopen: true } } } } }));
    const reopened = await taskMove(s.paths, s.model, { kind: 'goto', step: 'plan' }, s.opts);
    expect(reopened?.task.status).toEqual({ before: 'Done', after: 'In Progress', expected: 'In Progress' });
    expect(reopened?.task.warnings).toEqual([]);
  });

  it('moves a done ticket to another done status of the mapping', async () => {
    const s = await setup({
      jira: { statuses: [...DEFAULT_STATUSES, { id: '10009', name: 'Closed', categoryKey: 'done' }] },
      tracker: { flows: { sample: { statuses: { ...DEFAULT_MAPPING, review: 'Done', done: 'Closed' } } } },
    });
    await started(s);
    await taskMove(s.paths, s.model, { kind: 'goto', step: 'review' }, s.opts);
    expect(s.jira.issue('ABC-1').status).toBe('Done');
    const moved = await taskMove(s.paths, s.model, { kind: 'event', from: 'review' }, s.opts);
    expect(moved?.result.done).toBe(true);
    expect(moved?.task).toMatchObject({ status: { before: 'Done', after: 'Closed', expected: 'Closed' }, warnings: [] });

    // Back to a step that is not done: the done guard holds.
    const back = await taskMove(s.paths, s.model, { kind: 'goto', step: 'build' }, s.opts);
    expect(back?.task.warnings).toEqual(['ABC-1 is Closed (done); dfl does not reopen it. Add "reopen": true to the mapping of build to allow it.']);
  });

  it('leaves a ticket that was moved outside dfl, and reports missing transitions', async () => {
    const s = await setup({ jira: { workflow: { 'To Do': ['In Progress'], 'In Progress': ['Blocked'], Blocked: ['In Progress'] } } });
    await started(s);
    s.jira.issue('ABC-1').status = 'Blocked';
    const left = await taskMove(s.paths, s.model, { kind: 'goto', step: 'review' }, s.opts);
    expect(left?.task.warnings).toEqual([
      "ABC-1 was moved to 'Blocked' outside dfl; dfl left it there (expected 'In Review'). Move it yourself or run the step again after moving it back.",
    ]);
    expect(s.jira.requestsTo('getTransitions')).toHaveLength(0);

    s.jira.issue('ABC-1').status = 'In Progress';
    const stuck = await taskMove(s.paths, s.model, { kind: 'goto', step: 'review' }, s.opts);
    expect(stuck?.task.warnings).toEqual([
      "No transition from 'In Progress' to 'In Review' for ABC-1 (available: To Blocked → Blocked). " +
        'Move the ticket by hand or change the mapping with `dfl tracker map`.',
    ]);
    expect(s.jira.issue('ABC-1').status).toBe('In Progress');
  });

  it('sends the mapping fields with the transition', async () => {
    const workflow = { 'To Do': ['In Progress'], 'In Progress': ['In Review'], 'In Review': [{ to: 'Done', requires: ['resolution'] }] };
    const s = await setup({
      jira: { workflow },
      tracker: { flows: { sample: { statuses: { ...DEFAULT_MAPPING, done: { status: 'Done', fields: { resolution: { name: 'Done' } } } } } } },
    });
    await started(s);
    await taskMove(s.paths, s.model, { kind: 'goto', step: 'review' }, s.opts);
    const done = await taskMove(s.paths, s.model, { kind: 'event', from: 'review' }, s.opts);
    expect(done?.task.warnings).toEqual([]);
    expect(s.jira.issue('ABC-1').status).toBe('Done');
    expect(s.jira.issue('ABC-1').fields['resolution']).toEqual({ name: 'Done' });

    // Without the fields, Jira's validation error comes back as a warning with the fix.
    const t = await setup({ jira: { workflow } });
    await started(t);
    await taskMove(t.paths, t.model, { kind: 'goto', step: 'review' }, t.opts);
    const refused = await taskMove(t.paths, t.model, { kind: 'event', from: 'review' }, t.opts);
    expect(refused?.task.warnings[0]).toContain('resolution: Resolution is required.');
    expect(refused?.task.warnings[0]).toContain('add the fields the transition needs to "fields" of the mapping in .df/tracker.json');
  });

  it('requires a started task and the step an event completes', async () => {
    const s = await setup();
    const required = await failure(taskMove(s.paths, s.model, { kind: 'event', from: 'plan' }, s.opts));
    expect(required.code).toBe('TASK_REQUIRED');
    expect(required.hint).toContain('/init-task <ticket> (CLI: `dfl task start <ticket>`)');

    git(s.paths.root, 'switch', '-q', '-c', 'ABC-1-x');
    const notStarted = await failure(taskMove(s.paths, s.model, { kind: 'event', from: 'plan' }, { ...s.opts, commandPrefix: '$' }));
    expect(notStarted.code).toBe('TASK_NOT_STARTED');
    expect(notStarted.hint).toBe('Start it with $init-task ABC-1 (CLI: `dfl task start ABC-1`).');
    expect((await failure(taskMove(s.paths, s.model, { kind: 'goto', step: 'build' }, s.opts))).code).toBe('TASK_NOT_STARTED');

    s.jira.issue('ABC-1').properties['dfl.run'] = seededRecord({ step: 'plan' });
    expect((await failure(taskMove(s.paths, s.model, { kind: 'event' }, s.opts))).code).toBe('TASK_FROM_REQUIRED');
    const free = await taskMove(s.paths, s.model, { kind: 'event', requireFrom: false }, s.opts);
    expect(free?.result).toMatchObject({ from: 'plan', to: 'build' });

    s.jira.issue('ABC-1').properties['dfl.run'] = seededRecord({ flow: 'other' });
    expect((await failure(taskMove(s.paths, s.model, { kind: 'goto', step: 'build' }, s.opts))).code).toBe('TASK_FLOW_MISMATCH');

    git(s.paths.root, 'switch', '-q', 'main');
    writeTracker(s.paths, trackerJson(s.jira, { flows: { sample: { requireTask: false, statuses: DEFAULT_MAPPING } } }));
    expect(await taskMove(s.paths, s.model, { kind: 'event' }, s.opts)).toBeUndefined();
  });

  it('repairs an unknown step or an invalid record only with goto (and reset)', async () => {
    const s = await setup();
    git(s.paths.root, 'switch', '-q', '-c', BRANCH);
    const issue = s.jira.issue('ABC-1');
    issue.properties['dfl.run'] = seededRecord({ step: 'gone' });
    const unknown = await failure(taskMove(s.paths, s.model, { kind: 'event', from: 'plan' }, s.opts));
    expect(unknown.code).toBe('TASK_STEP_UNKNOWN');
    expect(unknown.hint).toContain('`dfl goto <step> --task ABC-1`');

    const repaired = await taskMove(s.paths, s.model, { kind: 'goto', step: 'build' }, s.opts);
    expect(repaired?.result).toMatchObject({ from: 'gone', to: 'build', event: 'GOTO' });
    expect(recordOf(s.jira)).toMatchObject({ step: 'build', params: { branch: BRANCH } });
    expect((recordOf(s.jira)['history'] as unknown[]).length).toBe(3);

    issue.properties['dfl.run'] = seededRecord({ step: 'gone' });
    const reset = await taskMove(s.paths, s.model, { kind: 'reset' }, s.opts);
    expect(reset?.result).toMatchObject({ from: 'gone', to: 'plan', event: 'RESET' });

    issue.properties['dfl.run'] = { schema: 1, issueId: '10231', key: 'ABC-1', flow: 'sample', step: 7 };
    expect((await failure(taskMove(s.paths, s.model, { kind: 'event', from: 'plan' }, s.opts))).code).toBe('TASK_RECORD_INVALID');
    expect((await failure(taskMove(s.paths, s.model, { kind: 'reset' }, s.opts))).code).toBe('TASK_RECORD_INVALID');
    const fresh = await taskMove(s.paths, s.model, { kind: 'goto', step: 'review', params: { slug: 'csv' } }, s.opts);
    expect(fresh?.task.warnings).toEqual(['The invalid dfl record of ABC-1 was replaced; its history starts over.']);
    expect(recordOf(s.jira)).toMatchObject({
      issueId: '10231',
      step: 'review',
      params: { slug: 'csv' },
      history: [{ from: '', to: 'review', event: 'GOTO', op: processOpId() }],
    });
    expect(issue.status).toBe('In Review');
  });

  it('resets a task to the initial step and projects its status', async () => {
    const s = await setup();
    await started(s);
    await taskMove(s.paths, s.model, { kind: 'goto', step: 'review' }, s.opts);
    const reset = await taskMove(s.paths, s.model, { kind: 'reset' }, s.opts);
    expect(reset?.result).toMatchObject({ from: 'review', to: 'plan', event: 'RESET' });
    expect(reset?.task.status).toEqual({ before: 'In Review', after: 'In Progress', expected: 'In Progress' });
    expect(s.jira.issue('ABC-1').status).toBe('In Progress');
  });
});

// ---------------------------------------------------------------------------
// Read-only views
// ---------------------------------------------------------------------------

describe('syncTrackedViewNote', () => {
  it('names the ticket of the branch for tracked flows and never throws', async () => {
    const s = await setup();
    expect(syncTrackedViewNote(s.paths, s.model)).toEqual({ note: 'tracked in Jira; no ticket on this branch' });
    git(s.paths.root, 'switch', '-q', '-c', 'feature/ABC-12-x');
    expect(syncTrackedViewNote(s.paths, 'sample')).toEqual({ note: 'tracked in Jira (ABC-12): run `dfl status`', key: 'ABC-12' });
    expect(syncTrackedViewNote(s.paths, 'other')).toBeUndefined();

    writeTracker(s.paths, { ...trackerJson(s.jira), provider: 'github' });
    expect(syncTrackedViewNote(s.paths, 'sample')?.note).toContain('.df/tracker.json is invalid: run `dfl tracker check`');
    writeTracker(s.paths, '{ not json');
    expect(syncTrackedViewNote(s.paths, 'sample')).toBeUndefined();
    fs.rmSync(s.paths.trackerFile);
    expect(syncTrackedViewNote(s.paths, 'sample')).toBeUndefined();
    expect(s.jira.requests).toHaveLength(0);
  });
});
