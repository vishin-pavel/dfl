/**
 * Import flows distributed over git (OWNER: sync agent).
 * Sources: `https://…`/`git@…`/`ssh://…` URLs (optionally `#ref`), `github:owner/repo[/sub/path][#ref]`,
 * a local directory path, or a file written by `dfl flow export`. Git sources are shallow-cloned
 * (`git clone --depth 1 [--branch ref]`, or a fetch of the commit for `#<sha>`) into a temp dir; the
 * imported commit is recorded as `source.commit`. `pullFlow` re-imports a flow from the source
 * recorded in its flow.json.
 *
 * Replacing a flow is always two steps: `prepareImport`/`preparePull` stage the incoming version
 * (nothing in the project changes) and say what would change; `apply` then replaces exactly that,
 * under the project lock, after saving a backup. `apply` refuses when the flow changed after the
 * preview, and a pull refuses to discard changes made in the project unless asked to.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupFlow, extractBundle, readBundle } from './bundle.js';
import { DflError } from './errors.js';
import {
  NEXT_EVENT,
  type StagedFlow,
  buildFlowModel,
  commitStagedFlow,
  discardStagedFlow,
  flowContentFiles,
  flowDigests,
  flowExists,
  getFlowTemplate,
  listFlowTemplates,
  listFlows,
  loadFlow,
  orderStates,
  parseFlowDefinition,
  readFlowDefinition,
  recordedDigests,
  stageFlowCopy,
} from './flow.js';
import { copyFile, exists, isDir, isFile, listDirs, readJson, relPosix, toPosix, walkFiles } from './fsx.js';
import { runGit } from './git.js';
import { assertValidFlowName } from './ids.js';
import { moveCurrentInRuntime, storedCurrentStep } from './machine.js';
import { readRenderedOutputs } from './render.js';
import type { FlowDefinition, FlowModel, FlowSource, ProjectPaths } from './types.js';

export interface ParsedFlowSource {
  kind: 'git' | 'local' | 'bundle';
  /** Clone URL, absolute local directory, or absolute path of an export file (`bundle`). */
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
 * - anything else is a local path (resolved against `cwd`; DflError when missing): a directory, a
 *   flow's `flow.json` (its directory), or any other file, read as a `dfl flow export` file.
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
  if (isFile(abs)) return path.basename(abs) === 'flow.json' ? { kind: 'local', url: path.dirname(abs) } : { kind: 'bundle', url: abs };
  if (!isDir(abs)) {
    throw new DflError(`Flow source "${trimmed}" is neither a directory nor a file.`, { hint: importHint(), code: 'INVALID_SOURCE' });
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

/**
 * What replacing a flow does to a file, judged against the version recorded when the flow was
 * created, imported or last pulled (`source.files`):
 * - `none` – the file was not changed in this project: the change comes from the new version;
 * - `reverted` – changed here, the same as before in the new version: the replacement undoes the change;
 * - `conflict` – changed here and in the new version: the replacement drops the change made here;
 * - `added-here` – the file was added here: the replacement deletes it;
 * - `deleted-here` – the file was deleted here: the replacement brings it back;
 * - `unknown` – the flow records no version (created by an older dfl), so dfl cannot tell.
 */
export type LocalChange = 'none' | 'reverted' | 'conflict' | 'added-here' | 'deleted-here' | 'unknown';

/** One file that replacing a flow adds, removes or changes. */
export interface FileChange {
  /** Flow-relative posix path. */
  path: string;
  change: 'added' | 'removed' | 'changed';
  local: LocalChange;
}

/** How a flow in `.df/` differs from the version that would replace it. */
export interface FlowDiff {
  /**
   * Changed files, sorted by path. Rendered output, the hand-written `kept` files, OS junk and line
   * ends are ignored; flow.json counts as changed when the definition (without `source`) changes.
   */
  changes: FileChange[];
  /** The recorded `source` changes (another rev or commit, its digests, or another origin). */
  sourceChanged: boolean;
  /** The flow records the version it came from, so `local` is known; without it every change is `unknown`. */
  baseline: boolean;
}

/** True when replacing the flow would change anything at all (files or the recorded source). */
export function hasChanges(diff: FlowDiff): boolean {
  return diff.changes.length > 0 || diff.sourceChanged;
}

/** The changes that discard (or, `unknown`, may discard) work done in this project. */
export function localLosses(diff: FlowDiff): FileChange[] {
  return diff.changes.filter((change) => change.local !== 'none');
}

/** A flow an import would create or replace (see {@link prepareImport}). */
export interface ImportPreview extends FlowReplacement {
  /** Target flow name in this project. */
  name: string;
  /** The incoming flow, as it would be in `.df/<name>`. */
  model: FlowModel;
  /** Set when `.df/<name>` exists and would be replaced (`force`): what changes. */
  diff?: FlowDiff | undefined;
}

/** An imported flow; `kept`/`currentMoved` are only non-empty when `force` replaced an existing flow. */
export type ImportedFlow = FlowModel &
  FlowReplacement & {
    /** An existing flow was replaced. */
    replaced: boolean;
    /** `force` found the existing flow identical to the incoming one and left it alone. */
    unchanged: boolean;
    /** Project-relative backup of the replaced flow (`.df/.dfl-backups/…`). */
    backup?: string | undefined;
  };

export interface PreparedImport {
  flows: ImportPreview[];
  /**
   * Creates and replaces the flows (call it under the project lock). Saves a backup of every flow it
   * replaces first. Throws PLAN_CHANGED, writing nothing, when a target flow was created, changed or
   * deleted since {@link prepareImport}.
   */
  apply(): ImportedFlow[];
  /** Removes the staged copies (always call it, also after `apply`). */
  discard(): void;
}

/**
 * Imports flow(s) into `.df/`. Returns the imported models. A directory or git source is recorded in
 * flow.json `source` with the digests of the imported files; `source.path` is the imported flow's
 * directory relative to the repository / source root, and for a local source `source.ref` is that
 * root relative to the project root (posix). An export file keeps the `source` each flow was exported
 * with. Every target name is validated and every flow is staged before any existing flow is replaced;
 * `force` then swaps each flow directory atomically (after a backup), keeping active-flow settings,
 * runtime state (keyed by name) and hand-written `.md` files under steps/; a current step the new
 * version lacks moves like in {@link pullFlow}.
 */
export async function importFlows(paths: ProjectPaths, input: string, options: ImportOptions = {}): Promise<ImportedFlow[]> {
  const prepared = await prepareImport(paths, input, options);
  try {
    return prepared.apply();
  } finally {
    prepared.discard();
  }
}

/**
 * The first half of {@link importFlows}: fetches the source and stages every selected flow in
 * `.df/.dfl-stage-*` (FLOW_EXISTS for an existing flow without `force`), changing nothing in the
 * project. Needs no lock; `apply` does.
 */
export async function prepareImport(paths: ProjectPaths, input: string, options: ImportOptions = {}): Promise<PreparedImport> {
  if (options.name !== undefined) assertValidFlowName(options.name);
  const source = parseFlowSource(input);
  if (source.kind === 'local') return stageImport(paths, source.url, source, input, options, undefined);
  if (source.kind === 'bundle') return withBundle(source.url, (dir) => stageImport(paths, dir, source, input, options, undefined));
  return withCheckout(source.url, source.ref, (checkout, commit) => stageImport(paths, checkout, source, input, options, commit));
}

export interface PullOptions {
  /** Git sources only: branch, tag or commit to pull instead of the recorded `rev`. */
  rev?: string | undefined;
  /** Only compute what would change; nothing is written. */
  dryRun?: boolean | undefined;
  /**
   * Replace files changed in this project too (`localLosses`). Without it a pull that would discard
   * such changes throws LOCAL_CHANGES and writes nothing.
   */
  discardLocal?: boolean | undefined;
}

/** What a pull would change (see {@link preparePull}). */
export interface PullPreview extends FlowReplacement, FlowDiff {
  /** The flow as it is now. */
  model: FlowModel;
  /** The source recorded in flow.json after the pull. */
  source: RecordedFlowSource;
  /** Flow-relative posix paths of `changes`, by kind. */
  added: string[];
  removed: string[];
  changed: string[];
}

export interface PullResult extends PullPreview {
  /** The flow after the pull (with `dryRun`, or when nothing changed: as it is now). */
  model: FlowModel;
  /**
   * With `dryRun`, `kept` and `currentMoved` say what the pull would keep and where the position
   * would move. Both are empty when nothing changes (the flow's files are then left alone).
   */
  dryRun: boolean;
  /** Project-relative backup of the flow before the pull (`.df/.dfl-backups/…`), when it was replaced. */
  backup?: string | undefined;
}

export interface PreparedPull extends PullPreview {
  /**
   * Replaces the flow with the staged version (call it under the project lock), after saving a
   * backup; does nothing when there are no changes. Throws, writing nothing, PLAN_CHANGED when the
   * flow changed since {@link preparePull}, and LOCAL_CHANGES when the pull would discard changes made
   * in this project and `discardLocal` is not set.
   */
  apply(options?: { discardLocal?: boolean | undefined }): PullResult;
  /** Removes the staged copy (always call it, also after `apply`). */
  discard(): void;
}

/**
 * Re-imports `.df/<name>` from the source recorded in its flow.json: a prebuilt template (from the
 * running dfl package), a git repository (`ref` URL at `rev`, or `options.rev`) or a local
 * directory. The flow's files are replaced atomically, after a backup; runtime state, active-flow
 * settings and hand-written `.md` files under steps/ (`kept`) are kept. Changes made to the flow in
 * this project are only discarded with `discardLocal` (LOCAL_CHANGES otherwise). When the
 * developer's current step is not in the new version, the position moves to a surviving step
 * (`currentMoved`, see {@link planCurrentStepMove}). Nothing is written when nothing changes.
 * Throws NO_SOURCE for flows created in the project (`source.type: 'created'`) or without a
 * recorded source.
 */
export async function pullFlow(paths: ProjectPaths, name: string, options: PullOptions = {}): Promise<PullResult> {
  const prepared = await preparePull(paths, name, options);
  try {
    if (options.dryRun) return { ...previewOf(prepared), dryRun: true };
    return prepared.apply({ discardLocal: options.discardLocal });
  } finally {
    prepared.discard();
  }
}

/**
 * The first half of {@link pullFlow}: fetches the recorded source, stages the new version in
 * `.df/.dfl-stage-*` and computes what would change, without changing anything in the project.
 * Needs no lock; `apply` does.
 */
export async function preparePull(paths: ProjectPaths, name: string, options: Pick<PullOptions, 'rev'> = {}): Promise<PreparedPull> {
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
    return stagePull(paths, name, template.dir, { type: 'template', ref: template.name });
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
    return stagePull(paths, name, dir, next);
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
    return stagePull(paths, name, dir, next);
  });
}

