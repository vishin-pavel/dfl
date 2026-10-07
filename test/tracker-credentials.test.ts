import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOKEN_EXPIRY_WARNING_DAYS,
  credentialFor,
  credentialSource,
  credentialsFile,
  normalizeOrigin,
  removeCredential,
  saveCredential,
  userConfigDir,
} from '../src/core/tracker/credentials.js';
import { cleanupTempDirs, makeTempDir } from './helpers/project.js';

const posix = process.platform !== 'win32';
const ORIGIN = 'https://acme.atlassian.net';
const TOKEN = 'ATATT3xFfGF0-secret-token';
let configDir: string;

beforeEach(() => {
  configDir = path.join(makeTempDir('dfl-config-'), 'nested', 'dfl');
  vi.stubEnv('DFL_CONFIG_DIR', configDir);
  vi.stubEnv('DFL_JIRA_URL', '');
  vi.stubEnv('DFL_JIRA_EMAIL', '');
  vi.stubEnv('DFL_JIRA_TOKEN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirs();
});

const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

describe('userConfigDir / credentialsFile', () => {
  it('uses DFL_CONFIG_DIR', () => {
    expect(userConfigDir()).toBe(configDir);
    expect(credentialsFile()).toBe(path.join(configDir, 'credentials.json'));
  });

  it.skipIf(!posix)('falls back to ~/.config/dfl (not XDG_CONFIG_HOME)', () => {
    vi.stubEnv('DFL_CONFIG_DIR', '');
    vi.stubEnv('XDG_CONFIG_HOME', '/somewhere/else');
    expect(userConfigDir()).toMatch(/[/\\]\.config[/\\]dfl$/);
  });
});

describe('normalizeOrigin', () => {
  it('normalizes http(s) URLs to their origin', () => {
    expect(normalizeOrigin('https://Acme.Atlassian.net/jira/software')).toBe(ORIGIN);
    expect(normalizeOrigin('https://acme.atlassian.net:443/')).toBe(ORIGIN);
    expect(normalizeOrigin('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080');
    expect(normalizeOrigin('ftp://acme')).toBeUndefined();
    expect(normalizeOrigin('nope')).toBeUndefined();
    expect(normalizeOrigin(undefined)).toBeUndefined();
  });
});

describe('saveCredential / credentialFor', () => {
  it.skipIf(!posix)('writes the file 0600 in a new 0700 directory', () => {
    const file = saveCredential(`${ORIGIN}/browse/ABC-1`, { email: 'dev@example.com', token: TOKEN, accountId: 'acc-1', displayName: 'Dev' });
    expect(file).toBe(credentialsFile());
    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(configDir)).toBe(0o700);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data).toEqual({
      version: 1,
      origins: {
        [ORIGIN]: { type: 'jira-cloud-basic', email: 'dev@example.com', token: TOKEN, accountId: 'acc-1', displayName: 'Dev', savedAt: expect.any(String) },
      },
    });
  });

  it.skipIf(!posix)('forces 0600 on an existing, more open file when saving', () => {
    saveCredential(ORIGIN, { email: 'dev@example.com', token: TOKEN });
    fs.chmodSync(credentialsFile(), 0o644);
    saveCredential(ORIGIN, { email: 'dev@example.com', token: TOKEN });
    expect(modeOf(credentialsFile())).toBe(0o600);
  });

  it('returns the credential of exactly that origin, with a hidden token', () => {
    saveCredential(ORIGIN, { email: 'dev@example.com', token: TOKEN, displayName: 'Dev' });
    const credential = credentialFor('https://ACME.atlassian.net/some/path')!;
    expect(credential).toMatchObject({ origin: ORIGIN, email: 'dev@example.com', displayName: 'Dev', source: 'file', warnings: [] });
    expect(credential.token).toBe(TOKEN);
    expect(JSON.stringify(credential)).not.toContain(TOKEN);
    expect(util.inspect(credential)).not.toContain(TOKEN);
    expect({ ...credential }).not.toHaveProperty('token');
    expect(credentialSource(ORIGIN)).toBe('file');

    expect(credentialFor('https://acme.atlassian.net.evil.example')).toBeUndefined();
    expect(credentialFor('http://acme.atlassian.net')).toBeUndefined();
    expect(credentialFor('https://other.atlassian.net')).toBeUndefined();
    expect(credentialSource('https://other.atlassian.net')).toBeUndefined();
    expect(credentialFor('not a url')).toBeUndefined();
  });

  it('keeps other origins when saving and removing', () => {
    saveCredential(ORIGIN, { email: 'a@example.com', token: 'token-a' });
    saveCredential('https://other.atlassian.net', { email: 'b@example.com', token: 'token-b' });
    saveCredential(ORIGIN, { email: 'a2@example.com', token: 'token-a2' });
    expect(credentialFor(ORIGIN)?.email).toBe('a2@example.com');
    expect(credentialFor('https://other.atlassian.net')?.token).toBe('token-b');
    expect(removeCredential(ORIGIN)).toBe(true);
    expect(removeCredential(ORIGIN)).toBe(false);
    expect(credentialFor(ORIGIN)).toBeUndefined();
    expect(credentialFor('https://other.atlassian.net')?.email).toBe('b@example.com');
  });

  it('rejects empty or multi-line input', () => {
    expect(() => saveCredential(ORIGIN, { email: 'dev@example.com', token: ' ' })).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    expect(() => saveCredential(ORIGIN, { email: 'dev@example.com', token: 'a\nb' })).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    expect(() => saveCredential(ORIGIN, { email: '', token: TOKEN })).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    expect(() => saveCredential('nope', { email: 'dev@example.com', token: TOKEN })).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    expect(fs.existsSync(credentialsFile())).toBe(false);
  });

  it.skipIf(!posix)('makes a group/world-readable file private on read, with a warning', () => {
    saveCredential(ORIGIN, { email: 'dev@example.com', token: TOKEN });
    fs.chmodSync(credentialsFile(), 0o644);
    const credential = credentialFor(ORIGIN)!;
    expect(credential.warnings).toEqual([expect.stringContaining('was readable by other users (mode 644)')]);
    expect(modeOf(credentialsFile())).toBe(0o600);
    expect(credentialFor(ORIGIN)!.warnings).toEqual([]);
  });

  it('warns when the token was saved long ago', () => {
    const old = new Date(Date.now() - (TOKEN_EXPIRY_WARNING_DAYS + 70) * 24 * 60 * 60 * 1000);
    saveCredential(ORIGIN, { email: 'dev@example.com', token: TOKEN }, old);
    const [warning] = credentialFor(ORIGIN)!.warnings;
    expect(warning).toBe(
      `Your Jira API token for ${ORIGIN} was saved 400 days ago; Atlassian tokens expire after at most a year – ` +
        'run `dfl tracker login` with a new one if requests start failing.',
    );
    saveCredential(ORIGIN, { email: 'dev@example.com', token: TOKEN }, new Date(Date.now() - 100 * 24 * 60 * 60 * 1000));
    expect(credentialFor(ORIGIN)!.warnings).toEqual([]);
  });

  it('reports a corrupt file without quoting its content', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(credentialsFile(), `{"origins": {"${ORIGIN}": {"token": "${TOKEN}"`);
    let caught: unknown;
    try {
      credentialFor(ORIGIN);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'TRACKER_CREDENTIALS_INVALID' });
    const { message, hint } = caught as { message: string; hint: string };
    expect(`${message} ${hint}`).not.toContain(TOKEN);
    expect(hint).toContain('`dfl tracker login`');
    expect(() => saveCredential(ORIGIN, { email: 'dev@example.com', token: TOKEN })).toThrow(expect.objectContaining({ code: 'TRACKER_CREDENTIALS_INVALID' }));
  });

  it('never rewrites a file of a newer dfl', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(credentialsFile(), JSON.stringify({ version: 2, origins: {} }));
    expect(() => credentialFor(ORIGIN)).toThrow(expect.objectContaining({ code: 'TRACKER_CREDENTIALS_INVALID' }));
    expect(() => saveCredential(ORIGIN, { email: 'dev@example.com', token: TOKEN })).toThrow(/newer dfl/);
  });

  it('treats an incomplete entry as no credential', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(credentialsFile(), JSON.stringify({ version: 1, origins: { [ORIGIN]: { email: 'dev@example.com' } } }));
    expect(credentialFor(ORIGIN)).toBeUndefined();
  });
});

