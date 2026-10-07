import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DflError } from '../src/core/errors.js';
import {
  createBranch,
  currentBranch,
  fetchBranch,
  isValidBranchName,
  listRemotes,
  localBranchExists,
  previousBranch,
  refExists,
  runGit,
  worktreeHolding,
} from '../src/core/git.js';
import { cleanupTempDirs, makeTempDir } from './helpers/project.js';

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=dfl', '-c', 'user.email=dfl@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_EDITOR: 'true' },
  }).trim();
}

/** A repository on `main` with one commit of `file.txt`. */
function makeRepo(): string {
  const repo = makeTempDir('dfl-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'one');
  return repo;
}

function commitFile(repo: string, content: string, message: string): void {
  fs.writeFileSync(path.join(repo, 'file.txt'), content);
  git(repo, 'commit', '-q', '-am', message);
}

async function rejection(promise: Promise<unknown>): Promise<DflError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DflError);
    return error as DflError;
  }
  throw new Error('expected a DflError');
}

describe('runGit', () => {
  it('resolves with stdout and rejects with git stderr', async () => {
    const repo = makeRepo();
    expect((await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).trim()).toBe('main');
    const error = (await runGit(['rev-parse', '--verify', 'nope'], { cwd: repo }).catch((e: unknown) => e)) as { stderr?: string };
    expect(error.stderr).toMatch(/nope|Needed a single revision/);
  });
});

describe('currentBranch / previousBranch', () => {
  it('reads the checked-out branch, also from a subdirectory and when a tag has the same name', () => {
    const repo = makeRepo();
    expect(currentBranch(repo)).toBe('main');
    git(repo, 'switch', '-q', '-c', 'feature/ABC-1-csv');
    git(repo, 'tag', 'feature/ABC-1-csv');
    expect(currentBranch(repo)).toBe('feature/ABC-1-csv');
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    expect(currentBranch(sub)).toBe('feature/ABC-1-csv');
  });

  it('is undefined on a detached HEAD and outside git', () => {
    const repo = makeRepo();
    git(repo, 'switch', '-q', '--detach', 'HEAD');
    expect(currentBranch(repo)).toBeUndefined();
    expect(currentBranch(makeTempDir())).toBeUndefined();
    expect(currentBranch(path.join(makeTempDir(), 'missing'))).toBeUndefined();
  });

  it('is the branch being rebased during a stopped rebase', () => {
    const repo = makeRepo();
    git(repo, 'switch', '-q', '-c', 'ABC-2-fix');
    commitFile(repo, 'branch\n', 'branch');
    git(repo, 'switch', '-q', 'main');
    commitFile(repo, 'main\n', 'main');
    git(repo, 'switch', '-q', 'ABC-2-fix');
    expect(() => git(repo, 'rebase', 'main')).toThrow();
    expect(() => git(repo, 'symbolic-ref', '-q', 'HEAD')).toThrow(); // detached while rebasing
    expect(currentBranch(repo)).toBe('ABC-2-fix');
    git(repo, 'rebase', '--abort');
    expect(currentBranch(repo)).toBe('ABC-2-fix');
  });

  it('previousBranch is the branch checked out before, never a commit', () => {
    const repo = makeRepo();
    expect(previousBranch(repo)).toBeUndefined();
    git(repo, 'switch', '-q', '-c', 'ABC-3-x');
    git(repo, 'switch', '-q', 'main');
    expect(previousBranch(repo)).toBe('ABC-3-x');
    git(repo, 'switch', '-q', '--detach', 'HEAD');
    git(repo, 'switch', '-q', 'main');
    expect(previousBranch(repo)).toBeUndefined();
    expect(previousBranch(makeTempDir())).toBeUndefined();
  });
});

