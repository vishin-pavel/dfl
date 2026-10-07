/**
 * Task identity: which ticket a tracked flow works on.
 *
 * 1. An explicit task (`task` argument / `--task`): a full key or a browse URL on the configured
 *    site; a bare number (`123`, `#123`) only where starting a task or reading its status
 *    (`allowBare`), expanded with `jira.defaultProjectKey` – a move needs the full key, so a number
 *    taken from free text cannot move the wrong ticket.
 * 2. Else the uppercase key in the current branch name (restricted to `jira.projectKeys`; this is
 *    also how Jira links branches to tickets).
 * 3. Else no task.
 * An explicit task that contradicts the key of the current branch is refused (`TASK_BRANCH_MISMATCH`).
 */
import { DflError } from '../errors.js';
import { currentBranch, previousBranch } from '../git.js';
import type { ProjectPaths } from '../types.js';
import { DEFAULT_PROTECTED_BRANCHES, TRACKER_FILE_LABEL, type TrackerConfig } from './config.js';

/** A ticket key in any case (`abc-123`); normalized to uppercase. */
const KEY_RE = /^([A-Za-z][A-Za-z0-9_]+)-(\d+)$/;
const BARE_RE = /^#?(\d+)$/;
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const BROWSE_RE = /\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)\/?$/;

export interface ResolvedTask {
  /** Uppercase ticket key. */
  key: string;
  /** Where the key came from. */
  via: 'arg' | 'branch';
  /** The current branch (undefined on a detached HEAD or outside git). */
  branch: string | undefined;
}

/**
 * The ticket key `ref` names (uppercase). Accepts `ABC-123` (any case), a browse URL on the
 * configured site (`<origin>/browse/ABC-123`, or any URL with `selectedIssue=ABC-123`) and – with
 * `allowBare` and a `defaultProjectKey` – `123` / `#123`. Throws DflError `TASK_REF_FOREIGN` for a
 * URL on another site and `TASK_REF_INVALID` for anything else, including a key of a project that
 * is not in `projectKeys`.
 */
export function parseTaskRef(ref: string, cfg: TrackerConfig, options: { allowBare?: boolean | undefined } = {}): string {
  const text = String(ref ?? '').trim();
  const example = `${cfg.jira.defaultProjectKey ?? cfg.jira.projectKeys[0] ?? 'ABC'}-123`;
  if (URL_RE.test(text)) return keyFromUrl(text, cfg, example);

  const key = KEY_RE.exec(text);
  if (key) return configuredKey(key[1]!, key[2]!, cfg);

  const bare = BARE_RE.exec(text);
  if (bare) {
    const number = bare[1]!.replace(/^0+(?=\d)/, '');
    if (!options.allowBare) {
      throw new DflError(`"${text}" is only a ticket number; pass the full ticket key (e.g. ${cfg.jira.defaultProjectKey ?? cfg.jira.projectKeys[0]}-${number}).`, {
        hint: 'Numbers alone are accepted only when starting a task or showing its status.',
        code: 'TASK_REF_INVALID',
      });
    }
    if (!cfg.jira.defaultProjectKey) {
      throw new DflError(`"${text}" is only a ticket number, and no default project is configured.`, {
        hint: `Pass the full key (e.g. ${cfg.jira.projectKeys[0]}-${number}), or set "jira.defaultProjectKey" in ${TRACKER_FILE_LABEL}.`,
        code: 'TASK_REF_INVALID',
      });
    }
    if (/^0+$/.test(number)) throw invalidRef(text, example, true);
    return `${cfg.jira.defaultProjectKey}-${number}`;
  }
  throw invalidRef(text, example, options.allowBare === true && cfg.jira.defaultProjectKey !== undefined);
}

/**
 * The first ticket key of a configured project in `branch` (`feature/ABC-123-x` → `ABC-123`).
 * Uppercase keys only (Jira links only those), not inside a longer word or number.
 */
export function keyFromBranch(branch: string, projectKeys: readonly string[]): string | undefined {
  const keys = projectKeys.filter((key) => /^[A-Z][A-Z0-9_]+$/.test(key)).sort((a, b) => b.length - a.length);
  if (keys.length === 0 || !branch) return undefined;
  const match = new RegExp(`(?<![A-Za-z0-9])(${keys.join('|')})-(\\d+)(?!\\d)`).exec(branch);
  return match ? `${match[1]}-${match[2]}` : undefined;
}

/**
 * The task of the current call: the explicit `task` (see {@link parseTaskRef}) or the key in the
 * current branch of `paths.root`; undefined when there is neither. Throws DflError
 * `TASK_BRANCH_MISMATCH` when `task` names another ticket than the current branch.
 */
