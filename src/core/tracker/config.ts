/**
 * Task tracker config: `.df/tracker.json` (committed, optional). See docs/ARCHITECTURE.md.
 *
 * Parsed lazily and only by the tracker layer (never on the `getActiveFlowName` hot path), so a typo
 * breaks tracker operations and nothing else: the tasks of the flows the file names (all flows only
 * when it is not even a JSON object; see `isTracked`). {@link loadTrackerConfig} validates and normalizes;
 * the CLI editors (`dfl tracker init/map/field`) edit the raw JSON ({@link readTrackerConfigRaw} /
 * {@link writeTrackerConfigRaw}) so key order and unknown keys survive. A flow is TRACKED when the
 * file has an entry `flows.<flow>` (even with no status mapping).
 */
import { z } from 'zod';
import { DflError, errorMessage } from '../errors.js';
import { flowExists, readFlowDefinition } from '../flow.js';
import { exists, readTextIfExists, writeText } from '../fsx.js';
import { PACKAGE_NAME } from '../paths.js';
import { resolveVars } from '../vars.js';
import type { FlowDefinition, ProjectPaths } from '../types.js';

/** The only `version` this dfl reads and writes. */
export const TRACKER_CONFIG_VERSION = 1;
/** How messages name the file (project-relative). */
export const TRACKER_FILE_LABEL = '.df/tracker.json';
/** Default issue entity property that holds the dfl record (`jira.property`). */
export const DEFAULT_RECORD_PROPERTY = 'dfl.run';
export const DEFAULT_BRANCH_TEMPLATE = '{key}-{slug}';
/** Protected branches when `branch.protected` is not set (the flow's `mainBranch` var is added). */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['main', 'master', 'develop'];
/** Jira project key (uppercase, as Jira stores it). */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]+$/;
/** Task param names (record params, `fields` keys). */
export const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Jira custom field ids (`fields` values). */
export const CUSTOM_FIELD_RE = /^customfield_\d+$/;

const PROPERTY_RE = /^[A-Za-z0-9._-]{1,200}$/;
const TEMPLATE_PLACEHOLDERS = new Set(['key', 'slug']);
/** Hosts that may use plain `http:` (local test servers); everything else must be https. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A status mapping as written in tracker.json. */
export type StatusMapping = string | { status?: string; id?: string; fields?: Record<string, unknown>; reopen?: boolean };

/** A mapped Jira status: matched by `id` when set, else by `name` (case-insensitively). */
export interface NormalizedStatus {
  /** Status name. */
  name?: string | undefined;
  /** Status id (wins over the name when both are set). */
  id?: string | undefined;
  /** Fields sent with the transition (e.g. `{ resolution: { name: 'Done' } }`). */
  fields?: Record<string, unknown> | undefined;
  /** Allow moving the ticket out of a done-category status. */
  reopen: boolean;
  /** Status category key (`new`, `indeterminate`, `done`) when known (from Jira, never from the config). */
  categoryKey?: string | undefined;
}

export interface TrackedFlowConfig {
  /** Overrides `branch.template` for this flow. */
  branchTemplate?: string | undefined;
  /** A tracked flow needs a task for every status read and move (default true). */
  requireTask: boolean;
  /** Step id → status; `null` (or no key) keeps the ticket's status. */
  statuses: Record<string, NormalizedStatus | null>;
}

/** Parsed and normalized `.df/tracker.json`. */
export interface TrackerConfig {
  version: 1;
  provider: 'jira';
  jira: {
    baseUrl: string;
    /** `new URL(baseUrl).origin`: the only part dfl uses (and binds credentials to). */
    origin: string;
    projectKeys: string[];
    defaultProjectKey?: string | undefined;
    /** Issue entity property of the dfl record. */
    property: string;
  };
  /** As configured; {@link resolveBranchSettings} applies the defaults. */
  branch: { template?: string | undefined; from?: string | undefined; protected?: string[] | undefined; fetch?: boolean | undefined };
  /** Param name → Jira custom field id (`customfield_10042`). */
  fields: Record<string, string>;
  flowSelect: { byIssueType: Record<string, string>; default?: string | undefined };
  flows: Record<string, TrackedFlowConfig>;
}

