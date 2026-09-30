/**
 * Cross-process lock for the mutations of one project (used by the MCP server and the CLI).
 *
 * Several processes can change the same project at once: two agents each running their own
 * `dfl mcp`, or an MCP server plus `dfl step …` in a terminal. The core mutators do a synchronous
 * read-modify-write of `.df/<flow>/flow.json`, `.df/state.json` and `.df/installed.json`; without a
 * lock one process's write silently replaces the other's. `withProjectLock` serializes whole
 * mutations (read, write and the closing sync) across processes with an exclusive lock file,
 * `.df/.lock`, created with O_CREAT|O_EXCL.
 *
 * - The file holds `{ pid, host, token, at }`. Only the owner (matching `token`) removes it.
 * - While held, the owner refreshes the file's mtime every `staleMs / 4` (a heartbeat), so a long
 *   mutation (e.g. a `git clone` for `flow pull`) is never mistaken for an abandoned lock.
 * - A lock whose process is gone (same host, `kill(pid, 0)` → ESRCH), or whose mtime is older than
 *   `staleMs` (no heartbeat: the process died, hangs or is suspended), is taken over.
 * - Never keep a lock across an interactive prompt: other processes give up after `timeoutMs`.
 * - A `.lock` that is not a regular file (a symlink or directory) is never followed or deleted:
 *   the mutation fails with a DflError asking to remove it.
 * - When the lock file cannot be created for another reason (read-only `.df/`, …) the mutation runs
 *   unlocked; its own write then reports the real problem.
 *
 * The lock is not re-entrant: never nest withProjectLock calls for the same project.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DflError } from './errors.js';
import type { ProjectPaths } from './types.js';

/** Lock file name inside `.df/` (should be git-ignored by `.df/.gitignore`). */
export const PROJECT_LOCK_FILE = '.lock';

export interface ProjectLockOptions {
  /** How long to wait for another process's lock before failing with `LOCKED`. Default 15 s. */
  timeoutMs?: number | undefined;
  /**
   * A lock not refreshed for this long is considered abandoned and taken over. Default 60 s. The
   * holder refreshes its lock every quarter of its own `staleMs`.
   */
  staleMs?: number | undefined;
}

interface LockInfo {
  pid?: number;
  host?: string;
  token?: string;
  at?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 60_000;
const MAX_DELAY_MS = 100;

export function projectLockFile(paths: ProjectPaths): string {
  return path.join(paths.dfDir, PROJECT_LOCK_FILE);
}

/** Runs `fn` while holding the project lock (see the module doc). */
export async function withProjectLock<T>(
  paths: ProjectPaths,
  fn: () => T | Promise<T>,
  options: ProjectLockOptions = {},
): Promise<T> {
  const release = await acquireProjectLock(paths, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Acquires the project lock and returns its release function (idempotent). */
export async function acquireProjectLock(paths: ProjectPaths, options: ProjectLockOptions = {}): Promise<() => void> {
  const file = projectLockFile(paths);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const token = randomBytes(12).toString('hex');
  const content = `${JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: new Date().toISOString() })}\n`;
  const deadline = Date.now() + timeoutMs;
  let delay = 5;

  for (;;) {
    const created = tryCreate(file, content);
    if (created === 'created') return releaser(file, token, heartbeat(file, token, staleMs));
    if (created === 'unavailable') return () => undefined;

    const held = inspect(file);
    if (held.kind === 'gone') continue;
    if (held.kind === 'foreign') {
      throw new DflError(`${file} is not a regular file, so dfl cannot lock the project.`, {
        hint: 'Remove it; dfl creates the lock file itself while it changes the project.',
        code: 'LOCKED',
      });
    }
    if (isStale(held.info, held.mtimeMs, staleMs)) {
      removeIfUnchanged(file, held.raw);
      continue;
    }
    if (Date.now() >= deadline) {
      const owner = held.info?.pid !== undefined ? ` (process ${held.info.pid}${held.info.host ? ` on ${held.info.host}` : ''})` : '';
      throw new DflError(`Another dfl process${owner} is changing this project; gave up waiting after ${Math.round(timeoutMs / 1000)} s.`, {
        hint: `Retry in a moment. If no dfl process is running, delete ${file}.`,
        code: 'LOCKED',
      });
    }
    await sleep(delay + Math.floor(Math.random() * delay));
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

function tryCreate(file: string, content: string): 'created' | 'exists' | 'unavailable' {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o644);
  } catch (error) {
    return errorCode(error) === 'EEXIST' ? 'exists' : 'unavailable';
  }
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  return 'created';
}

type Held =
  | { kind: 'gone' }
  | { kind: 'foreign' }
  | { kind: 'held'; raw: string; info: LockInfo | undefined; mtimeMs: number };

function inspect(file: string): Held {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return { kind: 'gone' };
  }
  if (!stat.isFile()) return { kind: 'foreign' };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { kind: 'gone' };
  }
  return { kind: 'held', raw, info: parseInfo(raw), mtimeMs: stat.mtimeMs };
}

function parseInfo(raw: string): LockInfo | undefined {
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
    const record = data as Record<string, unknown>;
    return {
      ...(typeof record['pid'] === 'number' && Number.isInteger(record['pid']) && record['pid'] > 0 ? { pid: record['pid'] } : {}),
      ...(typeof record['host'] === 'string' ? { host: record['host'] } : {}),
      ...(typeof record['token'] === 'string' ? { token: record['token'] } : {}),
      ...(typeof record['at'] === 'string' ? { at: record['at'] } : {}),
    };
  } catch {
    // Empty (the owner is between create and write) or garbage: only the age decides.
    return undefined;
  }
}

function isStale(info: LockInfo | undefined, mtimeMs: number, staleMs: number): boolean {
  if (Date.now() - mtimeMs > staleMs) return true;
  if (info?.pid === undefined || info.host !== os.hostname()) return false;
  if (info.pid === process.pid) return false;
  return !isProcessAlive(info.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/** Removes an abandoned lock unless another process replaced it meanwhile. */
function removeIfUnchanged(file: string, raw: string): void {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || fs.readFileSync(file, 'utf8') !== raw) return;
    fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/** True while `file` is a regular file holding our `token`. */
function ownsLock(file: string, token: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && parseInfo(fs.readFileSync(file, 'utf8'))?.token === token;
  } catch {
    return false;
  }
}

/**
 * Refreshes the lock file's mtime every quarter of `staleMs` while we hold it (the timer does not
 * keep the process alive). Stops by itself once the lock is gone or belongs to someone else.
 */
function heartbeat(file: string, token: string, staleMs: number): NodeJS.Timeout {
  const timer = setInterval(
    () => {
      if (!ownsLock(file, token)) {
        clearInterval(timer);
        return;
      }
      try {
        const now = new Date();
        fs.utimesSync(file, now, now);
      } catch {
        // Removed meanwhile: the next tick stops the timer.
      }
    },
    // setInterval takes at most 2^31-1 ms (larger values fire every millisecond).
    Math.min(Math.max(10, Math.floor(staleMs / 4)), 2 ** 31 - 1),
  );
  timer.unref();
  return timer;
}

function releaser(file: string, token: string, timer: NodeJS.Timeout): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) return;
      if (parseInfo(fs.readFileSync(file, 'utf8'))?.token !== token) return;
      fs.unlinkSync(file);
    } catch {
      // Taken over or removed by hand.
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}
