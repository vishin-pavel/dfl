/**
 * Online checks of the Jira tracker setup: `dfl tracker check`, and the status / field lookups of
 * `dfl tracker map` and `dfl tracker field`. Nothing here writes; network problems are results
 * (a failed check, or a `problem` the caller shows as a warning), never thrown.
 */
import { projectDependsOnDfl } from '../../agents/mcp-config.js';
import { DflError, errorMessage, isDflError } from '../errors.js';
import { PACKAGE_NAME } from '../paths.js';
import type { ProjectPaths } from '../types.js';
import { TRACKER_FILE_LABEL, loadTrackerConfig, notConfiguredError, trackerWarnings, type TrackerConfig } from './config.js';
import { credentialFor, credentialsFile } from './credentials.js';
import { closeMatches, type StatusTarget } from './edit.js';
import { trackerDeadline } from './http.js';
import { createJiraClient, type JiraClient, type JiraField, type JiraProjectStatus } from './jira.js';
import { nameMatches } from './projection.js';

export type CheckLevel = 'ok' | 'warn' | 'fail';

/** One line of `dfl tracker check`. */
export interface TrackerCheck {
  /** What was checked: config, launcher, credential, auth, project, statuses, fields, flowSelect. */
  check: string;
  level: CheckLevel;
  message: string;
  hint?: string;
}

/** The statuses and issue types of the configured projects that could be read. */
export interface StatusCatalog {
  /** Unique across the projects (by id), in Jira's order. */
  statuses: JiraProjectStatus[];
  issueTypes: string[];
  /** The project keys that were read. */
  projects: string[];
}

/** Why an online lookup could not run (no credential, offline, …); callers warn and carry on. */
export interface LookupProblem {
  problem: string;
}

/** Field types dfl can write a param to: single-line text and URL fields (both `string` in Jira's schema). */
const MULTILINE_FIELD = 'com.atlassian.jira.plugin.system.customfieldtypes:textarea';

/**
 * A client for the configured site with the stored credential (its requests share a deadline that
 * starts now), or why there is none.
 */
export function trackerClient(cfg: TrackerConfig): { client: JiraClient; warnings: string[] } | LookupProblem {
  let credential: ReturnType<typeof credentialFor>;
  try {
    credential = credentialFor(cfg.jira.origin);
  } catch (error) {
    return { problem: errorMessage(error) };
  }
  if (!credential) return { problem: `no Jira credential for ${cfg.jira.origin} (run \`dfl tracker login\`)` };
  return {
    client: createJiraClient({ baseUrl: cfg.jira.baseUrl, credential, signal: trackerDeadline() }),
    warnings: [...credential.warnings],
  };
}

/** The statuses (and issue types) of the configured projects; a problem when none could be read. */
export async function fetchStatusCatalog(cfg: TrackerConfig, client?: JiraClient): Promise<StatusCatalog | LookupProblem> {
  let jira = client;
  if (!jira) {
    const connected = trackerClient(cfg);
    if ('problem' in connected) return connected;
    jira = connected.client;
  }
  const { catalog, failures } = await readCatalog(jira, cfg.jira.projectKeys);
  return catalog.projects.length > 0 ? catalog : { problem: errorMessage(failures[0]?.error) };
}

/** The Jira field catalog, or why it could not be read. */
export async function fetchFieldCatalog(cfg: TrackerConfig, client?: JiraClient): Promise<JiraField[] | LookupProblem> {
  let jira = client;
  if (!jira) {
    const connected = trackerClient(cfg);
    if ('problem' in connected) return connected;
    jira = connected.client;
  }
  try {
    return await jira.listFields();
  } catch (error) {
    return { problem: errorMessage(error) };
  }
}