/** Raw JSON of tracker.json (for the editors). */
export type TrackerConfigRaw = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const baseUrlSchema = z.string().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'expected the URL of the Jira site, e.g. https://acme.atlassian.net' });
    return;
  }
  // The value is never echoed: it could hold credentials.
  if (url.username !== '' || url.password !== '') {
    ctx.addIssue({ code: 'custom', message: 'must not contain a user name or password (dfl keeps credentials outside the project)' });
  } else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    ctx.addIssue({ code: 'custom', message: 'must be an https:// URL (plain http:// only for localhost)' });
  }
});

const branchTemplateSchema = z.string().superRefine((value, ctx) => {
  const unknown = [...value.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!).filter((name) => !TEMPLATE_PLACEHOLDERS.has(name));
  if (unknown.length > 0) {
    ctx.addIssue({ code: 'custom', message: `unknown placeholder {${unknown[0]}} (use {key} and {slug})` });
  }
  if (!value.includes('{key}')) {
    ctx.addIssue({ code: 'custom', message: 'must contain {key} (dfl finds the ticket of a branch by the key in its name)' });
  } else if (/(?:[A-Za-z0-9]|\{slug\})\{key\}|\{key\}(?:[A-Za-z0-9]|\{slug\})/.test(value)) {
    // `{key}{slug}` with the slug `2fa-…` would turn ABC-2 into ABC-22: the branch would name another ticket.
    ctx.addIssue({
      code: 'custom',
      message: 'put a separator such as "-" or "/" around {key} (dfl finds the ticket by the key in the branch name, which must not run into other letters or digits)',
    });
  }
});

/** A ref to branch from (`origin/main`): a plain ref name, never refspec or revision syntax. */
const branchFromSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('-') &&
      !value.startsWith('+') &&
      !/[\s\u0000-\u001f\u007f-\u009f:*?[^~\\]/.test(value) &&
      !value.includes('..') &&
      !value.includes('@{'),
    'expected a git ref such as "origin/main" (no ":", "*", "?", "[", "^", "~", "\\", "..", "@{", leading "+" or "-", or whitespace)',
  );

/** A status mapping (string | object | null), normalized; type errors become issues at its path. */
const statusMappingSchema = z.unknown().transform((value, ctx): NormalizedStatus | null => {
  if (value === null) return null;
  if (typeof value === 'string') {
    if (value.trim() === '') {
      ctx.addIssue({ code: 'custom', message: 'empty status name (use null to keep the status at this step)' });
      return z.NEVER;
    }
    return { name: value.trim(), reopen: false };
  }
  if (!isPlainObject(value)) {
    ctx.addIssue({ code: 'custom', message: 'expected a status name, null, or an object with "status" or "id"' });
    return z.NEVER;
  }
  const problems: string[] = [];
  const name = value['status'];
  const id = value['id'];
  const fields = value['fields'];
  const reopen = value['reopen'];
  if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) problems.push('"status" must be a non-empty string');
  if (id !== undefined && !(typeof id === 'string' && id.trim() !== '') && !(typeof id === 'number' && Number.isInteger(id))) {
    problems.push('"id" must be a status id such as "10004"');
  }
  if (name === undefined && id === undefined) problems.push('set "status" (a status name) or "id"');
  if (fields !== undefined && !isPlainObject(fields)) problems.push('"fields" must be an object of Jira field ids to values');
  if (reopen !== undefined && typeof reopen !== 'boolean') problems.push('"reopen" must be true or false');
  if (problems.length > 0) {
    for (const message of problems) ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  }
  return {
    ...(typeof name === 'string' ? { name: name.trim() } : {}),
    ...(id !== undefined ? { id: String(id).trim() } : {}),
    ...(fields !== undefined ? { fields: fields as Record<string, unknown> } : {}),
    reopen: reopen === true,
  };
});

