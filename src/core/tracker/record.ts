/**
 * The dfl record of a task: the issue entity property `<jira.property>` (default `dfl.run`), the
 * source of truth of a tracked flow's position (the ticket's status is only a projection of it).
 *
 * ```json
 * { "schema": 1, "issueId": "10231", "key": "ABC-123", "flow": "feature", "step": "implement-feature",
 *   "params": { "branch": "feature/ABC-123-csv-export", "slug": "csv-export" },
 *   "history": [{ "from": "", "to": "spec-feature", "event": "START", "at": "…", "op": "7f3a9c1e" }],
 *   "updatedAt": "…", "dfl": "0.1.0" }
 * ```
 *
 * Validated on read (a newer `schema` → `TASK_SCHEMA_NEWER`, anything invalid → a `TASK_RECORD_INVALID`
 * the caller decides about); a record whose `issueId` is not the issue's (copied onto a cloned issue)
 * counts as not started. Writes replace the whole record, at most 32000 bytes, history capped at 50.
 * The record holds no accounts or emails: anyone who can browse the issue can read it.
 *
 * Anyone who can edit the issue can also rewrite the record through the REST API, so it is as
 * untrusted as the ticket text: the read checks the shapes dfl itself writes (a flow name, step ids,
 * event names, ISO timestamps, single-line params, a branch name of a shell-safe charset, a slug
 * that is one file-name segment, plain relative path params), so record values that reach results
 * and messages are ids, not prose.
 * {@link mergeParams} applies the same param rules on write, so a dfl-written record always reads.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DflError } from '../errors.js';
import { isValidFlowName, isValidId } from '../ids.js';
import { packageVersion } from '../paths.js';
import type { HistoryEntry } from '../types.js';
import { PARAM_NAME_RE } from './config.js';

export const RECORD_SCHEMA = 1;
/** History entries kept in the record (oldest dropped on write). */
export const RECORD_HISTORY_LIMIT = 50;
/** Jira's limit for an entity property value is 32 KB; stay below it. */
export const RECORD_MAX_BYTES = 32_000;
export const MAX_PARAMS = 30;
export const MAX_PARAM_NAME_LENGTH = 64;
export const MAX_PARAM_VALUE_LENGTH = 1000;
/** Event of the first history entry (`start_task`). */
export const START_EVENT = 'START';

/** Param names that look like secrets are refused (the record is readable by everyone with Browse). */
const SECRET_PARAM_RE = /token|secret|password|apikey|api_key|credential/i;
/** Params that hold a project-relative path (`specPath`, `outputDir`). */
const PATH_PARAM_RE = /(?:Path|Dir)$|^(?:path|dir)$/;
/** C0 and C1 control characters (line breaks included): never in a param, event or timestamp. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
/**
 * `params.branch`: a branch name of a shell-safe charset (letters, digits, `.`, `_`, `/`, `+`, `-`;
 * no leading `-`, no `..`, `//` or trailing `/`). Stricter than git (`x;curl$(id)` is a valid ref
 * name), because agents are told to run `git switch <branch>`.
 */
export const BRANCH_PARAM_RE = /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._/+-]{1,255}$/;
/**
 * `params.slug`: one file-name segment of letters, digits, `.`, `_` and `-` (steps build paths
 * such as `docs/specs/<slug>.md` and commit messages from it), no `..`.
 */
const SLUG_PARAM_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** A history event: no whitespace or control characters. */
const EVENT_RE = /^[^\s\u0000-\u001f\u007f-\u009f]{1,200}$/;
/** A timestamp as dfl writes it (`Date#toISOString`). */
const TIMESTAMP_RE = /^[0-9TZ:.+-]{1,64}$/;

export interface RecordHistoryEntry extends HistoryEntry {
  /** Id of the dfl process that wrote the entry ({@link processOpId}); makes retries idempotent. */
  op: string;
}

export interface TaskRecord {
  schema: 1;
  /** Jira's numeric issue id (a cloned issue copies the property, but gets another id). */
  issueId: string;
  key: string;
  flow: string;
  step: string;
  params: Record<string, string>;
  history: RecordHistoryEntry[];
  updatedAt: string;
  /** dfl version that wrote the record. */
  dfl: string;
  /** Keys written by newer dfl versions are kept on rewrite. */
  [key: string]: unknown;
}

