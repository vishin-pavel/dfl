import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DflError } from './errors.js';
import type { ProjectPaths } from './types.js';

export const DF_DIR = '.df';
export const PACKAGE_NAME = '@vishin-pavel/dfl';

/** Nearest ancestor of `start` (inclusive) that contains a `.df/` directory. */
export function findProjectRoot(start: string = process.cwd()): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    try {
      if (fs.statSync(path.join(current, DF_DIR)).isDirectory()) return current;
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** `git rev-parse --show-toplevel`, or undefined outside a git work tree. */
export function gitRoot(cwd: string = process.cwd()): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? path.resolve(out) : undefined;
  } catch {
    return undefined;
  }
}

export interface ResolveRootOptions {
  /** Explicit root (`--root`). */
  root?: string | undefined;
  cwd?: string | undefined;
  /** When true, fall back to the git root or cwd instead of throwing (used by `dfl install`). */
  forInstall?: boolean | undefined;
}

/**
 * Project root resolution: `--root` → `DFL_ROOT` env → nearest ancestor with `.df/`
 * → (install only) git root → cwd.
 */
export function resolveProjectRoot(options: ResolveRootOptions = {}): string {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (options.root) return path.resolve(cwd, options.root);
  const fromEnv = process.env['DFL_ROOT'];
  if (fromEnv) return path.resolve(cwd, fromEnv);
  const found = findProjectRoot(cwd);
  if (found) return found;
  if (options.forInstall) return gitRoot(cwd) ?? cwd;
  throw new DflError('No dfl project found (no .df/ directory in this or any parent directory).', {
    hint: 'Run `dfl install` in your project root first.',
    code: 'NO_PROJECT',
  });
}

export function projectPaths(root: string): ProjectPaths {
  const abs = path.resolve(root);
  const dfDir = path.join(abs, DF_DIR);
  return {
    root: abs,
    dfDir,
    configFile: path.join(dfDir, 'config.json'),
    localFile: path.join(dfDir, 'local.json'),
    stateFile: path.join(dfDir, 'state.json'),
    manifestFile: path.join(dfDir, 'installed.json'),
    dfGitignoreFile: path.join(dfDir, '.gitignore'),
    rootGitignoreFile: path.join(abs, '.gitignore'),
    flowDir: (flow) => path.join(dfDir, flow),
    flowFile: (flow) => path.join(dfDir, flow, 'flow.json'),
    partialsDir: (flow) => path.join(dfDir, flow, 'partials'),
    stepsDir: (flow) => path.join(dfDir, flow, 'steps'),
    stepDir: (flow, step) => path.join(dfDir, flow, 'steps', step),
  };
}

let cachedPackageRoot: string | undefined;

/** Root directory of the installed dfl package (contains package.json and templates/). */
export function packageRoot(): string {
  if (cachedPackageRoot) return cachedPackageRoot;
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkgFile = path.join(current, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { name?: string };
      if (pkg.name === PACKAGE_NAME) {
        cachedPackageRoot = current;
        return current;
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) throw new DflError('Cannot locate the dfl package root (package.json not found).');
    current = parent;
  }
}

export function packageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

/** `<pkg>/templates` */
export function templatesDir(): string {
  return path.join(packageRoot(), 'templates');
}

/** `<pkg>/templates/flows` – prebuilt flow templates. */
export function flowTemplatesDir(): string {
  return path.join(templatesDir(), 'flows');
}

/** `<pkg>/templates/skills` – built-in skills (add/edit/delete-flow-step). */
export function builtinSkillsDir(): string {
  return path.join(templatesDir(), 'skills');
}

/** `<pkg>/templates/partials` – built-in Handlebars partials. */
export function builtinPartialsDir(): string {
  return path.join(templatesDir(), 'partials');
}