const flowSchema = z.looseObject({
  branchTemplate: branchTemplateSchema.optional(),
  requireTask: z.boolean().optional(),
  statuses: z.record(z.string(), statusMappingSchema).optional(),
});

const trackerConfigSchema = z.looseObject({
  version: z.literal(TRACKER_CONFIG_VERSION),
  provider: z.string().superRefine((value, ctx) => {
    if (value !== 'jira') ctx.addIssue({ code: 'custom', message: `unsupported provider "${value}" (this dfl supports "jira")` });
  }),
  jira: z
    .looseObject({
      baseUrl: baseUrlSchema,
      projectKeys: z.array(z.string().regex(PROJECT_KEY_RE, 'expected an uppercase Jira project key such as "ABC"')).min(1),
      defaultProjectKey: z.string().optional(),
      property: z.string().regex(PROPERTY_RE, 'expected letters, digits, ".", "_" or "-" (max 200)').optional(),
    })
    .superRefine((jira, ctx) => {
      if (jira.defaultProjectKey !== undefined && !jira.projectKeys.includes(jira.defaultProjectKey)) {
        ctx.addIssue({ code: 'custom', path: ['defaultProjectKey'], message: `"${jira.defaultProjectKey}" is not one of "projectKeys"` });
      }
    }),
  branch: z
    .looseObject({
      template: branchTemplateSchema.optional(),
      from: branchFromSchema.optional(),
      protected: z.array(z.string().min(1)).optional(),
      fetch: z.boolean().optional(),
    })
    .optional(),
  fields: z.record(z.string(), z.string().regex(CUSTOM_FIELD_RE, 'expected a custom field id such as "customfield_10042"')).optional(),
  flowSelect: z
    .looseObject({
      byIssueType: z.record(z.string(), z.string().min(1)).optional(),
      default: z.string().min(1).optional(),
    })
    .optional(),
  flows: z.record(z.string(), flowSchema).optional(),
});

// ---------------------------------------------------------------------------
// Loading and raw editing
// ---------------------------------------------------------------------------

/**
 * Validates tracker.json content and normalizes it (defaults applied, status mappings normalized).
 * Throws DflError `TRACKER_CONFIG_NEWER` for a higher `version`, `TRACKER_CONFIG_INVALID` (naming
 * the JSON path) for anything else.
 */
export function parseTrackerConfig(raw: unknown, file: string = TRACKER_FILE_LABEL): TrackerConfig {
  if (!isPlainObject(raw)) {
    throw new DflError(`Invalid tracker config in ${file}: expected a JSON object.`, { hint: CONFIG_HINT, code: 'TRACKER_CONFIG_INVALID' });
  }
  const version = raw['version'];
  if (typeof version === 'number' && version > TRACKER_CONFIG_VERSION) {
    throw new DflError(`${file} has version ${version}; this dfl understands version ${TRACKER_CONFIG_VERSION}.`, {
      hint: `It was written by a newer dfl: upgrade (\`npm install -D ${PACKAGE_NAME}@latest\`) and run the command again.`,
      code: 'TRACKER_CONFIG_NEWER',
    });
  }
  const result = trackerConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new DflError(`Invalid tracker config in ${file}: ${details}`, { hint: CONFIG_HINT, code: 'TRACKER_CONFIG_INVALID' });
  }
  const data = result.data;
  const flows: Record<string, TrackedFlowConfig> = {};
  for (const [name, flow] of Object.entries(data.flows ?? {})) {
    flows[name] = {
      ...(flow.branchTemplate !== undefined ? { branchTemplate: flow.branchTemplate } : {}),
      requireTask: flow.requireTask ?? true,
      statuses: { ...(flow.statuses ?? {}) },
    };
  }
  return {
    version: TRACKER_CONFIG_VERSION,
    provider: 'jira',
    jira: {
      baseUrl: data.jira.baseUrl,
      origin: new URL(data.jira.baseUrl).origin,
      projectKeys: [...new Set(data.jira.projectKeys)],
      ...(data.jira.defaultProjectKey !== undefined ? { defaultProjectKey: data.jira.defaultProjectKey } : {}),
      property: data.jira.property ?? DEFAULT_RECORD_PROPERTY,
    },
    branch: {
      ...(data.branch?.template !== undefined ? { template: data.branch.template } : {}),
      ...(data.branch?.from !== undefined ? { from: data.branch.from } : {}),
      ...(data.branch?.protected !== undefined ? { protected: [...data.branch.protected] } : {}),
      ...(data.branch?.fetch !== undefined ? { fetch: data.branch.fetch } : {}),
    },
    fields: { ...(data.fields ?? {}) },
    flowSelect: {
      byIssueType: { ...(data.flowSelect?.byIssueType ?? {}) },
      ...(data.flowSelect?.default !== undefined ? { default: data.flowSelect.default } : {}),
    },
    flows,
  };
}