/** What an issue's record property amounts to. */
export type RecordRead =
  | { kind: 'missing' }
  /** Copied from another issue (issueId mismatch): treated as not started. */
  | { kind: 'foreign'; warning: string }
  /** Unusable (`error` is DflError TASK_RECORD_INVALID): only an explicit goto may overwrite it. */
  | { kind: 'invalid'; error: DflError }
  | { kind: 'ok'; record: TaskRecord };

const historyEntrySchema = z.looseObject({
  from: z.string().max(64),
  to: z.string().min(1).max(64),
  event: z.string().min(1).max(200),
  at: z.string().min(1).max(64),
  op: z.string().max(64).optional(),
});

const recordSchema = z.looseObject({
  schema: z.literal(RECORD_SCHEMA),
  issueId: z.string().min(1).max(32),
  key: z.string().min(1).max(32),
  flow: z.string().min(1).max(64),
  step: z.string().min(1).max(64),
  params: z
    .record(z.string().max(MAX_PARAM_NAME_LENGTH).regex(PARAM_NAME_RE), z.string().max(MAX_PARAM_VALUE_LENGTH))
    .refine((params) => Object.keys(params).length <= MAX_PARAMS, `at most ${MAX_PARAMS} params`)
    .optional(),
  history: z.array(historyEntrySchema).optional(),
  updatedAt: z.string().max(64).optional(),
  dfl: z.string().max(64).optional(),
});

let opId: string | undefined;

/** A random 8-hex id of this process, the same for every write it makes. */
export function processOpId(): string {
  opId ??= randomBytes(4).toString('hex');
  return opId;
}

/**
 * Interprets the record property `value` of `issue` (undefined/null when the property is not set).
 * Throws DflError `TASK_SCHEMA_NEWER` when a newer dfl wrote it (it must not be overwritten).
 */
export function readRecord(value: unknown, issue: { id: string; key: string }): RecordRead {
  if (value === undefined || value === null) return { kind: 'missing' };
  if (isPlainObject(value)) {
    const issueId = value['issueId'];
    if (typeof issueId === 'string' && issueId !== issue.id) {
      // The id is shown only when it is one (record values are untrusted text).
      const from = /^\d{1,32}$/.test(issueId) ? ` (id ${issueId})` : '';
      return {
        kind: 'foreign',
        warning: `${issue.key} carries a dfl record copied from another issue${from}; dfl treats ${issue.key} as not started.`,
      };
    }
    const schema = value['schema'];
    if (typeof schema === 'number' && schema > RECORD_SCHEMA) {
      throw new DflError(`The dfl record of ${issue.key} was written by a newer dfl (record schema ${schema}).`, {
        hint: 'Upgrade dfl (pin the newer @vishin-pavel/dfl in devDependencies) and run the command again.',
        code: 'TASK_SCHEMA_NEWER',
      });
    }
  }
  const result = recordSchema.safeParse(value);
  if (!result.success) {
    return invalidRecord(
      issue.key,
      result.error.issues.map((issue) => `${pathLabel(issue.path)}: ${issue.message}`),
    );
  }
  const data = result.data;
  const problems = recordProblems(data);
  if (problems.length > 0) return invalidRecord(issue.key, problems);
  return {
    kind: 'ok',
    record: {
      ...data,
      schema: RECORD_SCHEMA,
      issueId: data.issueId,
      key: data.key,
      flow: data.flow,
      step: data.step,
      params: { ...(data.params ?? {}) },
      history: (data.history ?? []).map((entry) => ({ ...entry, op: entry.op ?? '' })),
      updatedAt: data.updatedAt ?? '',
      dfl: data.dfl ?? '',
    },
  };
}

/** A history entry stamped with this process's op id. */
export function recordHistoryEntry(entry: HistoryEntry): RecordHistoryEntry {
  return { from: entry.from, to: entry.to, event: entry.event, at: entry.at, op: processOpId() };
}

/**
 * The record to write: `previous` (its unknown keys are kept) with the given position, params and
 * history (oldest entries beyond {@link RECORD_HISTORY_LIMIT} dropped, and more of them while the
 * record exceeds {@link RECORD_MAX_BYTES}), `updatedAt` now and this dfl's version. Throws DflError
 * `TASK_RECORD_TOO_LARGE` when even that does not make it fit (the params are too large).
 */