describe('isValidBranchName', () => {
  it('accepts branch names git accepts', () => {
    for (const name of ['main', 'ABC-1', 'feature/ABC-123-csv-export', 'fix_1.2', 'user@host']) {
      expect(isValidBranchName(name), name).toBe(true);
    }
  });

  it('rejects options, reflog syntax and names git refuses', () => {
    for (const name of [
      '',
      '-x',
      '--force',
      '@{-1}',
      'main@{u}',
      'HEAD',
      '@',
      'a b',
      'a..b',
      'a~1',
      'a^',
      'a:b',
      'a?',
      'a*',
      'a[',
      'a\\b',
      '/a',
      'a/',
      'a//b',
      '.a',
      'a/.b',
      'a.lock',
      'a.',
      'a\nb',
      'a\tb',
    ]) {
      expect(isValidBranchName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe('localBranchExists / refExists', () => {
  it('checks local branches and refs that resolve to a commit', () => {
    const repo = makeRepo();
    git(repo, 'tag', 'v1');
    git(repo, 'branch', 'ABC-4-x');
    const sha = git(repo, 'rev-parse', 'HEAD');
    expect(localBranchExists(repo, 'main')).toBe(true);
    expect(localBranchExists(repo, 'ABC-4-x')).toBe(true);
    expect(localBranchExists(repo, 'v1')).toBe(false); // a tag, not a branch
    expect(localBranchExists(repo, 'nope')).toBe(false);
    expect(localBranchExists(repo, '-x')).toBe(false);
    expect(localBranchExists(makeTempDir(), 'main')).toBe(false);
    for (const ref of ['main', 'HEAD', 'v1', sha, sha.slice(0, 8), 'ABC-4-x']) expect(refExists(repo, ref), ref).toBe(true);
    for (const ref of ['nope', 'origin/main', '-x', '--all', '']) expect(refExists(repo, ref), ref).toBe(false);
  });
});

describe('worktreeHolding', () => {
  it('finds another work tree that has the branch checked out', () => {
    const repo = makeRepo();
    const other = path.join(makeTempDir(), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'ABC-5-x', other);
    expect(fs.realpathSync(worktreeHolding(repo, 'ABC-5-x')!)).toBe(fs.realpathSync(other));
    // The work tree at root itself does not count.
    expect(worktreeHolding(repo, 'main')).toBeUndefined();
    expect(fs.realpathSync(worktreeHolding(other, 'main')!)).toBe(fs.realpathSync(repo));
    expect(worktreeHolding(path.join(repo, '.'), 'nope')).toBeUndefined();
    expect(worktreeHolding(makeTempDir(), 'main')).toBeUndefined();
  });
});

describe('listRemotes', () => {
  it('lists the configured remotes', () => {
    const repo = makeRepo();
    expect(listRemotes(repo)).toEqual([]);
    git(repo, 'remote', 'add', 'origin', makeTempDir());
    git(repo, 'remote', 'add', 'team/fork', makeTempDir());
    expect(listRemotes(repo).sort()).toEqual(['origin', 'team/fork']);
    expect(listRemotes(makeTempDir())).toEqual([]);
  });
});

describe('fetchBranch', () => {
  it('updates the remote-tracking branch and returns false on failure', async () => {
    const origin = makeRepo();
    const clone = path.join(makeTempDir(), 'clone');
    git(path.dirname(clone), 'clone', '-q', origin, clone);
    commitFile(origin, 'two\n', 'two');
    const head = git(origin, 'rev-parse', 'HEAD');
    expect(git(clone, 'rev-parse', 'origin/main')).not.toBe(head);
    expect(await fetchBranch(clone, 'origin', 'main', 20_000)).toBe(true);
    expect(git(clone, 'rev-parse', 'origin/main')).toBe(head);
    expect(await fetchBranch(clone, 'origin', 'no-such-branch', 20_000)).toBe(false);
    expect(await fetchBranch(clone, 'nowhere', 'main', 20_000)).toBe(false);
    expect(await fetchBranch(clone, '--upload-pack=touch x', 'main', 20_000)).toBe(false);
    expect(await fetchBranch(makeTempDir(), 'origin', 'main', 20_000)).toBe(false);
  });
});

describe('createBranch', () => {
  it('creates and checks out the branch, carrying uncommitted changes', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'file.txt'), 'edited\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    await createBranch(repo, 'feature/ABC-6-x', 'main');
    expect(currentBranch(repo)).toBe('feature/ABC-6-x');
    expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('edited\n');
    expect(git(repo, 'status', '--porcelain').split('\n').map((line) => line.trim()).sort()).toEqual(['?? new.txt', 'M file.txt']);
    expect(localBranchExists(repo, 'feature/ABC-6-x')).toBe(true);
  });

  it('branches from a remote-tracking branch without tracking it', async () => {
    const origin = makeRepo();
    const clone = path.join(makeTempDir(), 'clone');
    git(path.dirname(clone), 'clone', '-q', origin, clone);
    await createBranch(clone, 'ABC-7-x', 'origin/main');
    expect(currentBranch(clone)).toBe('ABC-7-x');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'HEAD'));
    expect(() => git(clone, 'config', '--get', 'branch.ABC-7-x.merge')).toThrow();
  });

  it('reports invalid names, a missing base and git refusals', async () => {
    const repo = makeRepo();
    expect((await rejection(createBranch(repo, '-x', 'main'))).code).toBe('TASK_BRANCH_INVALID');
    expect((await rejection(createBranch(repo, '@{-1}', 'main'))).code).toBe('TASK_BRANCH_INVALID');
    expect((await rejection(createBranch(repo, 'ok', '--orphan'))).code).toBe('TASK_BRANCH_INVALID');
    const missing = await rejection(createBranch(repo, 'ABC-8-x', 'origin/nope'));
    expect(missing.code).toBe('TASK_BRANCH_FAILED');
    expect(missing.message).toContain('origin/nope');
    git(repo, 'branch', 'ABC-9-x');
    const existing = await rejection(createBranch(repo, 'ABC-9-x', 'main'));
    expect(existing.code).toBe('TASK_BRANCH_FAILED');
    expect(existing.message).toMatch(/already exists/);
    expect(currentBranch(repo)).toBe('main');
  });

  it('refuses when local changes conflict with the base', async () => {
    const repo = makeRepo();
    git(repo, 'switch', '-q', '-c', 'other');
    commitFile(repo, 'other\n', 'other');
    git(repo, 'switch', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'local edit\n');
    const error = await rejection(createBranch(repo, 'ABC-10-x', 'other'));
    expect(error.code).toBe('TASK_BRANCH_FAILED');
    expect(error.message).toMatch(/local changes/i);
    expect(currentBranch(repo)).toBe('main');
    expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('local edit\n');
  });
});
