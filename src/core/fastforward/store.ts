/**
 * `.df/fast-forward.json` (git-ignored): the fast-forward runs of this checkout, one intent record
 * per flow (and ticket): the target, where the current segment started, and an explicit stop.
 * Everything else about a run (its moves, visits, whether it reached its target) is derived from the
 * flow history (run.ts), so moves never write this file: only a start or a stop does, `deleteFlow`
 * drops a flow's runs and `dfl uninstall --purge` removes the file (docs/ARCHITECTURE.md §1.6).
 *
 * Reads are tolerant and never throw (runtime state is disposable); writes run under the caller's
 * project lock and throw on failure.
 */
import { DflError } from '../errors.js';
import { exists, readJson, removePath, writeJson } from '../fsx.js';
import { isValidId } from '../ids.js';
import type { HistoryEntry, ProjectPaths } from '../types.js';

/** One fast-forward run. Keys are written in this order. */
export interface FastForwardRun {
  /** Flow id. */
  flow: string;
  /** Ticket key (Jira `issue.key`) of a tracked run, else null. */
  task: string | null;
  /** The resolved target state id. */
  target: string;
  /** The current step when this segment started. */
  from: string;
  /** The last history entry when this segment started (`{from, to, event, at}` only); null for an empty history. */
  anchor: HistoryEntry | null;
  /** ISO, the first start of the run. */
  startedAt: string;
  /** ISO, the start of the latest segment (a resume). */
  resumedAt?: string | undefined;
  /** Set by an explicit stop; `reason` is one line of at most {@link FAST_FORWARD_NOTE_MAX} characters (data). */
  stopped?: { at: string; reason?: string | undefined } | undefined;
}

export interface FastForwardFile {
  version: 1;
  /** By {@link runKey}. */
  runs: Record<string, FastForwardRun>;
}

/**
 * A state may become current at most this often per run segment (the segment's start counts).
 * Here, not in run.ts, so that run.ts and instructions.ts do not import each other at runtime.
 */
export const FAST_FORWARD_MAX_VISITS = 3;
/** Runs kept in the file; older ones (by `resumedAt ?? startedAt`) are evicted. */
export const FAST_FORWARD_MAX_RUNS = 20;
/** Longest stop reason. */
export const FAST_FORWARD_NOTE_MAX = 300;

const FILE_LABEL = '.df/fast-forward.json';
/** A Jira issue key (the form `issue.key` has). */
const TASK_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** The key of a run: `<flow>`, or `<flow>#<KEY>` for a ticket's run. */
export function runKey(flow: string, task?: string | null): string {
  return task ? `${flow}#${task}` : flow;
}

/** True for a stop reason that can be stored: one line of at most 300 characters without control characters. */
export function isValidStopReason(reason: string): boolean {
  return reason.length <= FAST_FORWARD_NOTE_MAX && !CONTROL_RE.test(reason);
}

/**
 * The run file, normalized: entries that are not valid runs (or are stored under another key than
 * their own) and unknown keys are dropped. A missing file is empty; an unreadable or malformed one
 * is empty with `problem` set. Never throws.
 */
export function readFastForwardFile(paths: ProjectPaths): { file: FastForwardFile; problem?: string | undefined } {
  const empty = (): FastForwardFile => ({ version: 1, runs: {} });
  if (!exists(paths.fastForwardFile)) return { file: empty() };
  let data: unknown;
  try {
    data = readJson(paths.fastForwardFile);
  } catch {
    return { file: empty(), problem: `${FILE_LABEL} could not be parsed and was ignored` };
  }
  const runs = isRecord(data) ? data['runs'] : undefined;
  if (!isRecord(runs)) return { file: empty(), problem: `${FILE_LABEL} has an unexpected shape and was ignored` };
  const file = empty();
  for (const [key, raw] of Object.entries(runs)) {
    const run = parseRun(raw);
    if (run && key === runKey(run.flow, run.task)) file.runs[key] = run;
  }
  return { file };
}

/** The run stored under `key`, or undefined. Only checks that the file exists when it does not (no read). Never throws. */
export function readFastForwardRun(paths: ProjectPaths, key: string): FastForwardRun | undefined {
  if (!exists(paths.fastForwardFile)) return undefined;
  return ownRun(readFastForwardFile(paths).file, key);
}

/**
 * Stores `run` under `key` (null deletes it), keeping at most {@link FAST_FORWARD_MAX_RUNS} runs: the
 * oldest others (by `resumedAt ?? startedAt`) are evicted, never `key`. An empty file is removed.
 * Only under the caller's project lock; write errors throw.
 */
export function saveFastForwardRun(paths: ProjectPaths, key: string, run: FastForwardRun | null): void {
  const { file } = readFastForwardFile(paths);
  if (run) file.runs[key] = normalizedRun(run);
  else delete file.runs[key];
  const others = Object.entries(file.runs)
    .filter(([other]) => other !== key)
    .sort(([, a], [, b]) => compare(a.resumedAt ?? a.startedAt, b.resumedAt ?? b.startedAt));
  for (const [other] of others.slice(0, Math.max(0, Object.keys(file.runs).length - FAST_FORWARD_MAX_RUNS))) delete file.runs[other];
  writeRunFile(paths, file);
}

