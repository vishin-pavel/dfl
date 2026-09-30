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

/**
 * Writes a text file atomically (temp file + rename), creating parent dirs.
 * Returns false (and does not touch the file) when the content is unchanged.
 */
export function writeText(p: string, content: string): boolean {
  const current = readTextIfExists(p);
  if (current === content) return false;
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
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
export function writeJson(p: string, data: unknown): boolean {
  return writeText(p, `${JSON.stringify(data, null, 2)}\n`);
}

/** `rm -rf` */
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

/** Recursive list of files under `dir` as sorted posix paths relative to `dir`; `[]` when missing. */
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

export function copyFile(src: string, dest: string): boolean {
  const content = fs.readFileSync(src);
  try {
    if (fs.readFileSync(dest).equals(content)) return false;
  } catch {
    // destination missing
  }
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, content);
  fs.chmodSync(dest, fs.statSync(src).mode);
  return true;
}

/** Recursively copies a directory. `filter` receives posix paths relative to `src`. */
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

/** Removes `dir` and its empty ancestors, stopping at (and never removing) `stopAt`. */
export function removeEmptyDirsUpTo(dir: string, stopAt: string): void {
  let current = path.resolve(dir);
  const stop = path.resolve(stopAt);
  while (current.startsWith(stop + path.sep) && current !== stop) {
    try {
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}