/** A prebuilt-template flow whose template changed since the flow was created or last pulled. */
export interface TemplateUpdate {
  flow: string;
  template: string;
}

/**
 * Flows created from a prebuilt template whose template in the running dfl package differs from the
 * version recorded in their `source.files` (for example after upgrading dfl). Read-only: only
 * `dfl flow pull` applies an update. Flows without recorded digests, unreadable flows and flows
 * whose template no longer exists are skipped.
 */
export function templateUpdates(paths: ProjectPaths): TemplateUpdate[] {
  const templates = new Map(listFlowTemplates().map((template) => [template.name, template]));
  const out: TemplateUpdate[] = [];
  for (const flow of listFlows(paths)) {
    let def: FlowDefinition;
    try {
      def = readFlowDefinition(paths, flow);
    } catch {
      continue;
    }
    const recorded = recordedDigests(def);
    const template = def.source?.type === 'template' && def.source.ref ? templates.get(def.source.ref) : undefined;
    if (!recorded || !template) continue;
    const file = path.join(template.dir, 'flow.json');
    const current = flowDigests(template.dir, parseFlowDefinition(readJson(file), file));
    if (stableJson(current) !== stableJson(recorded)) out.push({ flow, template: template.name });
  }
  return out;
}

/** The hand-written `.md` files under steps/ of `.df/<name>` (see {@link handWrittenFiles}): never imported or exported. */
export function handWrittenFlowFiles(paths: ProjectPaths, name: string): string[] {
  return handWrittenFiles(paths, name, undefined);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function importHint(): string {
  return (
    'Use a git URL (https://…, git@host:owner/repo.git, optionally //sub/path and #ref), github:owner/repo[/path][#ref], ' +
    'a local directory or a file written by `dfl flow export`.'
  );
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

/** Checks an export file, writes its flows to a temp dir (`<tmp>/<name>/`), runs `fn(tmp)` and cleans up. */
async function withBundle<T>(file: string, fn: (dir: string) => T): Promise<T> {
  const bundle = readBundle(file);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dfl-export-'));
  try {
    extractBundle(bundle, tmp);
    return fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Shallow-clones `url` at `ref` into `dest`; returns the checked-out commit. */
async function cloneRepo(url: string, ref: string | undefined, dest: string): Promise<string> {
  try {
    await runGit(['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, dest]);
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
    return (await runGit(['rev-parse', 'HEAD'], { cwd: dest })).trim();
  } catch (error) {
    throw cloneError(url, ref, error);
  }
}

/** Checks out a commit SHA: a shallow fetch of the commit, else a full fetch (abbreviated SHAs). */
async function checkoutCommit(url: string, sha: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  await runGit(['init', '-q'], { cwd: dest });
  await runGit(['remote', 'add', 'origin', '--', url], { cwd: dest });
  try {
    await runGit(['fetch', '-q', '--depth', '1', 'origin', sha], { cwd: dest });
    await runGit(['checkout', '-q', '--detach', 'FETCH_HEAD'], { cwd: dest });
  } catch {
    await runGit(['fetch', '-q', '--tags', 'origin'], { cwd: dest });
    await runGit(['checkout', '-q', '--detach', `${sha}^{commit}`], { cwd: dest });
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

/** A flow staged for an import, with what `.df/<target>` looked like when it was staged. */
interface StagedImport {
  staged: StagedFlow;
  preview: ImportPreview;
  /** {@link projectFlowState} of the target at staging time. */
  before: string;
}

function stageImport(
  paths: ProjectPaths,
  baseDir: string,
  source: ParsedFlowSource,
  input: string,
  options: ImportOptions,
  commit: string | undefined,
): PreparedImport {
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

  // Validate every target before anything is staged or replaced.
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
    const clashes = plan.filter((p) => occupied(paths, p.target)).map((p) => p.target);
    if (clashes.length > 0) {
      throw new DflError(`Flow${clashes.length > 1 ? 's' : ''} ${clashes.map((n) => `"${n}"`).join(', ')} already exist${clashes.length > 1 ? '' : 's'}.`, {
        hint: 'Use --force to replace (you are asked first, and a backup is saved), or --name to import under another name.',
        code: 'FLOW_EXISTS',
      });
    }
  }

  const staged: StagedImport[] = [];
  try {
    for (const p of plan) {
      const rel = toPosix(path.relative(baseDir, p.dir));
      // An export file is a snapshot: each flow keeps the `source` it was exported with.
      const flowSource: RecordedFlowSource | undefined =
        source.kind === 'bundle'
          ? undefined
          : source.kind === 'local'
            ? { type: 'local', ref: localRef(paths, source.url), ...(rel !== '' ? { path: rel } : {}) }
            : {
                type: 'git',
                ref: source.url,
                ...(rel !== '' ? { path: rel } : {}),
                ...(source.ref ? { rev: source.ref } : {}),
                ...(commit ? { commit } : {}),
              };
      const flow = stageFlowCopy(paths, p.dir, p.target, flowSource);
      const replaces = occupied(paths, p.target);
      const diff = replaces ? diffFlow(paths, p.target, flow) : undefined;
      const changing = diff !== undefined && hasChanges(diff);
      staged.push({
        staged: flow,
        before: projectFlowState(paths, p.target),
        preview: {
          name: p.target,
          model: buildFlowModel(flow.def, paths.flowDir(p.target)),
          diff,
          kept: changing ? handWrittenFiles(paths, p.target, flow.dir) : [],
          currentMoved: changing ? planCurrentStepMove(paths, p.target, flow.def) : undefined,
        },
      });
    }
  } catch (error) {
    for (const s of staged) discardStagedFlow(s.staged);
    throw error;
  }

  let applied = false;
  return {
    flows: staged.map((s) => s.preview),
    apply(): ImportedFlow[] {
      if (applied) throw new DflError('This import was already applied.', { code: 'INVALID_STATE' });
      applied = true;
      for (const s of staged) {
        if (projectFlowState(paths, s.preview.name) !== s.before) throw planChanged(s.preview.name);
      }
      // Every replaced flow is backed up, and its hand-written files are carried over, before the first one is replaced.
      const work = staged.map((s) => {
        const replaces = s.preview.diff !== undefined;
        const unchanged = replaces && !hasChanges(s.preview.diff!);
        const backup = replaces && !unchanged ? backupFlow(paths, s.preview.name) : undefined;
        return { s, replaces, unchanged, backup };
      });
      const prepared = work.map((w) => (w.unchanged ? undefined : prepareReplacement(paths, w.s.staged, w.replaces)));
      return work.map((w, i) => {
        if (w.unchanged) return Object.assign(loadFlow(paths, w.s.preview.name), { kept: [], replaced: false, unchanged: true });
        const model = commitReplacement(paths, prepared[i]!, w.replaces);
        return Object.assign(model, { replaced: w.replaces, unchanged: false, backup: w.backup });
      });
    },
    discard(): void {
      for (const s of staged) discardStagedFlow(s.staged);
    },
  };
}

/** Stages the flow at `srcDir` to replace `.df/<name>` and computes the diff (see {@link preparePull}). */
function stagePull(paths: ProjectPaths, name: string, srcDir: string, source: RecordedFlowSource): PreparedPull {
  const before = projectFlowState(paths, name);
  const staged = stageFlowCopy(paths, srcDir, name, source);
  let preview: PullPreview;
  try {
    const diff = diffFlow(paths, name, staged);
    const changing = hasChanges(diff);
    preview = {
      ...diff,
      model: loadFlow(paths, name),
      source: staged.def.source as RecordedFlowSource,
      added: diff.changes.filter((c) => c.change === 'added').map((c) => c.path),
      removed: diff.changes.filter((c) => c.change === 'removed').map((c) => c.path),
      changed: diff.changes.filter((c) => c.change === 'changed').map((c) => c.path),
      kept: changing ? handWrittenFiles(paths, name, staged.dir) : [],
      currentMoved: changing ? planCurrentStepMove(paths, name, staged.def) : undefined,
    };
  } catch (error) {
    discardStagedFlow(staged);
    throw error;
  }
  let applied = false;
  return {
    ...preview,
    apply({ discardLocal = false } = {}): PullResult {
      if (applied) throw new DflError('This pull was already applied.', { code: 'INVALID_STATE' });
      applied = true;
      if (projectFlowState(paths, name) !== before) throw planChanged(name);
      if (!hasChanges(preview)) return { ...previewOf(preview), dryRun: false };
      const losses = localLosses(preview);
      if (losses.length > 0 && !discardLocal) throw localChangesError(name, preview, losses);
      const backup = backupFlow(paths, name);
      const { kept, currentMoved, ...model } = commitReplacement(paths, prepareReplacement(paths, staged, true), true);
      return { ...previewOf(preview), model, kept, currentMoved, backup, dryRun: false };
    },
    discard(): void {
      discardStagedFlow(staged);
    },
  };
}

/** The data part of a prepared pull (without `apply`/`discard`). */
function previewOf(preview: PullPreview): PullPreview {
  const { model, source, changes, sourceChanged, baseline, added, removed, changed, kept, currentMoved } = preview;
  return { model, source, changes, sourceChanged, baseline, added, removed, changed, kept, currentMoved };
}

/** How `.df/<name>` would change if `staged` replaced it (see {@link FlowDiff}, {@link LocalChange}). */
function diffFlow(paths: ProjectPaths, name: string, staged: StagedFlow): FlowDiff {
  const def = tryReadFlowDefinition(paths, name);
  const current = flowDigests(paths.flowDir(name), def);
  const incoming = flowDigests(staged.dir, staged.def);
  const base = recordedDigests(def);
  const changes: FileChange[] = [];
  for (const rel of [...new Set([...Object.keys(current), ...Object.keys(incoming)])].sort()) {
    const now = current[rel];
    const next = incoming[rel];
    if (now === next) continue;
    const change = now === undefined ? 'added' : next === undefined ? 'removed' : 'changed';
    changes.push({ path: rel, change, local: localChange(base, rel, now, next) });
  }
  return { changes, sourceChanged: stableJson(def?.source) !== stableJson(staged.def.source), baseline: base !== undefined };
}

/** {@link LocalChange} of one changed file: `now`/`next` are its digests here and in the new version. */
function localChange(base: Record<string, string> | undefined, rel: string, now: string | undefined, next: string | undefined): LocalChange {
  if (!base) return 'unknown';
  const was = base[rel];
  if (now === was) return 'none';
  if (now === undefined) return 'deleted-here';
  if (was === undefined) return next === undefined ? 'added-here' : 'conflict';
  return next === was ? 'reverted' : 'conflict';
}

/**
 * True when `.df/<name>` holds a flow, or flow files without a flow.json (work that an import must
 * not overwrite unasked); a leftover dir with only rendered output does not count.
 */
function occupied(paths: ProjectPaths, name: string): boolean {
  return flowExists(paths, name) || flowContentFiles(paths.flowDir(name)).length > 0;
}

/** Identifies the content and recorded source of `.df/<name>` (or `absent`), to detect changes between preview and apply. */
function projectFlowState(paths: ProjectPaths, name: string): string {
  if (!isDir(paths.flowDir(name))) return 'absent';
  const def = tryReadFlowDefinition(paths, name);
  const state = stableJson({ files: flowDigests(paths.flowDir(name), def), source: def?.source ?? null });
  return createHash('sha256').update(state).digest('hex');
}

function tryReadFlowDefinition(paths: ProjectPaths, name: string): FlowDefinition | undefined {
  try {
    return readFlowDefinition(paths, name);
  } catch {
    return undefined;
  }
}

function planChanged(name: string): DflError {
  return new DflError(`Flow "${name}" changed while dfl was asking; nothing was changed.`, {
    hint: 'Run the command again to see the current changes.',
    code: 'PLAN_CHANGED',
  });
}

/** LOCAL_CHANGES: the pull would discard work done in this project. */
function localChangesError(name: string, diff: FlowDiff, losses: readonly FileChange[]): DflError {
  const list = losses.map((change) => `  ${change.path} (${localChangeLabel(change)})`).join('\n');
  const message = diff.baseline
    ? `Updating flow "${name}" would discard changes made in this project:\n${list}`
    : `Flow "${name}" has no record of the version it was created from, so dfl cannot tell changes made in this project ` +
      `from changes in its source. Updating it replaces:\n${list}`;
  return new DflError(message, {
    hint: `Review them with \`dfl flow pull ${name} --dry-run\`. To replace them anyway, re-run with --discard-local (a backup of the flow is saved first).`,
    code: 'LOCAL_CHANGES',
  });
}

/** What a change does to work done in this project, for listings (`edited here – your edits are lost`, …). */
export function localChangeLabel(change: FileChange): string {
  switch (change.local) {
    case 'reverted':
      return 'edited here – your edits are lost';
    case 'conflict':
      return change.change === 'removed'
        ? 'edited here, deleted in the new version – your edits are lost'
        : 'edited here and in the new version – your edits are lost';
    case 'added-here':
      return 'added here – it is deleted';
    case 'deleted-here':
      return 'deleted here – it comes back';
    case 'unknown':
      return 'may hold edits made here';
    default:
      return 'from the new version';
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
function commitReplacement(paths: ProjectPaths, prepared: PreparedReplacement, replace: boolean): FlowModel & FlowReplacement {
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
function handWrittenFiles(paths: ProjectPaths, name: string, incomingDir: string | undefined): string[] {
  const dir = paths.flowDir(name);
  const rendered = readRenderedOutputs(paths);
  const hasTemplate = (base: string, rel: string): boolean => isFile(path.join(base, ...`${rel}.hbs`.split('/')));
  return walkFiles(dir).filter((rel) => {
    if (!rel.startsWith('steps/') || !rel.endsWith('.md')) return false;
    if (rendered.has(relPosix(paths.root, path.join(dir, ...rel.split('/'))))) return false;
    return !hasTemplate(dir, rel) && (incomingDir === undefined || !hasTemplate(incomingDir, rel));
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

/** JSON with object keys sorted (stable comparison of records). */
function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
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

/** File path for error messages: `<url>//<path in repo>` for git sources, `<file>: <path>` for exports, the real path otherwise. */
function displayPath(file: string, baseDir: string, source: ParsedFlowSource): string {
  const rel = path.relative(baseDir, file).split(path.sep).join('/');
  if (source.kind === 'local') return file;
  if (source.kind === 'bundle') return `${path.basename(source.url)}: ${rel}`;
  return `${source.url}//${rel}`;
}
