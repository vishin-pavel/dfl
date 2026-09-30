/**
 * Import flows distributed over git (OWNER: sync agent).
 * Sources: `https://…`/`git@…`/`ssh://…` URLs (optionally `#ref`), `github:owner/repo[/sub/path][#ref]`,
 * or a local directory path. Git sources are shallow-cloned (`git clone --depth 1 [--branch ref]`) into a temp dir.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DflError } from './errors.js';
import { copyFlowFromDir, flowExists, parseFlowDefinition } from './flow.js';
import { exists, isDir, listDirs, readJson, removePath } from './fsx.js';
import type { FlowModel, FlowSource, ProjectPaths } from './types.js';

const execFileAsync = promisify(execFile);

export interface ParsedFlowSource {
  kind: 'git' | 'local';
  /** Clone URL or absolute local path. */
  url: string;
  /** Sub-path inside the repo/dir where to look for flows. */
  subpath?: string | undefined;
  ref?: string | undefined;
}

/** `scheme://` prefix of URL-style git sources. */
const URL_SCHEME_RE = /^(?:https?|ssh|git|git\+ssh|file):\/\//i;
/** scp-like git syntax: `git@github.com:owner/repo.git`. */
const SCP_RE = /^[\w.-]+@[\w.-]+:/;
const GITHUB_PREFIX = 'github:';
const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Parses an import source:
 * - `github:owner/repo[/sub/path][#ref]` → `https://github.com/owner/repo.git`
 * - `https://…`, `http://…`, `ssh://…`, `git://…`, `file://…`, `git@host:path` with an optional
 *   git-style `//sub/path` after the repository path and an optional `#ref`
 * - anything else is a local directory (resolved against `cwd`; DflError when missing).
 */
export function parseFlowSource(input: string, cwd: string = process.cwd()): ParsedFlowSource {
  const trimmed = input.trim();
  if (trimmed === '') throw new DflError('No flow source given.', { hint: importHint(), code: 'INVALID_SOURCE' });

  if (trimmed.toLowerCase().startsWith(GITHUB_PREFIX)) {
    const { body, ref } = splitRef(trimmed.slice(GITHUB_PREFIX.length), trimmed);
    const [owner, repo, ...rest] = body.split('/').filter((part) => part !== '');
    if (!owner || !repo || !GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(repo)) {
      throw new DflError(`Invalid GitHub source "${trimmed}".`, {
        hint: 'Use github:owner/repo[/sub/path][#ref], e.g. github:acme/flows/flows/feature#v1.',
        code: 'INVALID_SOURCE',
      });
    }
    const name = repo.endsWith('.git') ? repo.slice(0, -'.git'.length) : repo;
    return gitSource(`https://github.com/${owner}/${name}.git`, cleanSubpath(rest.join('/'), trimmed), ref);
  }

  if (URL_SCHEME_RE.test(trimmed) || SCP_RE.test(trimmed)) {
    const { body, ref } = splitRef(trimmed, trimmed);
    const scheme = URL_SCHEME_RE.exec(body)?.[0] ?? '';
    const rest = body.slice(scheme.length);
    const split = rest.indexOf('//');
    const url = split === -1 ? body : scheme + rest.slice(0, split);
    const subpath = split === -1 ? undefined : cleanSubpath(rest.slice(split + 2), trimmed);
    if (url === scheme || url.endsWith(':')) {
      throw new DflError(`Invalid git URL "${trimmed}".`, { hint: importHint(), code: 'INVALID_SOURCE' });
    }
    return gitSource(url, subpath, ref);
  }

  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
  const abs = path.resolve(cwd, expanded);
  if (!exists(abs)) {
    throw new DflError(`Flow source "${trimmed}" not found (${abs} does not exist).`, {
      hint: importHint(),
      code: 'SOURCE_NOT_FOUND',
    });
  }
  if (!isDir(abs)) {
    throw new DflError(`Flow source "${trimmed}" is not a directory.`, { hint: importHint(), code: 'INVALID_SOURCE' });
  }
  return { kind: 'local', url: abs };
}