export function buildRecord(input: {
  previous?: TaskRecord | undefined;
  issueId: string;
  key: string;
  flow: string;
  step: string;
  params: Record<string, string>;
  history: RecordHistoryEntry[];
  now?: Date | undefined;
  dflVersion?: string | undefined;
}): TaskRecord {
  const record: TaskRecord = {
    ...(input.previous ?? {}),
    schema: RECORD_SCHEMA,
    issueId: input.issueId,
    key: input.key,
    flow: input.flow,
    step: input.step,
    params: { ...input.params },
    history: input.history.slice(-RECORD_HISTORY_LIMIT),
    updatedAt: (input.now ?? new Date()).toISOString(),
    dfl: input.dflVersion ?? currentDflVersion(),
  };
  // History is informational: drop the oldest entries (keeping the newest) before giving up.
  let size = Buffer.byteLength(JSON.stringify(record), 'utf8');
  while (size > RECORD_MAX_BYTES && record.history.length > 1) {
    record.history = record.history.slice(Math.max(1, Math.ceil(record.history.length / 4)));
    size = Buffer.byteLength(JSON.stringify(record), 'utf8');
  }
  if (size > RECORD_MAX_BYTES) {
    throw new DflError(`The dfl record of ${input.key} would be ${size} bytes; Jira stores at most ${RECORD_MAX_BYTES}.`, {
      hint: 'Remove params later steps no longer need (pass them with the value null).',
      code: 'TASK_RECORD_TOO_LARGE',
    });
  }
  return record;
}

/** The stored position of a record, in the shape `runtimeFromStored` takes (history without op ids). */
export function storedPosition(record: TaskRecord): { current: string; history: HistoryEntry[]; updatedAt: string } {
  return {
    current: record.step,
    history: record.history.map(({ from, to, event, at }) => ({ from, to, event, at })),
    updatedAt: record.updatedAt || new Date().toISOString(),
  };
}

/**
 * `current` params with `updates` applied: `null` deletes, numbers and booleans are stringified.
 * Returns the new params and the names whose value changed. Throws DflError `TASK_PARAM_INVALID`
 * for an invalid or secret-looking name, a value that is not a string/number/boolean/null, is
 * longer than 1000 characters or contains control characters (line breaks included), a path param
 * (`…Path`, `…Dir`) that is not a plain relative path ({@link isPlainRelativePath}), a `branch`
 * outside {@link BRANCH_PARAM_RE}, a `slug` that is not one file-name segment, or more than 30
 * params in total.
 */
export function mergeParams(
  current: Record<string, string>,
  updates: Record<string, unknown> | undefined,
): { params: Record<string, string>; changed: string[] } {
  const params = { ...current };
  const changed: string[] = [];
  for (const [name, raw] of Object.entries(updates ?? {})) {
    assertValidParamName(name);
    if (raw === null || raw === undefined) {
      if (Object.hasOwn(params, name)) {
        delete params[name];
        changed.push(name);
      }
      continue;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      throw paramError(`Param "${name}" must be a string (or null to delete it).`);
    }
    const value = String(raw);
    if (value.length > MAX_PARAM_VALUE_LENGTH) {
      throw paramError(`Param "${name}" is ${value.length} characters long; the limit is ${MAX_PARAM_VALUE_LENGTH}.`);
    }
    if (CONTROL_RE.test(value)) {
      throw paramError(`Param "${name}" contains control characters such as a line break; a task param is a single line.`);
    }
    if (PATH_PARAM_RE.test(name) && !isPlainRelativePath(value)) {
      throw paramError(
        `Param "${name}" must be a path relative to the project root, without "..", "~" or ".git" (got ${JSON.stringify(truncate(value, 80))}).`,
      );
    }
    if (name === 'branch' && !BRANCH_PARAM_RE.test(value)) {
      throw paramError(
        `Param "branch" must be a git branch name of letters, digits, ".", "_", "/", "+" and "-" (got ${JSON.stringify(truncate(value, 80))}).`,
        'dfl records only branch names that are safe to pass to git in a shell.',
      );
    }
    if (name === 'slug' && !SLUG_PARAM_RE.test(value)) {
      throw paramError(
        `Param "slug" must be a short name of letters, digits, ".", "_" and "-" such as "csv-export" (got ${JSON.stringify(truncate(value, 80))}).`,
      );
    }
    if (params[name] !== value || !Object.hasOwn(params, name)) {
      params[name] = value;
      changed.push(name);
    }
  }
  if (Object.keys(params).length > MAX_PARAMS) {
    throw paramError(`A task can hold at most ${MAX_PARAMS} params.`, 'Delete params later steps no longer need (pass them with the value null).');
  }
  return { params, changed };
}

