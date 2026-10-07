/**
 * A fake Jira Cloud (REST API v3) for tests: a node:http server on 127.0.0.1 (random port).
 *
 * Emulates Basic auth (configurable accounts and permissions; bad credentials are served like
 * Jira Cloud does, as an anonymous user – see `badAuth`), GET /myself,
 * GET /issue/{key}?fields&properties, PUT /issue/{key}/properties/{prop}, GET/POST
 * /issue/{key}/transitions (a workflow: status → allowed targets; POST validates the id, applies
 * the status and the `fields`, which must be on the transition's screen), PUT /issue/{key}
 * (fields; unknown field ids → 400), GET /project/{key}/statuses and GET /field. Status and
 * issue-type names can be translated into the account's language (`language`). Every request is
 * recorded (`requests`, without credentials); `setFailure` injects a status code and/or a delay
 * per route.
 *
 * ```ts
 * const jira = await createFakeJira({ issues: [{ key: 'ABC-1', summary: 'Export CSV' }] });
 * // tracker.json: "baseUrl": jira.url  (plain http is allowed for 127.0.0.1)
 * vi.stubEnv('DFL_JIRA_URL', jira.url); … or credentialEnv(jira)
 * jira.issue('ABC-1').status = 'Blocked';            // a human moved the ticket
 * jira.setFailure('transition', 500);                // every POST /transitions fails
 * jira.setFailure('getIssue', { delayMs: 500 });     // with DFL_TRACKER_TIMEOUT_MS=100 → timeout
 * await jira.close();
 * ```
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeStatusCategory = 'new' | 'indeterminate' | 'done';

export interface FakeJiraStatus {
  id: string;
  name: string;
  categoryKey: FakeStatusCategory;
}

export interface FakeJiraAccount {
  email: string;
  token: string;
  accountId?: string | undefined;
  displayName?: string | undefined;
  /** Project permissions (all true by default). `edit: false` + `transition: true` = Transition-without-Edit. */
  permissions?: { browse?: boolean | undefined; edit?: boolean | undefined; transition?: boolean | undefined } | undefined;
}

export interface FakeJiraIssueInput {
  key: string;
  /** Numeric issue id (default: generated, 10001, 10002, …). */
  id?: string | undefined;
  summary?: string | undefined;
  /** Status name (default: the first `new`-category status, "To Do"). */
  status?: string | undefined;
  issueType?: string | undefined;
  /** Entity properties (e.g. `{ 'dfl.run': record }`). */
  properties?: Record<string, unknown> | undefined;
  /** Other field values by field id (e.g. `customfield_10042`). */
  fields?: Record<string, unknown> | undefined;
}

/** The live state of an issue; mutate it to simulate people or automation. */
export interface FakeJiraIssue {
  id: string;
  key: string;
  summary: string;
  /** Status name. */
  status: string;
  issueType: string;
  properties: Record<string, unknown>;
  fields: Record<string, unknown>;
}

/**
 * A transition target: a status name, or a named transition with a screen: `requires` lists the
 * fields the screen requires (such as `resolution`), `screen` further optional ones. A transition
 * has a screen when either is non-empty; like Jira, POST /transitions refuses `fields` that are
 * not on the screen (so every field of a screenless transition) with 400.
 */
export type FakeWorkflowTarget =
  | string
  | { to: string; name?: string | undefined; id?: string | undefined; requires?: string[] | undefined; screen?: string[] | undefined };

export interface FakeJiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type: string; custom?: string | undefined } | undefined;
}