/**
 * Candidate flow dirs inside a checked-out source: the dir itself if it has flow.json, else
 * `*\/flow.json`, `flows/*\/flow.json`, `.df/*\/flow.json` (in that order; deduped).
 */
export function findFlowDirs(dir: string): string[] {
  const root = path.resolve(dir);
  if (exists(path.join(root, 'flow.json'))) return [root];
  const found: string[] = [];
  for (const parent of [root, path.join(root, 'flows'), path.join(root, '.df')]) {
    for (const name of listDirs(parent)) {
      const candidate = path.join(parent, name);
      if (name === '.git' || name === 'node_modules' || found.includes(candidate)) continue;
      if (exists(path.join(candidate, 'flow.json'))) found.push(candidate);
    }
  }
  return found;
}

export interface ImportOptions {
  /** Target flow name (default: the source flow's name). Only valid when importing one flow. */
  name?: string | undefined;
  /** Import only these source flow names. Default: all found. */
  flows?: string[] | undefined;
  /** Replace existing flows with the same name. */
  force?: boolean | undefined;
}

/**
 * Imports flow(s) into `.df/` (records `source` in flow.json). Returns the imported models.
 * `source.path` is the imported flow's directory relative to the repository / source root.
 * `force` replaces the flow directory in place: active-flow settings and runtime state that refer
 * to the flow are kept.
 */
export async function importFlows(paths: ProjectPaths, input: string, options: ImportOptions = {}): Promise<FlowModel[]> {
  const source = parseFlowSource(input);
  if (source.kind === 'local') return importFromDir(paths, source.url, source, input, options);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dfl-import-'));
  try {
    const checkout = path.join(tmp, 'repo');
    await cloneRepo(source.url, source.ref, checkout);
    return importFromDir(paths, checkout, source, input, options);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function importHint(): string {
  return 'Use a git URL (https://…, git@host:owner/repo.git, optionally //sub/path and #ref), github:owner/repo[/path][#ref] or a local directory.';
}

function gitSource(url: string, subpath: string | undefined, ref: string | undefined): ParsedFlowSource {
  return { kind: 'git', url, ...(subpath ? { subpath } : {}), ...(ref ? { ref } : {}) };
}

/** Splits a trailing `#ref`. */
function splitRef(value: string, input: string): { body: string; ref: string | undefined } {
  const hash = value.indexOf('#');
  if (hash === -1) return { body: value, ref: undefined };
  const ref = value.slice(hash + 1).trim();
  if (ref === '' || ref.startsWith('-') || /\s/.test(ref)) {
    throw new DflError(`Invalid git ref in "${input}".`, { hint: 'Put a branch or tag name after "#".', code: 'INVALID_SOURCE' });
  }
  return { body: value.slice(0, hash), ref };
}

/** Normalizes a sub-path (posix, no leading/trailing slashes); rejects `..` segments. */
function cleanSubpath(value: string, input: string): string | undefined {
  const parts = value.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) {
    throw new DflError(`Invalid sub-path in "${input}": ".." is not allowed.`, { code: 'INVALID_SOURCE' });
  }
  return parts.length > 0 ? parts.join('/') : undefined;
}

async function cloneRepo(url: string, ref: string | undefined, dest: string): Promise<void> {
  const args = ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, dest];
  try {
    // No interactive credential prompts: they would hang `dfl mcp` and non-TTY runs.
    await execFileAsync('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      throw new DflError('git is not installed (or not on PATH).', {
        hint: 'Install git, or import from a local directory instead.',
        code: 'GIT_NOT_FOUND',
        cause: error,
      });
    }
    const detail = (err.stderr ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('Cloning into'))
      .slice(-3)
      .join(' ');
    throw new DflError(`Cannot clone ${url}${ref ? ` at "${ref}"` : ''}${detail ? `: ${detail}` : '.'}`, {
      hint: ref
        ? 'Check the URL, your access to the repository, and that the ref is a branch or tag (commit SHAs are not supported).'
        : 'Check the URL and your access to the repository (SSH key or git credential helper).',
      code: 'CLONE_FAILED',
      cause: error,
    });
  }
}