/** Throws DflError `TASK_PARAM_INVALID` unless `name` is a valid, non-secret param name. */
export function assertValidParamName(name: string): void {
  if (typeof name !== 'string' || name.length > MAX_PARAM_NAME_LENGTH || !PARAM_NAME_RE.test(name)) {
    throw paramError(
      `Invalid param name "${truncate(String(name), 80)}".`,
      `Use letters, digits and "_", starting with a letter (max ${MAX_PARAM_NAME_LENGTH}), e.g. "specPath".`,
    );
  }
  if (SECRET_PARAM_RE.test(name)) {
    throw paramError(
      `Param "${name}" looks like a secret; dfl does not store secrets in tickets.`,
      'Task params are readable by everyone who can see the ticket: keep secrets out of them.',
    );
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function currentDflVersion(): string {
  try {
    return packageVersion();
  } catch {
    return '';
  }
}

/**
 * A path inside the project: relative (no leading `/` or `\`, no drive letter, no leading `~`), no
 * `..` segment, no `.git` segment (any case: git's own files), no control characters.
 */
export function isPlainRelativePath(value: string): boolean {
  if (typeof value !== 'string' || value === '' || CONTROL_RE.test(value)) return false;
  if (/^[/\\~]/.test(value) || /^[A-Za-z]:/.test(value)) return false;
  return value.split(/[/\\]/).every((part) => part !== '..' && part.toLowerCase() !== '.git');
}

/** The checks beyond the schema (see the module comment); each problem names its field, never its value. */
function recordProblems(data: z.infer<typeof recordSchema>): string[] {
  const problems: string[] = [];
  if (!isValidFlowName(data.flow)) problems.push('flow: not a flow name');
  if (!isValidId(data.step)) problems.push('step: not a step id');
  for (const [name, value] of Object.entries(data.params ?? {})) {
    if (CONTROL_RE.test(value)) problems.push(`params.${name}: contains control characters`);
    else if (PATH_PARAM_RE.test(name) && !isPlainRelativePath(value)) problems.push(`params.${name}: not a plain relative path`);
    else if (name === 'branch' && !BRANCH_PARAM_RE.test(value)) problems.push('params.branch: not a branch name dfl records');
    else if (name === 'slug' && !SLUG_PARAM_RE.test(value)) problems.push('params.slug: not a slug');
  }
  (data.history ?? []).forEach((entry, i) => {
    if (entry.from !== '' && !isValidId(entry.from)) problems.push(`history.${i}.from: not a step id`);
    if (!isValidId(entry.to)) problems.push(`history.${i}.to: not a step id`);
    if (!EVENT_RE.test(entry.event)) problems.push(`history.${i}.event: not an event name`);
    if (!TIMESTAMP_RE.test(entry.at)) problems.push(`history.${i}.at: not a timestamp`);
    if (entry.op !== undefined && CONTROL_RE.test(entry.op)) problems.push(`history.${i}.op: contains control characters`);
  });
  if (data.updatedAt !== undefined && data.updatedAt !== '' && !TIMESTAMP_RE.test(data.updatedAt)) problems.push('updatedAt: not a timestamp');
  return problems;
}

/** `TASK_RECORD_INVALID` naming the first problems (field paths only: the record is untrusted text). */
function invalidRecord(key: string, problems: readonly string[]): RecordRead {
  const details = problems.slice(0, 3).join('; ');
  return {
    kind: 'invalid',
    error: new DflError(`The dfl record of ${key} is invalid (${details}).`, {
      hint: `Repair it by moving the task to the right step: \`dfl goto <step> --task ${key}\`.`,
      code: 'TASK_RECORD_INVALID',
    }),
  };
}

/** A zod issue path for a message: plain names and indexes as they are, anything else JSON-quoted. */
function pathLabel(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path
    .map((part) => (typeof part === 'number' || (typeof part === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(part)) ? String(part) : JSON.stringify(truncate(String(part), 40))))
    .join('.');
}

function paramError(message: string, hint?: string): DflError {
  return new DflError(message, { ...(hint !== undefined ? { hint } : {}), code: 'TASK_PARAM_INVALID' });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
