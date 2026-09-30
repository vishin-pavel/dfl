/**
 * Import flows distributed over git (OWNER: sync agent).
 * Sources: `https://…`/`git@…`/`ssh://…` URLs (optionally `#ref`), `github:owner/repo[/sub/path][#ref]`,
 * or a local directory path. Git sources are shallow-cloned (`git clone --depth 1 [--branch ref]`, or a
 * fetch of the commit for `#<sha>`) into a temp dir; the imported commit is recorded as `source.commit`.
 * `pullFlow` re-imports a flow from the source recorded in its flow.json.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DflError } from './errors.js';
import {
  NEXT_EVENT,
  type StagedFlow,
  commitStagedFlow,
  discardStagedFlow,
  flowExists,
  getFlowTemplate,
  loadFlow,
  orderStates,
  parseFlowDefinition,
  readFlowDefinition,
  stageFlowCopy,
} from './flow.js';
import { copyFile, exists, isDir, isFile, listDirs, readJson, relPosix, toPosix, walkFiles } from './fsx.js';
import { assertValidFlowName } from './ids.js';
import { moveCurrentInRuntime, storedCurrentStep } from './machine.js';
import { readRenderedOutputs } from './render.js';
import type { FlowDefinition, FlowModel, FlowSource, ProjectPaths } from './types.js';

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

/** `source` as recorded in flow.json (`commit`: the imported git commit). */
export type RecordedFlowSource = FlowSource & { commit?: string | undefined };

/** The developer's position moved because the current step is not in the new version of the flow. */
export interface CurrentStepMove {
  from: string;
  to: string;
}

/** What replacing an existing flow's files kept of the old flow dir (see {@link importFlows}, {@link pullFlow}). */
export interface FlowReplacement {
  /**
   * Hand-written `.md` files under `steps/` (flow-relative posix paths) carried over into the new
   * files: dfl did not render them, and they are git-ignored, so deleting them would lose them.
   */
  kept: string[];
  /** Set when the current step was not in the new version and the position moved (`STEP_REMOVED` history entry). */
  currentMoved?: CurrentStepMove | undefined;
}

/** An imported flow; `kept`/`currentMoved` are only non-empty when `force` replaced an existing flow. */
export type ImportedFlow = FlowModel & FlowReplacement;

/**
 * Imports flow(s) into `.df/` (records `source` in flow.json). Returns the imported models.
 * `source.path` is the imported flow's directory relative to the repository / source root; for a
 * local source `source.ref` is that root relative to the project root (posix). Every target name
 * is validated and every flow is staged before any existing flow is replaced; `force` then swaps
 * each flow directory atomically, keeping active-flow settings, runtime state (keyed by name) and
 * hand-written `.md` files under steps/; a current step the new version lacks moves like in
 * {@link pullFlow}.
 */
export async function importFlows(paths: ProjectPaths, input: string, options: ImportOptions = {}): Promise<ImportedFlow[]> {
  if (options.name !== undefined) assertValidFlowName(options.name);
  const source = parseFlowSource(input);
  if (source.kind === 'local') return importFromDir(paths, source.url, source, input, options, undefined);
  return withCheckout(source.url, source.ref, (checkout, commit) => importFromDir(paths, checkout, source, input, options, commit));
}

export interface PullOptions {
  /** Git sources only: branch, tag or commit to pull instead of the recorded `rev`. */
  rev?: string | undefined;
  /** Only compute what would change; nothing is written. */
  dryRun?: boolean | undefined;
}

export interface PullResult extends FlowReplacement {
  /** The flow after the pull (with `dryRun`: as it is now). */
  model: FlowModel;
  /** The source recorded in flow.json after the pull. */
  source: RecordedFlowSource;
  /** Flow-relative posix paths (rendered `.md` output and the `kept` files excluded). */
  added: string[];
  removed: string[];
  changed: string[];
  /**
   * With `dryRun`, `kept` and `currentMoved` say what the pull would keep and where the position
   * would move. Both are empty when nothing changes (the flow's files are then left alone).
   */
  dryRun: boolean;
}

/**
 * Re-imports `.df/<name>` from the source recorded in its flow.json: a prebuilt template (from the
 * running dfl package), a git repository (`ref` URL at `rev`, or `options.rev`) or a local
 * directory. The flow's files are replaced atomically (local edits to its templates are lost);
 * runtime state, active-flow settings and hand-written `.md` files under steps/ (`kept`) are kept.
 * When the developer's current step is not in the new version, the position moves to a surviving
 * step (`currentMoved`, see {@link planCurrentStepMove}). Nothing is written when no file changes.
 * Throws NO_SOURCE for flows created in the project (`source.type: 'created'`) or without a
 * recorded source.
 */
