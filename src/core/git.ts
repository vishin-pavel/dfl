/**
 * git helpers (flow import, task branches).
 *
 * Every call runs the `git` executable with `GIT_TERMINAL_PROMPT=0` (an interactive credential
 * prompt would hang `dfl mcp` and non-TTY runs) and pipes its output (nothing reaches our
 * stdout, which carries the MCP protocol). The sync helpers answer questions about a work tree
 * (`git -C <root> …`) and return undefined/false when git fails, is missing, or `root` is not
 * inside a work tree; only {@link createBranch} turns git's own error into a DflError.
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DflError } from './errors.js';

const execFileAsync = promisify(execFile);

/** Upper bound for the quick, local sync queries (a hung git must not hang dfl). */
const SYNC_TIMEOUT_MS = 10_000;
/** Upper bound for `git switch -c` (checkout hooks such as LFS can be slow). */
const SWITCH_TIMEOUT_MS = 120_000;
const HEADS = 'refs/heads/';
/** A reflog subject of `git checkout` / `git switch`. */
const CHECKOUT_REFLOG_RE = /^checkout: moving from (\S+) to \S+$/;
/** A full object id (SHA-1 or SHA-256): the "branch" of a detached HEAD in the reflog. */
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface RunGitOptions {
  /** Working directory of the git process (default: the current directory). */
  cwd?: string | undefined;
  /** Kill git after this many milliseconds (the promise then rejects). Default: no limit. */
  timeoutMs?: number | undefined;
}

/**
 * Runs `git <args>` asynchronously and resolves with its stdout. Rejects with the `execFile`
 * error (`code` ENOENT when git is missing, `stderr` with git's message otherwise).
 */
export async function runGit(args: string[], options: RunGitOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs !== undefined && options.timeoutMs > 0 ? { timeout: options.timeoutMs } : {}),
    env: gitEnv(),
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/**
 * The branch checked out in the work tree at `root` (`feature/ABC-1-x`, without `refs/heads/`).
 * During a rebase (HEAD is detached) it is the branch being rebased. Undefined on a detached HEAD,
 * outside a git work tree, or when git is missing.
 */
export function currentBranch(root: string): string | undefined {
  // The full ref, not `--short`: a tag with the same name would make the short form `heads/<name>`.
  const ref = gitSync(['-C', root, 'symbolic-ref', '--quiet', 'HEAD']);
  if (ref !== undefined) return branchFromRef(ref);
  for (const name of ['rebase-merge/head-name', 'rebase-apply/head-name']) {
    const file = gitSync(['-C', root, 'rev-parse', '--git-path', name])?.trim();
    if (!file) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.resolve(root, file), 'utf8').trim();
    } catch {
      continue;
    }
    const branch = branchFromRef(content);
    if (branch) return branch;
  }
  return undefined;
}

/**
 * The branch checked out before the current one (`@{-1}`, as `git switch -` would use). When
 * `@{-1}` no longer resolves (the branch was deleted, e.g. by the cleanup after shipping), the name
 * from the newest `checkout: moving from <name> to …` entry of HEAD's reflog (among the last 50).
 * Undefined when there is none, it was a detached commit, or git fails.
 */
export function previousBranch(root: string): string | undefined {
  const ref = gitSync(['-C', root, 'rev-parse', '--symbolic-full-name', '@{-1}']);
  if (ref !== undefined) return branchFromRef(ref);
  const log = gitSync(['-C', root, 'log', '-g', '-n', '50', '--format=%gs', 'HEAD']);
  for (const line of (log ?? '').split(/\r?\n/)) {
    const from = CHECKOUT_REFLOG_RE.exec(line.trim())?.[1];
    if (from !== undefined && !OBJECT_ID_RE.test(from) && isPlainArg(from)) return from;
  }
  return undefined;
}

/**
 * True when `name` can be created as a local branch: not empty, no leading `-` (it would be read
 * as an option), no `@{` (reflog syntax), not `HEAD`/`@`, and accepted by
 * `git check-ref-format refs/heads/<name>`.
 */
export function isValidBranchName(name: string): boolean {
  if (typeof name !== 'string' || name === '' || name.startsWith('-') || name.includes('@{')) return false;
  if (name === 'HEAD' || name === '@') return false;
  return gitSync(['check-ref-format', `${HEADS}${name}`]) !== undefined;
}

/** True when the repository at `root` has the local branch `name`. */
export function localBranchExists(root: string, name: string): boolean {
  if (!isPlainArg(name)) return false;
  return gitSync(['-C', root, 'show-ref', '--verify', '--quiet', `${HEADS}${name}`]) !== undefined;
}

