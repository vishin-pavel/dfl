/**
 * Edits of the raw `.df/tracker.json` behind `dfl tracker init/map/field`: pure functions on the raw
 * JSON object (readTrackerConfigRaw → edit → writeTrackerConfigRaw, which validates before writing),
 * so key order and unknown keys survive. An edited section of the wrong type (e.g. `"flows": []`)
 * is DflError `TRACKER_CONFIG_INVALID`: there is nothing to merge into.
 */
import { DflError } from '../errors.js';
import { TRACKER_CONFIG_VERSION, TRACKER_FILE_LABEL, type TrackerConfigRaw } from './config.js';

/** A status to map a step to: by name (case-insensitive in Jira) or by id. */
export type StatusTarget = { name: string } | { id: string };

/**
 * A step's new mapping: a status, `null` (none: dfl keeps the ticket's status at this step) or
 * `'unset'` (the key is removed, which has the same effect).
 */
export type StatusEditValue = StatusTarget | null | 'unset';

export interface StatusEdit {
  step: string;
  value: StatusEditValue;
}

export interface StatusEditResult {
  /** `flows.<flow>` did not exist: the flow is tracked from now on. */
  created: boolean;
  /** Steps whose object mapping kept its `fields` / `reopen` (only the status changed). */
  kept: string[];
}

/**
 * Parses the status argument of `dfl tracker map <step> <status>`: `none` → null, `id:10004` →
 * `{ id }`, anything else a status name. Throws DflError `INVALID_OPTIONS` for an empty value.
 */
export function parseStatusArg(text: string): StatusTarget | null {
  const value = text.trim();
  if (value === '') {
    throw new DflError('The status is empty.', { hint: 'Pass a Jira status name, id:<status id>, or none.', code: 'INVALID_OPTIONS' });
  }
  if (value.toLowerCase() === 'none') return null;
  const id = /^id:\s*(.*)$/i.exec(value);
  if (id) {
    const statusId = id[1]!.trim();
    if (statusId === '' || /\s/.test(statusId)) {
      throw new DflError(`"${value}" is not a status id.`, { hint: 'Write it as id:10004 (the id of the status in Jira).', code: 'INVALID_OPTIONS' });
    }
    return { id: statusId };
  }
  return { name: value };
}

/**
 * Applies `edits` to `flows.<flow>.statuses` of `raw` (in place), creating `flows`, the flow entry
 * and `statuses` when missing (an entry makes the flow tracked). A status set on a step whose
 * mapping is an object replaces only its `status` / `id`: `fields`, `reopen` and other keys stay.
 */
export function applyStatusEdits(raw: TrackerConfigRaw, flow: string, edits: readonly StatusEdit[]): StatusEditResult {
  const flows = section(raw, 'flows', 'flows');
  const created = !Object.hasOwn(flows, flow);
  if (created) flows[flow] = { statuses: {} };
  const entry = flows[flow];
  if (!isPlainObject(entry)) throw wrongType(`flows.${flow}`);
  const statuses = section(entry, 'statuses', `flows.${flow}.statuses`);
  const kept: string[] = [];
  for (const { step, value } of edits) {
    if (value === 'unset') {
      delete statuses[step];
      continue;
    }
    if (value === null) {
      statuses[step] = null;
      continue;
    }
    const existing = statuses[step];
    if (isPlainObject(existing)) {
      if ('name' in value) {
        delete existing['id'];
        existing['status'] = value.name;
      } else {
        delete existing['status'];
        existing['id'] = value.id;
      }
      if (Object.keys(existing).some((key) => key !== 'status' && key !== 'id')) kept.push(step);
      continue;
    }
    statuses[step] = 'name' in value ? value.name : { id: value.id };
  }
  return { created, kept };
}

/**
 * Moves the status mapping of step `from` to `to` in `flows.<flow>.statuses` of `raw` (in place, at
 * the same position; a stale mapping of `to` is replaced), for a renamed step. False when `from`
 * has no mapping (or the section is missing or not an object).
 */
export function renameStatusMapping(raw: TrackerConfigRaw, flow: string, from: string, to: string): boolean {
  const statuses = existingStatuses(raw, flow);
  if (!statuses || !Object.hasOwn(statuses, from) || from === to) return false;
  const entries = Object.entries(statuses)
    .filter(([step]) => step !== to)
    .map(([step, value]): [string, unknown] => [step === from ? to : step, value]);
  for (const step of Object.keys(statuses)) delete statuses[step];
  for (const [step, value] of entries) Object.defineProperty(statuses, step, { value, enumerable: true, writable: true, configurable: true });
  return true;
}

/** Removes the status mapping of step `step` from `flows.<flow>.statuses` of `raw` (a removed step). False when it has none. */
export function removeStatusMapping(raw: TrackerConfigRaw, flow: string, step: string): boolean {
  const statuses = existingStatuses(raw, flow);
  if (!statuses || !Object.hasOwn(statuses, step)) return false;
  delete statuses[step];
  return true;
}