export async function pullFlow(paths: ProjectPaths, name: string, options: PullOptions = {}): Promise<PullResult> {
  const def = readFlowDefinition(paths, name);
  const source = def.source as RecordedFlowSource | undefined;
  if (!source || source.type === 'created') {
    throw new DflError(`Flow "${name}" has no source to pull from${source ? ' (it was created in this project)' : ''}.`, {
      hint: 'Only flows created from a template (`dfl flow create --from`, `dfl install --flow`) or imported with `dfl flow import` can be pulled.',
      code: 'NO_SOURCE',
    });
  }
  if (options.rev !== undefined && source.type !== 'git') {
    throw new DflError('A revision can only be given for flows imported from git.', { code: 'INVALID_OPTION' });
  }
  const subpath = source.path !== undefined ? cleanSubpath(source.path, `.df/${name}/flow.json`) : undefined;

  if (source.type === 'template') {
    const template = getFlowTemplate(source.ref ?? '');
    return pullFromDir(paths, name, template.dir, { type: 'template', ref: template.name }, options);
  }

  if (source.type === 'local') {
    if (!source.ref) throw noRefError(name);
    const base = path.resolve(paths.root, source.ref);
    const dir = subpath ? path.join(base, ...subpath.split('/')) : base;
    if (!isDir(dir)) {
      throw new DflError(`The source of flow "${name}" (${toPosix(path.relative(paths.root, dir)) || '.'}) does not exist.`, {
        hint: `Fix "source" in .df/${name}/flow.json, or re-import it with \`dfl flow import <path> --name ${name} --force\`.`,
        code: 'SOURCE_NOT_FOUND',
      });
    }
    const next: RecordedFlowSource = { type: 'local', ref: localRef(paths, base), ...(subpath ? { path: subpath } : {}) };
    return pullFromDir(paths, name, dir, next, options);
  }

  // git
  const url = source.ref;
  if (!url || !(URL_SCHEME_RE.test(url) || SCP_RE.test(url))) throw noRefError(name);
  const rev = options.rev ?? source.rev;
  if (rev !== undefined) assertValidRev(rev, rev);
  return withCheckout(url, rev, (checkout, commit) => {
    const dir = subpath ? path.join(checkout, ...subpath.split('/')) : checkout;
    if (!isDir(dir)) {
      throw new DflError(`Path "${subpath ?? ''}" does not exist in ${url}${rev ? ` at "${rev}"` : ''}.`, { code: 'SOURCE_NOT_FOUND' });
    }
    const next: RecordedFlowSource = { type: 'git', ref: url, ...(subpath ? { path: subpath } : {}), ...(rev ? { rev } : {}), commit };
    return pullFromDir(paths, name, dir, next, options);
  });
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
  assertValidRev(ref, input);
  return { body: value.slice(0, hash), ref };
}

function assertValidRev(ref: string, input: string): void {
  if (ref === '' || ref.startsWith('-') || /[\s\0]/.test(ref)) {
    throw new DflError(`Invalid git ref in "${input}".`, { hint: 'Put a branch, tag or commit SHA after "#".', code: 'INVALID_SOURCE' });
  }
}

function noRefError(name: string): DflError {
  return new DflError(`Flow "${name}" has an incomplete "source" in its flow.json (no ref).`, {
    hint: `Re-import it with \`dfl flow import <source> --name ${name} --force\`.`,
    code: 'NO_SOURCE',
  });
}

/** Normalizes a sub-path (posix, no leading/trailing slashes); rejects `..` segments. */
function cleanSubpath(value: string, input: string): string | undefined {
  const parts = value.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) {
    throw new DflError(`Invalid sub-path in "${input}": ".." is not allowed.`, { code: 'INVALID_SOURCE' });
  }
  return parts.length > 0 ? parts.join('/') : undefined;
}

/** A full (7–64 hex digit) or abbreviated commit SHA. */
const SHA_RE = /^[0-9a-f]{7,64}$/i;

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    ...(cwd ? { cwd } : {}),
    // No interactive credential prompts: they would hang `dfl mcp` and non-TTY runs.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** Clones `url` at `ref` (branch, tag or commit SHA) into a temp dir, runs `fn(checkout, commit)` and cleans up. */
