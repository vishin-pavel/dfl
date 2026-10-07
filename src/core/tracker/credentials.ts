/**
 * Tracker credentials (user level, never inside a project).
 *
 * `<userConfigDir>/credentials.json` holds one Jira API token per site origin and is always written
 * with mode 0600 (its directory is created 0700). `dfl tracker login` writes it; the CLI and the MCP
 * server of every agent read it. In CI, `DFL_JIRA_URL` + `DFL_JIRA_EMAIL` + `DFL_JIRA_TOKEN` override
 * it, but only for the origin of `DFL_JIRA_URL`: a branch that changes the committed `baseUrl` never
 * gets a token sent to the new host.
 *
 * Tokens never reach logs, tool results, `--json` output or error messages: the `token` property
 * of a {@link TrackerCredential} is not enumerable (JSON.stringify, spreads and util.inspect skip
 * it), and parse errors of the file are reported without the parser's message (it quotes content).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DflError } from '../errors.js';
import { readTextIfExists, writeText } from '../fsx.js';

export const CREDENTIALS_FILE_NAME = 'credentials.json';
export const CREDENTIALS_VERSION = 1;
export const CREDENTIAL_TYPE = 'jira-cloud-basic';
/** Warn about token expiry when a token was saved longer ago than this (Atlassian tokens last at most a year). */
export const TOKEN_EXPIRY_WARNING_DAYS = 330;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A token for one origin. `token` is not enumerable (see the module comment). */
export interface TrackerCredential {
  /** Normalized origin (`https://acme.atlassian.net`). */
  readonly origin: string;
  readonly email: string;
  readonly token: string;
  readonly accountId?: string | undefined;
  readonly displayName?: string | undefined;
  /** ISO time of `dfl tracker login` (file credentials only). */
  readonly savedAt?: string | undefined;
  readonly source: 'env' | 'file';
  /** File permission repairs, expiry reminders. Safe to show (no secrets). */
  readonly warnings: string[];
}

export interface SaveCredentialInput {
  email: string;
  token: string;
  accountId?: string | undefined;
  displayName?: string | undefined;
}

/**
 * dfl's user-level config directory: `$DFL_CONFIG_DIR`, else `%APPDATA%\dfl` on Windows, else
 * `~/.config/dfl`. XDG_CONFIG_HOME is deliberately not used: MCP servers often start with a
 * reduced environment, and the CLI and the server must find the same file.
 */
export function userConfigDir(): string {
  const override = process.env['DFL_CONFIG_DIR'];
  if (override) return path.resolve(override);
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    return appData ? path.join(appData, 'dfl') : path.join(os.homedir(), 'AppData', 'Roaming', 'dfl');
  }
  return path.join(os.homedir(), '.config', 'dfl');
}

/** Absolute path of the credentials file. */
export function credentialsFile(): string {
  return path.join(userConfigDir(), CREDENTIALS_FILE_NAME);
}

/** `new URL(value).origin`, or undefined when `value` is not an http(s) URL. */
export function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The credential for `origin`: (1) the environment, when `DFL_JIRA_URL` has exactly this origin and
 * `DFL_JIRA_EMAIL` + `DFL_JIRA_TOKEN` are set; (2) the credentials file entry of exactly this origin;
 * else undefined. Throws DflError `TRACKER_CREDENTIALS_INVALID` when the file cannot be read.
 */
export function credentialFor(origin: string): TrackerCredential | undefined {
  const target = normalizeOrigin(origin);
  if (target === undefined) return undefined;
  const fromEnv = envCredential(target);
  if (fromEnv) return fromEnv;

  const { origins, warnings } = readCredentialsFile();
  const entry = Object.hasOwn(origins, target) ? origins[target] : undefined;
  if (!isPlainObject(entry)) return undefined;
  const email = entry['email'];
  const token = entry['token'];
  // An incomplete entry counts as no credential (`dfl tracker login` replaces it).
  if (typeof email !== 'string' || email === '' || typeof token !== 'string' || token === '') return undefined;
  const savedAt = typeof entry['savedAt'] === 'string' ? entry['savedAt'] : undefined;
  const age = savedAt !== undefined ? ageInDays(savedAt) : undefined;
  if (age !== undefined && age > TOKEN_EXPIRY_WARNING_DAYS) {
    warnings.push(
      `Your Jira API token for ${target} was saved ${age} days ago; Atlassian tokens expire after at most a year – ` +
        'run `dfl tracker login` with a new one if requests start failing.',
    );
  }
  return makeCredential({
    origin: target,
    email,
    token,
    accountId: typeof entry['accountId'] === 'string' ? entry['accountId'] : undefined,
    displayName: typeof entry['displayName'] === 'string' ? entry['displayName'] : undefined,
    savedAt,
    source: 'file',
    warnings,
  });
}

/** Where the credential for `origin` would come from (`env`, `file`), or undefined when there is none. */
export function credentialSource(origin: string): 'env' | 'file' | undefined {
  return credentialFor(origin)?.source;
}

/**
 * Stores the credential for `origin` (other origins are kept) with mode 0600, creating the
 * directory 0700. Returns the file path. Throws DflError `INVALID_OPTIONS` for an empty or
 * multi-line email/token or an invalid origin.
 */