/** True when `ref` (branch, remote-tracking branch, tag or SHA) resolves to a commit in the repository at `root`. */
export function refExists(root: string, ref: string): boolean {
  if (!isPlainArg(ref)) return false;
  return gitSync(['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== undefined;
}

/** Names of the remotes of the repository at `root` (`git remote`); empty when there are none or git fails. */
export function listRemotes(root: string): string[] {
  const out = gitSync(['-C', root, 'remote']);
  if (out === undefined) return [];
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * The path of ANOTHER work tree of the repository at `root` that has `branch` checked out (git
 * refuses to check a branch out twice). Undefined when no other work tree holds it.
 */
export function worktreeHolding(root: string, branch: string): string | undefined {
  if (!isPlainArg(branch)) return undefined;
  const out = gitSync(['-C', root, 'worktree', 'list', '--porcelain']);
  if (out === undefined) return undefined;
  const top = gitSync(['-C', root, 'rev-parse', '--show-toplevel'])?.trim();
  const own = top ? realpath(path.resolve(root, top)) : undefined;
  let worktree: string | undefined;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      worktree = line.slice('worktree '.length);
    } else if (line === `branch ${HEADS}${branch}` && worktree !== undefined && realpath(worktree) !== own) {
      return worktree;
    }
  }
  return undefined;
}

/**
 * Best-effort fetch of the branch `branch` of `remote` into its remote-tracking branch
 * (`git fetch <remote> refs/heads/<branch>:refs/remotes/<remote>/<branch>`, an explicit refspec
 * without `+`, so it never force-updates a ref). Resolves false on any failure, including the
 * timeout, and without running git for a `remote` or `branch` that is not a plain name (a `:` or a
 * leading `+` would make it a refspec of its own).
 */
export async function fetchBranch(root: string, remote: string, branch: string, timeoutMs: number): Promise<boolean> {
  if (!isPlainRefName(remote) || !isPlainRefName(branch)) return false;
  try {
    await runGit(['-C', root, 'fetch', '--quiet', '--', remote, `${HEADS}${branch}:refs/remotes/${remote}/${branch}`], { timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the branch `name` at `from` and checks it out in the work tree at `root`
 * (`git switch -c <name> <from>`); uncommitted changes are carried over, as git does. The new
 * branch does not track `from` (`--no-track`): a feature branch that tracks `origin/main` would
 * make a plain `git push`/`git pull` target main. Throws DflError `TASK_BRANCH_INVALID` for an
 * invalid name or base, `GIT_NOT_FOUND` without git, and `TASK_BRANCH_FAILED` (with git's message)
 * when git refuses (existing branch, conflicting local changes, …).
 */
export async function createBranch(root: string, name: string, from: string): Promise<void> {
  if (!isValidBranchName(name)) {
    throw new DflError(`"${name}" is not a valid git branch name.`, {
      hint: 'Check the branch template in .df/tracker.json, or pass another slug.',
      code: 'TASK_BRANCH_INVALID',
    });
  }
  if (!isPlainArg(from)) {
    throw new DflError(`"${from}" is not a valid git ref to branch from.`, {
      hint: 'Check "branch.from" in .df/tracker.json.',
      code: 'TASK_BRANCH_INVALID',
    });
  }
  try {
    await runGit(['-C', root, 'switch', '--no-track', '-c', name, from], { timeoutMs: SWITCH_TIMEOUT_MS });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.code === 'ENOENT') {
      throw new DflError('git is not installed (or not on PATH).', {
        hint: 'Install git and run the command again.',
        code: 'GIT_NOT_FOUND',
        cause: error,
      });
    }
    const detail = err.killed ? `git did not finish within ${SWITCH_TIMEOUT_MS / 1000} s` : stderrDetail(err.stderr);
    throw new DflError(`Cannot create branch "${name}" from "${from}"${detail ? `: ${detail}` : '.'}`, {
      hint: 'Fix the problem git reports (for example commit or stash conflicting changes), then run the command again.',
      code: 'TASK_BRANCH_FAILED',
      cause: error,
    });
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}

/** `git <args>` synchronously: stdout on exit 0, undefined on any failure (non-zero exit, timeout, no git). */
function gitSync(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv(),
      timeout: SYNC_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** `refs/heads/x` → `x`; anything else (a SHA, another ref kind, empty) → undefined. */
function branchFromRef(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed.startsWith(HEADS)) return undefined;
  const name = trimmed.slice(HEADS.length);
  return name === '' ? undefined : name;
}

/** A value that is safe as a positional git argument: non-empty, no leading `-`, no NUL or newline. */
function isPlainArg(value: string): boolean {
  return typeof value === 'string' && value !== '' && !value.startsWith('-') && !/[\0\r\n]/.test(value);
}

/** {@link isPlainArg} that is not refspec syntax either: no `:`, no leading `+`, no whitespace. */
function isPlainRefName(value: string): boolean {
  return isPlainArg(value) && !value.startsWith('+') && !/[:\s]/.test(value);
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The last few meaningful lines of git's stderr, joined (hint lines dropped), at most 500 characters. */
function stderrDetail(stderr: string | undefined): string {
  const text = (stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('hint:'))
    .slice(-4)
    .join(' ');
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}
