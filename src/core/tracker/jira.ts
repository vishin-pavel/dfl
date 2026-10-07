/**
 * Jira Cloud REST API v3 client (the calls dfl needs, nothing more). Responses are normalized to
 * small typed shapes; a response without the expected parts is DflError `TRACKER_HTTP`.
 * Errors: see {@link jiraRequest}; a 404 of an issue or project request may become `TRACKER_AUTH`
 * (see {@link createJiraClient}).
 *
 * Status and issue-type names: dfl asks for English names (http.ts), and keeps Jira's
 * `untranslatedName` (the name the workflow was created with) when the response has one, so a
 * name mapping can match either (projection.ts `nameMatches`).
 */
import { DflError } from '../errors.js';
import { TrackerError, jiraRequest, type JiraConnection, type JiraRequest } from './http.js';

export interface JiraStatus {
  id: string;
  /** The name in the requested language (English). */
  name: string;
  /** The name the status was created with, when Jira sent one. */
  untranslatedName?: string | undefined;
  statusCategory: { key: string };
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: JiraStatus;
    issuetype: { name: string; untranslatedName?: string | undefined };
    project: { key: string };
    /** Any other requested field, as Jira returned it. */
    [field: string]: unknown;
  };
  /** Requested entity properties that are set (missing ones are absent). */
  properties: Record<string, unknown>;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatus;
  /**
   * Whether the transition shows a screen (absent when Jira did not say). Jira rejects `fields`
   * sent with a transition that has no screen, or that are not on its screen.
   */
  hasScreen?: boolean | undefined;
}

/** A status of a project (unique across its issue types). */
export interface JiraProjectStatus {
  id: string;
  name: string;
  /** The name the status was created with, when Jira sent one. */
  untranslatedName?: string | undefined;
  categoryKey?: string | undefined;
}

/** The statuses and issue types of a project (GET /project/{key}/statuses). */
export interface JiraProjectCatalog {
  statuses: JiraProjectStatus[];
  /** Issue type names (the untranslated name when Jira sent one). */
  issueTypes: string[];
}

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type: string; custom?: string | undefined } | undefined;
}

export interface JiraMyself {
  accountId: string;
  displayName: string;
  emailAddress?: string | undefined;
}

/** Jira `historyMetadata`: shown in the issue history next to dfl's transitions and edits. */
export interface HistoryMetadata {
  type: string;
  description: string;
}

export interface JiraClient {
  readonly origin: string;
  /** Email of the credential (for messages). */
  readonly email: string;
  myself(): Promise<JiraMyself>;
  /** The issue with {@link ISSUE_FIELDS} plus `options.fields`, and the requested entity properties. */
  getIssue(key: string, options?: { fields?: string[] | undefined; properties?: string[] | undefined }): Promise<JiraIssue>;
  putProperty(key: string, property: string, value: unknown): Promise<void>;
  getTransitions(key: string): Promise<JiraTransition[]>;
  transition(key: string, transitionId: string, options: { fields?: Record<string, unknown> | undefined; historyMetadata: HistoryMetadata }): Promise<void>;
  editIssue(key: string, options: { fields: Record<string, unknown>; historyMetadata: HistoryMetadata }): Promise<void>;
  projectStatuses(projectKey: string): Promise<JiraProjectStatus[]>;
  /** {@link JiraClient.projectStatuses} plus the names of the project's issue types (one request). */
  projectCatalog(projectKey: string): Promise<JiraProjectCatalog>;
  listFields(): Promise<JiraField[]>;
}

export interface CreateJiraClientOptions {
  /** Site URL; only its origin is used. */
  baseUrl: string;
  credential: { readonly email: string; readonly token: string };
  /** The operation's deadline (`trackerDeadline()`), shared by every request of the client. */
  signal?: AbortSignal | undefined;
}

/** Fields `getIssue` requests by default. */
export const ISSUE_FIELDS: readonly string[] = ['summary', 'status', 'issuetype', 'project'];
/** Jira caps `historyMetadata.description`. */
const HISTORY_DESCRIPTION_MAX = 255;

/**
 * A client for one site and credential; its requests share `options.signal`.
 *
 * With an expired, revoked or wrong API token Jira Cloud answers as for an anonymous user: an issue
 * or project is then "not found" (404). http.ts recognizes the X-Seraph-LoginReason header Jira
 * usually adds; when a 404 of an issue or project request comes without it, the client asks GET
 * /myself once and throws its `TRACKER_AUTH` instead of the 404 (one extra request, only on a 404).
 */