interface Candidate {
  /** Source flow name (flow.json `name`). */
  name: string;
  dir: string;
}

function importFromDir(
  paths: ProjectPaths,
  baseDir: string,
  source: ParsedFlowSource,
  input: string,
  options: ImportOptions,
): FlowModel[] {
  const searchDir = source.subpath ? path.join(baseDir, ...source.subpath.split('/')) : baseDir;
  if (!isDir(searchDir)) {
    throw new DflError(`Path "${source.subpath ?? ''}" does not exist in ${source.url}.`, { code: 'SOURCE_NOT_FOUND' });
  }

  // Deduped by flow name: the first match in findFlowDirs order wins.
  const candidates: Candidate[] = [];
  for (const dir of findFlowDirs(searchDir)) {
    const file = path.join(dir, 'flow.json');
    const { name } = parseFlowDefinition(readJson(file), displayPath(file, baseDir, source));
    if (!candidates.some((c) => c.name === name)) candidates.push({ name, dir });
  }
  if (candidates.length === 0) {
    throw new DflError(`No flows found in ${input.trim()}.`, {
      hint: 'A flow is a directory with a flow.json; dfl looks in the source dir itself, */, flows/*/ and .df/*/.',
      code: 'FLOW_NOT_FOUND',
    });
  }

  let selected = candidates;
  if (options.flows && options.flows.length > 0) {
    const wanted = [...new Set(options.flows)];
    const missing = wanted.filter((name) => !candidates.some((c) => c.name === name));
    if (missing.length > 0) {
      throw new DflError(`Flow${missing.length > 1 ? 's' : ''} ${missing.map((n) => `"${n}"`).join(', ')} not found in ${input.trim()}.`, {
        hint: `Available: ${candidates.map((c) => c.name).join(', ')}.`,
        code: 'FLOW_NOT_FOUND',
      });
    }
    selected = candidates.filter((c) => wanted.includes(c.name));
  }
  if (options.name !== undefined && selected.length !== 1) {
    throw new DflError(`--name can only be used when importing exactly one flow (found ${selected.length}).`, {
      hint: `Pick one of: ${selected.map((c) => c.name).join(', ')}.`,
      code: 'INVALID_OPTION',
    });
  }

  const plan = selected.map((c) => ({ ...c, target: options.name ?? c.name }));
  if (!options.force) {
    const clashes = plan.filter((p) => flowExists(paths, p.target)).map((p) => p.target);
    if (clashes.length > 0) {
      throw new DflError(`Flow${clashes.length > 1 ? 's' : ''} ${clashes.map((n) => `"${n}"`).join(', ')} already exist${clashes.length > 1 ? '' : 's'}.`, {
        hint: 'Use --force to replace, or --name to import under another name.',
        code: 'FLOW_EXISTS',
      });
    }
  }

  return plan.map((p) => {
    if (options.force && flowExists(paths, p.target)) removePath(paths.flowDir(p.target));
    const rel = path.relative(baseDir, p.dir).split(path.sep).join('/');
    const flowSource: FlowSource = {
      type: source.kind,
      ref: source.url,
      ...(rel !== '' ? { path: rel } : {}),
      ...(source.ref ? { rev: source.ref } : {}),
    };
    return copyFlowFromDir(paths, p.dir, p.target, flowSource);
  });
}

/** File path for error messages: `<url>//<path in repo>` for git sources, the real path otherwise. */
function displayPath(file: string, baseDir: string, source: ParsedFlowSource): string {
  if (source.kind === 'local') return file;
  return `${source.url}//${path.relative(baseDir, file).split(path.sep).join('/')}`;
}