/** Removes `flows.<flow>` from `raw` (the flow is no longer tracked). False when it was not tracked. */
export function removeTrackedFlow(raw: TrackerConfigRaw, flow: string): boolean {
  const flows = raw['flows'];
  if (!isPlainObject(flows) || !Object.hasOwn(flows, flow)) return false;
  delete flows[flow];
  return true;
}

/** Sets `fields.<param>` to `fieldId`, or removes it (undefined). Returns false when nothing changed. */
export function setFieldMapping(raw: TrackerConfigRaw, param: string, fieldId: string | undefined): boolean {
  if (fieldId === undefined) {
    const fields = raw['fields'];
    if (!isPlainObject(fields) || !Object.hasOwn(fields, param)) return false;
    delete fields[param];
    return true;
  }
  const fields = section(raw, 'fields', 'fields');
  if (fields[param] === fieldId) return false;
  fields[param] = fieldId;
  return true;
}

export interface NewTrackerConfig {
  /** Site origin (`https://acme.atlassian.net`). */
  baseUrl: string;
  projectKeys: string[];
  defaultProjectKey?: string | undefined;
  property?: string | undefined;
  branchTemplate?: string | undefined;
  from?: string | undefined;
  /** Flows to track (each `{ "statuses": {} }`: tracked, no status changes yet). */
  flows: readonly string[];
}

/** The raw content of a new `.df/tracker.json` (`dfl tracker init`). */
export function newTrackerConfigRaw(input: NewTrackerConfig): TrackerConfigRaw {
  const branch: Record<string, unknown> = {
    ...(input.branchTemplate !== undefined ? { template: input.branchTemplate } : {}),
    ...(input.from !== undefined ? { from: input.from } : {}),
  };
  return {
    version: TRACKER_CONFIG_VERSION,
    provider: 'jira',
    jira: {
      baseUrl: input.baseUrl,
      projectKeys: [...input.projectKeys],
      ...(input.defaultProjectKey !== undefined ? { defaultProjectKey: input.defaultProjectKey } : {}),
      ...(input.property !== undefined ? { property: input.property } : {}),
    },
    ...(Object.keys(branch).length > 0 ? { branch } : {}),
    flows: Object.fromEntries(input.flows.map((flow) => [flow, { statuses: {} }])),
  };
}

/**
 * How tables show a raw status mapping: the status name or `id:<id>`, `—` for none (null or no key),
 * plus what else the mapping sets (`+fields`, `reopen`).
 */
export function mappingLabel(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (!isPlainObject(value)) return String(value);
  const status = typeof value['status'] === 'string' ? value['status'] : value['id'] !== undefined ? `id:${String(value['id'])}` : '?';
  const extras = [...(value['fields'] !== undefined ? ['+fields'] : []), ...(value['reopen'] === true ? ['reopen'] : [])];
  return extras.length > 0 ? `${status} (${extras.join(', ')})` : status;
}

/**
 * Up to `max` of `candidates` that look like `input` (case-insensitive: one contains the other, or
 * a small edit distance), closest first.
 */
export function closeMatches(input: string, candidates: readonly string[], max = 3): string[] {
  const needle = input.trim().toLowerCase();
  if (needle === '') return [];
  const limit = Math.max(2, Math.floor(needle.length / 3));
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of new Set(candidates)) {
    const hay = name.toLowerCase();
    const distance = editDistance(needle, hay);
    const contains = hay.includes(needle) || needle.includes(hay);
    if (distance <= limit || contains) scored.push({ name, score: contains ? Math.min(distance, limit) : distance });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((entry) => entry.name);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** `flows.<flow>.statuses` of `raw` when it exists and every level is an object (nothing is created). */
function existingStatuses(raw: TrackerConfigRaw, flow: string): Record<string, unknown> | undefined {
  const flows = raw['flows'];
  if (!isPlainObject(flows) || !Object.hasOwn(flows, flow)) return undefined;
  const entry = flows[flow];
  if (!isPlainObject(entry)) return undefined;
  const statuses = entry['statuses'];
  return isPlainObject(statuses) ? statuses : undefined;
}

/** `parent[key]` as an object, created (appended) when missing. */
function section(parent: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const value = parent[key];
  if (value === undefined) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }
  if (!isPlainObject(value)) throw wrongType(where);
  return value;
}

function wrongType(where: string): DflError {
  return new DflError(`Invalid tracker config in ${TRACKER_FILE_LABEL}: ${where} must be an object.`, {
    hint: `Fix ${TRACKER_FILE_LABEL} by hand, then run the command again.`,
    code: 'TRACKER_CONFIG_INVALID',
  });
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