export function createJiraClient(options: CreateJiraClientOptions): JiraClient {
  const conn: JiraConnection = { origin: new URL(options.baseUrl).origin, credential: options.credential, signal: options.signal };
  const email = options.credential.email;
  let authProbe: Promise<TrackerError | undefined> | undefined;
  /** The TRACKER_AUTH error of GET /myself, or undefined when it worked or failed otherwise (asked once). */
  const authFailure = (): Promise<TrackerError | undefined> => {
    authProbe ??= jiraRequest(conn, { method: 'GET', path: '/myself' }).then(
      () => undefined,
      (error: unknown) => (error instanceof TrackerError && error.code === 'TRACKER_AUTH' ? error : undefined),
    );
    return authProbe;
  };
  const send = async <T>(request: JiraRequest): Promise<T | undefined> => {
    try {
      return await jiraRequest<T>(conn, request);
    } catch (error) {
      if (request.notFound && error instanceof TrackerError && error.status === 404 && error.code === request.notFound.code) {
        throw (await authFailure()) ?? error;
      }
      throw error;
    }
  };
  const issueNotFound = (key: string): JiraRequest['notFound'] => ({
    message: `${key} does not exist or is not visible to ${email}.`,
    hint: 'Check the ticket key, and that this account can browse the project.',
    code: 'TASK_NOT_FOUND',
  });
  const issuePath = (key: string): string => `/issue/${encodeURIComponent(key)}`;
  const projectCatalog = async (projectKey: string): Promise<JiraProjectCatalog> => {
    const label = `GET /project/${projectKey}/statuses`;
    const data = await send<unknown>({
      method: 'GET',
      path: `/project/${encodeURIComponent(projectKey)}/statuses`,
      notFound: {
        message: `Project ${projectKey} does not exist on ${conn.origin} or is not visible to ${email}.`,
        hint: 'Check "jira.projectKeys" in .df/tracker.json, and that this account can browse the project.',
        code: 'TRACKER_PROJECT_NOT_FOUND',
      },
    });
    if (!Array.isArray(data)) throw unexpected(label);
    const statuses: JiraProjectStatus[] = [];
    const issueTypes: string[] = [];
    const seen = new Set<string>();
    for (const item of data) {
      const issueType = record(item, label);
      const typeName = untranslatedName(issueType) ?? optionalString(issueType['name']);
      if (typeName !== undefined && typeName !== '' && !issueTypes.includes(typeName)) issueTypes.push(typeName);
      const list = issueType['statuses'];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const s = record(entry, label);
        const id = requireString(s['id'], label);
        if (seen.has(id)) continue;
        seen.add(id);
        const category = s['statusCategory'] === undefined ? undefined : optionalString(record(s['statusCategory'], label)['key']);
        const base = untranslatedName(s);
        statuses.push({
          id,
          name: optionalString(s['name']) ?? '',
          ...(base !== undefined ? { untranslatedName: base } : {}),
          ...(category !== undefined ? { categoryKey: category } : {}),
        });
      }
    }
    return { statuses, issueTypes };
  };

  return {
    origin: conn.origin,
    email,

    async myself() {
      const data = record(await send<unknown>({ method: 'GET', path: '/myself' }), 'GET /myself');
      return {
        accountId: requireString(data['accountId'], 'GET /myself'),
        displayName: optionalString(data['displayName']) ?? '',
        ...(typeof data['emailAddress'] === 'string' ? { emailAddress: data['emailAddress'] } : {}),
      };
    },

    async getIssue(key, issueOptions = {}) {
      const fields = [...new Set([...ISSUE_FIELDS, ...(issueOptions.fields ?? [])])];
      const properties = issueOptions.properties ?? [];
      const label = `GET ${issuePath(key)}`;
      const data = record(
        await send<unknown>({
          method: 'GET',
          path: issuePath(key),
          query: { fields: fields.join(','), ...(properties.length > 0 ? { properties: properties.join(',') } : {}) },
          notFound: issueNotFound(key),
        }),
        label,
      );
      const rawFields = record(data['fields'], label);
      const issuetype = rawFields['issuetype'] === undefined ? {} : record(rawFields['issuetype'], label);
      const issuetypeBase = untranslatedName(issuetype);
      const project = rawFields['project'] === undefined ? {} : record(rawFields['project'], label);
      return {
        id: requireString(data['id'], label),
        key: requireString(data['key'], label),
        fields: {
          ...rawFields,
          summary: optionalString(rawFields['summary']) ?? '',
          status: status(rawFields['status'], label),
          issuetype: { name: optionalString(issuetype['name']) ?? '', ...(issuetypeBase !== undefined ? { untranslatedName: issuetypeBase } : {}) },
          project: { key: optionalString(project['key']) ?? '' },
        },
        properties: data['properties'] === undefined ? {} : { ...record(data['properties'], label) },
      };
    },

    async putProperty(key, property, value) {
      await send({
        method: 'PUT',
        path: `${issuePath(key)}/properties/${encodeURIComponent(property)}`,
        body: value,
        notFound: issueNotFound(key),
      });
    },

    async getTransitions(key) {
      const label = `GET ${issuePath(key)}/transitions`;
      const data = record(await send<unknown>({ method: 'GET', path: `${issuePath(key)}/transitions`, notFound: issueNotFound(key) }), label);
      const list = data['transitions'];
      if (!Array.isArray(list)) throw unexpected(label);
      return list.map((item) => {
        const t = record(item, label);
        return {
          id: requireString(t['id'], label),
          name: optionalString(t['name']) ?? '',
          to: status(t['to'], label),
          ...(typeof t['hasScreen'] === 'boolean' ? { hasScreen: t['hasScreen'] } : {}),
        };
      });
    },

    async transition(key, transitionId, transitionOptions) {
      await send({
        method: 'POST',
        path: `${issuePath(key)}/transitions`,
        body: {
          transition: { id: transitionId },
          ...(transitionOptions.fields && Object.keys(transitionOptions.fields).length > 0 ? { fields: transitionOptions.fields } : {}),
          historyMetadata: transitionOptions.historyMetadata,
        },
        notFound: issueNotFound(key),
      });
    },

    async editIssue(key, editOptions) {
      await send({
        method: 'PUT',
        path: issuePath(key),
        body: { fields: editOptions.fields, historyMetadata: editOptions.historyMetadata },
        notFound: issueNotFound(key),
      });
    },

    async projectStatuses(projectKey) {
      return (await projectCatalog(projectKey)).statuses;
    },

    projectCatalog,

    async listFields() {
      const label = 'GET /field';
      const data = await send<unknown>({ method: 'GET', path: '/field' });
      if (!Array.isArray(data)) throw unexpected(label);
      return data.map((item) => {
        const f = record(item, label);
        const schema = f['schema'] === undefined ? undefined : record(f['schema'], label);
        const custom = optionalString(schema?.['custom']);
        return {
          id: requireString(f['id'], label),
          name: optionalString(f['name']) ?? '',
          custom: f['custom'] === true,
          ...(schema ? { schema: { type: optionalString(schema['type']) ?? '', ...(custom !== undefined ? { custom } : {}) } } : {}),
        };
      });
    },
  };
}

