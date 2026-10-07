/**
 * HTTP for the tracker client: one JSON request to the Jira REST API with Basic auth, mapped to
 * DflErrors (see {@link jiraRequest}).
 *
 * - One overall deadline per dfl operation ({@link trackerDeadline}): every request of one tool
 *   call or CLI command shares it. No automatic retries.
 * - Redirects are never followed (a redirect would carry the credentials to another URL).
 * - Every request asks for English (`Accept-Language: en` with `X-Force-Accept-Language: true`,
 *   without which Jira Cloud ignores Accept-Language): status and issue-type names then do not
 *   depend on each user's Jira language, so the names in the shared tracker.json match for everyone.
 * - `DFL_DEBUG=1` logs method, path, status and duration to stderr – never headers, query values
 *   or bodies.
 */
import { DflError, errorMessage } from '../errors.js';

/** Base path of the Jira Cloud REST API v3. */
export const JIRA_API_BASE = '/rest/api/3';
/** Default deadline of one tracker operation (`DFL_TRACKER_TIMEOUT_MS` overrides it). */
export const DEFAULT_TRACKER_TIMEOUT_MS = 10_000;

const MAX_DETAIL_LENGTH = 500;

/** A DflError from a Jira response; `status` is the HTTP status (absent for network errors and timeouts). */
export class TrackerError extends DflError {
  readonly status: number | undefined;

  constructor(message: string, options: { hint?: string; code: string; status?: number | undefined; cause?: unknown }) {
    super(message, { ...(options.hint !== undefined ? { hint: options.hint } : {}), code: options.code, cause: options.cause });
    this.name = 'TrackerError';
    this.status = options.status;
  }
}

/** The deadline of one tracker operation in milliseconds (`DFL_TRACKER_TIMEOUT_MS`, default 10 s). */
export function trackerTimeoutMs(): number {
  const value = Number(process.env['DFL_TRACKER_TIMEOUT_MS']);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TRACKER_TIMEOUT_MS;
}

/** An AbortSignal that fires after {@link trackerTimeoutMs}: create one per dfl operation and pass it to every request. */
export function trackerDeadline(): AbortSignal {
  return AbortSignal.timeout(trackerTimeoutMs());
}

/** Who the requests go to and as whom. */
export interface JiraConnection {
  /** Site origin (`https://acme.atlassian.net`). */
  origin: string;
  credential: { readonly email: string; readonly token: string };
  /** The operation's deadline ({@link trackerDeadline}). */
  signal?: AbortSignal | undefined;
}

export interface JiraRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path below {@link JIRA_API_BASE}, starting with `/`; path segments already URL-encoded. */
  path: string;
  query?: Record<string, string | undefined> | undefined;
  /** JSON body. */
  body?: unknown;
  /** Error for a 404 (default: TRACKER_HTTP naming the path). */
  notFound?: { message: string; hint?: string | undefined; code: string } | undefined;
}

/**
 * Sends one request and returns the parsed JSON body (undefined for an empty body, e.g. 204).
 *
 * Errors (DflError {@link TrackerError}): network failure → `TRACKER_UNREACHABLE`; the deadline →
 * `TRACKER_TIMEOUT`; credentials that did not work → `TRACKER_AUTH` (see {@link authError}: 401,
 * a CAPTCHA lock-out, or any response – 2xx and 404 included – marked
 * `X-Seraph-LoginReason: AUTHENTICATED_FAILED`); 3xx → `TRACKER_HTTP` (redirects are not followed);
 * 403 → `TRACKER_FORBIDDEN`; 404 → `request.notFound`; 429 → `TRACKER_RATE_LIMITED`; other ≥ 400
 * and non-JSON success bodies → `TRACKER_HTTP` with Jira's error messages (at most 500 characters).
 */