describe('environment override', () => {
  it('applies only to the origin of DFL_JIRA_URL and needs email and token', () => {
    saveCredential(ORIGIN, { email: 'file@example.com', token: 'file-token' });
    vi.stubEnv('DFL_JIRA_URL', `${ORIGIN}/`);
    vi.stubEnv('DFL_JIRA_EMAIL', 'ci@example.com');
    vi.stubEnv('DFL_JIRA_TOKEN', 'ci-token');
    const fromEnv = credentialFor(ORIGIN)!;
    expect(fromEnv).toMatchObject({ origin: ORIGIN, email: 'ci@example.com', source: 'env', warnings: [] });
    expect(fromEnv.token).toBe('ci-token');
    expect(JSON.stringify(fromEnv)).not.toContain('ci-token');
    expect(credentialSource(ORIGIN)).toBe('env');

    // Another origin never gets the env token.
    expect(credentialFor('https://evil.example')).toBeUndefined();
    vi.stubEnv('DFL_JIRA_URL', 'https://other.atlassian.net');
    expect(credentialFor(ORIGIN)).toMatchObject({ email: 'file@example.com', source: 'file' });
    expect(credentialFor('https://other.atlassian.net')).toMatchObject({ email: 'ci@example.com', source: 'env' });

    vi.stubEnv('DFL_JIRA_URL', ORIGIN);
    vi.stubEnv('DFL_JIRA_TOKEN', '');
    expect(credentialFor(ORIGIN)?.source).toBe('file');
  });

  it('works without a credentials file (CI)', () => {
    vi.stubEnv('DFL_JIRA_URL', ORIGIN);
    vi.stubEnv('DFL_JIRA_EMAIL', 'ci@example.com');
    vi.stubEnv('DFL_JIRA_TOKEN', 'ci-token');
    expect(credentialFor(ORIGIN)?.source).toBe('env');
    expect(fs.existsSync(configDir)).toBe(false);
  });
});
