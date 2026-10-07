import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DflError } from '../src/core/errors.js';
import { saveProjectConfig } from '../src/core/config.js';
import {
  DEFAULT_RECORD_PROPERTY,
  loadTrackerConfig,
  managedStatuses,
  parseTrackerConfig,
  readTrackerConfigRaw,
  resolveBranchSettings,
  statusLabel,
  statusMappingFor,
  trackedFlow,
  trackerValidationWarnings,
  trackerWarnings,
  writeTrackerConfigRaw,
} from '../src/core/tracker/config.js';
import type { ProjectPaths } from '../src/core/types.js';
import { validateFlow } from '../src/core/validate.js';
import { cleanupTempDirs, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirs();
});

/** A valid tracker.json for the sample flow (plan → build → review → done). */
function baseRaw(): Record<string, unknown> {
  return {
    version: 1,
    provider: 'jira',
    jira: { baseUrl: 'https://acme.atlassian.net/jira/', projectKeys: ['ABC', 'DEF'], defaultProjectKey: 'ABC' },
    flows: {
      sample: {
        statuses: {
          plan: 'In Progress',
          build: null,
          review: { id: '10004' },
          done: { status: 'Done', fields: { resolution: { name: 'Done' } } },
        },
      },
    },
  };
}

function parseError(raw: unknown): DflError {
  try {
    parseTrackerConfig(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(DflError);
    return error as DflError;
  }
  throw new Error('expected a DflError');
}

function writeTracker(paths: ProjectPaths, raw: unknown): void {
  fs.writeFileSync(paths.trackerFile, `${JSON.stringify(raw, null, 2)}\n`);
}

describe('parseTrackerConfig', () => {
  it('normalizes a valid config and applies defaults', () => {
    const cfg = parseTrackerConfig(baseRaw());
    expect(cfg.jira).toEqual({
      baseUrl: 'https://acme.atlassian.net/jira/',
      origin: 'https://acme.atlassian.net',
      projectKeys: ['ABC', 'DEF'],
      defaultProjectKey: 'ABC',
      property: DEFAULT_RECORD_PROPERTY,
    });
    expect(cfg.flows['sample']).toEqual({
      requireTask: true,
      statuses: {
        plan: { name: 'In Progress', reopen: false },
        build: null,
        review: { id: '10004', reopen: false },
        done: { name: 'Done', fields: { resolution: { name: 'Done' } }, reopen: false },
      },
    });
    expect(cfg.branch).toEqual({});
    expect(cfg.fields).toEqual({});
    expect(cfg.flowSelect).toEqual({ byIssueType: {} });
  });

  it('accepts optional sections, numeric status ids, reopen and unknown keys', () => {
    const raw = {
      ...baseRaw(),
      extra: { anything: true },
      jira: { baseUrl: 'https://acme.atlassian.net', projectKeys: ['ABC'], property: 'team.dfl-run_1', custom: 1 },
      branch: { template: 'feature/{key}-{slug}', from: 'origin/develop', protected: ['develop'], fetch: false },
      fields: { branch: 'customfield_10042', prUrl: 'customfield_10077' },
      flowSelect: { byIssueType: { Bug: 'bugfix' }, default: 'sample' },
      flows: { sample: { requireTask: false, branchTemplate: 'x/{key}', statuses: { review: { id: 10004, reopen: true } }, note: 'kept' } },
    };
    const cfg = parseTrackerConfig(raw);
    expect(cfg.jira.property).toBe('team.dfl-run_1');
    expect(cfg.branch).toEqual({ template: 'feature/{key}-{slug}', from: 'origin/develop', protected: ['develop'], fetch: false });
    expect(cfg.fields).toEqual({ branch: 'customfield_10042', prUrl: 'customfield_10077' });
    expect(cfg.flowSelect).toEqual({ byIssueType: { Bug: 'bugfix' }, default: 'sample' });
    expect(cfg.flows['sample']).toEqual({ branchTemplate: 'x/{key}', requireTask: false, statuses: { review: { id: '10004', reopen: true } } });
  });

  it('treats a flow entry without statuses as tracked with no status changes', () => {
    const cfg = parseTrackerConfig({ ...baseRaw(), flows: { sample: {} } });
    expect(trackedFlow(cfg, 'sample')).toEqual({ requireTask: true, statuses: {} });
    expect(statusMappingFor(cfg, 'sample', 'plan')).toBeNull();
    expect(managedStatuses(cfg, 'sample')).toEqual([]);
  });

  it('refuses a newer version with an upgrade hint', () => {
    const error = parseError({ ...baseRaw(), version: 2 });
    expect(error.code).toBe('TRACKER_CONFIG_NEWER');
    expect(error.message).toContain('version 2');
    expect(error.hint).toMatch(/upgrade/i);
  });

  it.each<[string, (raw: Record<string, unknown>) => void, RegExp]>([
    ['a missing version', (raw) => delete raw['version'], /version:/],
    ['an unsupported provider', (raw) => (raw['provider'] = 'github'), /provider: unsupported provider "github"/],
    ['a plain-http site', (raw) => ((raw['jira'] as Record<string, unknown>)['baseUrl'] = 'http://acme.atlassian.net'), /jira\.baseUrl: must be an https/],
    ['a non-URL site', (raw) => ((raw['jira'] as Record<string, unknown>)['baseUrl'] = 'acme'), /jira\.baseUrl: expected the URL/],
    ['lowercase project keys', (raw) => ((raw['jira'] as Record<string, unknown>)['projectKeys'] = ['abc']), /jira\.projectKeys\.0/],
    ['no project keys', (raw) => ((raw['jira'] as Record<string, unknown>)['projectKeys'] = []), /jira\.projectKeys/],
    ['a default project outside the keys', (raw) => ((raw['jira'] as Record<string, unknown>)['defaultProjectKey'] = 'XYZ'), /jira\.defaultProjectKey: "XYZ" is not one of/],
    ['an invalid property', (raw) => ((raw['jira'] as Record<string, unknown>)['property'] = 'has space'), /jira\.property/],
    ['an unknown template placeholder', (raw) => (raw['branch'] = { template: '{key}-{title}' }), /branch\.template: unknown placeholder \{title\}/],
    ['a template without the key', (raw) => (raw['branch'] = { template: 'work/{slug}' }), /branch\.template: must contain \{key\}/],
    ['a flow template without the key', (raw) => (raw['flows'] = { sample: { branchTemplate: '{slug}' } }), /flows\.sample\.branchTemplate/],
    ['an option-like base ref', (raw) => (raw['branch'] = { from: '--upload-pack=x' }), /branch\.from/],
    ['a system field id', (raw) => (raw['fields'] = { labels: 'labels' }), /fields\.labels: expected a custom field id/],
    ['a numeric status mapping', (raw) => (raw['flows'] = { sample: { statuses: { done: 5 } } }), /flows\.sample\.statuses\.done: expected a status name, null/],
    ['an empty status name', (raw) => (raw['flows'] = { sample: { statuses: { done: ' ' } } }), /flows\.sample\.statuses\.done: empty status name/],
    ['a mapping object without status or id', (raw) => (raw['flows'] = { sample: { statuses: { done: { reopen: true } } } }), /flows\.sample\.statuses\.done: set "status"/],
    ['a non-boolean reopen', (raw) => (raw['flows'] = { sample: { statuses: { done: { status: 'Done', reopen: 'yes' } } } }), /"reopen" must be true or false/],
    ['non-object fields', (raw) => (raw['flows'] = { sample: { statuses: { done: { status: 'Done', fields: [] } } } }), /"fields" must be an object/],
    ['a non-boolean requireTask', (raw) => (raw['flows'] = { sample: { requireTask: 'no' } }), /flows\.sample\.requireTask/],
  ])('rejects %s (TRACKER_CONFIG_INVALID naming the path)', (_name, edit, pattern) => {
    const raw = baseRaw();
    edit(raw);
    const error = parseError(raw);
    expect(error.code).toBe('TRACKER_CONFIG_INVALID');
    expect(error.message).toMatch(pattern);
    expect(error.message).toContain('.df/tracker.json');
  });

  it('allows plain http only for loopback hosts and never echoes credentials in the URL', () => {
    for (const baseUrl of ['http://localhost:8080', 'http://127.0.0.1:1234', 'http://[::1]:99']) {
      expect(parseTrackerConfig({ ...baseRaw(), jira: { baseUrl, projectKeys: ['ABC'] } }).jira.origin).toBe(new URL(baseUrl).origin);
    }
    const error = parseError({ ...baseRaw(), jira: { baseUrl: 'https://me:s3cret@acme.atlassian.net', projectKeys: ['ABC'] } });
    expect(error.message).toContain('must not contain a user name or password');
    expect(error.message).not.toContain('s3cret');
  });

  it('rejects a non-object document', () => {
    expect(parseError([]).code).toBe('TRACKER_CONFIG_INVALID');
    expect(parseError('x').code).toBe('TRACKER_CONFIG_INVALID');
  });
});

describe('tracked flows and mappings', () => {
  it('looks mappings up by own keys only', () => {
    const cfg = parseTrackerConfig(baseRaw());
    expect(trackedFlow(cfg, 'sample')?.requireTask).toBe(true);
    expect(trackedFlow(cfg, 'other')).toBeUndefined();
    expect(trackedFlow(cfg, 'constructor')).toBeUndefined();
    expect(statusMappingFor(cfg, 'sample', 'plan')).toEqual({ name: 'In Progress', reopen: false });
    expect(statusMappingFor(cfg, 'sample', 'build')).toBeNull();
    expect(statusMappingFor(cfg, 'sample', 'missing')).toBeNull();
    expect(statusMappingFor(cfg, 'sample', 'toString')).toBeNull();
    expect(statusMappingFor(cfg, 'other', 'plan')).toBeNull();
  });

  it('lists every distinct managed status', () => {
    const raw = baseRaw();
    (raw['flows'] as Record<string, unknown>)['sample'] = {
      statuses: { plan: 'In Progress', build: 'in progress', review: { id: '10004' }, x: { id: '10004', status: 'In Review' }, done: null },
    };
    const managed = managedStatuses(parseTrackerConfig(raw), 'sample');
    expect(managed.map(statusLabel)).toEqual(['In Progress', 'id:10004']);
    expect(managedStatuses(parseTrackerConfig(raw), 'other')).toEqual([]);
  });
});

describe('readTrackerConfigRaw / writeTrackerConfigRaw / loadTrackerConfig', () => {
  it('returns undefined without a file', () => {
    const paths = makeTempProject();
    expect(readTrackerConfigRaw(paths)).toBeUndefined();
    expect(loadTrackerConfig(paths)).toBeUndefined();
  });

  it('round-trips raw JSON keeping key order and unknown keys', () => {
    const paths = makeTempProject();
    const raw = { zeta: 1, ...baseRaw(), alpha: { nested: [1, 2] } };
    const cfg = writeTrackerConfigRaw(paths, raw);
    expect(cfg.jira.projectKeys).toEqual(['ABC', 'DEF']);
    const text = fs.readFileSync(paths.trackerFile, 'utf8');
    expect(text).toBe(`${JSON.stringify(raw, null, 2)}\n`);
    const back = readTrackerConfigRaw(paths)!;
    expect(Object.keys(back)).toEqual(['zeta', 'version', 'provider', 'jira', 'flows', 'alpha']);
    (back['flows'] as Record<string, Record<string, Record<string, unknown>>>)['sample']!['statuses']!['build'] = 'In Review';
    writeTrackerConfigRaw(paths, back);
    expect(loadTrackerConfig(paths)?.flows['sample']?.statuses['build']).toEqual({ name: 'In Review', reopen: false });
    expect(Object.keys(readTrackerConfigRaw(paths)!)).toEqual(['zeta', 'version', 'provider', 'jira', 'flows', 'alpha']);
  });

  it('does not write an invalid config', () => {
    const paths = makeTempProject();
    writeTrackerConfigRaw(paths, baseRaw());
    const before = fs.readFileSync(paths.trackerFile, 'utf8');
    expect(() => writeTrackerConfigRaw(paths, { ...baseRaw(), provider: 'github' })).toThrow(/unsupported provider/);
    expect(fs.readFileSync(paths.trackerFile, 'utf8')).toBe(before);
  });

  it('reports unparseable JSON and non-objects as TRACKER_CONFIG_INVALID', () => {
    const paths = makeTempProject();
    fs.writeFileSync(paths.trackerFile, '{ "version": 1,');
    expect(() => readTrackerConfigRaw(paths)).toThrow(expect.objectContaining({ code: 'TRACKER_CONFIG_INVALID' }));
    fs.writeFileSync(paths.trackerFile, '[1]');
    expect(() => loadTrackerConfig(paths)).toThrow(expect.objectContaining({ code: 'TRACKER_CONFIG_INVALID' }));
  });
});

describe('resolveBranchSettings', () => {
  it('defaults from, protected and template from the flow mainBranch var', () => {
    const paths = makeTempProject();
    const def = writeSampleFlow(paths);
    const cfg = parseTrackerConfig(baseRaw());
    expect(resolveBranchSettings(paths, cfg, def)).toEqual({
      template: '{key}-{slug}',
      from: 'origin/main',
      protected: ['main', 'master', 'develop'],
      fetch: true,
    });
    saveProjectConfig(paths, { version: 1, vars: { mainBranch: 'trunk' } });
    expect(resolveBranchSettings(paths, cfg, def)).toMatchObject({ from: 'origin/trunk', protected: ['main', 'master', 'develop', 'trunk'] });
    vi.stubEnv('DFL_VAR_MAIN_BRANCH', 'release');
    expect(resolveBranchSettings(paths, cfg, def).from).toBe('origin/release');
    expect(resolveBranchSettings(makeTempProject(), cfg, undefined).from).toBe('origin/main');
  });

  it('uses configured values and the flow branchTemplate', () => {
    const paths = makeTempProject();
    const def = writeSampleFlow(paths);
    const raw = baseRaw();
    raw['branch'] = { template: 'feature/{key}-{slug}', from: 'upstream/dev', protected: ['dev'], fetch: false };
    expect(resolveBranchSettings(paths, parseTrackerConfig(raw), def)).toEqual({
      template: 'feature/{key}-{slug}',
      from: 'upstream/dev',
      protected: ['dev'],
      fetch: false,
    });
    (raw['flows'] as Record<string, Record<string, unknown>>)['sample']!['branchTemplate'] = 'fix/{key}';
    expect(resolveBranchSettings(paths, parseTrackerConfig(raw), def).template).toBe('fix/{key}');
  });
});

describe('trackerWarnings', () => {
  function setup(): ProjectPaths {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    writeSampleFlow(paths, sampleFlowDefinition('other'));
    return paths;
  }

  it('is empty for a consistent config', () => {
    const paths = setup();
    expect(trackerWarnings(paths, parseTrackerConfig(baseRaw()))).toEqual([]);
  });

  it('warns about missing flows and steps, http, field names and flowSelect', () => {
    const paths = setup();
    const raw = {
      ...baseRaw(),
      jira: { baseUrl: 'http://127.0.0.1:9999', projectKeys: ['ABC'] },
      fields: { 'pr-url': 'customfield_10077', branch: 'customfield_10042' },
      flowSelect: { byIssueType: { Bug: 'bugfix', Story: 'other' }, default: 'sample' },
      flows: { sample: { statuses: { plan: 'In Progress', shipit: 'Done' } }, ghost: {} },
    };
    const warnings = trackerWarnings(paths, parseTrackerConfig(raw));
    expect(warnings).toEqual([
      expect.stringContaining('plain http://'),
      expect.stringContaining('fields.pr-url is not a valid param name'),
      expect.stringContaining('flowSelect.byIssueType.Bug names flow "bugfix", which does not exist'),
      expect.stringContaining('flowSelect.byIssueType.Story names flow "other", which is not tracked (map it with `dfl tracker map --flow other`)'),
      expect.stringContaining('flows.sample.statuses.shipit maps a step that flow "sample" does not have'),
      expect.stringContaining('flows.ghost maps a flow that does not exist'),
    ]);
    expect(warnings.every((warning) => warning.startsWith('.df/tracker.json: '))).toBe(true);

    const forSample = trackerWarnings(paths, parseTrackerConfig(raw), { flow: 'sample' });
    expect(forSample.some((w) => w.includes('flows.ghost'))).toBe(false);
    expect(forSample.some((w) => w.includes('statuses.shipit'))).toBe(true);
    expect(trackerWarnings(paths, parseTrackerConfig(raw), { flow: 'other' })).toEqual([]);
  });

  it('feeds validateFlow as warnings only', () => {
    const paths = setup();
    expect(trackerValidationWarnings(paths, 'sample')).toEqual([]);
    const trackerIssues = (flow: string) => validateFlow(paths, flow).filter((issue) => issue.file === paths.trackerFile);
    const before = validateFlow(paths, 'sample');
    writeTracker(paths, { ...baseRaw(), flows: { sample: { statuses: { shipit: 'Done' } } } });
    const issues = validateFlow(paths, 'sample');
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
    expect(issues.slice(0, before.length)).toEqual(before);
    expect(trackerIssues('sample')).toEqual([
      expect.objectContaining({ level: 'warning', message: expect.stringContaining('statuses.shipit') }),
    ]);
    expect(trackerIssues('other')).toEqual([]);

    writeTracker(paths, { ...baseRaw(), provider: 'github' });
    for (const flow of ['sample', 'other']) {
      expect(trackerIssues(flow)).toEqual([
        expect.objectContaining({ level: 'warning', file: paths.trackerFile, message: expect.stringMatching(/unsupported provider.*tracker operations fail/) }),
      ]);
    }
  });
});