/** The status `target` names: by id when it has one, else by name or untranslated name (case-insensitively). */
export function findStatus(statuses: readonly JiraProjectStatus[], target: { name?: string | undefined; id?: string | undefined }): JiraProjectStatus | undefined {
  if (target.id !== undefined) return statuses.find((s) => s.id === target.id);
  const name = target.name;
  return name === undefined ? undefined : statuses.find((s) => nameMatches(name, s));
}

/**
 * The name to store in a status mapping: Jira's `untranslatedName` when it sent one (the same for
 * every user's language), else the name.
 */
export function mappingName(status: { name: string; untranslatedName?: string | undefined }): string {
  return status.untranslatedName ?? status.name;
}

/** DflError `TRACKER_STATUS_UNKNOWN` for a status the projects do not have, with close matches. */
export function unknownStatusError(target: StatusTarget, catalog: StatusCatalog): DflError {
  const where = `${catalog.projects.length === 1 ? 'project' : 'projects'} ${catalog.projects.join(', ')}`;
  const names = catalog.statuses.map(mappingName);
  if ('id' in target) {
    return new DflError(`Jira has no status with id ${target.id} in ${where}.`, {
      hint: `Statuses: ${catalog.statuses.map((s) => `${mappingName(s)} (${s.id})`).join(', ') || '(none)'}. Pass --no-check to map it anyway.`,
      code: 'TRACKER_STATUS_UNKNOWN',
    });
  }
  // The user may type the name in their own Jira language: suggest from both spellings.
  const spellings = [...new Set(catalog.statuses.flatMap((s) => (s.untranslatedName !== undefined ? [s.name, s.untranslatedName] : [s.name])))];
  const close = closeMatches(target.name, spellings);
  return new DflError(`Jira has no status "${target.name}" in ${where}.`, {
    hint:
      (close.length > 0 ? `Did you mean ${close.map((name) => `"${name}"`).join(' or ')}? ` : '') +
      `Statuses: ${names.join(', ') || '(none)'}. Pass --no-check to map it anyway.`,
    code: 'TRACKER_STATUS_UNKNOWN',
  });
}

/** Why dfl cannot write a param to `field` (undefined when it can: single-line text or URL). */
export function fieldProblem(field: JiraField): string | undefined {
  const type = field.schema?.type;
  if (type !== 'string') return `is ${type ? `a ${type}` : 'not a text'} field`;
  if (field.schema?.custom === MULTILINE_FIELD) return 'is a paragraph (multi-line) field';
  return undefined;
}

/** `Branch (customfield_10042)`. */
export function fieldLabel(field: Pick<JiraField, 'id' | 'name'>): string {
  return field.name ? `${field.name} (${field.id})` : field.id;
}

/** `a URL field` or `a single-line text field` (for a field {@link fieldProblem} accepts). */
function fieldKind(field: JiraField): string {
  return field.schema?.custom?.endsWith(':url') ? 'a URL field' : 'a single-line text field';
}

/**
 * `dfl tracker check`: the config and its offline warnings (including an unmapped `fields.branch`),
 * the dfl launcher, the credential, then online: authentication, each project, every mapped status,
 * every mapped field (single-line text or URL) and the issue types of `flowSelect` (warnings only).
 * Throws `TRACKER_NOT_CONFIGURED` when there is no tracker.json; everything else is a check result.
 *
 * A mapped field is checked against Jira's global field list only: whether its field context
 * includes every project and issue type needs admin rights, so with several projects or issue
 * types a custom field is a warning that says so, not an ok.
 */