export function resolveTask(
  paths: ProjectPaths,
  cfg: TrackerConfig,
  options: { task?: string | undefined; allowBare?: boolean | undefined } = {},
): ResolvedTask | undefined {
  const branch = currentBranch(paths.root);
  const branchKey = branch !== undefined ? keyFromBranch(branch, cfg.jira.projectKeys) : undefined;
  if (options.task !== undefined && options.task.trim() !== '') {
    const key = parseTaskRef(options.task, cfg, { allowBare: options.allowBare });
    if (branchKey !== undefined && branchKey !== key) {
      throw new DflError(`You named ${key}, but the current branch ${branch} belongs to ${branchKey}.`, {
        hint: `Switch to the branch of ${key} first, or leave the task out to work on ${branchKey}.`,
        code: 'TASK_BRANCH_MISMATCH',
      });
    }
    return { key, via: 'arg', branch };
  }
  return branchKey !== undefined ? { key: branchKey, via: 'branch', branch } : undefined;
}

/**
 * On a protected branch (or a detached HEAD): the key of the previously checked-out branch (`@{-1}`),
 * e.g. after `git switch main` at the end of a task. Undefined anywhere else or when there is none.
 * `protectedBranches` defaults to `branch.protected` or the built-in list (pass the resolved
 * list from `resolveBranchSettings` to include the flow's main branch).
 */
export function suggestTask(paths: ProjectPaths, cfg: TrackerConfig, protectedBranches?: readonly string[]): string | undefined {
  const branch = currentBranch(paths.root);
  const protectedList = protectedBranches ?? cfg.branch.protected ?? DEFAULT_PROTECTED_BRANCHES;
  if (branch !== undefined && !protectedList.includes(branch)) return undefined;
  const previous = previousBranch(paths.root);
  return previous !== undefined ? keyFromBranch(previous, cfg.jira.projectKeys) : undefined;
}

/** The ticket's web page: `<origin>/browse/<KEY>`. */
export function browseUrl(cfg: TrackerConfig, key: string): string {
  return `${cfg.jira.origin}/browse/${encodeURIComponent(key)}`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function keyFromUrl(text: string, cfg: TrackerConfig, example: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalidRef(text, example);
  }
  if (url.origin !== cfg.jira.origin) {
    throw new DflError(`${url.origin} is not the Jira site of this project (${cfg.jira.origin}).`, {
      hint: `Pass the ticket key (e.g. ${example}) or a link on ${cfg.jira.origin}; if the project moved, change "jira.baseUrl" in ${TRACKER_FILE_LABEL}.`,
      code: 'TASK_REF_FOREIGN',
    });
  }
  const fromPath = BROWSE_RE.exec(url.pathname)?.[1];
  const fromQuery = url.searchParams.get('selectedIssue') ?? undefined;
  const candidate = fromPath ?? fromQuery;
  const key = candidate !== undefined ? KEY_RE.exec(candidate.trim()) : null;
  if (!key) {
    throw new DflError(`The link ${url.origin}${url.pathname} does not name a ticket.`, {
      hint: `Pass the ticket key (e.g. ${example}) or its browse link (${cfg.jira.origin}/browse/${example}).`,
      code: 'TASK_REF_INVALID',
    });
  }
  return configuredKey(key[1]!, key[2]!, cfg);
}

function configuredKey(projectRaw: string, number: string, cfg: TrackerConfig): string {
  const project = projectRaw.toUpperCase();
  if (!cfg.jira.projectKeys.includes(project)) {
    throw new DflError(`Project ${project} is not configured for this repository (configured: ${cfg.jira.projectKeys.join(', ')}).`, {
      hint: `Pass a ticket of a configured project, or add ${project} to "jira.projectKeys" in ${TRACKER_FILE_LABEL}.`,
      code: 'TASK_REF_INVALID',
    });
  }
  return `${project}-${number}`;
}

/** `bare`: numbers alone (`123`, `#123`) are accepted where this ref is used, so the hint may suggest them. */
function invalidRef(text: string, example: string, bare = false): DflError {
  if (text === '') {
    return new DflError('No ticket given.', {
      hint: bare
        ? `Pass the ticket key (e.g. ${example}). In a shell, # starts a comment: use 123, ${example} or "#123".`
        : `Pass the full ticket key (e.g. ${example}). In a shell, # starts a comment, so a "#123" typed there never arrives.`,
      code: 'TASK_REF_INVALID',
    });
  }
  const shown = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return new DflError(`"${shown}" is not a ticket (expected a key such as ${example}, or a link to the ticket).`, {
    hint: `Use the key as Jira shows it, e.g. ${example}.`,
    code: 'TASK_REF_INVALID',
  });
}