export interface FakeJiraOptions {
  /** Default: one account `dev@example.com` / `test-token`. */
  accounts?: FakeJiraAccount[] | undefined;
  issues?: FakeJiraIssueInput[] | undefined;
  /** Status catalog (default {@link DEFAULT_STATUSES}). */
  statuses?: FakeJiraStatus[] | undefined;
  /** Status name → allowed targets. Default: every status can move to every other one (transition "To <status>"). */
  workflow?: Record<string, FakeWorkflowTarget[]> | undefined;
  /** Project key → status names of the project. Default: every catalog status, for the projects of `issues` and ABC. */
  projectStatuses?: Record<string, string[]> | undefined;
  /** Field catalog (default {@link DEFAULT_FIELDS}). */
  fields?: FakeJiraField[] | undefined;
  /** Issue types listed by GET /project/{key}/statuses (default Task, Bug). */
  issueTypes?: string[] | undefined;
  /**
   * How requests with bad credentials (an expired, revoked or wrong token) are answered. Jira Cloud
   * serves them as an anonymous user: `'anonymous'` (default) answers 401 only on GET /myself, 404
   * on issue and project routes and 200 with empty data on GET /field, each with
   * `X-Seraph-LoginReason: AUTHENTICATED_FAILED`; `'anonymous-no-header'` the same without that
   * header; `'401'` answers 401 on every route.
   */
  badAuth?: 'anonymous' | 'anonymous-no-header' | '401' | undefined;
  /**
   * The account's Jira language: status and issue-type names are translated with `names` (name →
   * translated name; names without an entry stay) and statuses and issue types of issues carry
   * `untranslatedName`, unless the request forces English (`X-Force-Accept-Language: true` with
   * `Accept-Language: en…`), as Jira Cloud does. `ignoreForcedLanguage` translates anyway.
   */
  language?: { names: Record<string, string>; ignoreForcedLanguage?: boolean | undefined } | undefined;
}

export type FakeRoute =
  | 'myself'
  | 'getIssue'
  | 'putProperty'
  | 'getTransitions'
  | 'transition'
  | 'editIssue'
  | 'projectStatuses'
  | 'listFields';

export interface FakeFailure {
  /** Respond with this status (and `body`) instead of handling the request. */
  status?: number | undefined;
  /** Wait this long before responding (handled normally afterwards unless `status` is set). */
  delayMs?: number | undefined;
  /** Body of the injected response (default `{ errorMessages: ['Injected failure'] }`). */
  body?: unknown;
  headers?: Record<string, string> | undefined;
  /** Number of requests affected (default: all until cleared). */
  times?: number | undefined;
}

export interface FakeJiraRequest {
  method: string;
  /** Path below `/rest/api/3` (e.g. `/issue/ABC-1/transitions`); the full path for unknown routes. */
  path: string;
  route: FakeRoute | undefined;
  query: Record<string, string>;
  body: unknown;
  /** Email of the authenticated account (undefined when auth failed). */
  account: string | undefined;
  /** Request headers (lower-case names), without Authorization. */
  headers: Record<string, string>;
  /** Status sent. */
  status: number;
}

export interface FakeJira {
  /** `http://127.0.0.1:<port>` – use as `jira.baseUrl`. */
  url: string;
  origin: string;
  requests: FakeJiraRequest[];
  /** The live issue (throws when there is none). */
  issue(key: string): FakeJiraIssue;
  addIssue(input: FakeJiraIssueInput): FakeJiraIssue;
  /** Injects a failure for a route (`undefined` clears it); a number is a status code. */
  setFailure(route: FakeRoute, failure: number | FakeFailure | undefined): void;
  clearFailures(): void;
  /** Requests of one route. */
  requestsTo(route: FakeRoute): FakeJiraRequest[];
  close(): Promise<void>;
}

export const DEFAULT_ACCOUNT: FakeJiraAccount = {
  email: 'dev@example.com',
  token: 'test-token',
  accountId: '5b10ac8d82e05b22cc7d4ef5',
  displayName: 'Dev Eloper',
};

export const DEFAULT_STATUSES: FakeJiraStatus[] = [
  { id: '10000', name: 'To Do', categoryKey: 'new' },
  { id: '3', name: 'In Progress', categoryKey: 'indeterminate' },
  { id: '10004', name: 'In Review', categoryKey: 'indeterminate' },
  { id: '10005', name: 'Blocked', categoryKey: 'indeterminate' },
  { id: '10001', name: 'Done', categoryKey: 'done' },
];