/** `{ type: 'dfl', description: 'dfl: <from> <event> → <to>' }` (description capped at 255 characters). */
export function historyMetadata(from: string, event: string, to: string): HistoryMetadata {
  const description = `dfl: ${from || '(start)'} ${event} → ${to}`;
  return {
    type: 'dfl',
    description: description.length > HISTORY_DESCRIPTION_MAX ? `${description.slice(0, HISTORY_DESCRIPTION_MAX - 3)}...` : description,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function unexpected(label: string): DflError {
  return new DflError(`Jira returned an unexpected response to ${label}.`, {
    hint: 'Check "jira.baseUrl" in .df/tracker.json: dfl supports Jira Cloud (REST API v3).',
    code: 'TRACKER_HTTP',
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw unexpected(label);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  throw unexpected(label);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function status(value: unknown, label: string): JiraStatus {
  const s = record(value, label);
  const category = s['statusCategory'] === undefined ? {} : record(s['statusCategory'], label);
  const base = untranslatedName(s);
  return {
    id: requireString(s['id'], label),
    name: optionalString(s['name']) ?? '',
    ...(base !== undefined ? { untranslatedName: base } : {}),
    statusCategory: { key: optionalString(category['key']) ?? '' },
  };
}

/** A status's or issue type's non-empty `untranslatedName`. */
function untranslatedName(value: Record<string, unknown>): string | undefined {
  const name = optionalString(value['untranslatedName']);
  return name !== undefined && name !== '' ? name : undefined;
}
