import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTrackerConfig, type TrackerConfig } from '../src/core/tracker/config.js';
import { browseUrl, keyFromBranch, parseTaskRef, resolveTask, suggestTask } from '../src/core/tracker/resolve.js';
import type { ProjectPaths } from '../src/core/types.js';
import { cleanupTempDirs, makeTempDir, makeTempProject } from './helpers/project.js';

beforeEach(() => {
  // Isolate from the developer's git config (hooks paths, signing, default branch, …).
  const home = makeTempDir('dfl-git-home-');
  fs.writeFileSync(path.join(home, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(home, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirs();
});

function config(jira: Record<string, unknown> = {}): TrackerConfig {
  return parseTrackerConfig({
    version: 1,
    provider: 'jira',
    jira: { baseUrl: 'https://acme.atlassian.net', projectKeys: ['ABC', 'AB', 'DEF_2'], defaultProjectKey: 'ABC', ...jira },
    flows: { sample: {} },
  });
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=dfl', '-c', 'user.email=dfl@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A temp dfl project that is a git repository on `main` with one commit. */
function makeRepoProject(): ProjectPaths {
  const paths = makeTempProject();
  git(paths.root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(paths.root, 'file.txt'), 'one\n');
  git(paths.root, 'add', '-A');
  git(paths.root, 'commit', '-q', '-m', 'one');
  return paths;
}

describe('parseTaskRef', () => {
  const cfg = config();

  it('normalizes full keys of configured projects', () => {
    expect(parseTaskRef('ABC-123', cfg)).toBe('ABC-123');
    expect(parseTaskRef('  abc-7 ', cfg)).toBe('ABC-7');
    expect(parseTaskRef('def_2-15', cfg)).toBe('DEF_2-15');
  });

  it('refuses keys of other projects', () => {
    let message = '';
    try {
      parseTaskRef('XYZ-1', cfg);
    } catch (error) {
      message = (error as Error).message;
      expect((error as { code: string }).code).toBe('TASK_REF_INVALID');
    }
    expect(message).toContain('Project XYZ is not configured');
  });

  it('reads browse links and selectedIssue links of the configured site only', () => {
    expect(parseTaskRef('https://acme.atlassian.net/browse/ABC-42', cfg)).toBe('ABC-42');
    expect(parseTaskRef('https://ACME.atlassian.net/browse/abc-42/', cfg)).toBe('ABC-42');
    expect(parseTaskRef('https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-9', cfg)).toBe('ABC-9');
    expect(code(() => parseTaskRef('https://evil.example/browse/ABC-42', cfg))).toBe('TASK_REF_FOREIGN');
    expect(code(() => parseTaskRef('http://acme.atlassian.net/browse/ABC-42', cfg))).toBe('TASK_REF_FOREIGN');
    expect(code(() => parseTaskRef('https://acme.atlassian.net/jira/your-work', cfg))).toBe('TASK_REF_INVALID');
    expect(code(() => parseTaskRef('https://acme.atlassian.net/browse/XYZ-1', cfg))).toBe('TASK_REF_INVALID');
  });

  it('expands bare numbers only where allowed and with a default project', () => {
    expect(parseTaskRef('123', cfg, { allowBare: true })).toBe('ABC-123');
    expect(parseTaskRef('#0123', cfg, { allowBare: true })).toBe('ABC-123');
    expect(code(() => parseTaskRef('#123', cfg))).toBe('TASK_REF_INVALID');
    expect(code(() => parseTaskRef('0', cfg, { allowBare: true }))).toBe('TASK_REF_INVALID');
    const noDefault = config({ defaultProjectKey: undefined });
    let hint = '';
    try {
      parseTaskRef('123', noDefault, { allowBare: true });
    } catch (error) {
      hint = (error as { hint: string }).hint;
    }
    expect(hint).toContain('jira.defaultProjectKey');
  });

  it('refuses anything else', () => {
    for (const ref of ['', 'hello', 'ABC', 'ABC-', '-123', 'ABC 123', 'split into 2 increments']) {
      expect(code(() => parseTaskRef(ref, cfg, { allowBare: true })), ref).toBe('TASK_REF_INVALID');
    }
  });
});

describe('keyFromBranch', () => {
  const keys = ['ABC', 'AB', 'DEF_2'];

  it('finds the first uppercase key of a configured project', () => {
    expect(keyFromBranch('feature/ABC-123-csv-export', keys)).toBe('ABC-123');
    expect(keyFromBranch('ABC-1', keys)).toBe('ABC-1');
    expect(keyFromBranch('fix/AB-7_DEF_2-9', keys)).toBe('AB-7');
    expect(keyFromBranch('DEF_2-31-x', keys)).toBe('DEF_2-31');
    expect(keyFromBranch('feature/ABC-1234', keys)).toBe('ABC-1234');
  });

  it('ignores lowercase keys, other projects and keys inside words', () => {
    expect(keyFromBranch('feature/abc-123-x', keys)).toBeUndefined();
    expect(keyFromBranch('feature/XYZ-1', keys)).toBeUndefined();
    expect(keyFromBranch('feature/XABC-12', keys)).toBeUndefined();
    expect(keyFromBranch('feature/9ABC-12', keys)).toBeUndefined();
    expect(keyFromBranch('main', keys)).toBeUndefined();
    expect(keyFromBranch('', keys)).toBeUndefined();
    expect(keyFromBranch('ABC-1', [])).toBeUndefined();
  });
});

describe('resolveTask', () => {
  it('takes the key from the branch, or an explicit task that agrees with it', () => {
    const paths = makeRepoProject();
    const cfg = config();
    git(paths.root, 'switch', '-q', '-c', 'feature/ABC-12-csv');
    expect(resolveTask(paths, cfg)).toEqual({ key: 'ABC-12', via: 'branch', branch: 'feature/ABC-12-csv' });
    expect(resolveTask(paths, cfg, { task: 'abc-12' })).toEqual({ key: 'ABC-12', via: 'arg', branch: 'feature/ABC-12-csv' });
    expect(resolveTask(paths, cfg, { task: '  ' })).toEqual({ key: 'ABC-12', via: 'branch', branch: 'feature/ABC-12-csv' });
  });

  it('refuses an explicit task that contradicts the branch', () => {
    const paths = makeRepoProject();
    git(paths.root, 'switch', '-q', '-c', 'feature/ABC-12-csv');
    let error: { code?: string; message?: string; hint?: string } = {};
    try {
      resolveTask(paths, config(), { task: 'ABC-13' });
    } catch (e) {
      error = e as typeof error;
    }
    expect(error.code).toBe('TASK_BRANCH_MISMATCH');
    expect(error.message).toContain('feature/ABC-12-csv belongs to ABC-12');
  });

  it('has no task on a branch without a key unless one is passed', () => {
    const paths = makeRepoProject();
    const cfg = config();
    expect(resolveTask(paths, cfg)).toBeUndefined();
    expect(resolveTask(paths, cfg, { task: 'ABC-5' })).toEqual({ key: 'ABC-5', via: 'arg', branch: 'main' });
    expect(code(() => resolveTask(paths, cfg, { task: '5' }))).toBe('TASK_REF_INVALID');
    expect(resolveTask(paths, cfg, { task: '5', allowBare: true })).toEqual({ key: 'ABC-5', via: 'arg', branch: 'main' });
  });

  it('works on a detached HEAD and outside git', () => {
    const paths = makeRepoProject();
    git(paths.root, 'switch', '-q', '-c', 'feature/ABC-12-csv');
    git(paths.root, 'switch', '-q', '--detach');
    expect(resolveTask(paths, config())).toBeUndefined();
    expect(resolveTask(paths, config(), { task: 'ABC-99' })).toEqual({ key: 'ABC-99', via: 'arg', branch: undefined });

    const plain = makeTempProject();
    expect(resolveTask(plain, config())).toBeUndefined();
    expect(resolveTask(plain, config(), { task: 'ABC-1' })).toEqual({ key: 'ABC-1', via: 'arg', branch: undefined });
  });
});

describe('suggestTask', () => {
  it('suggests the key of the previous branch on a protected branch only', () => {
    const paths = makeRepoProject();
    const cfg = config();
    expect(suggestTask(paths, cfg)).toBeUndefined();
    git(paths.root, 'switch', '-q', '-c', 'feature/ABC-5-x');
    expect(suggestTask(paths, cfg)).toBeUndefined();
    git(paths.root, 'switch', '-q', 'main');
    expect(suggestTask(paths, cfg)).toBe('ABC-5');
    expect(suggestTask(paths, cfg, ['develop'])).toBeUndefined();
    git(paths.root, 'switch', '-q', '--detach');
    expect(suggestTask(paths, cfg)).toBeUndefined(); // @{-1} is main now
  });

  it('suggests on a detached HEAD after leaving a task branch', () => {
    const paths = makeRepoProject();
    git(paths.root, 'switch', '-q', '-c', 'ABC-8-y');
    git(paths.root, 'switch', '-q', '--detach');
    expect(suggestTask(paths, config())).toBe('ABC-8');
  });
});

describe('browseUrl', () => {
  it('links the ticket on the configured origin', () => {
    expect(browseUrl(config({ baseUrl: 'https://acme.atlassian.net/jira/' }), 'ABC-1')).toBe('https://acme.atlassian.net/browse/ABC-1');
  });
});