/** `.df/tracker.json`, validated; undefined when the file does not exist. Throws like {@link parseTrackerConfig}. */
export function loadTrackerConfig(paths: ProjectPaths): TrackerConfig | undefined {
  const raw = readTrackerConfigRaw(paths);
  return raw === undefined ? undefined : parseTrackerConfig(raw);
}

/**
 * The raw JSON object of `.df/tracker.json` (undefined when missing), for read-modify-write edits
 * that keep key order and unknown keys. Not validated beyond "a JSON object"
 * (DflError `TRACKER_CONFIG_INVALID` otherwise).
 */
export function readTrackerConfigRaw(paths: ProjectPaths): TrackerConfigRaw | undefined {
  const text = readTextIfExists(paths.trackerFile);
  if (text === undefined) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new DflError(`Cannot parse ${TRACKER_FILE_LABEL}: ${errorMessage(error)}`, { hint: CONFIG_HINT, code: 'TRACKER_CONFIG_INVALID', cause: error });
  }
  if (!isPlainObject(data)) {
    throw new DflError(`Invalid tracker config in ${TRACKER_FILE_LABEL}: expected a JSON object.`, { hint: CONFIG_HINT, code: 'TRACKER_CONFIG_INVALID' });
  }
  return data;
}

/**
 * Validates `raw` ({@link parseTrackerConfig}) and writes it to `.df/tracker.json` (2-space JSON,
 * trailing newline; nothing is written when it is invalid). Returns the parsed config.
 */
export function writeTrackerConfigRaw(paths: ProjectPaths, raw: TrackerConfigRaw): TrackerConfig {
  const cfg = parseTrackerConfig(raw);
  writeText(paths.trackerFile, `${JSON.stringify(raw, null, 2)}\n`);
  return cfg;
}

/**
 * The config and the entry of `flow` when `.df/tracker.json` tracks it; undefined when the file does
 * not exist or does not name the flow in `flows`, without validating the rest: a broken mapping of
 * one flow must not break the flows the file does not track. Throws DflError
 * `TRACKER_CONFIG_INVALID` when the file is not a JSON object (dfl cannot tell which flows it
 * names) and like {@link parseTrackerConfig} when it names `flow` (or `flows` is not an object).
 */
export function loadTrackedFlow(paths: ProjectPaths, flow: string): { cfg: TrackerConfig; tracked: TrackedFlowConfig } | undefined {
  const raw = readTrackerConfigRaw(paths);
  if (raw === undefined) return undefined;
  const flows = raw['flows'];
  if (flows === undefined || (isPlainObject(flows) && !Object.hasOwn(flows, flow))) return undefined;
  const cfg = parseTrackerConfig(raw);
  const tracked = trackedFlow(cfg, flow);
  return tracked ? { cfg, tracked } : undefined;
}

