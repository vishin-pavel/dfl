import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentBranch } from '../src/core/git.js';
import { loadTrackerConfig } from '../src/core/tracker/config.js';
import { isTracked } from '../src/core/tracker/runtime.js';
import type { ProjectPaths } from '../src/core/types.js';
import { runCli } from '../src/run.js';
import { plain, truncate } from '../src/ui/output.js';
import { DEFAULT_ACCOUNT, DEFAULT_STATUSES, createFakeJira, credentialEnv, type FakeJira, type FakeJiraOptions } from './helpers/fake-jira.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

/**
 * Scripted prompts: with `interactive` set, isInteractive() is true (unless --yes) and every prompt
 * takes the next answer (a value, or a function of the prompt's options); otherwise the real module.
 */
type PromptAnswer = unknown | ((options: { message: string; options?: Array<{ value: string; label?: string }> }) => unknown);
const prompts = vi.hoisted(() => ({
  interactive: false,
  answers: [] as unknown[],
  asked: [] as Array<{ kind: string; message: string; options?: Array<{ value: string; label?: string }> }>,
}));
vi.mock('../src/ui/prompts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/prompts.js')>();
  const answer = async (kind: string, options: any): Promise<any> => {
    prompts.asked.push({ kind, message: options.message, options: options.options });
    if (prompts.answers.length === 0) throw new Error(`unexpected ${kind} prompt: ${options.message}`);
    const next = prompts.answers.shift();
    const value = typeof next === 'function' ? (next as (o: unknown) => unknown)(options) : next;
    if (kind === 'text' && typeof options.validate === 'function') {
      const problem = options.validate(String(value));
      if (problem) throw new Error(`text prompt rejected ${String(value)}: ${problem}`);
    }
    return value;
  };
  const silent = { start() {}, message() {}, stop() {}, error() {} };
  return {
    ...actual,
    isInteractive: (options: { yes?: boolean } = {}) => (prompts.interactive ? options.yes !== true : actual.isInteractive(options)),
    select: (options: any) => (prompts.interactive ? answer('select', options) : actual.select(options)),
    text: (options: any) => (prompts.interactive ? answer('text', options) : actual.text(options)),
    confirm: (options: any) => (prompts.interactive ? answer('confirm', options) : actual.confirm(options)),
    password: (options: any) => (prompts.interactive ? answer('password', options) : actual.password(options)),
    intro: (title: string) => (prompts.interactive ? undefined : actual.intro(title)),
    outro: (message: string) => (prompts.interactive ? process.stdout.write(`${message}\n`) : actual.outro(message)),
    logWarning: (message: string) => (prompts.interactive ? process.stderr.write(`${message}\n`) : actual.logWarning(message)),
    spinner: () => (prompts.interactive ? silent : actual.spinner()),
  };
});

/** Answers the next prompts with `answers` (in order) as if in a terminal. */
function answerPrompts(...answers: PromptAnswer[]): void {
  prompts.interactive = true;
  prompts.answers.push(...answers);
}