/**
 * Stops the run of `flow` (and `task`): sets `stopped` on its record (a stopped run stays open
 * until the flow reaches, skips or leaves its target: a bare start resumes it; on a run that has
 * already ended the stop changes nothing). A stop without a reason keeps the reason of an earlier
 * stop. Reads neither the network nor the position (the caller checks a local run, see
 * start.ts stopFastForward). Only under the caller's project lock. Throws DflError `INVALID_OPTIONS`
 * for a reason that is not one line of at most 300 characters, and `FAST_FORWARD_NOT_ACTIVE` when
 * there is no record (saying so when the file could not be read).
 */
export function stopFastForwardRun(
  paths: ProjectPaths,
  flow: string,
  task: string | null,
  options: { reason?: string | undefined; now?: string | undefined } = {},
): FastForwardRun {
  assertStopReason(options.reason);
  const key = runKey(flow, task);
  const { file, problem } = readFastForwardFile(paths);
  const existing = ownRun(file, key);
  if (!existing) {
    if (problem) {
      throw new DflError(`${problem}, so no run can be stopped.`, {
        hint: 'Delete the file, or start a new run.',
        code: 'FAST_FORWARD_NOT_ACTIVE',
      });
    }
    throw new DflError(`Flow "${flow}"${task ? ` (ticket ${task})` : ''} has no fast-forward run to stop.`, { code: 'FAST_FORWARD_NOT_ACTIVE' });
  }
  const reason = options.reason ? options.reason : existing.stopped?.reason;
  const stopped = { at: options.now ?? new Date().toISOString(), ...(reason ? { reason } : {}) };
  const run: FastForwardRun = { ...existing, stopped };
  saveFastForwardRun(paths, key, run);
  return run;
}

/** Throws DflError `INVALID_OPTIONS` unless `reason` is absent or one line of at most 300 characters without control characters. */
export function assertStopReason(reason: string | undefined): void {
  if (reason === undefined || isValidStopReason(reason)) return;
  throw new DflError(`The stop reason must be one line of at most ${FAST_FORWARD_NOTE_MAX} characters without control characters.`, {
    code: 'INVALID_OPTIONS',
  });
}

/** Drops every run of `flow` (`deleteFlow`). A missing or unreadable file is left alone. */
export function removeFlowRuns(paths: ProjectPaths, flow: string): void {
  if (!exists(paths.fastForwardFile)) return;
  const { file, problem } = readFastForwardFile(paths);
  if (problem) return;
  const keys = Object.entries(file.runs)
    .filter(([, run]) => run.flow === flow)
    .map(([key]) => key);
  if (keys.length === 0) return;
  for (const key of keys) delete file.runs[key];
  writeRunFile(paths, file);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Writes the file atomically, or removes it when it holds no run. */
function writeRunFile(paths: ProjectPaths, file: FastForwardFile): void {
  if (Object.keys(file.runs).length === 0) removePath(paths.fastForwardFile);
  else writeJson(paths.fastForwardFile, file);
}

function ownRun(file: FastForwardFile, key: string): FastForwardRun | undefined {
  return Object.hasOwn(file.runs, key) ? file.runs[key] : undefined;
}

/** A stored run rebuilt with only its own keys, in their order; undefined when it is not valid. */
function parseRun(raw: unknown): FastForwardRun | undefined {
  if (!isRecord(raw)) return undefined;
  const { flow, task, target, from, anchor, startedAt, resumedAt, stopped } = raw;
  if (typeof flow !== 'string' || !isValidId(flow)) return undefined;
  if (task !== null && (typeof task !== 'string' || !TASK_KEY_RE.test(task))) return undefined;
  if (typeof target !== 'string' || !isValidId(target) || typeof from !== 'string' || !isValidId(from)) return undefined;
  if (anchor !== null && !isHistoryEntry(anchor)) return undefined;
  if (typeof startedAt !== 'string' || (resumedAt !== undefined && typeof resumedAt !== 'string')) return undefined;
  if (stopped !== undefined && !isStop(stopped)) return undefined;
  return normalizedRun({ flow, task, target, from, anchor, startedAt, resumedAt, stopped });
}

/** `run` with its keys in the stored order and nothing else; optional keys only when set. */
function normalizedRun(run: FastForwardRun): FastForwardRun {
  const { anchor, stopped } = run;
  return {
    flow: run.flow,
    task: run.task,
    target: run.target,
    from: run.from,
    anchor: anchor ? { from: anchor.from, to: anchor.to, event: anchor.event, at: anchor.at } : null,
    startedAt: run.startedAt,
    ...(run.resumedAt !== undefined ? { resumedAt: run.resumedAt } : {}),
    ...(stopped ? { stopped: { at: stopped.at, ...(stopped.reason !== undefined ? { reason: stopped.reason } : {}) } } : {}),
  };
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  return (
    isRecord(value) &&
    typeof value['from'] === 'string' &&
    typeof value['to'] === 'string' &&
    typeof value['event'] === 'string' &&
    typeof value['at'] === 'string'
  );
}

function isStop(value: unknown): value is { at: string; reason?: string } {
  if (!isRecord(value) || typeof value['at'] !== 'string') return false;
  const reason = value['reason'];
  return reason === undefined || (typeof reason === 'string' && isValidStopReason(reason));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