export async function jiraRequest<T = unknown>(conn: JiraConnection, request: JiraRequest): Promise<T | undefined> {
  const label = `${request.method} ${request.path}`;
  const url = requestUrl(conn.origin, request);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': 'en',
    'X-Force-Accept-Language': 'true',
    Authorization: `Basic ${Buffer.from(`${conn.credential.email}:${conn.credential.token}`).toString('base64')}`,
  };
  if (request.body !== undefined) headers['Content-Type'] = 'application/json';

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      redirect: 'manual',
      ...(conn.signal ? { signal: conn.signal } : {}),
    });
  } catch (error) {
    debug(`${label} → failed (${Date.now() - started} ms)`);
    throw fetchError(error, conn, label);
  }
  debug(`${label} → ${response.status} (${Date.now() - started} ms)`);

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw fetchError(error, conn, label);
  }

  const auth = authError(response, conn);
  if (auth) throw auth;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    const target = location ? redirectOrigin(location, url) : undefined;
    throw new TrackerError(`Jira answered ${label} with a redirect (${response.status}${target ? ` to ${target}` : ''}); dfl does not follow redirects.`, {
      hint: 'Check "jira.baseUrl" in .df/tracker.json: it must be the Jira site itself, e.g. https://acme.atlassian.net.',
      code: 'TRACKER_HTTP',
      status: response.status,
    });
  }
  if (response.status >= 400) throw statusError(response, text, conn, request, label);

  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new TrackerError(`Jira returned an unexpected (non-JSON) response to ${label}.`, {
      hint: 'Check "jira.baseUrl" in .df/tracker.json: it must be the Jira site itself (a login or proxy page answers otherwise).',
      code: 'TRACKER_HTTP',
      status: response.status,
      cause: error,
    });
  }
}

/** Jira's `errorMessages` and `errors` of an error body, joined (at most 500 characters); '' when there are none. */
export function jiraErrorDetails(text: string): string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return '';
  }
  if (typeof data !== 'object' || data === null) return '';
  const body = data as { errorMessages?: unknown; errors?: unknown; message?: unknown };
  const parts: string[] = [];
  if (Array.isArray(body.errorMessages)) {
    for (const message of body.errorMessages) if (typeof message === 'string' && message.trim() !== '') parts.push(message.trim());
  }
  if (typeof body.errors === 'object' && body.errors !== null && !Array.isArray(body.errors)) {
    for (const [field, message] of Object.entries(body.errors)) {
      if (typeof message === 'string' && message.trim() !== '') parts.push(`${field}: ${message.trim()}`);
    }
  }
  if (parts.length === 0 && typeof body.message === 'string' && body.message.trim() !== '') parts.push(body.message.trim());
  return truncate(parts.join('; '), MAX_DETAIL_LENGTH);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requestUrl(origin: string, request: JiraRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) params.set(key, value);
  const query = params.toString();
  return `${origin}${JIRA_API_BASE}${request.path}${query ? `?${query}` : ''}`;
}

function fetchError(error: unknown, conn: JiraConnection, label: string): TrackerError {
  const name = (error as { name?: unknown } | null)?.name;
  if (conn.signal?.aborted || name === 'AbortError' || name === 'TimeoutError') {
    return new TrackerError(`Jira did not answer within ${formatDuration(trackerTimeoutMs())} (${label}).`, {
      hint:
        'The outcome of a write is unknown; repeating the command is safe for reads, goto, reset and moves that name ' +
        'their step (complete_step, or `dfl next --from <step>`). ' +
        'If Jira is just slow, raise the limit with DFL_TRACKER_TIMEOUT_MS (milliseconds; at 15000 or more, other dfl ' +
        'commands that wait for a move may fail with LOCKED).',
      code: 'TRACKER_TIMEOUT',
      cause: error,
    });
  }
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : errorMessage(error);
  const tls = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/i.test(detail);
  return new TrackerError(`Cannot reach Jira at ${conn.origin} (${detail}).`, {
    hint:
      'Check your network, VPN or proxy. Behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1 for dfl (recent Node versions). ' +
      (tls ? 'A proxy that re-signs TLS needs its CA in NODE_EXTRA_CA_CERTS. ' : '') +
      'Agents that sandbox MCP servers may block network access: allow it for the dfl server.',
    code: 'TRACKER_UNREACHABLE',
    cause: error,
  });
}

