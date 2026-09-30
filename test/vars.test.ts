import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLocalConfig, loadProjectConfig, saveLocalConfig, saveProjectConfig } from '../src/core/config.js';
import { DflError } from '../src/core/errors.js';
import { envVarName, resolveVars, setVar, unsetVar, varScope } from '../src/core/vars.js';
import { cleanupTempDirs, makeTempProject, sampleFlowDefinition } from './helpers/project.js';

afterEach(cleanupTempDirs);

describe('envVarName', () => {
  it('converts camelCase, kebab-case and snake_case to UPPER_SNAKE', () => {
    expect(envVarName('reviewer-name')).toBe('DFL_VAR_REVIEWER_NAME');
    expect(envVarName('reviewerName')).toBe('DFL_VAR_REVIEWER_NAME');
    expect(envVarName('mainBranch')).toBe('DFL_VAR_MAIN_BRANCH');
    expect(envVarName('main_branch')).toBe('DFL_VAR_MAIN_BRANCH');
    expect(envVarName('apiURLBase')).toBe('DFL_VAR_API_URL_BASE');
    expect(envVarName('jira2Key')).toBe('DFL_VAR_JIRA2_KEY');
    expect(envVarName('x')).toBe('DFL_VAR_X');
  });
});

describe('resolveVars', () => {
  it('applies default < config.json < local.json < env', () => {
    const paths = makeTempProject();
    const def = sampleFlowDefinition();
    def.vars = { ...def.vars, tone: { default: 'formal' }, strict: { default: false } };

    expect(resolveVars(paths, def, {}).values).toEqual({ mainBranch: 'main', tone: 'formal', strict: false });

    saveProjectConfig(paths, { version: 1, vars: { mainBranch: 'develop', tone: 'casual', teamOnly: 1 } });
    expect(resolveVars(paths, def, {}).values).toEqual({ mainBranch: 'develop', tone: 'casual', strict: false, teamOnly: 1 });

    saveLocalConfig(paths, { version: 1, vars: { tone: 'terse', reviewer: 'pavel' } });
    const env = { DFL_VAR_MAIN_BRANCH: 'trunk', DFL_VAR_STRICT: 'true', DFL_VAR_TEAM_ONLY: '', DFL_VAR_UNKNOWN: 'x' };
    const { values, missing } = resolveVars(paths, def, env);
    expect(values).toEqual({ mainBranch: 'trunk', tone: 'terse', strict: 'true', teamOnly: 1, reviewer: 'pavel' });
    expect(missing).toEqual([]);
  });

  it('reports required vars without a value; an empty string counts as missing', () => {
    const paths = makeTempProject();
    const def = sampleFlowDefinition();
    expect(resolveVars(paths, def, {}).missing).toEqual([{ name: 'reviewer', def: def.vars!['reviewer'] }]);

    saveLocalConfig(paths, { version: 1, vars: { reviewer: '' } });
    expect(resolveVars(paths, def, {}).missing.map((m) => m.name)).toEqual(['reviewer']);

    expect(resolveVars(paths, def, { DFL_VAR_REVIEWER: 'env-user' })).toEqual({
      values: { mainBranch: 'main', reviewer: 'env-user' },
      missing: [],
    });
  });

  it('works without a flow definition', () => {
    const paths = makeTempProject();
    saveProjectConfig(paths, { version: 1, vars: { a: 'b' } });
    expect(resolveVars(paths, undefined, { DFL_VAR_A: 'env' })).toEqual({ values: { a: 'env' }, missing: [] });
  });
});

describe('varScope', () => {
  it('returns the declared scope, defaulting to project', () => {
    const def = sampleFlowDefinition();
    expect(varScope(def, 'reviewer')).toBe('personal');
    expect(varScope(def, 'mainBranch')).toBe('project');
    expect(varScope(def, 'undeclared')).toBe('project');
    expect(varScope(undefined, 'reviewer')).toBe('project');
  });
});

describe('setVar / unsetVar', () => {
  it('stores values in the file of their scope and removes them from both', () => {
    const paths = makeTempProject();
    saveProjectConfig(paths, { version: 1, activeFlow: 'sample', vars: { keep: 1 } });

    setVar(paths, 'mainBranch', 'develop', 'project');
    setVar(paths, 'reviewer', 'pavel', 'personal');
    setVar(paths, 'mainBranch', 'trunk', 'personal');
    expect(loadProjectConfig(paths)).toEqual({ version: 1, activeFlow: 'sample', vars: { keep: 1, mainBranch: 'develop' } });
    expect(loadLocalConfig(paths).vars).toEqual({ reviewer: 'pavel', mainBranch: 'trunk' });

    expect(unsetVar(paths, 'mainBranch')).toBe(true);
    expect(loadProjectConfig(paths).vars).toEqual({ keep: 1 });
    expect(loadLocalConfig(paths).vars).toEqual({ reviewer: 'pavel' });
    expect(unsetVar(paths, 'mainBranch')).toBe(false);
  });

  it('does not create local.json when unsetting', () => {
    const paths = makeTempProject();
    expect(unsetVar(paths, 'nothing')).toBe(false);
    expect(fs.existsSync(paths.localFile)).toBe(false);
  });

  it('rejects names that templates cannot reference', () => {
    const paths = makeTempProject();
    expect(() => setVar(paths, 'a.b', 'x', 'project')).toThrow(DflError);
    expect(() => setVar(paths, '', 'x', 'project')).toThrow(DflError);
  });
});