export const DEFAULT_FIELDS: FakeJiraField[] = [
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
  { id: 'labels', name: 'Labels', custom: false, schema: { type: 'array' } },
  { id: 'resolution', name: 'Resolution', custom: false, schema: { type: 'resolution' } },
  {
    id: 'customfield_10042',
    name: 'Branch',
    custom: true,
    schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' },
  },
  {
    id: 'customfield_10077',
    name: 'Pull request',
    custom: true,
    schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:url' },
  },
  {
    id: 'customfield_10088',
    name: 'Notes',
    custom: true,
    schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' },
  },
  { id: 'customfield_10099', name: 'Story points', custom: true, schema: { type: 'number' } },
];

/** `DFL_JIRA_*` variables that make dfl use `account` (default {@link DEFAULT_ACCOUNT}) for this fake. */
export function credentialEnv(jira: Pick<FakeJira, 'url'>, account: FakeJiraAccount = DEFAULT_ACCOUNT): Record<string, string> {
  return { DFL_JIRA_URL: jira.url, DFL_JIRA_EMAIL: account.email, DFL_JIRA_TOKEN: account.token };
}

const API = '/rest/api/3';
const PROPERTY_MAX_BYTES = 32_768;

export async function createFakeJira(options: FakeJiraOptions = {}): Promise<FakeJira> {
  const accounts = options.accounts ?? [DEFAULT_ACCOUNT];
  const statuses = options.statuses ?? DEFAULT_STATUSES;
  const fieldCatalog = options.fields ?? DEFAULT_FIELDS;
  const issueTypes = options.issueTypes ?? ['Task', 'Bug'];
  const issues = new Map<string, FakeJiraIssue>();
  const failures = new Map<FakeRoute, FakeFailure>();
  const timers = new Set<NodeJS.Timeout>();
  const requests: FakeJiraRequest[] = [];
  let nextId = 10001;

  const statusByName = (name: string): FakeJiraStatus => {
    const found = statuses.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new Error(`fake-jira: unknown status "${name}"`);
    return found;
  };
  const defaultStatus = statuses.find((s) => s.categoryKey === 'new') ?? statuses[0]!;

  const addIssue = (input: FakeJiraIssueInput): FakeJiraIssue => {
    const issue: FakeJiraIssue = {
      id: input.id ?? String(nextId++),
      key: input.key,
      summary: input.summary ?? `Issue ${input.key}`,
      status: statusByName(input.status ?? defaultStatus.name).name,
      issueType: input.issueType ?? issueTypes[0] ?? 'Task',
      properties: { ...(input.properties ?? {}) },
      fields: { ...(input.fields ?? {}) },
    };
    issues.set(issue.key.toUpperCase(), issue);
    return issue;
  };
  for (const input of options.issues ?? []) addIssue(input);

  const projectStatuses: Record<string, string[]> = options.projectStatuses ?? {};
  if (!options.projectStatuses) {
    const projects = new Set(['ABC', ...[...issues.values()].map((issue) => projectOf(issue.key))]);
    for (const project of projects) projectStatuses[project] = statuses.map((s) => s.name);
  }

  /** Transitions available from the issue's current status (`screen`: every field on its screen). */
  const transitionsFrom = (statusName: string): Array<{ id: string; name: string; to: FakeJiraStatus; requires: string[]; screen: string[] }> => {
    const configured = options.workflow
      ? (Object.entries(options.workflow).find(([from]) => from.toLowerCase() === statusName.toLowerCase())?.[1] ?? [])
      : statuses.filter((s) => s.name.toLowerCase() !== statusName.toLowerCase()).map((s) => s.name);
    return configured.map((target) => {
      const spec = typeof target === 'string' ? { to: target } : target;
      const to = statusByName(spec.to);
      const requires = spec.requires ?? [];
      return { id: spec.id ?? `tr-${to.id}`, name: spec.name ?? `To ${to.name}`, to, requires, screen: [...requires, ...(spec.screen ?? [])] };
    });
  };

  /** `{ name }` of a status or issue type, translated and with `untranslatedName` when `options.language` is set. */
  const named = (name: string, translate: boolean): { name: string; untranslatedName?: string } =>
    options.language ? { name: translate ? (options.language.names[name] ?? name) : name, untranslatedName: name } : { name };

  const statusJson = (status: FakeJiraStatus, translate: boolean): unknown => ({
    id: status.id,
    ...named(status.name, translate),
    statusCategory: { key: status.categoryKey, name: categoryName(status.categoryKey) },
  });

  const knownField = (id: string): boolean => fieldCatalog.some((f) => f.id === id) || id === 'resolution';

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      const fullPath = url.pathname;
      const path = fullPath.startsWith(API) ? fullPath.slice(API.length) : fullPath;
      const query = Object.fromEntries(url.searchParams.entries());
      const text = Buffer.concat(chunks).toString('utf8');
      const account = authenticate(req.headers.authorization, accounts);
      const route = fullPath.startsWith(API) ? routeOf(method, path) : undefined;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) if (name !== 'authorization' && typeof value === 'string') headers[name] = value;
      const entry: FakeJiraRequest = { method, path, route: route?.name, query, body: undefined, account: account?.email, headers, status: 0 };
      requests.push(entry);
      const forcedEnglish = headers['x-force-accept-language'] === 'true' && /^en\b/i.test(headers['accept-language'] ?? '');
      const translate = options.language !== undefined && (!forcedEnglish || options.language.ignoreForcedLanguage === true);

      const send = (status: number, body?: unknown, headers: Record<string, string> = {}): void => {
        entry.status = status;
        if (res.destroyed || res.writableEnded) return;
        if (body === undefined) {
          res.writeHead(status, headers);
          res.end();
        } else if (typeof body === 'string') {
          res.writeHead(status, { 'Content-Type': 'text/plain;charset=UTF-8', ...headers });
          res.end(body);
        } else {
          res.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8', ...headers });
          res.end(JSON.stringify(body));
        }
      };

      let body: unknown;
      if (text !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          send(400, { errorMessages: ['Unexpected character in the request body (not JSON).'], errors: {} });
          return;
        }
      }
      entry.body = body;

      const handle = (): void => {
        if (!account) {
          // Jira Cloud serves a request with bad credentials as an anonymous user.
          const mode = options.badAuth ?? 'anonymous';
          const reason: Record<string, string> = mode === 'anonymous' ? { 'X-Seraph-LoginReason': 'AUTHENTICATED_FAILED' } : {};
          if (mode === '401' || route?.name === 'myself') send(401, 'Client must be authenticated to access this resource.', reason);
          else if (route?.name === 'listFields') send(200, [], reason);
          else if (route?.name === 'projectStatuses') send(404, { errorMessages: [`No project could be found with key '${route.params[0]}'.`], errors: {} }, reason);
          else if (route) send(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} }, reason);
          else send(404, { errorMessages: [`No route for ${method} ${fullPath}`], errors: {} }, reason);
          return;
        }
        if (!route) {
          send(404, { errorMessages: [`No route for ${method} ${fullPath}`], errors: {} });
          return;
        }
        const perms = { browse: true, edit: true, transition: true, ...(account.permissions ?? {}) };
        const issueOr404 = (key: string): FakeJiraIssue | undefined => {
          const issue = issues.get(key.toUpperCase());
          if (!issue || !perms.browse) {
            send(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} });
            return undefined;
          }
          return issue;
        };

        switch (route.name) {
          case 'myself':
            send(200, {
              accountId: account.accountId ?? `acc-${account.email}`,
              displayName: account.displayName ?? account.email,
              emailAddress: account.email,
              active: true,
            });
            return;
          case 'listFields':
            send(200, fieldCatalog);
            return;
          case 'projectStatuses': {
            const project = route.params[0]!;
            const names = Object.hasOwn(projectStatuses, project) ? projectStatuses[project] : undefined;
            if (!names || !perms.browse) {
              send(404, { errorMessages: [`No project could be found with key '${project}'.`], errors: {} });
              return;
            }
            const list = names.map((name) => statusJson(statusByName(name), translate));
            // Like Jira, the issue types of this list have no untranslatedName.
            send(
              200,
              issueTypes.map((type, i) => ({ id: String(i + 1), name: named(type, translate).name, subtask: false, statuses: list })),
            );
            return;
          }
          case 'getIssue': {
            const issue = issueOr404(route.params[0]!);
            if (!issue) return;
            const wanted = (query['fields'] ?? '*all').split(',').map((f) => f.trim()).filter(Boolean);
            const all = wanted.includes('*all') || wanted.includes('*navigable');
            const fields: Record<string, unknown> = {};
            const want = (id: string): boolean => all || wanted.includes(id);
            if (want('summary')) fields['summary'] = issue.summary;
            if (want('status')) fields['status'] = statusJson(statusByName(issue.status), translate);
            if (want('issuetype')) fields['issuetype'] = { ...named(issue.issueType, translate), subtask: false };
            if (want('project')) fields['project'] = { key: projectOf(issue.key), name: `Project ${projectOf(issue.key)}` };
            for (const id of wanted) if (id !== '*all' && !(id in fields) && knownField(id)) fields[id] = issue.fields[id] ?? null;
            if (all) for (const [id, value] of Object.entries(issue.fields)) fields[id] = value;
            const properties: Record<string, unknown> = {};
            for (const name of (query['properties'] ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
              if (Object.hasOwn(issue.properties, name)) properties[name] = issue.properties[name];
            }
            send(200, { id: issue.id, key: issue.key, self: `${API}/issue/${issue.id}`, fields, properties });
            return;
          }
          case 'putProperty': {
            const issue = issueOr404(route.params[0]!);
            if (!issue) return;
            if (!perms.edit) {
              send(403, { errorMessages: ['You do not have permission to edit issues in this project.'], errors: {} });
              return;
            }
            if (body === undefined) {
              send(400, { errorMessages: ['The property value must be valid JSON.'], errors: {} });
              return;
            }
            if (Buffer.byteLength(text, 'utf8') > PROPERTY_MAX_BYTES) {
              send(400, { errorMessages: ['The property value is too large (the limit is 32768 bytes).'], errors: {} });
              return;
            }
            const name = route.params[1]!;
            const created = !Object.hasOwn(issue.properties, name);
            issue.properties[name] = body;
            send(created ? 201 : 200);
            return;
          }
          case 'getTransitions': {
            const issue = issueOr404(route.params[0]!);
            if (!issue) return;
            const list = perms.transition ? transitionsFrom(issue.status) : [];
            send(200, {
              expand: 'transitions',
              transitions: list.map((t) => ({ id: t.id, name: t.name, to: statusJson(t.to, translate), hasScreen: t.screen.length > 0 })),
            });
            return;
          }
          case 'transition': {
            const issue = issueOr404(route.params[0]!);
            if (!issue) return;
            if (!perms.transition) {
              send(403, { errorMessages: ['You do not have permission to transition this issue.'], errors: {} });
              return;
            }
            const request = (body ?? {}) as { transition?: { id?: unknown }; fields?: Record<string, unknown> };
            const id = String(request.transition?.id ?? '');
            const chosen = transitionsFrom(issue.status).find((t) => t.id === id);
            if (!chosen) {
              send(400, { errorMessages: [`Transition id '${id}' is not valid for this issue.`], errors: {} });
              return;
            }
            const fields = request.fields ?? {};
            // Jira refuses fields that are unknown or not on the transition's screen (all of them without a screen).
            const refused = Object.keys(fields).filter((f) => !knownField(f) || !chosen.screen.includes(f));
            if (refused.length > 0) {
              send(400, { errorMessages: [], errors: Object.fromEntries(refused.map((f) => [f, fieldError(f)])) });
              return;
            }
            const missing = chosen.requires.filter((f) => fields[f] === undefined || fields[f] === null);
            if (missing.length > 0) {
              send(400, { errorMessages: [], errors: Object.fromEntries(missing.map((f) => [f, `${titleOf(f)} is required.`])) });
              return;
            }
            issue.status = chosen.to.name;
            Object.assign(issue.fields, fields);
            send(204);
            return;
          }
          case 'editIssue': {
            const issue = issueOr404(route.params[0]!);
            if (!issue) return;
            if (!perms.edit) {
              send(403, { errorMessages: ['You do not have permission to edit issues in this project.'], errors: {} });
              return;
            }
            const fields = ((body ?? {}) as { fields?: Record<string, unknown> }).fields ?? {};
            const unknown = Object.keys(fields).filter((f) => !knownField(f));
            if (unknown.length > 0) {
              send(400, { errorMessages: [], errors: Object.fromEntries(unknown.map((f) => [f, fieldError(f)])) });
              return;
            }
            Object.assign(issue.fields, fields);
            send(204);
            return;
          }
        }
      };

      const failure = route ? failures.get(route.name) : undefined;
      if (failure && route) {
        if (failure.times !== undefined) {
          failure.times -= 1;
          if (failure.times <= 0) failures.delete(route.name);
        }
        const respond = (): void => {
          if (failure.status !== undefined) send(failure.status, failure.body ?? { errorMessages: ['Injected failure'], errors: {} }, failure.headers);
          else handle();
        };
        if (failure.delayMs !== undefined && failure.delayMs > 0) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            respond();
          }, failure.delayMs);
          timers.add(timer);
        } else {
          respond();
        }
        return;
      }
      handle();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    origin: url,
    requests,
    issue(key) {
      const issue = issues.get(key.toUpperCase());
      if (!issue) throw new Error(`fake-jira: no issue ${key}`);
      return issue;
    },
    addIssue,
    setFailure(route, failure) {
      if (failure === undefined) failures.delete(route);
      else failures.set(route, typeof failure === 'number' ? { status: failure } : { ...failure });
    },
    clearFailures() {
      failures.clear();
    },
    requestsTo(route) {
      return requests.filter((r) => r.route === route);
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function routeOf(method: string, path: string): { name: FakeRoute; params: string[] } | undefined {
  const parts = path.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  const [a, b, c, d] = parts;
  if (method === 'GET' && parts.length === 1 && a === 'myself') return { name: 'myself', params: [] };
  if (method === 'GET' && parts.length === 1 && a === 'field') return { name: 'listFields', params: [] };
  if (method === 'GET' && parts.length === 3 && a === 'project' && c === 'statuses') return { name: 'projectStatuses', params: [b!] };
  if (a !== 'issue' || b === undefined) return undefined;
  if (parts.length === 2 && method === 'GET') return { name: 'getIssue', params: [b] };
  if (parts.length === 2 && method === 'PUT') return { name: 'editIssue', params: [b] };
  if (parts.length === 3 && c === 'transitions' && method === 'GET') return { name: 'getTransitions', params: [b] };
  if (parts.length === 3 && c === 'transitions' && method === 'POST') return { name: 'transition', params: [b] };
  if (parts.length === 4 && c === 'properties' && method === 'PUT') return { name: 'putProperty', params: [b, d!] };
  return undefined;
}

function authenticate(header: string | undefined, accounts: FakeJiraAccount[]): FakeJiraAccount | undefined {
  const match = /^Basic\s+(.+)$/i.exec(header ?? '');
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  const email = decoded.slice(0, colon);
  const token = decoded.slice(colon + 1);
  return accounts.find((a) => a.email === email && a.token === token);
}

function projectOf(key: string): string {
  return key.toUpperCase().replace(/-\d+$/, '');
}

function categoryName(key: FakeStatusCategory): string {
  return key === 'new' ? 'To Do' : key === 'done' ? 'Done' : 'In Progress';
}

function fieldError(field: string): string {
  return `Field '${field}' cannot be set. It is not on the appropriate screen, or unknown.`;
}

function titleOf(field: string): string {
  return field.charAt(0).toUpperCase() + field.slice(1);
}
