import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DflError } from './errors.js';

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when `p` itself is a symbolic link (the link is not followed). */
export function isSymlink(p: string): boolean {
  return lstatOrUndefined(p)?.isSymbolicLink() ?? false;
}

/** `fs.lstatSync` that returns undefined when the path does not exist. */
export function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function readText(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

export function readTextIfExists(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export interface WriteOptions {
  /**
   * When `p` is a symlink to an existing file, write that file (the link is kept) instead of
   * replacing the link with a regular file. Only for user config files that may legitimately be
   * links to shared files (MCP configs); never for files whose content comes from templates.
   * A dangling link is always replaced.
   */
  followSymlink?: boolean | undefined;
}

/**
 * Writes a text file atomically (temp file + rename), creating parent dirs.
 * Returns false (and does not touch the file) when the content is unchanged.
 *
 * - An existing file keeps its permission bits (and, when possible, its owner); the temp file
 *   is created 0600 so restrictive content is never readable in between.
 * - A symlink at `p` is replaced by a regular file (the link target is never written), unless
 *   `followSymlink` is set (see {@link WriteOptions}).
 * - Throws DflError `NOT_A_FILE` when `p` is a directory or another non-regular file.
 */
export function writeText(p: string, content: string, options: WriteOptions = {}): boolean {
  let target = p;
  let st = lstatOrUndefined(p);
  if (st?.isSymbolicLink()) {
    const real = options.followSymlink ? realpathOrUndefined(p) : undefined;
    const realSt = real !== undefined ? lstatOrUndefined(real) : undefined;
    if (real !== undefined && realSt?.isFile()) {
      target = real;
      st = realSt;
    } else {
      st = undefined; // replace the link itself with a regular file
    }
  }
  if (st && !st.isFile()) {
    throw new DflError(`Cannot write ${p}: it is not a regular file.`, { code: 'NOT_A_FILE' });
  }
  if (st && fs.readFileSync(target, 'utf8') === content) return false;
  ensureDir(path.dirname(target));
  atomicWrite(target, content, st);
  return true;
}

export function readJson<T = unknown>(p: string): T {
  const text = readText(p);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new DflError(`Cannot parse JSON in ${p}: ${(error as Error).message}`, { code: 'INVALID_JSON', cause: error });
  }
}

export function readJsonIfExists<T = unknown>(p: string): T | undefined {
  if (!exists(p)) return undefined;
  return readJson<T>(p);
}

/** Pretty JSON (2 spaces) with a trailing newline. Returns false when unchanged. */
export function writeJson(p: string, data: unknown, options: WriteOptions = {}): boolean {
  return writeText(p, `${JSON.stringify(data, null, 2)}\n`, options);
}

/** `rm -rf` (a symlink is removed itself, its target is never touched). */
export function removePath(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

/** Sorted names of child directories; `[]` when `p` does not exist. */
export function listDirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Recursive list of regular files under `dir` as sorted posix paths relative to `dir`; `[]` when
 * missing. Symlinks (to files or directories) are neither listed nor followed.
 */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (abs: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(childAbs, childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  visit(dir, '');
  return out.sort();
}

/**
 * Copies a file (content + permission bits) atomically. Returns false when `dest` already has the
 * same content and mode. Never writes through a symlink: throws DflError `UNSAFE_PATH` when `dest`
 * is a symlink, and `NOT_A_FILE` when it is a directory or another non-regular file.
 */
export function copyFile(src: string, dest: string): boolean {
  const content = fs.readFileSync(src);
  const mode = fs.statSync(src).mode & 0o777;
  const st = lstatOrUndefined(dest);
  if (st?.isSymbolicLink()) {
    throw new DflError(`Refusing to write ${dest}: it is a symbolic link.`, {
      hint: 'Remove the link (dfl never writes through symlinks).',
      code: 'UNSAFE_PATH',
    });
  }
  if (st && !st.isFile()) {
    throw new DflError(`Cannot write ${dest}: it is not a regular file.`, { code: 'NOT_A_FILE' });
  }
  if (st && fs.readFileSync(dest).equals(content)) {
    if ((st.mode & 0o777) === mode) return false;
    fs.chmodSync(dest, mode);
    return true;
  }
  ensureDir(path.dirname(dest));
  atomicWrite(dest, content, undefined, mode);
  return true;
}

/** Recursively copies a directory (symlinks are skipped). `filter` receives posix paths relative to `src`. */
export function copyDir(src: string, dest: string, filter: (rel: string) => boolean = () => true): string[] {
  const copied: string[] = [];
  for (const rel of walkFiles(src)) {
    if (!filter(rel)) continue;
    copyFile(path.join(src, ...rel.split('/')), path.join(dest, ...rel.split('/')));
    copied.push(rel);
  }
  return copied;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Project-relative posix path. */
export function relPosix(root: string, abs: string): string {
  return toPosix(path.relative(root, abs));
}

/** Removes `dir` and its empty ancestors, stopping at (and never removing) `stopAt`. Stops at symlinks. */
export function removeEmptyDirsUpTo(dir: string, stopAt: string): void {
  let current = path.resolve(dir);
  const stop = path.resolve(stopAt);
  while (current.startsWith(stop + path.sep) && current !== stop) {
    try {
      if (!fs.lstatSync(current).isDirectory()) return;
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

// ---------------------------------------------------------------------------
// Symlink-safe paths inside a root
// ---------------------------------------------------------------------------

/**
 * True for a plain relative posix path: non-empty segments separated by `/`, no `.`/`..`
 * segments, no backslashes, no NUL, not absolute.
 */
export function isSafeRelPath(rel: string): boolean {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || rel.includes('\\')) return false;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export interface InsideOptions {
  /** Accept a symlink as the last component (e.g. to remove the link itself). Default: rejected. */
  allowLeafSymlink?: boolean | undefined;
}

/**
 * Resolves the project-relative posix path `rel` inside `root` without trusting symlinks: `rel`
 * must be a plain relative path ({@link isSafeRelPath}), and every existing component below `root`
 * is `lstat`ed – a symlink (or a non-directory where a directory is needed) throws DflError
 * `UNSAFE_PATH`. Components that do not exist yet are fine (they will be created as real
 * directories). The result therefore always stays inside `root` (also after realpath).
 */
export function safeResolveInside(root: string, rel: string, options: InsideOptions = {}): string {
  if (!isSafeRelPath(rel)) {
    throw new DflError(`Unsafe path "${rel}": expected a plain relative path inside ${root}.`, { code: 'UNSAFE_PATH' });
  }
  const base = path.resolve(root);
  const parts = rel.split('/');
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    const st = lstatOrUndefined(current);
    if (!st) break;
    const leaf = i === parts.length - 1;
    if (st.isSymbolicLink()) {
      if (leaf && options.allowLeafSymlink) break;
      throw new DflError(`Refusing to use ${toPosix(path.relative(base, current))}: it is a symbolic link (dfl never writes or deletes through symlinks).`, {
        code: 'UNSAFE_PATH',
      });
    }
    if (!leaf && !st.isDirectory()) {
      throw new DflError(`Cannot use ${rel}: ${toPosix(path.relative(base, current))} is not a directory.`, { code: 'UNSAFE_PATH' });
    }
  }
  return path.join(base, ...parts);
}

/** {@link writeText} at `root/rel` after {@link safeResolveInside} (no symlinked parents, no symlink leaf). */
export function writeTextInside(root: string, rel: string, content: string): boolean {
  return writeText(safeResolveInside(root, rel), content);
}

/** {@link copyFile} to `root/rel` after {@link safeResolveInside} (no symlinked parents, no symlink leaf). */
export function copyFileInside(root: string, rel: string, src: string): boolean {
  return copyFile(src, safeResolveInside(root, rel));
}

/**
 * Removes `root/rel` (file or directory tree) when its parents are not symlinks; a symlink leaf is
 * removed itself. Returns true when something was removed.
 */
export function removeInside(root: string, rel: string): boolean {
  const abs = safeResolveInside(root, rel, { allowLeafSymlink: true });
  if (!lstatOrUndefined(abs)) return false;
  removePath(abs);
  return true;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function realpathOrUndefined(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Writes `content` to a fresh temp file next to `target` (O_EXCL, 0600), applies the mode
 * (existing file's mode, `mode`, or the umask default) and owner, then renames it over `target`.
 */
function atomicWrite(target: string, content: string | Buffer, existing: fs.Stats | undefined, mode?: number): void {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx', mode: existing || mode !== undefined ? 0o600 : 0o666 });
    if (existing) {
      fs.chmodSync(tmp, existing.mode & 0o7777);
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      if ((uid !== undefined && existing.uid !== uid) || (gid !== undefined && existing.gid !== gid)) {
        try {
          fs.chownSync(tmp, existing.uid, existing.gid);
        } catch {
          // not permitted: keep our own ownership
        }
      }
    } else if (mode !== undefined) {
      fs.chmodSync(tmp, mode);
    }
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }
}