export async function checkTracker(paths: ProjectPaths): Promise<TrackerCheck[]> {
  const checks: TrackerCheck[] = [];
  let cfg: TrackerConfig | undefined;
  try {
    cfg = loadTrackerConfig(paths);
  } catch (error) {
    return [failed('config', error)];
  }
  if (!cfg) throw notConfiguredError();
  const flows = Object.keys(cfg.flows);
  checks.push({
    check: 'config',
    level: 'ok',
    message:
      `${TRACKER_FILE_LABEL} is valid (Jira ${cfg.jira.origin}, ${cfg.jira.projectKeys.length === 1 ? 'project' : 'projects'} ` +
      `${cfg.jira.projectKeys.join(', ')}; ${flows.length > 0 ? `tracked: ${flows.join(', ')}` : 'no tracked flow'})`,
  });
  for (const message of trackerWarnings(paths, cfg)) checks.push({ check: 'config', level: 'warn', message });
  if (cfg.fields['branch'] === undefined) {
    checks.push({
      check: 'fields',
      level: 'warn',
      message: 'The branch is not stored in a Jira field; optional: `dfl tracker field branch <field>`.',
      hint: 'Map a single-line text or URL field, so teammates see the task branch on the ticket.',
    });
  }
  if (!projectDependsOnDfl(paths.root)) {
    checks.push({
      check: 'launcher',
      level: 'warn',
      message: 'This project runs the global `dfl`: a teammate with an older dfl (or one without tracker support) would advance only local state.',
      hint: `Pin it: \`npm install -D ${PACKAGE_NAME}\` (agents then start \`npx --no-install dfl mcp\`; run \`dfl flow-update\`).`,
    });
  }

  let credential: ReturnType<typeof credentialFor>;
  try {
    credential = credentialFor(cfg.jira.origin);
  } catch (error) {
    checks.push(failed('credential', error));
    return checks;
  }
  if (!credential) {
    checks.push({
      check: 'credential',
      level: 'fail',
      message: `No Jira credential for ${cfg.jira.origin}; the online checks were skipped.`,
      hint: `Run \`dfl tracker login\` (dfl looks in ${credentialsFile()}, and in DFL_JIRA_URL, DFL_JIRA_EMAIL and DFL_JIRA_TOKEN for CI).`,
    });
    return checks;
  }
  const source = credential.source === 'env' ? 'DFL_JIRA_URL, DFL_JIRA_EMAIL and DFL_JIRA_TOKEN' : credentialsFile();
  checks.push({ check: 'credential', level: 'ok', message: `Credential for ${cfg.jira.origin}: ${credential.email} (from ${source})` });
  for (const message of credential.warnings) checks.push({ check: 'credential', level: 'warn', message });

  const client = createJiraClient({ baseUrl: cfg.jira.baseUrl, credential, signal: trackerDeadline() });
  try {
    const me = await client.myself();
    checks.push({ check: 'auth', level: 'ok', message: `Authenticated as ${me.displayName || credential.email} (${credential.email})` });
  } catch (error) {
    checks.push(failed('auth', error));
    return checks;
  }

  const { catalog, counts, failures } = await readCatalog(client, cfg.jira.projectKeys);
  for (const project of cfg.jira.projectKeys) {
    const failure = failures.find((f) => f.project === project);
    checks.push(failure ? failed('project', failure.error) : { check: 'project', level: 'ok', message: `Project ${project}: ${counts.get(project) ?? 0} statuses` });
  }

  if (catalog.projects.length > 0) {
    for (const [flow, tracked] of Object.entries(cfg.flows)) {
      let mapped = 0;
      let missing = 0;
      for (const [step, status] of Object.entries(tracked.statuses)) {
        if (!status) continue;
        mapped += 1;
        if (findStatus(catalog.statuses, status)) continue;
        missing += 1;
        const target: StatusTarget = status.id !== undefined ? { id: status.id } : { name: status.name ?? '' };
        const error = unknownStatusError(target, catalog);
        checks.push({
          check: 'statuses',
          level: 'fail',
          message: `flows.${flow}.statuses.${step}: ${error.message}`,
          hint: `${error.hint?.replace(' Pass --no-check to map it anyway.', '') ?? ''} Fix it with \`dfl tracker map ${step} <status> --flow ${flow}\`.`.trim(),
        });
      }
      if (missing === 0) {
        checks.push({
          check: 'statuses',
          level: 'ok',
          message:
            mapped === 0
              ? `flows.${flow}: no step changes the Jira status`
              : mapped === 1
                ? `flows.${flow}: the mapped status exists in Jira`
                : `flows.${flow}: every mapped status exists in Jira (${mapped} steps)`,
        });
      }
    }
    for (const type of Object.keys(cfg.flowSelect.byIssueType)) {
      if (catalog.issueTypes.some((name) => name.toLowerCase() === type.toLowerCase())) continue;
      checks.push({
        check: 'flowSelect',
        level: 'warn',
        message:
          `flowSelect.byIssueType.${type}: ${catalog.projects.join(', ')} ${catalog.projects.length === 1 ? 'has' : 'have'} ` +
          `no issue type "${type}" (issue types: ${catalog.issueTypes.join(', ') || 'none'}).`,
      });
    }
  }

  const params = Object.entries(cfg.fields);
  if (params.length > 0) {
    const fields = await fetchFieldCatalog(cfg, client);
    const issueTypes = Object.keys(cfg.flowSelect.byIssueType);
    // Several projects, or flows chosen by issue type: a custom field's context may leave some out.
    const scoped = cfg.jira.projectKeys.length > 1 || issueTypes.length > 0;
    if ('problem' in fields) {
      checks.push({ check: 'fields', level: 'fail', message: `Could not read the Jira fields: ${fields.problem}` });
    } else {
      for (const [param, id] of params) {
        const field = fields.find((f) => f.id === id);
        const problem = field ? fieldProblem(field) : undefined;
        if (field && !problem && field.custom && scoped) {
          checks.push({
            check: 'fields',
            level: 'warn',
            message:
              `fields.${param} → ${fieldLabel(field)}: exists and is ${fieldKind(field)}, but its field context must include every ` +
              `project (${cfg.jira.projectKeys.join(', ')}) and issue type of the tickets dfl tracks; dfl cannot verify that without admin rights.`,
            hint:
              'A Jira admin sees the contexts under Settings → Issues → Custom fields. Jira refuses the field for a ticket ' +
              'outside its context, and each move of that ticket then warns.',
          });
          continue;
        }
        if (field && !problem) {
          checks.push({ check: 'fields', level: 'ok', message: `fields.${param} → ${fieldLabel(field)}: ${fieldKind(field)}` });
          continue;
        }
        checks.push({
          check: 'fields',
          level: 'fail',
          message: field
            ? `fields.${param}: ${fieldLabel(field)} ${problem}; dfl writes params as single-line text`
            : `fields.${param}: Jira has no field ${id}`,
          hint: `Map a single-line text or URL field with \`dfl tracker field ${param} <customfield_id>\`, or remove it with \`dfl tracker field ${param} --none\`.`,
        });
      }
    }
  }
  return checks;
}

/** Reads the projects one by one; the statuses and issue types of those that could be read. */
async function readCatalog(
  client: JiraClient,
  projects: readonly string[],
): Promise<{ catalog: StatusCatalog; counts: Map<string, number>; failures: Array<{ project: string; error: unknown }> }> {
  const catalog: StatusCatalog = { statuses: [], issueTypes: [], projects: [] };
  const counts = new Map<string, number>();
  const failures: Array<{ project: string; error: unknown }> = [];
  for (const project of projects) {
    try {
      const read = await client.projectCatalog(project);
      catalog.projects.push(project);
      counts.set(project, read.statuses.length);
      for (const status of read.statuses) if (!catalog.statuses.some((s) => s.id === status.id)) catalog.statuses.push(status);
      for (const type of read.issueTypes) if (!catalog.issueTypes.includes(type)) catalog.issueTypes.push(type);
    } catch (error) {
      failures.push({ project, error });
    }
  }
  return { catalog, counts, failures };
}

function failed(check: string, error: unknown): TrackerCheck {
  return { check, level: 'fail', message: errorMessage(error), ...(isDflError(error) && error.hint ? { hint: error.hint } : {}) };
}