/**
 * `TRACKER_AUTH` when the response says that the credentials did not work, else undefined:
 * - a 403 whose `X-Seraph-LoginReason` contains AUTHENTICATION_DENIED: a CAPTCHA lock-out after too
 *   many failed logins (checked first: its header also contains AUTHENTICATED_FAILED);
 * - a 401;
 * - any other response – 2xx and 404 included – whose `X-Seraph-LoginReason` contains
 *   AUTHENTICATED_FAILED. With an expired, revoked or wrong API token Jira Cloud answers most
 *   requests as for an anonymous user (a 404 for an issue or project, empty data elsewhere), and
 *   that header is the only sign. When it is missing too, jira.ts asks GET /myself after a 404.
 */
function authError(response: Response, conn: JiraConnection): TrackerError | undefined {
  const status = response.status;
  const reason = response.headers.get('x-seraph-loginreason') ?? '';
  const captcha = status === 403 && /AUTHENTICATION_DENIED/i.test(reason);
  if (!captcha && status !== 401 && !/AUTHENTICATED_FAILED/i.test(reason)) return undefined;
  const email = conn.credential.email;
  return new TrackerError(
    captcha
      ? `Jira locked the login of ${email} at ${conn.origin} behind a CAPTCHA (too many failed logins).`
      : `Jira rejected the credentials for ${conn.origin} (authenticated as ${email}).`,
    {
      hint: captcha
        ? `Log in to ${conn.origin} in a browser once, then run the command again.`
        : 'The API token may have expired (Atlassian tokens last at most a year) or been revoked, the email may be wrong, ' +
          'the token may be a scoped token (not supported yet: create a classic API token), or your organization may restrict ' +
          'API tokens. Run `dfl tracker login` in your own terminal – never paste a token into a chat.',
      code: 'TRACKER_AUTH',
      status,
    },
  );
}

function statusError(response: Response, text: string, conn: JiraConnection, request: JiraRequest, label: string): TrackerError {
  const status = response.status;
  const email = conn.credential.email;
  const details = jiraErrorDetails(text);
  if (status === 403) {
    return new TrackerError(`Jira refused ${label} for ${email}${details ? `: ${details}` : '.'}`, {
      hint: 'The account needs the Browse projects, Edit issues and Transition issues permissions in the project (ask a Jira admin).',
      code: 'TRACKER_FORBIDDEN',
      status,
    });
  }
  if (status === 404 && request.notFound) {
    return new TrackerError(request.notFound.message, {
      ...(request.notFound.hint !== undefined ? { hint: request.notFound.hint } : {}),
      code: request.notFound.code,
      status,
    });
  }
  if (status === 429) {
    const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
    return new TrackerError(`Jira rate-limited ${label}.`, {
      hint: retryAfter !== undefined ? `Wait ${retryAfter} s (Retry-After) and run the command again.` : 'Wait a minute and run the command again.',
      code: 'TRACKER_RATE_LIMITED',
      status,
    });
  }
  return new TrackerError(`Jira refused ${label} (${status}${response.statusText ? ` ${response.statusText}` : ''})${details ? `: ${details}` : '.'}`, {
    ...(status === 404 ? { hint: 'Check "jira.baseUrl" in .df/tracker.json.' } : {}),
    code: 'TRACKER_HTTP',
    status,
  });
}

/** Seconds from a Retry-After header (delta seconds or an HTTP date); undefined when absent or unparseable. */
function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function redirectOrigin(location: string, base: string): string | undefined {
  try {
    return new URL(location, base).origin;
  } catch {
    return undefined;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${(ms / 1000).toFixed(1)} s`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function debug(line: string): void {
  if (process.env['DFL_DEBUG'] === '1') process.stderr.write(`dfl jira: ${line}\n`);
}