/** Picks the select option whose label starts with `label`. */
function pick(label: string): (options: { options?: Array<{ value: string; label?: string }> }) => string {
  return (options) => {
    const option = options.options?.find((o) => (o.label ?? o.value).startsWith(label));
    if (!option) throw new Error(`no option "${label}" in ${JSON.stringify(options.options?.map((o) => o.label))}`);
    return option.value;
  };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const ANSI_RE = /\u001B\[[0-9;]*m/g;
const BRANCH = 'ABC-1-export-orders-as-csv';
const MAPPING = { plan: 'In Progress', build: 'In Progress', review: 'In Review', done: 'Done' };
const HASH_HINT = 'In a shell, # starts a comment: use 123, ABC-123 or "#123".';

let jira: FakeJira | undefined;
let configDir = '';

beforeEach(() => {
  // Never prompt; isolate from the developer's git config, dfl credentials and environment.
  vi.stubEnv('CI', '1');
  vi.stubEnv('DFL_ROOT', '');
  const home = makeTempDir('dfl-git-home-');
  fs.writeFileSync(path.join(home, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(home, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  configDir = makeTempDir('dfl-config-');
  vi.stubEnv('DFL_CONFIG_DIR', configDir);
  for (const name of ['DFL_JIRA_URL', 'DFL_JIRA_EMAIL', 'DFL_JIRA_TOKEN', 'DFL_TRACKER_TIMEOUT_MS', 'DFL_DEBUG']) vi.stubEnv(name, undefined);
});

afterEach(async () => {
  expect(prompts.answers, 'unused prompt answers').toEqual([]);
  prompts.interactive = false;
  prompts.answers.splice(0);
  prompts.asked.splice(0);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await jira?.close();
  jira = undefined;
  cleanupTempDirs();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Like `dfl` but fails the test (showing the output) on a non-zero exit code. */
async function ok(root: string, ...args: string[]): Promise<RunResult> {
  const result = await dfl(root, ...args);
  if (result.code !== 0) throw new Error(`dfl ${args.join(' ')} exited ${result.code}\n${result.stderr}\n${result.stdout}`);
  return result;
}

/** A command that must fail with exit code 1. */
async function fails(root: string, ...args: string[]): Promise<RunResult> {
  const result = await dfl(root, ...args);
  if (result.code !== 1) throw new Error(`dfl ${args.join(' ')} exited ${result.code}, expected 1\n${result.stderr}\n${result.stdout}`);
  return result;
}

async function json<T = any>(root: string, ...args: string[]): Promise<T> {
  return JSON.parse((await ok(root, ...args, '--json')).stdout) as T;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=dfl', '-c', 'user.email=dfl@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function trackerConfig(fake: FakeJira, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    provider: 'jira',
    jira: { baseUrl: fake.url, projectKeys: ['ABC'], defaultProjectKey: 'ABC' },
    branch: { from: 'main' },
    fields: { branch: 'customfield_10042', prUrl: 'customfield_10077' },
    flows: { sample: { statuses: MAPPING } },
    ...overrides,
  };
}

function writeTracker(paths: ProjectPaths, content: Record<string, unknown>): void {
  fs.writeFileSync(paths.trackerFile, `${JSON.stringify(content, null, 2)}\n`);
}

function readTracker(paths: ProjectPaths): Record<string, any> {
  return JSON.parse(fs.readFileSync(paths.trackerFile, 'utf8')) as Record<string, any>;
}

function useEnvCredentials(fake: FakeJira, account = DEFAULT_ACCOUNT): void {
  for (const [name, value] of Object.entries(credentialEnv(fake, account))) vi.stubEnv(name, value);
}

/** Feeds `text` to the next read of process.stdin (`--token-stdin`). */
function feedStdin(text: string): void {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([text]) as unknown as typeof process.stdin);
}

/**
 * A git repository on main (everything committed) with the sample flow (plan → build → review → done),
 * tracked in a fake Jira unless `tracker` is false; env credentials unless `credentials` is false.
 */
async function project(
  options: { tracker?: Record<string, unknown> | false; jira?: FakeJiraOptions; credentials?: boolean } = {},
): Promise<{ paths: ProjectPaths; root: string; jira: FakeJira }> {
  jira = await createFakeJira({
    issues: [
      { key: 'ABC-1', id: '10231', summary: 'Export orders as CSV' },
      { key: 'ABC-2', id: '10232', summary: 'Second ticket' },
    ],
    ...options.jira,
  });
  const paths = makeTempProject();
  writeSampleFlow(paths);
  if (options.tracker !== false) writeTracker(paths, trackerConfig(jira, options.tracker));
  git(paths.root, 'init', '-q', '-b', 'main');
  git(paths.root, 'add', '-A');
  git(paths.root, 'commit', '-q', '-m', 'init');
  if (options.credentials !== false) useEnvCredentials(jira);
  return { paths, root: paths.root, jira };
}

function recordOf(fake: FakeJira, key = 'ABC-1'): Record<string, any> {
  return fake.issue(key).properties['dfl.run'] as Record<string, any>;
}

// ---------------------------------------------------------------------------
// dfl tracker init
// ---------------------------------------------------------------------------

describe('dfl tracker init', () => {
  it('needs --url and --project without a terminal', async () => {
    const { paths } = await project({ tracker: false });
    const { stderr } = await fails(paths.root, 'tracker', 'init', '--url', 'https://acme.atlassian.net');
    expect(stderr).toContain('needs --url and --project when there is no terminal to ask');
    expect(stderr).toContain('dfl tracker init --url https://acme.atlassian.net --project ABC');
    expect(fs.existsSync(paths.trackerFile)).toBe(false);
  });

  it('creates .df/tracker.json that tracks the active flow without status changes', async () => {
    const { paths } = await project({ tracker: false });
    const { stdout } = await ok(paths.root, 'tracker', 'init', '--url', 'acme.atlassian.net/jira/your-work', '--project', 'abc');
    expect(readTracker(paths)).toEqual({
      version: 1,
      provider: 'jira',
      jira: { baseUrl: 'https://acme.atlassian.net', projectKeys: ['ABC'], defaultProjectKey: 'ABC' },
      flows: { sample: { statuses: {} } },
    });
    expect(fs.readFileSync(paths.trackerFile, 'utf8')).toMatch(/^\{\n {2}"version": 1,\n[\s\S]*\}\n$/);
    expect(isTracked(paths, 'sample')).toBe(true);
    expect(stdout).toContain('Created .df/tracker.json (Jira https://acme.atlassian.net, project ABC; tracked: sample)');
    expect(stdout).toContain('Commit .df/tracker.json');
    expect(stdout).toContain('`dfl tracker login`');
    expect(stdout).toContain('`dfl tracker map`');
    expect(stdout).toContain('`dfl tracker map --none`');
    expect(stdout).toContain('4. Optionally store the task branch in a Jira field: `dfl tracker field branch <field>`.');
  });

  it('installs the built-in /init-task skill for a developer who installed dfl (unless --no-sync)', async () => {
    const skill = (paths: ProjectPaths): string => path.join(paths.root, '.claude', 'skills', 'init-task', 'SKILL.md');
    const { paths } = await project({ tracker: false });
    await ok(paths.root, 'install', '--yes', '--agents', 'claude');
    expect(fs.existsSync(skill(paths))).toBe(false);
    const { stdout } = await ok(paths.root, 'tracker', 'init', '--url', 'https://acme.atlassian.net', '--project', 'ABC');
    expect(stdout).toContain('Synced 7 skills of flow "sample" for Claude Code (+1 −0)');
    expect(fs.readFileSync(skill(paths), 'utf8')).toContain('`start_task`');

    // Not installed for this developer: nothing is installed or reported.
    const other = makeTempProject();
    writeSampleFlow(other);
    const quiet = await ok(other.root, 'tracker', 'init', '--url', 'https://acme.atlassian.net', '--project', 'ABC');
    expect(quiet.stdout).not.toContain('Synced');
    expect(quiet.stdout).not.toContain('install');

    const skipped = makeTempProject();
    writeSampleFlow(skipped);
    await ok(skipped.root, 'install', '--yes', '--agents', 'claude');
    const noSync = await ok(skipped.root, 'tracker', 'init', '--url', 'https://acme.atlassian.net', '--project', 'ABC', '--no-sync');
    expect(noSync.stdout).not.toContain('Synced');
    expect(fs.existsSync(skill(skipped))).toBe(false);
  });

  it('refuses to overwrite without --force and takes every option', async () => {
    const { paths, jira: fake } = await project();
    writeSampleFlow(paths, sampleFlowDefinition('other'));
    const before = fs.readFileSync(paths.trackerFile, 'utf8');
    const exists = await fails(paths.root, 'tracker', 'init', '--url', fake.url, '--project', 'ABC');
    expect(exists.stderr).toContain('.df/tracker.json already exists.');
    expect(exists.stderr).toContain('--force');
    expect(fs.readFileSync(paths.trackerFile, 'utf8')).toBe(before);

    await ok(
      paths.root,
      'tracker',
      'init',
      '--force',
      '--url',
      fake.url,
      '--project',
      'abc, xyz',
      '--default-project',
      'xyz',
      '--branch-template',
      'feature/{key}-{slug}',
      '--from',
      'origin/develop',
      '--property',
      'dfl.task',
      '--flow',
      'sample',
      'other',
    );
    expect(readTracker(paths)).toEqual({
      version: 1,
      provider: 'jira',
      jira: { baseUrl: fake.url, projectKeys: ['ABC', 'XYZ'], defaultProjectKey: 'XYZ', property: 'dfl.task' },
      branch: { template: 'feature/{key}-{slug}', from: 'origin/develop' },
      flows: { sample: { statuses: {} }, other: { statuses: {} } },
    });
  });

  it('rejects bad values before writing anything', async () => {
    const { paths } = await project({ tracker: false });
    const url = 'https://acme.atlassian.net';
    expect((await fails(paths.root, 'tracker', 'init', '--url', url, '--project', '1AB')).stderr).toContain('"1AB" is not a Jira project key.');
    expect((await fails(paths.root, 'tracker', 'init', '--url', 'ftp://acme', '--project', 'ABC')).stderr).toContain('is not the URL of a Jira site');
    expect((await fails(paths.root, 'tracker', 'init', '--url', 'http://jira.example.com', '--project', 'ABC')).stderr).toContain(
      'must be an https:// URL',
    );
    expect((await fails(paths.root, 'tracker', 'init', '--url', url, '--project', 'ABC', '--flow', 'nope')).stderr).toContain(
      'Flow "nope" does not exist.',
    );
    expect(
      (await fails(paths.root, 'tracker', 'init', '--url', url, '--project', 'ABC', '--default-project', 'XYZ')).stderr,
    ).toContain('--default-project XYZ is not one of the projects (ABC).');
    expect(
      (await fails(paths.root, 'tracker', 'init', '--url', url, '--project', 'ABC', '--branch-template', '{slug}')).stderr,
    ).toContain('must contain {key}');
    expect(fs.existsSync(paths.trackerFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dfl tracker login / logout
// ---------------------------------------------------------------------------

describe('dfl tracker login / logout', () => {
  const credentialsPath = (): string => path.join(configDir, 'credentials.json');

  it('verifies a token from stdin and saves it for the site, readable only by the user', async () => {
    const { paths, jira: fake } = await project({ credentials: false });
    feedStdin(`${DEFAULT_ACCOUNT.token}\n`);
    const { stdout, stderr } = await ok(paths.root, 'tracker', 'login', '--email', DEFAULT_ACCOUNT.email, '--token-stdin');
    expect(stdout).toContain(`Jira site: ${fake.origin}`);
    expect(stdout).toContain(`Logged in to ${fake.origin} as Dev Eloper (dev@example.com)`);
    expect(stdout).toContain(`Saved to ${credentialsPath()} (readable only by you).`);
    expect(stdout + stderr).not.toContain(DEFAULT_ACCOUNT.token);
    expect(fake.requestsTo('myself')).toHaveLength(1);
    expect(fake.requestsTo('myself')[0]!.account).toBe(DEFAULT_ACCOUNT.email);

    const saved = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
    expect(saved.origins[fake.origin]).toMatchObject({
      type: 'jira-cloud-basic',
      email: 'dev@example.com',
      token: 'test-token',
      accountId: DEFAULT_ACCOUNT.accountId,
      displayName: 'Dev Eloper',
    });
    if (process.platform !== 'win32') expect(fs.statSync(credentialsPath()).mode & 0o777).toBe(0o600);

    // The saved credential works for tracker commands.
    expect((await json(paths.root, 'tracker', 'check')).checks).toContainEqual(
      expect.objectContaining({ check: 'credential', level: 'ok', message: `Credential for ${fake.origin}: dev@example.com (from ${credentialsPath()})` }),
    );
  });

  it('reuses the saved email; a rejected token saves nothing', async () => {
    const { paths, jira: fake } = await project({ credentials: false });
    feedStdin('test-token');
    await ok(paths.root, 'tracker', 'login', '--email', 'dev@example.com', '--token-stdin');
    const before = fs.readFileSync(credentialsPath(), 'utf8');

    feedStdin('wrong-token\n');
    const rejected = await fails(paths.root, 'tracker', 'login', '--token-stdin');
    expect(rejected.stderr).toContain(`Jira rejected the credentials for ${fake.origin} (authenticated as dev@example.com).`);
    expect(rejected.stderr).not.toContain('wrong-token');
    expect(fs.readFileSync(credentialsPath(), 'utf8')).toBe(before);
  });

  it('needs a terminal, or the token on stdin (never as an argument)', async () => {
    const { paths } = await project({ credentials: false });
    const noTerminal = await fails(paths.root, 'tracker', 'login', '--email', 'dev@example.com');
    expect(noTerminal.stderr).toContain('There is no terminal to ask for the Jira API token.');
    expect(noTerminal.stderr).toContain('--token-stdin < token-file');

    feedStdin('test-token');
    expect((await fails(paths.root, 'tracker', 'login', '--token-stdin')).stderr).toContain('--token-stdin needs --email');
    feedStdin('  \n');
    expect((await fails(paths.root, 'tracker', 'login', '--email', 'dev@example.com', '--token-stdin')).stderr).toContain('No API token on stdin.');
    feedStdin('test token');
    expect((await fails(paths.root, 'tracker', 'login', '--email', 'dev@example.com', '--token-stdin')).stderr).toContain(
      'The API token contains whitespace.',
    );
    expect((await fails(paths.root, 'tracker', 'login', '--token', 'test-token')).stderr).toContain("unknown option '--token'");
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });

  it('logout removes the saved credential of the site', async () => {
    const { paths, jira: fake } = await project({ credentials: false });
    feedStdin('test-token');
    await ok(paths.root, 'tracker', 'login', '--email', 'dev@example.com', '--token-stdin');
    expect((await ok(paths.root, 'tracker', 'logout')).stdout).toContain(`Removed your saved Jira credential for ${fake.origin}.`);
    expect(JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')).origins).toEqual({});
    expect((await ok(paths.root, 'tracker', 'logout')).stdout).toContain(`No Jira credential for ${fake.origin} is saved; nothing changed.`);

    // Env credentials are not touched, and logout says so.
    useEnvCredentials(fake);
    expect((await ok(paths.root, 'tracker', 'logout')).stderr).toContain('DFL_JIRA_URL, DFL_JIRA_EMAIL and DFL_JIRA_TOKEN are still set');
  });

  it('needs .df/tracker.json', async () => {
    const { paths } = await project({ tracker: false, credentials: false });
    for (const args of [['login', '--token-stdin'], ['logout']]) {
      const { stderr } = await fails(paths.root, 'tracker', ...args);
      expect(stderr).toContain('This project has no Jira tracker (.df/tracker.json does not exist).');
      expect(stderr).toContain('`dfl tracker init`');
    }
  });
});

// ---------------------------------------------------------------------------
// dfl tracker check
// ---------------------------------------------------------------------------

describe('dfl tracker check', () => {
  it('passes for a working setup', async () => {
    const { paths, jira: fake } = await project();
    fs.writeFileSync(path.join(paths.root, 'package.json'), JSON.stringify({ devDependencies: { '@vishin-pavel/dfl': '^0.1.0' } }));
    const { stdout } = await ok(paths.root, 'tracker', 'check');
    expect(stdout).toContain(`✔ .df/tracker.json is valid (Jira ${fake.origin}, project ABC; tracked: sample)`);
    expect(stdout).toContain(`✔ Credential for ${fake.origin}: dev@example.com (from DFL_JIRA_URL, DFL_JIRA_EMAIL and DFL_JIRA_TOKEN)`);
    expect(stdout).toContain('✔ Authenticated as Dev Eloper (dev@example.com)');
    expect(stdout).toContain('✔ Project ABC: 5 statuses');
    expect(stdout).toContain('✔ flows.sample: every mapped status exists in Jira (4 steps)');
    expect(stdout).toContain('✔ fields.branch → Branch (customfield_10042)');
    expect(stdout).toContain('✔ fields.prUrl → Pull request (customfield_10077)');
    // The only warning: the fake Jira is served over plain http.
    expect(stdout).toContain('▲ .df/tracker.json: jira.baseUrl uses plain http://');
    expect(stdout).toContain('✔ Ready to track tasks in Jira (1 warning).');
    expect(stdout).not.toContain('global `dfl`');

    const result = await json(paths.root, 'tracker', 'check');
    expect(result.ok).toBe(true);
    expect(result.checks.filter((check: { level: string }) => check.level !== 'ok')).toEqual([
      { check: 'config', level: 'warn', message: '.df/tracker.json: jira.baseUrl uses plain http:// (only for local testing; Jira Cloud needs https://).' },
    ]);
  });

  it('reports every problem and exits 1', async () => {
    const { paths } = await project({
      tracker: {
        jira: { baseUrl: '', projectKeys: ['ABC', 'XYZ'] },
        fields: { notes: 'customfield_10088', gone: 'customfield_99999', branch: 'customfield_10042' },
        flowSelect: { byIssueType: { Story: 'sample' } },
        flows: { sample: { statuses: { ...MAPPING, review: 'In Reviw' } } },
      },
    });
    const config = readTracker(paths);
    config['jira'].baseUrl = jira!.url;
    writeTracker(paths, config);

    const { stdout } = await fails(paths.root, 'tracker', 'check');
    expect(stdout).toContain('▲ This project runs the global `dfl`');
    expect(stdout).toContain('npm install -D @vishin-pavel/dfl');
    expect(stdout).toContain('✔ Project ABC: 5 statuses');
    expect(stdout).toContain(`✖ Project XYZ does not exist on ${jira!.origin} or is not visible to dev@example.com.`);
    expect(stdout).toContain('✖ flows.sample.statuses.review: Jira has no status "In Reviw" in project ABC.');
    expect(stdout).toContain('Did you mean "In Review"?');
    expect(stdout).toContain('`dfl tracker map review <status> --flow sample`');
    expect(stdout).toContain('✖ fields.notes: Notes (customfield_10088) is a paragraph (multi-line) field; dfl writes params as single-line text');
    expect(stdout).toContain('✖ fields.gone: Jira has no field customfield_99999');
    // Two projects: dfl cannot see the field's context, so the field is a warning, not an ok.
    expect(stdout).toContain(
      '▲ fields.branch → Branch (customfield_10042): exists and is a single-line text field, but its field context must include every project (ABC, XYZ)',
    );
    expect(stdout).toContain('▲ flowSelect.byIssueType.Story: ABC has no issue type "Story" (issue types: Task, Bug).');
    expect(stdout).toContain('✖ 4 problems found.');

    const result = JSON.parse((await fails(paths.root, 'tracker', 'check', '--json')).stdout);
    expect(result.ok).toBe(false);
    expect(result.checks.filter((check: { level: string }) => check.level === 'fail').map((check: { check: string }) => check.check)).toEqual([
      'project',
      'statuses',
      'fields',
      'fields',
    ]);
  });

  it('fails without a credential, with a rejected one, and with an invalid config', async () => {
    const { paths, jira: fake } = await project({ credentials: false });
    const missing = await fails(paths.root, 'tracker', 'check');
    expect(missing.stdout).toContain(`✖ No Jira credential for ${fake.origin}; the online checks were skipped.`);
    expect(missing.stdout).toContain('`dfl tracker login`');
    expect(fake.requests).toHaveLength(0);

    useEnvCredentials(fake, { ...DEFAULT_ACCOUNT, token: 'expired' });
    const rejected = await fails(paths.root, 'tracker', 'check');
    expect(rejected.stdout).toContain(`✖ Jira rejected the credentials for ${fake.origin} (authenticated as dev@example.com).`);
    expect(rejected.stdout).not.toContain('Project ABC');

    fs.writeFileSync(paths.trackerFile, '{ "version": 1, "provider": "jira" }\n');
    const invalid = JSON.parse((await fails(paths.root, 'tracker', 'check', '--json')).stdout);
    expect(invalid).toMatchObject({ ok: false, checks: [{ check: 'config', level: 'fail' }] });
    expect(invalid.checks[0].message).toContain('Invalid tracker config in .df/tracker.json: jira');

    fs.rmSync(paths.trackerFile);
    expect((await fails(paths.root, 'tracker', 'check')).stderr).toContain('This project has no Jira tracker');
  });
});

// ---------------------------------------------------------------------------
// dfl tracker map
// ---------------------------------------------------------------------------

describe('dfl tracker map', () => {
  it('prints the mapping without a terminal (table, --list, --json), with no network', async () => {
    const { paths, jira: fake } = await project({ tracker: { flows: { sample: { statuses: { plan: 'In Progress', review: { id: '10004' }, done: null } } } } });
    const { stdout } = await ok(paths.root, 'tracker', 'map');
    expect(stdout).toContain('Sample flow (sample) → Jira statuses');
    expect(stdout).toMatch(/STEP\s+JIRA STATUS/);
    expect(stdout).toMatch(/plan\s+In Progress\n/);
    expect(stdout).toMatch(/build\s+—\n/);
    expect(stdout).toMatch(/review\s+id:10004\n/);
    expect(stdout).toMatch(/done\s+—\s+final\n/);
    expect((await ok(paths.root, 'tracker', 'map', '--list')).stdout).toBe(stdout);
    expect(await json(paths.root, 'tracker', 'map')).toEqual({
      flow: 'sample',
      tracked: true,
      statuses: { plan: 'In Progress', build: null, review: { id: '10004' }, done: null },
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('shows untracked flows as such', async () => {
    const { paths } = await project({ tracker: { flows: {} } });
    expect(await json(paths.root, 'tracker', 'map')).toEqual({
      flow: 'sample',
      tracked: false,
      statuses: { plan: null, build: null, review: null, done: null },
    });
    const { stdout } = await ok(paths.root, 'tracker', 'map');
    expect(stdout).toContain('Flow "sample" is not tracked in Jira.');
    expect(stdout).toContain('`dfl tracker map --none`');
  });

  it('maps a step to a status as Jira spells it, keeping key order and unknown keys', async () => {
    const { paths, jira: fake } = await project({ tracker: { 'x-team': { owner: 'core' }, flows: { sample: { statuses: { plan: 'In Progress' }, note: 'kept' } } } });
    const before = readTracker(paths);
    const { stdout } = await ok(paths.root, 'tracker', 'map', 'review', 'in review');
    expect(stdout).toContain('✔ review → In Review');
    expect(stdout).toMatch(/review\s+In Review\n/);
    const after = readTracker(paths);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(after['x-team']).toEqual({ owner: 'core' });
    expect(after['flows'].sample).toEqual({ statuses: { plan: 'In Progress', review: 'In Review' }, note: 'kept' });
    expect(fake.requestsTo('projectStatuses')).toHaveLength(1);

    await ok(paths.root, 'tracker', 'map', 'build', 'id:10004');
    expect(readTracker(paths)['flows'].sample.statuses.build).toEqual({ id: '10004' });
    expect(loadTrackerConfig(paths)?.flows['sample']?.statuses['build']).toEqual({ id: '10004', reopen: false });
  });

  it('sets none per step (none, --none), unsets a step, and maps every step to none with --none', async () => {
    const { paths } = await project();
    await ok(paths.root, 'tracker', 'map', 'build', 'none');
    await ok(paths.root, 'tracker', 'map', 'plan', '--none');
    const unset = await ok(paths.root, 'tracker', 'map', 'review', '--unset');
    expect(unset.stdout).toContain("✔ review → none (dfl leaves the ticket's status alone at this step)");
    expect(readTracker(paths)['flows'].sample.statuses).toEqual({ plan: null, build: null, done: 'Done' });

    const all = await ok(paths.root, 'tracker', 'map', '--none');
    expect(all.stdout).toContain('No step of flow "sample" changes the Jira status: dfl still records each task, its params and branch.');
    expect(all.stdout).toContain("No step changes the Jira status: dfl records each task, its params and branch, and leaves the ticket's status alone.");
    expect(readTracker(paths)['flows'].sample.statuses).toEqual({ plan: null, build: null, done: null, review: null });
    expect(isTracked(paths, 'sample')).toBe(true);
  });

  it('creates the flow entry (the flow becomes tracked) and maps other flows with --flow', async () => {
    const { paths } = await project({ tracker: { flows: {} } });
    writeSampleFlow(paths, sampleFlowDefinition('other'));
    const { stdout } = await ok(paths.root, 'tracker', 'map', 'plan', 'In Progress', '--flow', 'sample');
    expect(stdout).toContain('✔ Flow "sample" is now tracked in Jira.');
    expect(readTracker(paths)['flows']).toEqual({ sample: { statuses: { plan: 'In Progress' } } });

    await ok(paths.root, 'tracker', 'map', '--none', '--flow', 'other');
    expect(readTracker(paths)['flows'].other).toEqual({ statuses: { plan: null, build: null, review: null, done: null } });
    expect(await json(paths.root, 'tracker', 'map', '--flow', 'other')).toMatchObject({ flow: 'other', tracked: true });
  });

  it('refuses statuses Jira does not have, with close matches; --no-check skips the check', async () => {
    const { paths, jira: fake } = await project();
    const before = fs.readFileSync(paths.trackerFile, 'utf8');
    const unknown = await fails(paths.root, 'tracker', 'map', 'review', 'In Reviw');
    expect(unknown.stderr).toContain('Jira has no status "In Reviw" in project ABC.');
    expect(unknown.stderr).toContain('Did you mean "In Review"?');
    expect(unknown.stderr).toContain('Pass --no-check to map it anyway.');
    expect((await fails(paths.root, 'tracker', 'map', 'review', 'id:999')).stderr).toContain('Jira has no status with id 999 in project ABC.');
    expect(fs.readFileSync(paths.trackerFile, 'utf8')).toBe(before);

    fake.requests.splice(0);
    await ok(paths.root, 'tracker', 'map', 'review', 'Code Review', '--no-check');
    expect(readTracker(paths)['flows'].sample.statuses.review).toBe('Code Review');
    expect(fake.requests).toHaveLength(0);
  });

  it('writes unchecked, with a warning, without a credential or when Jira fails', async () => {
    const { paths, jira: fake } = await project({ credentials: false });
    const offline = await ok(paths.root, 'tracker', 'map', 'review', 'Code Review');
    expect(offline.stderr).toContain(`Not checked against Jira: no Jira credential for ${fake.origin} (run \`dfl tracker login\`).`);
    expect(readTracker(paths)['flows'].sample.statuses.review).toBe('Code Review');

    useEnvCredentials(fake);
    fake.setFailure('projectStatuses', 500);
    const failing = await ok(paths.root, 'tracker', 'map', 'build', 'Building');
    expect(failing.stderr).toContain('Not checked against Jira:');
    expect(failing.stderr).toContain('Injected failure');
    expect(readTracker(paths)['flows'].sample.statuses.build).toBe('Building');
  });

  it('keeps fields and reopen of an object mapping when only the status changes', async () => {
    const { paths } = await project({
      tracker: { flows: { sample: { statuses: { ...MAPPING, done: { status: 'Done', fields: { resolution: { name: 'Done' } }, reopen: true } } } } },
    });
    const { stdout } = await ok(paths.root, 'tracker', 'map', 'done', 'Closed', '--no-check');
    expect(stdout).toContain('The mapping of done kept its other settings ("fields", "reopen").');
    expect(stdout).toMatch(/done\s+Closed \(\+fields, reopen\)\s+final/);
    expect(readTracker(paths)['flows'].sample.statuses.done).toEqual({ status: 'Closed', fields: { resolution: { name: 'Done' } }, reopen: true });
  });

  it('stops tracking a flow with --remove (confirmed with --yes without a terminal)', async () => {
    const { paths } = await project({ tracker: { flowSelect: { default: 'sample' } } });
    const unconfirmed = await fails(paths.root, 'tracker', 'map', '--remove');
    expect(unconfirmed.stderr).toContain('confirmation required');
    expect(unconfirmed.stderr).toContain('--yes');
    expect(isTracked(paths, 'sample')).toBe(true);

    const removed = await ok(paths.root, 'tracker', 'map', '--remove', '--yes');
    expect(removed.stdout).toContain('✔ Flow "sample" is no longer tracked in Jira: dfl uses its local state again.');
    expect(removed.stderr).toContain('flowSelect.default names flow "sample", which is not tracked');
    expect(readTracker(paths)['flows']).toEqual({});
    expect(isTracked(paths, 'sample')).toBe(false);
    expect((await ok(paths.root, 'tracker', 'map', '--remove', '--yes')).stdout).toContain('Flow "sample" is not tracked in Jira; nothing changed.');
    expect(await json(paths.root, 'tracker', 'map', '--remove', '--yes')).toEqual({
      flow: 'sample',
      tracked: false,
      statuses: { plan: null, build: null, review: null, done: null },
    });
  });

  it('checks the step and the options', async () => {
    const { paths } = await project();
    const before = fs.readFileSync(paths.trackerFile, 'utf8');
    expect((await fails(paths.root, 'tracker', 'map', 'nope', 'Done')).stderr).toContain('Step "nope" does not exist in flow "sample".');
    expect((await fails(paths.root, 'tracker', 'map', 'review')).stderr).toContain('Missing the Jira status for step "review".');
    expect((await fails(paths.root, 'tracker', 'map', 'review', 'Done', '--none')).stderr).toContain('Pass either a status or --none');
    expect((await fails(paths.root, 'tracker', 'map', '--unset')).stderr).toContain('--unset needs a step');
    expect((await fails(paths.root, 'tracker', 'map', 'review', '--remove')).stderr).toContain('--remove takes no step');
    expect((await fails(paths.root, 'tracker', 'map', 'review', 'id:')).stderr).toContain('is not a status id');
    expect((await fails(paths.root, 'tracker', 'map', '--flow', 'nope')).stderr).toContain('nope');
    expect(fs.readFileSync(paths.trackerFile, 'utf8')).toBe(before);

    fs.rmSync(paths.trackerFile);
    const missing = await fails(paths.root, 'tracker', 'map', 'review', 'Done');
    expect(missing.stderr).toContain('This project has no Jira tracker');
    expect(missing.stderr).toContain('`dfl tracker init`');
  });
});

// ---------------------------------------------------------------------------
// dfl tracker field
// ---------------------------------------------------------------------------

describe('dfl tracker field', () => {
  it('lists the mapped fields', async () => {
    const { paths } = await project();
    const { stdout } = await ok(paths.root, 'tracker', 'field');
    expect(stdout).toMatch(/PARAM\s+JIRA FIELD/);
    expect(stdout).toMatch(/branch\s+customfield_10042/);
    expect((await ok(paths.root, 'tracker', 'field', '--list')).stdout).toBe(stdout);
    // --list lists whatever else is given (it never maps).
    expect((await ok(paths.root, 'tracker', 'field', 'prUrl', '--list')).stdout).toBe(stdout);
    expect((await ok(paths.root, 'tracker', 'field', 'prUrl', 'customfield_10042', '--list')).stdout).toBe(stdout);
    expect((await fails(paths.root, 'tracker', 'field', 'prUrl', '--list', '--none')).stderr).toContain('Pass either --list or --none, not both.');
    expect(await json(paths.root, 'tracker', 'field')).toEqual({ fields: { branch: 'customfield_10042', prUrl: 'customfield_10077' } });

    writeTracker(paths, { ...readTracker(paths), fields: {} });
    expect((await ok(paths.root, 'tracker', 'field')).stdout).toContain('No task param is written to a Jira field.');
  });

  it('maps a param to a text or URL field by id or name, checked in Jira', async () => {
    const { paths } = await project({ tracker: { fields: {} } });
    expect((await ok(paths.root, 'tracker', 'field', 'prUrl', 'customfield_10077')).stdout).toContain('✔ prUrl → Pull request (customfield_10077)');
    expect((await ok(paths.root, 'tracker', 'field', 'branch', 'branch')).stdout).toContain('✔ branch → Branch (customfield_10042)');
    expect(readTracker(paths)['fields']).toEqual({ prUrl: 'customfield_10077', branch: 'customfield_10042' });
    expect(await json(paths.root, 'tracker', 'field', 'specPath', 'customfield_10042')).toEqual({
      fields: { prUrl: 'customfield_10077', branch: 'customfield_10042', specPath: 'customfield_10042' },
    });
  });

  it('refuses fields that cannot hold a param, unknown fields and bad param names', async () => {
    const { paths, jira: fake } = await project();
    const before = fs.readFileSync(paths.trackerFile, 'utf8');
    expect((await fails(paths.root, 'tracker', 'field', 'notes', 'customfield_10088')).stderr).toContain(
      'Notes (customfield_10088) is a paragraph (multi-line) field: dfl writes task params as single-line text.',
    );
    expect((await fails(paths.root, 'tracker', 'field', 'points', 'Story points')).stderr).toContain('is a number field');
    const unknown = await fails(paths.root, 'tracker', 'field', 'x', 'customfield_12345');
    expect(unknown.stderr).toContain('Jira has no custom field customfield_12345.');
    expect(unknown.stderr).toContain('Branch (customfield_10042), Pull request (customfield_10077)');
    expect((await fails(paths.root, 'tracker', 'field', 'x', 'Nothing like it')).stderr).toContain('Jira has no custom field named "Nothing like it".');
    expect((await fails(paths.root, 'tracker', 'field', '1abc', 'customfield_10042')).stderr).toContain('1abc');
    expect((await fails(paths.root, 'tracker', 'field', 'apiToken', 'customfield_10042')).stderr).toContain('apiToken');
    expect((await fails(paths.root, 'tracker', 'field', 'branch')).stderr).toContain('Missing the Jira field for "branch".');
    expect(fs.readFileSync(paths.trackerFile, 'utf8')).toBe(before);

    fake.requests.splice(0);
    await ok(paths.root, 'tracker', 'field', 'ticketUrl', 'customfield_555', '--no-check');
    expect(readTracker(paths)['fields'].ticketUrl).toBe('customfield_555');
    expect((await fails(paths.root, 'tracker', 'field', 'x', 'Branch', '--no-check')).stderr).toContain('--no-check does not look up field names');
    expect(fake.requests).toHaveLength(0);
  });

  it('stops writing a param with --none or none', async () => {
    const { paths } = await project();
    expect((await ok(paths.root, 'tracker', 'field', 'prUrl', '--none')).stdout).toContain('✔ prUrl is no longer written to Jira.');
    await ok(paths.root, 'tracker', 'field', 'branch', 'none');
    expect(readTracker(paths)['fields']).toEqual({});
    expect((await ok(paths.root, 'tracker', 'field', 'branch', '--none')).stdout).toContain('branch is not written to Jira; nothing changed.');
    expect((await fails(paths.root, 'tracker', 'field', '--none')).stderr).toContain('--none needs the param');
  });
});

// ---------------------------------------------------------------------------
// dfl task start
// ---------------------------------------------------------------------------

describe('dfl task start', () => {
  it('starts a ticket from main: creates its branch, records the task, moves the ticket', async () => {
    const { paths, jira: fake } = await project();
    const { stdout } = await ok(paths.root, 'task', 'start', 'ABC-1');
    expect(stdout).toContain('✔ Started ABC-1 · Export orders as CSV');
    expect(stdout).toContain(`Branch  ${BRANCH} (created and checked out)`);
    expect(stdout).toMatch(/Jira {4}In Progress {2}http:\/\/127\.0\.0\.1:\d+\/browse\/ABC-1/);
    expect(stdout).toContain('Step    ● Plan (step 1 of 3)');
    expect(currentBranch(paths.root)).toBe(BRANCH);
    expect(recordOf(fake)).toMatchObject({ flow: 'sample', step: 'plan', params: { branch: BRANCH, slug: 'export-orders-as-csv' } });
    expect(fake.issue('ABC-1').status).toBe('In Progress');
    expect(fake.issue('ABC-1').fields['customfield_10042']).toBe(BRANCH);

    const resumed = await json(paths.root, 'task', 'start', 'abc-1');
    expect(resumed).toMatchObject({
      flow: 'sample',
      current: 'plan',
      task: { key: 'ABC-1', started: true, step: 'plan', status: { actual: 'In Progress', expected: 'In Progress', inSync: true } },
      branch: { name: BRANCH, action: 'current' },
      resumed: true,
    });
    expect((await ok(paths.root, 'task', 'start', 'ABC-1')).stdout).toContain('✔ Continuing ABC-1 · Export orders as CSV');
  });

  it('takes bare numbers and "#123", and the branch mode', async () => {
    const { paths } = await project();
    const started = await json(paths.root, 'task', 'start', '#2', '--slug', 'Second Try');
    expect(started.branch).toEqual({ name: 'ABC-2-second-try', action: 'created' });
    expect(started.task).toMatchObject({ key: 'ABC-2', started: true });

    const choice = await fails(paths.root, 'task', 'start', '1', '--branch', 'current');
    expect(choice.stderr).toContain('The checked-out branch ABC-2-second-try belongs to ABC-2, not to ABC-1.');
    expect((await dfl(paths.root, 'task', 'start', '1', '--branch', 'sideways')).stderr).toContain("argument 'sideways' is invalid");
  });

  it('explains a missing ticket (an unquoted # starts a shell comment) and a missing tracker', async () => {
    const { paths } = await project({ tracker: false });
    const missing = await fails(paths.root, 'task', 'start');
    expect(missing.stderr).toContain("error: missing required argument 'ref'");
    expect(missing.stderr).toContain(HASH_HINT);
    // --task of the moves takes only the full key; status also takes 123 / "#123" with a default project.
    const status = (await fails(paths.root, 'status', '--task')).stderr;
    expect(status).toContain(
      'In a shell, # starts a comment: pass the full key, e.g. --task ABC-123 (or 123 and "#123" when jira.defaultProjectKey is set).',
    );
    for (const command of [['next'], ['goto', 'build'], ['reset']]) {
      const { stderr } = await fails(paths.root, ...command, '--task');
      expect(stderr, command[0]).toContain("option '--task <key>' argument missing");
      expect(stderr, command[0]).toContain('In a shell, # starts a comment: pass the full key, e.g. --task ABC-123.');
      expect(stderr, command[0]).not.toContain(HASH_HINT);
    }

    const notConfigured = await fails(paths.root, 'task', 'start', 'ABC-1');
    expect(notConfigured.stderr).toContain('This project has no Jira tracker (.df/tracker.json does not exist).');
    expect(notConfigured.stderr).toContain('`dfl tracker init`');
  });
});

// ---------------------------------------------------------------------------
// dfl status / next / goto / reset of tracked flows
// ---------------------------------------------------------------------------

describe('tracked dfl status / next / goto / reset', () => {
  it('status without a ticket on the branch asks for one', async () => {
    const { paths, jira: fake } = await project();
    const { stdout } = await ok(paths.root, 'status');
    expect(stdout).toContain('Flow "sample" is tracked in Jira, but no ticket is bound to this branch.');
    expect(stdout).toContain('Start one with `dfl task start <ticket>`, or pass --task <key>.');
    expect(stdout).not.toContain('Events');
    const status = await json(paths.root, 'status');
    expect(status).toMatchObject({ flow: 'sample', current: 'plan', history: [], task: { provider: 'jira', key: null, required: true, started: false } });
    expect(status.task.instructions).toContain('no ticket is bound to the current branch');
    expect(fake.requests).toHaveLength(0);

    const next = await fails(paths.root, 'next');
    expect(next.stderr).toContain('Flow "sample" is tracked in Jira, but no ticket is bound to the current branch.');
    expect(next.stderr).toContain('`dfl task start <ticket>`');
  });

  it('status --task of a ticket that is not started', async () => {
    const { paths } = await project();
    const { stdout } = await ok(paths.root, 'status', '--task', 'ABC-2');
    expect(stdout).toContain('ABC-2 · Second ticket · Jira: To Do · not started');
    expect(stdout).toContain('Start it with `dfl task start ABC-2`.');
    expect(await json(paths.root, 'status', '--task', 'ABC-2')).toMatchObject({
      current: 'plan',
      task: { key: 'ABC-2', started: false, via: 'arg', status: { actual: 'To Do', expected: null, inSync: true }, params: {} },
    });
  });

  it('status of a started task shows the ticket, its status against the mapping and its params', async () => {
    const { paths, jira: fake } = await project();
    await ok(paths.root, 'task', 'start', 'ABC-1');
    const { stdout } = await ok(paths.root, 'status');
    expect(stdout).toContain(`ABC-1 · Export orders as CSV · Jira: In Progress ✓ · branch ${BRANCH}`);
    expect(stdout).toMatch(/slug\s+export-orders-as-csv/);
    expect(stdout).toContain('● Plan (step 1 of 3)');
    expect(stdout).toContain('Complete the step with `dfl next`.');
    expect(await json(paths.root, 'status')).toMatchObject({
      current: 'plan',
      task: { key: 'ABC-1', started: true, step: 'plan', via: 'branch', branch: BRANCH, status: { actual: 'In Progress', expected: 'In Progress', inSync: true } },
    });

    fake.issue('ABC-1').status = 'Blocked';
    expect((await ok(paths.root, 'status')).stdout).toContain('Jira: Blocked ≠ expected In Progress');

    // From main the ticket is named with --task, and the commands shown carry it.
    git(paths.root, 'switch', '-q', 'main');
    const fromMain = await ok(paths.root, 'status', '--task', 'ABC-1');
    expect(fromMain.stdout).toContain('Complete the step with `dfl next --task ABC-1`.');
  });

  it('next / goto move the task in Jira and set params; reset goes back to the start', async () => {
    const { paths, jira: fake } = await project();
    await ok(paths.root, 'task', 'start', 'ABC-1');

    const first = await json(paths.root, 'next', '--set', 'specPath=docs/specs/csv.md', '--set', 'note=x');
    expect(first).toMatchObject({
      from: 'plan',
      to: 'build',
      event: 'NEXT',
      task: { key: 'ABC-1', status: { before: 'In Progress', after: 'In Progress', expected: 'In Progress' }, params: { specPath: 'docs/specs/csv.md', note: 'x' } },
    });
    expect(recordOf(fake)).toMatchObject({ step: 'build', params: { branch: BRANCH, specPath: 'docs/specs/csv.md', note: 'x' } });

    const second = await ok(paths.root, 'next', '--from', 'build', '--set', 'note=');
    expect(second.stdout).toContain('✔ Build → Review (NEXT)');
    expect(second.stdout).toContain('ABC-1 · Jira: In Progress → In Review');
    expect(fake.issue('ABC-1').status).toBe('In Review');
    expect(recordOf(fake)['params']).not.toHaveProperty('note');

    const notCurrent = await fails(paths.root, 'next', '--from', 'plan');
    expect(notCurrent.stderr).toContain('plan');
    expect(recordOf(fake)['step']).toBe('review');

    const back = await json(paths.root, 'goto', 'build', '--set', 'prUrl=https://example.com/pr/7');
    expect(back).toMatchObject({ from: 'review', to: 'build', event: 'GOTO', task: { status: { before: 'In Review', after: 'In Progress' } } });
    expect(fake.issue('ABC-1').fields['customfield_10077']).toBe('https://example.com/pr/7');

    const reset = await ok(paths.root, 'reset', '--yes');
    expect(reset.stdout).toContain('✔ Reset ABC-1 (sample) to Plan (plan)');
    expect(recordOf(fake)['step']).toBe('plan');
    expect((await json(paths.root, 'reset')).current).toBe('plan');
    // The local state was never used.
    expect(fs.existsSync(paths.stateFile)).toBe(false);
  });

  it('works from another branch with --task, and checks --set', async () => {
    const { paths, jira: fake } = await project();
    await ok(paths.root, 'task', 'start', 'ABC-1');
    git(paths.root, 'switch', '-q', 'main');
    expect((await json(paths.root, 'next', '--task', 'ABC-1', '--from', 'plan')).to).toBe('build');
    expect(recordOf(fake)['step']).toBe('build');
    expect((await dfl(paths.root, 'next', '--task', 'ABC-1', '--set', 'oops')).stderr).toContain('Expected name=value');
    expect((await fails(paths.root, 'goto', 'review', '--task', 'ABC-1', '--set', 'apiToken=x')).stderr).toContain('apiToken');
    expect(recordOf(fake)['step']).toBe('build');
  });
});

// ---------------------------------------------------------------------------
// Untracked flows
// ---------------------------------------------------------------------------

describe('untracked flows', () => {
  it('status and next ignore a tracker.json that does not track the flow', async () => {
    const { paths } = await project({ tracker: false });
    const normalize = (text: string): string => text.replace(/"updatedAt": "[^"]*"/, '"updatedAt": "…"');
    const plain = await ok(paths.root, 'status');
    const plainJson = normalize((await ok(paths.root, 'status', '--json')).stdout);
    writeTracker(paths, trackerConfig(jira!, { flows: { other: { statuses: {} } } }));
    expect(await ok(paths.root, 'status')).toEqual(plain);
    expect(normalize((await ok(paths.root, 'status', '--json')).stdout)).toBe(plainJson);

    const next = await ok(paths.root, 'next');
    expect(next.stdout).toContain('✔ Plan → Build (NEXT)');
    expect(next.stderr).toBe('');
    expect(JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')).flows.sample.current).toBe('build');
    expect(jira!.requests).toHaveLength(0);
  });

  it('says that --task and --set were not used', async () => {
    const { paths } = await project({ tracker: false });
    const status = await ok(paths.root, 'status', '--task', 'ABC-1');
    expect(status.stderr).toContain('No tracker is configured for flow "sample"; the ticket was not used.');
    expect((await json(paths.root, 'status', '--task', 'ABC-1')).task).toEqual({
      tracked: false,
      message: 'No tracker is configured for flow "sample"; the ticket was not used.',
    });
    const next = await ok(paths.root, 'next', '--set', 'a=b');
    expect(next.stderr).toContain('No tracker is configured for flow "sample"; --set was ignored.');
    expect(next.stdout).toContain('✔ Plan → Build (NEXT)');
    expect((await json(paths.root, 'goto', 'plan', '--task', 'ABC-1')).task.message).toContain('the ticket was not used');
  });
});

// ---------------------------------------------------------------------------
// Read-only views
// ---------------------------------------------------------------------------

describe('read-only views of tracked flows', () => {
  it('flow list, step list and flow view show the ticket note instead of the local step', async () => {
    const { paths } = await project();
    const list = await ok(paths.root, 'flow', 'list');
    expect(list.stdout).toContain('tracked in Jira; no ticket on this branch');
    expect((await json(paths.root, 'flow', 'list'))[0]).toMatchObject({ name: 'sample', tracked: true, note: 'tracked in Jira; no ticket on this branch' });

    git(paths.root, 'switch', '-q', '-c', 'ABC-12-something');
    expect((await ok(paths.root, 'flow', 'list')).stdout).toContain('tracked in Jira (ABC-12): run `dfl status`');
    const steps = await ok(paths.root, 'step', 'list');
    expect(steps.stdout).toContain('Sample flow (sample)  tracked in Jira (ABC-12): run `dfl status`');
    expect(steps.stdout).not.toContain('●');
    expect(await json(paths.root, 'step', 'list')).toMatchObject({ tracked: true, note: 'tracked in Jira (ABC-12): run `dfl status`' });
    expect((await ok(paths.root, 'flow', 'view', '--print')).stdout).toContain('Tracked in Jira (ABC-12): run `dfl status`.');
  });

  it('untracked flows keep their output', async () => {
    const { paths } = await project({ tracker: false });
    const row = (await json(paths.root, 'flow', 'list'))[0];
    expect(row).not.toHaveProperty('tracked');
    expect((await ok(paths.root, 'step', 'list')).stdout).toContain('●');
    expect(await json(paths.root, 'step', 'list')).not.toHaveProperty('note');
  });

  it('the install summary points to the task', async () => {
    const { paths } = await project();
    const { stdout } = await ok(paths.root, 'install', '--yes', '--agents', 'claude');
    expect(stdout).toContain('Next: start a ticket with dfl task start <ticket> (flow "sample" is tracked in Jira; no ticket on this branch)');
  });

  it('flow validate reports tracker problems as warnings', async () => {
    const { paths } = await project({ tracker: { flows: { sample: { statuses: { ...MAPPING, gone: 'Done' } } } } });
    const { stdout } = await ok(paths.root, 'flow', 'validate', 'sample');
    expect(stdout).toContain('✔ Flow sample is valid');
    expect(stdout).toContain('.df/tracker.json: flows.sample.statuses.gone maps a step that flow "sample" does not have (it is ignored).');
  });
});

// ---------------------------------------------------------------------------
// Prompts (scripted)
// ---------------------------------------------------------------------------

describe('interactive tracker commands', () => {
  it('the map wizard goes through every step: keep, a Jira status, a typed status, none', async () => {
    const { paths } = await project({ tracker: { flows: { sample: { statuses: { build: 'In Progress' } } } } });
    answerPrompts(pick('In Progress'), pick('keep: In Progress'), pick('type a status name'), 'in review', pick('none'));
    const { stdout } = await ok(paths.root, 'tracker', 'map');
    expect(prompts.asked.map((p) => p.kind)).toEqual(['select', 'select', 'select', 'text', 'select']);
    const first = prompts.asked[0]!;
    expect(first.message).toContain('Plan');
    expect(first.options?.map((o) => o.label)).toEqual([
      'keep: —',
      'To Do',
      'In Progress',
      'In Review',
      'Blocked',
      'Done',
      "none – don't change the Jira status at this step",
      'type a status name…',
    ]);
    expect(readTracker(paths)['flows'].sample.statuses).toEqual({ build: 'In Progress', plan: 'In Progress', review: 'In Review', done: null });
    expect(stdout).toMatch(/review\s+In Review\n/);
    expect(stdout).toContain('Saved .df/tracker.json.');
  });

  it('the wizard asks before tracking a flow, and maps one step when only the step is given', async () => {
    const { paths } = await project({ tracker: { flows: {} } });
    answerPrompts(false);
    expect((await ok(paths.root, 'tracker', 'map')).stdout).toContain('Nothing changed.');
    expect(readTracker(paths)['flows']).toEqual({});

    answerPrompts(true, pick('Done'));
    const { stdout } = await ok(paths.root, 'tracker', 'map', 'review');
    expect(stdout).toContain('Flow "sample" is now tracked in Jira.');
    expect(readTracker(paths)['flows']).toEqual({ sample: { statuses: { review: 'Done' } } });
  });

  it('the wizard lets you type statuses when Jira cannot be read', async () => {
    const { paths } = await project({ credentials: false });
    answerPrompts(pick('keep'), pick('keep'), pick('type a status name'), 'Code Review', pick('keep'));
    const { stderr } = await ok(paths.root, 'tracker', 'map');
    expect(stderr).toContain('no Jira credential for');
    expect(prompts.asked[0]!.options?.map((o) => o.label)).toEqual(['keep: In Progress', "none – don't change the Jira status at this step", 'type a status name…']);
    expect(readTracker(paths)['flows'].sample.statuses.review).toBe('Code Review');
  });

  it('--remove asks first', async () => {
    const { paths } = await project();
    answerPrompts(false);
    expect((await ok(paths.root, 'tracker', 'map', '--remove')).stdout).toContain('Nothing changed.');
    expect(isTracked(paths, 'sample')).toBe(true);
    answerPrompts(true);
    await ok(paths.root, 'tracker', 'map', '--remove');
    expect(isTracked(paths, 'sample')).toBe(false);
  });

  it('init and login prompt for what is missing; the token is masked', async () => {
    const { paths, jira: fake } = await project({ tracker: false, credentials: false });
    answerPrompts(fake.url, 'abc');
    await ok(paths.root, 'tracker', 'init');
    expect(readTracker(paths)['jira']).toEqual({ baseUrl: fake.url, projectKeys: ['ABC'], defaultProjectKey: 'ABC' });

    answerPrompts('dev@example.com', 'test-token');
    const { stdout } = await ok(paths.root, 'tracker', 'login');
    expect(prompts.asked.slice(-2).map((p) => p.kind)).toEqual(['text', 'password']);
    expect(stdout).toContain('Logged in to');
    expect(stdout).not.toContain('test-token');
  });

  it('reset of a tracked task asks with the ticket', async () => {
    const { paths, jira: fake } = await project();
    await ok(paths.root, 'task', 'start', 'ABC-1');
    await ok(paths.root, 'next');
    answerPrompts(false);
    expect((await ok(paths.root, 'reset')).stdout).toContain('Nothing changed.');
    expect(prompts.asked[0]!.message).toBe('Reset ABC-1 (sample) to plan?');
    expect(recordOf(fake)['step']).toBe('build');
    answerPrompts(true);
    await ok(paths.root, 'reset');
    expect(recordOf(fake)['step']).toBe('plan');
  });
});

// ---------------------------------------------------------------------------
// Ticket text in terminal output
// ---------------------------------------------------------------------------

describe('ticket and Jira text in terminal output', () => {
  /** C0/C1 control characters except tab and line feed (colours are off and stripped by `dfl`). */
  const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
  /** An OSC 52 clipboard write and a CSI "erase line" (neither is a colour code the helper strips). */
  const OSC = '\u001b]52;c;ZXZpbA==\u0007';
  const ERASE = '\u001b[2K';

  it('plain and truncate replace control characters but keep tabs and line feeds out of the way', () => {
    expect(plain(`a${OSC}b${ERASE}\u009bc\td\ne`)).toBe('a\uFFFD]52;c;ZXZpbA==\uFFFDb\uFFFD[2K\uFFFDc\td\ne');
    expect(truncate(`Export${OSC} orders\n\tas CSV`, 80)).toBe('Export\uFFFD]52;c;ZXZpbA==\uFFFD orders as CSV');
    expect(truncate(`x${ERASE}`, 80)).not.toMatch(CONTROL);
  });

  it('status, task start, next and errors print ticket and Jira text without control characters', async () => {
    const blocked = `Blocked${ERASE}`;
    const { paths, jira: fake } = await project({
      jira: {
        issues: [{ key: 'ABC-1', id: '10231', summary: `Export ${OSC}orders${ERASE} as CSV` }],
        statuses: [...DEFAULT_STATUSES, { id: '10099', name: blocked, categoryKey: 'indeterminate' }],
      },
    });
    const outputs: string[] = [];
    const run = async (...args: string[]): Promise<RunResult> => {
      const result = await dfl(paths.root, ...args);
      outputs.push(result.stdout, result.stderr);
      return result;
    };

    const started = await run('task', 'start', 'ABC-1');
    expect(started.code).toBe(0);
    expect(started.stdout).toContain('Started ABC-1 · Export \uFFFD]52;c;ZXZpbA==\uFFFDorders\uFFFD[2K as CSV');
    fake.issue('ABC-1').status = blocked;
    const status = await run('status');
    expect(status.stdout).toContain('Jira: Blocked\uFFFD[2K ≠ expected In Progress');
    const moved = await run('next');
    expect(moved.code).toBe(0);
    expect(moved.stderr).toContain("was moved to 'Blocked\uFFFD[2K' outside dfl");
    fake.setFailure('getIssue', { status: 500, body: { errorMessages: [`Boom${ERASE}${OSC}`] } });
    const failed = await run('status', '--task', 'ABC-1');
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('Boom\uFFFD[2K');

    for (const text of outputs) expect(text).not.toMatch(CONTROL);
    // JSON output keeps the text as Jira has it (escaped by JSON).
    fake.setFailure('getIssue', undefined);
    expect((await json(paths.root, 'status'))['task']['title']).toBe(`Export ${OSC}orders${ERASE} as CSV`);
  });
});