/** True when `.df/tracker.json` exists (no parsing). */
export function hasTrackerConfig(paths: ProjectPaths): boolean {
  return exists(paths.trackerFile);
}

/** {@link loadTrackerConfig}, but DflError `TRACKER_NOT_CONFIGURED` when the file does not exist. */
export function requireTrackerConfig(paths: ProjectPaths): TrackerConfig {
  const cfg = loadTrackerConfig(paths);
  if (!cfg) throw notConfiguredError();
  return cfg;
}

/** `TRACKER_NOT_CONFIGURED`: there is no `.df/tracker.json` (hint: `dfl tracker init`). */
export function notConfiguredError(): DflError {
  return new DflError(`This project has no Jira tracker (${TRACKER_FILE_LABEL} does not exist).`, {
    hint: 'Set one up with `dfl tracker init`.',
    code: 'TRACKER_NOT_CONFIGURED',
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** The tracker entry of `flow`; undefined when the flow is not tracked. */
export function trackedFlow(cfg: TrackerConfig, flow: string): TrackedFlowConfig | undefined {
  return Object.hasOwn(cfg.flows, flow) ? cfg.flows[flow] : undefined;
}

/** The status `step` of `flow` maps to; null when it keeps the status (unmapped, `null`, or the flow is untracked). */
export function statusMappingFor(cfg: TrackerConfig, flow: string, step: string): NormalizedStatus | null {
  const tracked = trackedFlow(cfg, flow);
  if (!tracked || !Object.hasOwn(tracked.statuses, step)) return null;
  return tracked.statuses[step] ?? null;
}

/** Every distinct non-null status the steps of `flow` map to (the statuses dfl manages for that flow). */
export function managedStatuses(cfg: TrackerConfig, flow: string): NormalizedStatus[] {
  const out: NormalizedStatus[] = [];
  const seen = new Set<string>();
  for (const status of Object.values(trackedFlow(cfg, flow)?.statuses ?? {})) {
    if (!status) continue;
    const key = status.id !== undefined ? `id:${status.id}` : `name:${status.name?.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(status);
  }
  return out;
}

/** How messages and tables show a mapped status: its name, else `id:<id>` (the `dfl tracker map` syntax). */
export function statusLabel(status: Pick<NormalizedStatus, 'name' | 'id'>): string {
  return status.name ?? `id:${status.id ?? '?'}`;
}

export interface BranchSettings {
  /** Branch name template (flow `branchTemplate` → `branch.template` → `{key}-{slug}`). */
  template: string;
  /** Ref new task branches start from (default `origin/<mainBranch>`). */
  from: string;
  /** Branches a task never works on directly. */
  protected: string[];
  /** Fetch `from` before branching (default true). */
  fetch: boolean;
}

/**
 * `branch` settings of `cfg` with the defaults applied for the flow `def` (its `mainBranch` var,
 * resolved like templates see it, else `main`).
 */
export function resolveBranchSettings(paths: ProjectPaths, cfg: TrackerConfig, def: FlowDefinition | undefined): BranchSettings {
  let mainBranch = 'main';
  try {
    const value = resolveVars(paths, def).values['mainBranch'];
    if (typeof value === 'string' && value.trim() !== '') mainBranch = value.trim();
  } catch {
    // unreadable config.json/local.json: keep the default
  }
  const flowTemplate = def ? trackedFlow(cfg, def.name)?.branchTemplate : undefined;
  return {
    template: flowTemplate ?? cfg.branch.template ?? DEFAULT_BRANCH_TEMPLATE,
    from: cfg.branch.from ?? `origin/${mainBranch}`,
    protected: cfg.branch.protected ? [...cfg.branch.protected] : [...new Set([...DEFAULT_PROTECTED_BRANCHES, mainBranch])],
    fetch: cfg.branch.fetch ?? true,
  };
}

// ---------------------------------------------------------------------------
// Offline checks
// ---------------------------------------------------------------------------

/**
 * Offline checks of a valid config (warnings, never errors): mapped flows that do not exist,
 * mapped step ids a flow does not have, plain-http `baseUrl`, `fields` keys that are not param
 * names, `flowSelect` naming missing or untracked flows. With `options.flow`, only the checks
 * that concern that flow (and the shared settings, when it is tracked).
 */
export function trackerWarnings(paths: ProjectPaths, cfg: TrackerConfig, options: { flow?: string | undefined } = {}): string[] {
  const warnings: string[] = [];
  const only = options.flow;
  if (only !== undefined && !trackedFlow(cfg, only)) return warnings;

  if (new URL(cfg.jira.baseUrl).protocol === 'http:') {
    warnings.push(`${TRACKER_FILE_LABEL}: jira.baseUrl uses plain http:// (only for local testing; Jira Cloud needs https://).`);
  }
  for (const name of Object.keys(cfg.fields)) {
    if (!PARAM_NAME_RE.test(name)) {
      warnings.push(`${TRACKER_FILE_LABEL}: fields.${name} is not a valid param name (letters, digits and "_", starting with a letter); it is never written.`);
    }
  }
  const selected = [
    ...Object.entries(cfg.flowSelect.byIssueType).map(([type, flow]) => ({ where: `flowSelect.byIssueType.${type}`, flow })),
    ...(cfg.flowSelect.default !== undefined ? [{ where: 'flowSelect.default', flow: cfg.flowSelect.default }] : []),
  ];
  for (const { where, flow } of selected) {
    if (!flowExists(paths, flow)) {
      warnings.push(`${TRACKER_FILE_LABEL}: ${where} names flow "${flow}", which does not exist in this project.`);
    } else if (!trackedFlow(cfg, flow)) {
      warnings.push(`${TRACKER_FILE_LABEL}: ${where} names flow "${flow}", which is not tracked (map it with \`dfl tracker map --flow ${flow}\`).`);
    }
  }

  for (const [name, tracked] of Object.entries(cfg.flows)) {
    if (only !== undefined && name !== only) continue;
    if (!flowExists(paths, name)) {
      warnings.push(`${TRACKER_FILE_LABEL}: flows.${name} maps a flow that does not exist in this project.`);
      continue;
    }
    let states: Record<string, unknown>;
    try {
      states = readFlowDefinition(paths, name).machine.states;
    } catch {
      continue; // an invalid flow is reported by its own validation
    }
    for (const step of Object.keys(tracked.statuses)) {
      if (!Object.hasOwn(states, step)) {
        warnings.push(`${TRACKER_FILE_LABEL}: flows.${name}.statuses.${step} maps a step that flow "${name}" does not have (it is ignored).`);
      }
    }
  }
  return warnings;
}

/**
 * Tracker warnings for `dfl flow validate <flow>` / `validateFlow`: the {@link trackerWarnings} of
 * `flow`, or the load error as a warning (tracker problems never block syncs). Empty when there
 * is no tracker.json or the flow is not tracked.
 */
export function trackerValidationWarnings(paths: ProjectPaths, flow: string): string[] {
  if (!hasTrackerConfig(paths)) return [];
  let cfg: TrackerConfig | undefined;
  try {
    cfg = loadTrackerConfig(paths);
  } catch (error) {
    // Which flows are affected follows `isTracked` (loadTrackedFlow): a JSON object whose `flows` is
    // missing or an object breaks only the flows it names; anything else breaks every flow.
    let named = false;
    try {
      const flows = readTrackerConfigRaw(paths)?.['flows'];
      named = flows === undefined || isPlainObject(flows);
    } catch {
      named = false;
    }
    return [`${errorMessage(error)} (tracker operations fail until it is fixed, ${named ? 'for the flows it names' : 'for every flow'})`];
  }
  return cfg ? trackerWarnings(paths, cfg, { flow }) : [];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const CONFIG_HINT = `Fix ${TRACKER_FILE_LABEL} (see the "Tracking tasks in Jira" section of the dfl README), then run \`dfl tracker check\`.`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