export function saveCredential(origin: string, input: SaveCredentialInput, now: Date = new Date()): string {
  const target = normalizeOrigin(origin);
  if (target === undefined) {
    throw new DflError('Cannot save a credential: the Jira site URL is invalid.', { code: 'INVALID_OPTIONS' });
  }
  const email = input.email.trim();
  const token = input.token.trim();
  if (email === '' || /[\s]/.test(email)) {
    throw new DflError('The email must be the address you log in to Jira with (no spaces).', { code: 'INVALID_OPTIONS' });
  }
  if (token === '' || /[\s]/.test(token)) {
    throw new DflError('The API token is empty or contains whitespace.', {
      hint: 'Paste the whole token as a single line (create one at https://id.atlassian.com/manage-profile/security/api-tokens).',
      code: 'INVALID_OPTIONS',
    });
  }
  const raw = readCredentialsRaw() ?? {};
  assertKnownVersion(raw);
  const origins = isPlainObject(raw['origins']) ? { ...raw['origins'] } : {};
  origins[target] = {
    type: CREDENTIAL_TYPE,
    email,
    token,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    savedAt: now.toISOString(),
  };
  writeCredentials({ ...raw, version: CREDENTIALS_VERSION, origins });
  return credentialsFile();
}

/** Removes the credential for `origin` from the file. Returns true when there was one. */
export function removeCredential(origin: string): boolean {
  const target = normalizeOrigin(origin);
  if (target === undefined) return false;
  const raw = readCredentialsRaw();
  if (raw) assertKnownVersion(raw);
  if (!raw || !isPlainObject(raw['origins']) || !Object.hasOwn(raw['origins'], target)) return false;
  const { [target]: _removed, ...rest } = raw['origins'];
  writeCredentials({ ...raw, origins: rest });
  return true;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function envCredential(origin: string): TrackerCredential | undefined {
  const url = normalizeOrigin(process.env['DFL_JIRA_URL']);
  const email = process.env['DFL_JIRA_EMAIL']?.trim();
  const token = process.env['DFL_JIRA_TOKEN']?.trim();
  if (url !== origin || !email || !token) return undefined;
  return makeCredential({ origin, email, token, source: 'env', warnings: [] });
}

function makeCredential(fields: Omit<TrackerCredential, 'token'> & { token: string }): TrackerCredential {
  const { token, ...rest } = fields;
  const credential = { ...rest } as TrackerCredential;
  Object.defineProperty(credential, 'token', { value: token, enumerable: false, writable: false, configurable: false });
  return credential;
}

/**
 * Reads and checks the credentials file: `origins` (empty when the file is missing) plus warnings.
 * A group/world-readable file is made private (0600) first, with a warning. Throws DflError
 * `TRACKER_CREDENTIALS_INVALID` when it is not valid JSON or has an unknown shape.
 */
function readCredentialsFile(): { origins: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  const file = credentialsFile();
  const raw = readCredentialsRaw(warnings);
  if (raw === undefined) return { origins: {}, warnings };
  assertKnownVersion(raw);
  if (raw['origins'] !== undefined && !isPlainObject(raw['origins'])) {
    throw invalidFileError(file);
  }
  return { origins: (raw['origins'] as Record<string, unknown> | undefined) ?? {}, warnings };
}

/** The raw JSON object of the credentials file (undefined when missing); repairs loose permissions into `warnings`. */
function readCredentialsRaw(warnings: string[] = []): Record<string, unknown> | undefined {
  const file = credentialsFile();
  const text = readTextIfExists(file);
  if (text === undefined) return undefined;
  restrictPermissions(file, warnings);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // The parser's message quotes the content (a token): never pass it on.
    throw invalidFileError(file);
  }
  if (!isPlainObject(data)) throw invalidFileError(file);
  return data;
}

function writeCredentials(data: Record<string, unknown>): void {
  writeText(credentialsFile(), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, forceMode: true, dirMode: 0o700 });
}

/** POSIX: a credentials file others can read is chmodded to 0600 (with a warning). */
function restrictPermissions(file: string, warnings: string[]): void {
  if (process.platform === 'win32') return;
  let mode: number;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    return;
  }
  if ((mode & 0o077) === 0) return;
  try {
    fs.chmodSync(file, 0o600);
    warnings.push(`${file} was readable by other users (mode ${mode.toString(8)}); dfl restricted it to you (0600).`);
  } catch {
    warnings.push(`${file} is readable by other users (mode ${mode.toString(8)}) and dfl could not change that: run \`chmod 600 ${file}\`.`);
  }
}

/** Throws DflError `TRACKER_CREDENTIALS_INVALID` for a file written by a newer dfl (never rewritten by this one). */
function assertKnownVersion(raw: Record<string, unknown>): void {
  const version = raw['version'];
  if (typeof version === 'number' && version > CREDENTIALS_VERSION) {
    throw new DflError(`${credentialsFile()} was written by a newer dfl (version ${version}).`, {
      hint: 'Upgrade dfl to use it.',
      code: 'TRACKER_CREDENTIALS_INVALID',
    });
  }
}

function invalidFileError(file: string): DflError {
  return new DflError(`Cannot read ${file}: it is not a valid dfl credentials file.`, {
    hint: 'Delete it and run `dfl tracker login` again.',
    code: 'TRACKER_CREDENTIALS_INVALID',
  });
}

/** Whole days since `iso`; undefined for an unparseable time. */
function ageInDays(iso: string, now: number = Date.now()): number | undefined {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return undefined;
  return Math.floor((now - time) / DAY_MS);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