async function withCheckout<T>(url: string, ref: string | undefined, fn: (checkout: string, commit: string) => T): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dfl-import-'));
  try {
    const checkout = path.join(tmp, 'repo');
    const commit = await cloneRepo(url, ref, checkout);
    return fn(checkout, commit);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Shallow-clones `url` at `ref` into `dest`; returns the checked-out commit. */
async function cloneRepo(url: string, ref: string | undefined, dest: string): Promise<string> {
  try {
    await git(['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, dest]);
  } catch (error) {
    if (!ref || !SHA_RE.test(ref) || (error as NodeJS.ErrnoException).code === 'ENOENT') throw cloneError(url, ref, error);
    await fs.rm(dest, { recursive: true, force: true });
    try {
      await checkoutCommit(url, ref, dest);
    } catch (shaError) {
      throw cloneError(url, ref, shaError);
    }
  }
  try {
    return (await git(['rev-parse', 'HEAD'], dest)).trim();
  } catch (error) {
    throw cloneError(url, ref, error);
  }
}

/** Checks out a commit SHA: a shallow fetch of the commit, else a full fetch (abbreviated SHAs). */
async function checkoutCommit(url: string, sha: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  await git(['init', '-q'], dest);
  await git(['remote', 'add', 'origin', '--', url], dest);
  try {
    await git(['fetch', '-q', '--depth', '1', 'origin', sha], dest);
    await git(['checkout', '-q', '--detach', 'FETCH_HEAD'], dest);
  } catch {
    await git(['fetch', '-q', '--tags', 'origin'], dest);
    await git(['checkout', '-q', '--detach', `${sha}^{commit}`], dest);
  }
}

function cloneError(url: string, ref: string | undefined, error: unknown): DflError {
  const err = error as NodeJS.ErrnoException & { stderr?: string };
  if (err.code === 'ENOENT') {
    return new DflError('git is not installed (or not on PATH).', {
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
  return new DflError(`Cannot clone ${url}${ref ? ` at "${ref}"` : ''}${detail ? `: ${detail}` : '.'}`, {
    hint: ref
      ? 'Check the URL, your access to the repository, and that the ref is a branch, tag or commit SHA.'
      : 'Check the URL and your access to the repository (SSH key or git credential helper).',
    code: 'CLONE_FAILED',
    cause: error,
  });
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
  commit: string | undefined,
): ImportedFlow[] {
  const searchDir = source.subpath ? path.join(baseDir, ...source.subpath.split('/')) : baseDir;
  if (!isDir(searchDir)) {
    throw new DflError(`Path "${source.subpath ?? ''}" does not exist in ${source.url}.`, { code: 'SOURCE_NOT_FOUND' });
  }

  // This project's own flows are skipped when found by searching from above `.df/` (e.g. `dfl flow import .`);
  // naming `.df` or one of its flows explicitly still reaches them (and then fails as a self-import).
  const ownDf = realpathOr(paths.dfDir);
  const searchingOwnDf = isInsideOrEqual(realpathOr(searchDir), ownDf);
  let skippedOwn = 0;

  // Deduped by flow name: the first match in findFlowDirs order wins.
  const candidates: Candidate[] = [];
  for (const dir of findFlowDirs(searchDir)) {
    if (source.kind === 'local' && !searchingOwnDf && isInsideOrEqual(realpathOr(dir), ownDf)) {
      skippedOwn++;
      continue;
    }
    const file = path.join(dir, 'flow.json');
    const { name } = parseFlowDefinition(readJson(file), displayPath(file, baseDir, source));
    if (!candidates.some((c) => c.name === name)) candidates.push({ name, dir });
  }
  if (candidates.length === 0) {
    if (skippedOwn > 0) {
      throw new DflError(`${input.trim()} only contains this project's own flows (in .df/); there is nothing to import.`, {
        hint: 'Import from another directory or a git repository.',
        code: 'INVALID_SOURCE',
      });
    }
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

  // Validate every target before anything is written or replaced.
  const plan = selected.map((c) => ({ ...c, target: options.name ?? c.name }));
  for (const p of plan) {
    try {
      assertValidFlowName(p.target);
    } catch (error) {
      if (options.name === undefined && error instanceof DflError) {
        throw new DflError(`${error.message.replace(/\.$/, '')} (flow.json of ${displayPath(p.dir, baseDir, source)}).`, {
          hint: 'Import it under another name with --name <name>.',
          code: error.code,
        });
      }
      throw error;
    }
  }
  if (!options.force) {
    const clashes = plan.filter((p) => flowExists(paths, p.target)).map((p) => p.target);
    if (clashes.length > 0) {
      throw new DflError(`Flow${clashes.length > 1 ? 's' : ''} ${clashes.map((n) => `"${n}"`).join(', ')} already exist${clashes.length > 1 ? '' : 's'}.`, {
        hint: 'Use --force to replace, or --name to import under another name.',
        code: 'FLOW_EXISTS',
      });
    }
  }

  const staged: StagedFlow[] = [];
  try {
    for (const p of plan) {
      const rel = toPosix(path.relative(baseDir, p.dir));
      const flowSource: RecordedFlowSource =
        source.kind === 'local'
          ? { type: 'local', ref: localRef(paths, source.url), ...(rel !== '' ? { path: rel } : {}) }
          : {
              type: 'git',
              ref: source.url,
              ...(rel !== '' ? { path: rel } : {}),
              ...(source.ref ? { rev: source.ref } : {}),
              ...(commit ? { commit } : {}),
            };
      staged.push(stageFlowCopy(paths, p.dir, p.target, flowSource));
    }
    const force = options.force ?? false;
    // Hand-written files are carried into every staged flow before the first existing flow is replaced.
    const prepared = staged.map((s) => prepareReplacement(paths, s, force));
    return prepared.map((replacement) => commitReplacement(paths, replacement, force));
  } finally {
    for (const s of staged) discardStagedFlow(s);
  }
}

/** Replaces `.df/<name>` with the flow at `srcDir` (or, with `dryRun`, only diffs it). */
function pullFromDir(paths: ProjectPaths, name: string, srcDir: string, source: RecordedFlowSource, options: PullOptions): PullResult {
  const staged = stageFlowCopy(paths, srcDir, name, source);
  try {
    const before = flowFiles(paths.flowDir(name));
    const after = flowFiles(staged.dir);
    const added = [...after.keys()].filter((rel) => !before.has(rel));
    const removed = [...before.keys()].filter((rel) => !after.has(rel));
    const changed = [...after.keys()].filter((rel) => before.has(rel) && !before.get(rel)!.equals(after.get(rel)!));
    const dryRun = options.dryRun ?? false;
    if (added.length + removed.length + changed.length === 0) {
      // Up to date: leave the flow dir (and its rendered output) alone.
      return { model: loadFlow(paths, name), source, added, removed, changed, kept: [], dryRun };
    }
    if (dryRun) {
      const kept = handWrittenFiles(paths, name, staged.dir);
      const currentMoved = planCurrentStepMove(paths, name, staged.def);
      return { model: loadFlow(paths, name), source, added, removed, changed, kept, currentMoved, dryRun };
    }
    const { kept, currentMoved, ...model } = commitReplacement(paths, prepareReplacement(paths, staged, true), true);
    return { model, source, added, removed, changed, kept, currentMoved, dryRun };
  } finally {
    discardStagedFlow(staged);
  }
}

/** A staged flow ready to replace `.df/<name>`, with what it keeps of the old flow dir. */
interface PreparedReplacement extends FlowReplacement {
  staged: StagedFlow;
}

/**
 * Before a staged flow replaces an existing `.df/<name>` (`replace`): copies the old dir's
 * hand-written `.md` files under steps/ into the staged dir and plans where the developer's current
 * step goes when the new version does not have it. Nothing outside the staged dir is written.
 */
function prepareReplacement(paths: ProjectPaths, staged: StagedFlow, replace: boolean): PreparedReplacement {
  const dir = paths.flowDir(staged.name);
  if (!replace || !isDir(dir)) return { staged, kept: [] };
  const kept = handWrittenFiles(paths, staged.name, staged.dir);
  for (const rel of kept) copyFile(path.join(dir, ...rel.split('/')), path.join(staged.dir, ...rel.split('/')));
  return { staged, kept, currentMoved: planCurrentStepMove(paths, staged.name, staged.def) };
}

/** Moves a prepared flow into place, then moves the developer's position as planned. */
function commitReplacement(paths: ProjectPaths, prepared: PreparedReplacement, replace: boolean): ImportedFlow {
  const { staged, kept, currentMoved: planned } = prepared;
  const model = commitStagedFlow(paths, staged, replace);
  const currentMoved = planned && moveCurrentInRuntime(paths, staged.name, planned.from, planned.to) ? planned : undefined;
  return Object.assign(model, { kept, currentMoved });
}

/**
 * The `.md` files under `steps/` of `.df/<name>` that dfl did not render (flow-relative, sorted):
 * neither listed in the install manifest's `rendered` nor next to a `<file>.hbs` template in the old
 * flow dir or in `incomingDir` (the next sync renders those again). Imports never copy `.md` files
 * under steps/, and `.df/.gitignore` ignores them, so a replacement must carry these over or they
 * are lost for good.
 */
function handWrittenFiles(paths: ProjectPaths, name: string, incomingDir: string): string[] {
  const dir = paths.flowDir(name);
  const rendered = readRenderedOutputs(paths);
  const hasTemplate = (base: string, rel: string): boolean => isFile(path.join(base, ...`${rel}.hbs`.split('/')));
  return walkFiles(dir).filter((rel) => {
    if (!rel.startsWith('steps/') || !rel.endsWith('.md')) return false;
    if (rendered.has(relPosix(paths.root, path.join(dir, ...rel.split('/'))))) return false;
    return !hasTemplate(dir, rel) && !hasTemplate(incomingDir, rel);
  });
}

/**
 * Where the developer's position in flow `name` goes when its definition is replaced by `next`:
 * undefined while the stored current step still exists in `next` (or nothing is stored). Otherwise,
 * like `removeStep`: the first step on the old step's `NEXT` path that survives as a (non-final) step,
 * else the nearest earlier surviving step in the old flow order, else the new initial step.
 */
function planCurrentStepMove(paths: ProjectPaths, name: string, next: FlowDefinition): CurrentStepMove | undefined {
  const current = storedCurrentStep(paths, name);
  const states = next.machine.states;
  if (current === undefined || Object.hasOwn(states, current)) return undefined;
  const survives = (id: string | undefined): id is string => id !== undefined && Object.hasOwn(states, id) && states[id]!.type !== 'final';
  let old: FlowDefinition | undefined;
  try {
    old = readFlowDefinition(paths, name);
  } catch {
    old = undefined; // an unreadable old flow: only the new initial step is left
  }
  let to: string | undefined;
  if (old && Object.hasOwn(old.machine.states, current)) {
    const oldStates = old.machine.states;
    const seen = new Set<string>();
    let id: string | undefined = current;
    while (id !== undefined && !seen.has(id) && !survives(id) && Object.hasOwn(oldStates, id)) {
      seen.add(id);
      id = transitionTarget(oldStates[id]!.on?.[NEXT_EVENT]);
    }
    if (survives(id)) to = id;
    else {
      const order = orderStates(old.machine);
      to = order.slice(0, order.indexOf(current)).reverse().find(survives);
    }
  }
  to ??= Object.hasOwn(states, next.machine.initial) ? next.machine.initial : undefined;
  return to === undefined ? undefined : { from: current, to };
}

/** Target state of a transition value (string or `{ target }`). */
function transitionTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const target = (value as { target?: unknown }).target;
    return typeof target === 'string' ? target : undefined;
  }
  return undefined;
}

/** The files of a flow dir that an import copies (rendered `.md` under steps/ excluded) → content. */
function flowFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const rel of walkFiles(dir)) {
    const parts = rel.split('/');
    if (parts.some((part) => part === '.git' || part === 'node_modules')) continue;
    if (parts[0] === 'steps' && rel.endsWith('.md')) continue;
    out.set(rel, readFileSync(path.join(dir, ...parts)));
  }
  return out;
}

/** A local source root as recorded in flow.json: posix, relative to the project root. */
function localRef(paths: ProjectPaths, dir: string): string {
  const rel = path.relative(realpathOr(paths.root), realpathOr(dir));
  if (path.isAbsolute(rel)) return toPosix(rel); // another drive (Windows): nothing relative exists
  return toPosix(rel) || '.';
}

function realpathOr(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `child` equals `parent` or lies inside it. */
function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** File path for error messages: `<url>//<path in repo>` for git sources, the real path otherwise. */
function displayPath(file: string, baseDir: string, source: ParsedFlowSource): string {
  if (source.kind === 'local') return file;
  return `${source.url}//${path.relative(baseDir, file).split(path.sep).join('/')}`;
}
