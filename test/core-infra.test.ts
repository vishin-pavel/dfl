import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActiveFlowName, loadLocalConfig, loadProjectConfig, saveProjectConfig, setActiveFlow } from '../src/core/config.js';
import { DflError } from '../src/core/errors.js';
import {
  buildFlowModel,
  createFlow,
  deleteFlow,
  flowExists,
  listFlows,
  loadFlow,
  orderStates,
  parseFlowDefinition,
  readFlowDefinition,
  skillSteps,
  writeFlowDefinition,
} from '../src/core/flow.js';
import {
  copyFile,
  copyFileInside,
  isSafeRelPath,
  removeInside,
  safeResolveInside,
  writeJson,
  writeText,
  writeTextInside,
} from '../src/core/fsx.js';
import { acquireProjectLock, projectLockFile } from '../src/core/lock.js';
import { removeLegacyGitignoreBlock, removeManagedBlock, updateManagedBlock, upsertManagedBlock } from '../src/core/gitignore.js';
import { assertValidStepId, isValidFlowName, isValidId, isValidStepId, titleCase, toId } from '../src/core/ids.js';
import { findProjectRoot, packageRoot, projectPaths, resolveProjectRoot } from '../src/core/paths.js';
import type { FlowMachineConfig } from '../src/core/types.js';
import { validateFlow } from '../src/core/validate.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

// The flow templates dfl shipped before "dev" (feature, bugfix, quick) are test fixtures now.
vi.mock('../src/core/paths.js', async (original) => (await import('./helpers/fixture-templates.js')).fixtureTemplatesPaths(original));

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirs();
});

const posixOnly = process.platform === 'win32' ? it.skip : it;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof DflError ? error.code : `non-dfl: ${String(error)}`;
  }
  return undefined;
}

function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe('ids', () => {
  it('validates and converts ids', () => {
    expect(isValidFlowName('feature')).toBe(true);
    expect(isValidFlowName('config')).toBe(false);
    expect(isValidFlowName('..')).toBe(false);
    expect(isValidId('plan-feature')).toBe(true);
    expect(isValidId('Plan')).toBe(false);
    expect(isValidId('a--b')).toBe(false);
    expect(titleCase('plan-feature')).toBe('Plan Feature');
    expect(toId('Plan Feature!')).toBe('plan-feature');
  });

  it('rejects step ids made of digits only (JavaScript lists such keys first, breaking the flow order)', () => {
    for (const id of ['1', '15', '007', '0']) {
      expect(isValidStepId(id)).toBe(false);
      expect(isValidId(id)).toBe(true); // still a valid flow name / path segment
      const error = (() => {
        try {
          assertValidStepId(id);
        } catch (e) {
          return e as DflError;
        }
        return undefined;
      })();
      expect(error).toMatchObject({ code: 'INVALID_NAME', message: expect.stringContaining('cannot be only digits'), hint: `Add a letter, e.g. "step-${id}".` });
    }
    for (const id of ['step-1', '1a', '1-2', 'v2']) expect(isValidStepId(id)).toBe(true);
    expect(isValidStepId('Bad')).toBe(false);
  });
});

describe('paths', () => {
  it('finds the project root and the package root', () => {
    const paths = makeTempProject();
    const nested = path.join(paths.root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(paths.root);
    expect(fs.existsSync(path.join(packageRoot(), 'package.json'))).toBe(true);
    expect(findProjectRoot(makeTempDir())).toBeUndefined();
  });

  it('refuses an explicit root that does not exist or is not a directory (never creates it)', () => {
    vi.stubEnv('DFL_ROOT', '');
    const base = makeTempDir();
    const missing = path.join(base, 'typo');
    const expectBadRoot = (fn: () => unknown, text: RegExp): void => {
      let error: unknown;
      try {
        fn();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DflError);
      expect((error as DflError).code).toBe('BAD_ROOT');
      expect((error as DflError).message).toMatch(text);
    };
    expectBadRoot(() => resolveProjectRoot({ root: missing }), /^--root .*typo does not exist\.$/);
    expectBadRoot(() => resolveProjectRoot({ root: missing, forInstall: true }), /does not exist/);
    expectBadRoot(() => resolveProjectRoot({ root: 'typo', cwd: base }), /--root typo does not exist/);
    const file = path.join(base, 'afile');
    fs.writeFileSync(file, 'x');
    expectBadRoot(() => resolveProjectRoot({ root: file, forInstall: true }), /is not a directory/);
    vi.stubEnv('DFL_ROOT', missing);
    expectBadRoot(() => resolveProjectRoot({ forInstall: true }), /^DFL_ROOT=.*typo does not exist/);
    expect(fs.existsSync(missing)).toBe(false);
    // An existing directory without .df is fine (install creates the project there).
    vi.stubEnv('DFL_ROOT', '');
    expect(resolveProjectRoot({ root: base })).toBe(base);
  });

  it('never builds .df paths from names that could leave .df', () => {
    const paths = projectPaths(makeTempDir());
    for (const bad of ['..', '.', '', '../x', 'a/b', 'a\\b', '/etc', 'x\0y']) {
      expect(codeOf(() => paths.flowDir(bad))).toBe('INVALID_NAME');
      expect(codeOf(() => paths.flowFile(bad))).toBe('INVALID_NAME');
      expect(codeOf(() => paths.stepDir('ok', bad))).toBe('INVALID_NAME');
    }
    expect(paths.flowDir('feature')).toBe(path.join(paths.dfDir, 'feature'));
    expect(paths.stepDir('feature', 'plan')).toBe(path.join(paths.dfDir, 'feature', 'steps', 'plan'));
  });

  it('places the tracker config in .df', () => {
    const paths = projectPaths(makeTempDir());
    expect(paths.trackerFile).toBe(path.join(paths.root, '.df', 'tracker.json'));
  });
});

describe('config', () => {
  it('resolves the active flow with local override', () => {
    const paths = makeTempProject();
    writeSampleFlow(paths, sampleFlowDefinition('one'));
    expect(getActiveFlowName(paths)).toBe('one');
    writeSampleFlow(paths, sampleFlowDefinition('two'));
    expect(getActiveFlowName(paths)).toBeUndefined();
    setActiveFlow(paths, 'one', 'project');
    expect(getActiveFlowName(paths)).toBe('one');
    setActiveFlow(paths, 'two');
    expect(getActiveFlowName(paths)).toBe('two');
    expect(loadLocalConfig(paths).activeFlow).toBe('two');
    expect(loadProjectConfig(paths).activeFlow).toBe('one');
  });
});

describe('gitignore managed block', () => {
  const START = '# >>> dfl (managed) >>>';
  const END = '# <<< dfl (managed) <<<';

  it('keeps every user line when the end marker is missing', () => {
    const dir = makeTempDir();
    const file = path.join(dir, '.gitignore');
    const broken = ['dist/', '', START, '.claude/skills/a/', '.claude/skills/b/', 'node_modules/', '.env', 'secrets/', ''].join('\n');
    fs.writeFileSync(file, broken);
    // Upsert: only the orphan marker and dfl's own lines right below it are replaced.
    upsertManagedBlock(file, ['.claude/skills/a/', '.claude/skills/b/']);
    const text = fs.readFileSync(file, 'utf8');
    for (const line of ['dist/', 'node_modules/', '.env', 'secrets/']) expect(text).toContain(`${line}\n`);
    expect(text.endsWith(`${START}\n.claude/skills/a/\n.claude/skills/b/\n${END}\n`)).toBe(true);
    expect(text.split(START)).toHaveLength(2);

    // Removal without knowing dfl's lines drops only the marker line.
    fs.writeFileSync(file, broken);
    const result = updateManagedBlock(file, [], { deleteIfEmpty: true });
    expect(result.deleted).toBe(false);
    expect(result.warnings.join('\n')).toMatch(/has no matching "# <<< dfl \(managed\) <<<" line/);
    expect(fs.readFileSync(file, 'utf8')).toBe(['dist/', '', '.claude/skills/a/', '.claude/skills/b/', 'node_modules/', '.env', 'secrets/', ''].join('\n'));

    // The legacy cleanup knows the manifest's dirs: drops them too, keeps the user's lines, never deletes the file.
    const paths = projectPaths(dir);
    fs.writeFileSync(file, [START, '.claude/skills/a/', '.claude/skills/b/', 'node_modules/', '.env', ''].join('\n'));
    const legacy = removeLegacyGitignoreBlock(paths, ['.claude/skills/a/', '.claude/skills/b/']);
    expect(legacy.deleted).toBe(false);
    expect(legacy.warnings).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('node_modules/\n.env\n');
    // removeManagedBlock (no known lines) keeps them as well.
    fs.writeFileSync(file, [START, 'node_modules/', '.env', ''].join('\n'));
    removeManagedBlock(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('node_modules/\n.env\n');
  });

  it('leaves an orphan end marker and a second start marker without dropping user lines', () => {
    const dir = makeTempDir();
    const file = path.join(dir, '.gitignore');
    const orphanEnd = ['node_modules/', END, '.env', ''].join('\n');
    fs.writeFileSync(file, orphanEnd);
    const result = updateManagedBlock(file, []);
    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(orphanEnd);

    fs.writeFileSync(file, [START, 'mine/', START, '.claude/skills/a/', END, '.env', ''].join('\n'));
    removeManagedBlock(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('mine/\n.env\n');
  });

  it('deletes a root .gitignore that only held the legacy block', () => {
    const paths = projectPaths(makeTempDir());
    fs.writeFileSync(paths.rootGitignoreFile, `${START}\n.claude/skills/a/\n${END}\n`);
    expect(removeLegacyGitignoreBlock(paths, ['.claude/skills/a/'])).toEqual({ changed: true, warnings: [], deleted: true });
    expect(fs.existsSync(paths.rootGitignoreFile)).toBe(false);
    expect(removeLegacyGitignoreBlock(paths)).toEqual({ changed: false, warnings: [], deleted: false });
    fs.writeFileSync(paths.rootGitignoreFile, `dist/\n\n${START}\n.claude/skills/a/\n${END}\n`);
    expect(removeLegacyGitignoreBlock(paths).deleted).toBe(false);
    expect(fs.readFileSync(paths.rootGitignoreFile, 'utf8')).toBe('dist/\n');
  });

  it('inserts, replaces and removes the block', () => {
    const dir = makeTempDir();
    const file = path.join(dir, '.gitignore');
    fs.writeFileSync(file, 'node_modules/\n');
    upsertManagedBlock(file, ['.claude/skills/a/']);
    upsertManagedBlock(file, ['.claude/skills/a/', '.claude/skills/b/']);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toBe('node_modules/\n\n# >>> dfl (managed) >>>\n.claude/skills/a/\n.claude/skills/b/\n# <<< dfl (managed) <<<\n');
    removeManagedBlock(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('node_modules/\n');
  });
});

describe('flow model', () => {
  it('orders states in declaration order with the initial state first and final states last', () => {
    const def = sampleFlowDefinition();
    expect(orderStates(def.machine)).toEqual(['plan', 'build', 'review', 'done']);
    const model = buildFlowModel(def, '/x');
    expect(model.byId.get('build')!.incoming.map((t) => t.source)).toEqual(['plan', 'review']);
    expect(model.byId.get('done')!.final).toBe(true);
  });

  it('keeps the main path when a step has a shortcut or a branch (no BFS reordering)', () => {
    const machine: FlowMachineConfig = {
      initial: 'a',
      states: {
        a: { on: { SKIP: 'c', NEXT: 'b' } },
        b: { on: { NEXT: 'c', ALT: 'x' } },
        c: { on: { NEXT: 'd', TRIVIAL: 'f' } },
        d: { on: { NEXT: 'e' } },
        e: { on: { NEXT: 'f' } },
        done: { type: 'final' },
        f: { on: { NEXT: 'done' } },
        x: { on: { NEXT: 'c' } },
      },
    };
    expect(orderStates(machine)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'x', 'done']);
    // The initial state moves first and finals move last, everything else keeps its declaration order.
    expect(orderStates({ initial: 'c', states: { end: { type: 'final' }, a: {}, c: { on: { NEXT: 'a' } }, b: {} } })).toEqual([
      'c',
      'a',
      'b',
      'end',
    ]);
    expect(orderStates({ initial: 'missing', states: { a: {}, z: { type: 'final' } } })).toEqual(['a', 'z']);
    const model = buildFlowModel({ ...sampleFlowDefinition(), machine: { ...machine, id: 'sample' } }, '/x');
    expect(skillSteps(model).map((s) => `${s.id}:${s.index}`)).toEqual(['a:0', 'b:1', 'c:2', 'd:3', 'e:4', 'f:5', 'x:6']);
  });

  it('refuses step ids that would leave the steps/ directory', () => {
    const def = sampleFlowDefinition();
    def.machine.states['../../evil'] = { on: { NEXT: 'done' } };
    expect(codeOf(() => buildFlowModel(def, '/x'))).toBe('INVALID_FLOW');
  });

  it('creates blank and template flows, lists and deletes them', () => {
    const paths = makeTempProject();
    createFlow(paths, 'research', { steps: ['explore', 'summarize'] });
    expect(listFlows(paths)).toEqual(['research']);
    const model = loadFlow(paths, 'research');
    expect(model.steps.map((s) => s.id)).toEqual(['explore', 'summarize', 'done']);
    expect(fs.existsSync(path.join(paths.stepDir('research', 'explore'), 'SKILL.md.hbs'))).toBe(true);
    setActiveFlow(paths, 'research');
    deleteFlow(paths, 'research');
    expect(listFlows(paths)).toEqual([]);
    expect(loadLocalConfig(paths).activeFlow).toBeUndefined();
    expect(fs.readdirSync(paths.dfDir).filter((name) => name.startsWith('.dfl-'))).toEqual([]);
  });

  it('rejects reserved and invalid names', () => {
    const paths = projectPaths(makeTempDir());
    expect(() => createFlow(paths, 'config')).toThrow(/reserved/);
    expect(() => createFlow(paths, 'Bad Name')).toThrow(/Invalid flow name/);
  });

  it('refuses digit-only step ids for a blank flow, writing nothing', () => {
    const paths = makeTempProject();
    expect(codeOf(() => createFlow(paths, 'nums', { steps: ['intro', '3', '2', '1'] }))).toBe('INVALID_NAME');
    expect(fs.existsSync(paths.flowDir('nums'))).toBe(false);
    expect(fs.readdirSync(paths.dfDir).filter((name) => name.startsWith('.dfl-'))).toEqual([]);
  });

  it('picks a final state id that no step uses and validates a blank flow before writing it', () => {
    const paths = makeTempProject();
    const x = createFlow(paths, 'x', { steps: ['done', 'x-done'] });
    expect(skillSteps(x).map((s) => s.id)).toEqual(['done', 'x-done']);
    const def = readFlowDefinition(paths, 'x');
    expect(def.machine.states['done']!.on).toEqual({ NEXT: 'x-done' });
    expect(def.machine.states['x-done']!.on).toEqual({ NEXT: 'done-2' });
    expect(def.machine.states['done-2']).toEqual({ type: 'final', description: 'Flow complete.' });
    expect(validateFlow(paths, 'x')).toEqual([]);

    const long = 'n'.repeat(60);
    createFlow(paths, long, { steps: ['done'] });
    expect(validateFlow(paths, long).filter((issue) => issue.level === 'error')).toEqual([]);

    expect(codeOf(() => createFlow(paths, 'y', { steps: ['add-flow-step'] }))).toBe('INVALID_FLOW');
    expect(fs.existsSync(paths.flowDir('y'))).toBe(false);
    expect(fs.readdirSync(paths.dfDir).filter((name) => name.startsWith('.dfl-'))).toEqual([]);
  });

  it('refuses to create a flow over a leftover directory', () => {
    const paths = makeTempProject();
    fs.mkdirSync(path.join(paths.flowDir('left'), 'steps', 'a'), { recursive: true });
    fs.writeFileSync(path.join(paths.flowDir('left'), 'steps', 'a', 'notes.txt'), 'keep');
    expect(codeOf(() => createFlow(paths, 'left'))).toBe('FLOW_EXISTS');
    expect(fs.readFileSync(path.join(paths.flowDir('left'), 'steps', 'a', 'notes.txt'), 'utf8')).toBe('keep');
    // An empty leftover dir, or one with only rendered output (after a branch switch), is reused.
    fs.mkdirSync(paths.flowDir('empty'));
    expect(createFlow(paths, 'empty').name).toBe('empty');
    fs.mkdirSync(path.join(paths.flowDir('feature'), 'steps', 'spec-feature'), { recursive: true });
    fs.writeFileSync(path.join(paths.flowDir('feature'), 'steps', 'spec-feature', 'SKILL.md'), 'rendered');
    expect(createFlow(paths, 'feature', { from: 'feature' }).name).toBe('feature');
    expect(fs.existsSync(path.join(paths.flowDir('feature'), 'steps', 'spec-feature', 'SKILL.md'))).toBe(false);
  });
});

describe('flow names are validated before any path is built', () => {
  function projectWithRootFlowJson() {
    const paths = makeTempProject();
    createFlow(paths, 'feature', { steps: ['a'] });
    fs.writeFileSync(path.join(paths.root, 'flow.json'), '{"other":"tool"}');
    fs.writeFileSync(path.join(paths.root, 'keep.txt'), 'keep');
    fs.mkdirSync(path.join(paths.root, '.git'));
    fs.mkdirSync(path.join(paths.root, 'sub'));
    fs.writeFileSync(path.join(paths.root, 'sub', 'flow.json'), JSON.stringify(sampleFlowDefinition('sub')));
    return paths;
  }

  it('deleteFlow refuses traversal names and deletes nothing', () => {
    const paths = projectWithRootFlowJson();
    const outer = path.dirname(paths.root);
    for (const bad of ['..', '../sub', '../..', '.', 'a/b', path.join(paths.root, 'sub'), '', 'Feature', 'config']) {
      expect(codeOf(() => deleteFlow(paths, bad))).toBe('INVALID_NAME');
    }
    expect(fs.existsSync(path.join(paths.root, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(paths.root, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(paths.root, 'sub', 'flow.json'))).toBe(true);
    expect(fs.existsSync(outer)).toBe(true);
    expect(listFlows(paths)).toEqual(['feature']);
    expect(codeOf(() => deleteFlow(paths, 'nope'))).toBe('FLOW_NOT_FOUND');
  });

  it('lookups reject or ignore invalid names', () => {
    const paths = projectWithRootFlowJson();
    expect(flowExists(paths, '..')).toBe(false);
    expect(flowExists(paths, '../sub')).toBe(false);
    expect(flowExists(paths, 'Feature')).toBe(false);
    expect(flowExists(paths, 'feature')).toBe(true);
    expect(codeOf(() => loadFlow(paths, '../sub'))).toBe('INVALID_NAME');
    expect(codeOf(() => readFlowDefinition(paths, '..'))).toBe('INVALID_NAME');
    expect(codeOf(() => writeFlowDefinition(paths, sampleFlowDefinition('../x')))).toBe('INVALID_NAME');
    // Legacy directories with invalid names are not listed.
    fs.mkdirSync(paths.flowDir('Legacy'));
    fs.writeFileSync(paths.flowFile('Legacy'), JSON.stringify(sampleFlowDefinition('Legacy')));
    fs.mkdirSync(paths.flowDir('steps'));
    fs.writeFileSync(paths.flowFile('steps'), JSON.stringify(sampleFlowDefinition('steps')));
    expect(listFlows(paths)).toEqual(['feature']);
  });

  it('refuses a flow whose flow.json name differs from its directory', () => {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    fs.cpSync(paths.flowDir('sample'), paths.flowDir('copy'), { recursive: true });
    let error: unknown;
    try {
      loadFlow(paths, 'copy');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DflError);
    expect((error as DflError).code).toBe('INVALID_FLOW');
    expect((error as DflError).message).toContain('does not match its directory "copy"');
    expect((error as DflError).hint).toContain('Set "name": "copy"');
    // validate still reports it as an issue instead of throwing.
    expect(validateFlow(paths, 'copy').map((i) => i.message)).toContain('Flow name "sample" does not match its directory name "copy".');
    expect(codeOf(() => writeFlowDefinition(paths, sampleFlowDefinition('sample'), 'copy'))).toBe('INVALID_FLOW');
  });
});

describe('deleteFlow bookkeeping', () => {
  it('tolerates a corrupt state.json and clears the active flow', () => {
    const paths = makeTempProject();
    createFlow(paths, 'research', { steps: ['explore'] });
    setActiveFlow(paths, 'research');
    setActiveFlow(paths, 'research', 'project');
    fs.writeFileSync(paths.stateFile, '{ "version": 1, "flows": {');
    expect(() => deleteFlow(paths, 'research')).not.toThrow();
    expect(fs.existsSync(paths.flowDir('research'))).toBe(false);
    expect(loadLocalConfig(paths).activeFlow).toBeUndefined();
    expect(loadProjectConfig(paths).activeFlow).toBeUndefined();

    createFlow(paths, 'other', { steps: ['x'] });
    fs.writeFileSync(paths.stateFile, '{ "version": 1, "flows": [] }');
    expect(() => deleteFlow(paths, 'other')).not.toThrow();
  });

  it('removes only the deleted flow from state.json', () => {
    const paths = makeTempProject();
    createFlow(paths, 'one', { steps: ['a'] });
    createFlow(paths, 'two', { steps: ['b'] });
    const entry = { current: 'a', history: [], updatedAt: '2026-01-01T00:00:00.000Z' };
    fs.writeFileSync(paths.stateFile, JSON.stringify({ version: 1, flows: { one: entry, two: { ...entry, current: 'b' } } }));
    deleteFlow(paths, 'one');
    expect(JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'))).toEqual({ version: 1, flows: { two: { ...entry, current: 'b' } } });
  });

  it('keeps the flow when config.json cannot be read', () => {
    const paths = makeTempProject();
    createFlow(paths, 'one', { steps: ['a'] });
    fs.writeFileSync(paths.configFile, '{ broken');
    expect(codeOf(() => deleteFlow(paths, 'one'))).toBe('INVALID_JSON');
    expect(fs.existsSync(paths.flowFile('one'))).toBe(true);
    saveProjectConfig(paths, { version: 1, vars: {} });
  });
});

describe('flow.json key order', () => {
  it('parseFlowDefinition returns the input unchanged (key order kept)', () => {
    const raw = { machine: { states: { a: { type: 'final', description: 'x' } }, initial: 'a', id: 'n' }, 'x-extra': 1, name: 'n' };
    const parsed = parseFlowDefinition(raw);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(raw));
  });

  it('re-writing a template flow is byte-identical and source sits before machine', () => {
    const paths = makeTempProject();
    createFlow(paths, 'feature', { from: 'feature' });
    const before = fs.readFileSync(paths.flowFile('feature'), 'utf8');
    const keys = Object.keys(JSON.parse(before) as object);
    expect(keys.indexOf('source')).toBe(keys.indexOf('machine') - 1);
    writeFlowDefinition(paths, readFlowDefinition(paths, 'feature'));
    expect(fs.readFileSync(paths.flowFile('feature'), 'utf8')).toBe(before);
  });
});

describe('fsx writes', () => {
  posixOnly('writeText keeps the permission bits of an existing file and uses the default for new files', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, '{"token":"x"}\n');
    fs.chmodSync(file, 0o600);
    expect(writeText(file, '{"token":"y"}\n')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"token":"y"}\n');
    expect(modeOf(file)).toBe(0o600);
    // Unchanged content: not touched.
    expect(writeText(file, '{"token":"y"}\n')).toBe(false);
    expect(modeOf(file)).toBe(0o600);
    const fresh = path.join(dir, 'sub', 'new.txt');
    writeText(fresh, 'x');
    const umask = process.umask();
    expect(modeOf(fresh)).toBe(0o666 & ~umask);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  posixOnly('writeText applies a forced mode to an existing file and creates private files and dirs', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, '{"token":"x"}\n');
    fs.chmodSync(file, 0o644);
    // Without forceMode an existing file keeps its bits.
    expect(writeText(file, '{"token":"y"}\n', { mode: 0o600 })).toBe(true);
    expect(modeOf(file)).toBe(0o644);
    // forceMode applies the mode on a content change …
    expect(writeText(file, '{"token":"z"}\n', { mode: 0o600, forceMode: true })).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"token":"z"}\n');
    expect(modeOf(file)).toBe(0o600);
    // … and on unchanged content (only the bits change).
    fs.chmodSync(file, 0o644);
    expect(writeText(file, '{"token":"z"}\n', { mode: 0o600, forceMode: true })).toBe(true);
    expect(modeOf(file)).toBe(0o600);
    expect(writeText(file, '{"token":"z"}\n', { mode: 0o600, forceMode: true })).toBe(false);

    const fresh = path.join(dir, 'config', 'dfl', 'credentials.json');
    expect(writeJson(fresh, { version: 1 }, { mode: 0o600, forceMode: true, dirMode: 0o700 })).toBe(true);
    const umask = process.umask();
    expect(modeOf(fresh)).toBe(0o600);
    expect(modeOf(path.dirname(fresh))).toBe(0o700 & ~umask);
    expect(modeOf(path.join(dir, 'config'))).toBe(0o700 & ~umask);
    expect(fs.readdirSync(path.dirname(fresh)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  posixOnly('writeText replaces a symlink by default and writes its target only with followSymlink', () => {
    const dir = makeTempDir();
    const outside = path.join(dir, 'shared.json');
    fs.writeFileSync(outside, '{}\n');
    fs.chmodSync(outside, 0o600);
    const link = path.join(dir, 'proj', '.mcp.json');
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(outside, link);

    writeJson(link, { a: 1 }, { followSymlink: true });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(outside, 'utf8'))).toEqual({ a: 1 });
    expect(modeOf(outside)).toBe(0o600);

    writeText(link, 'replaced');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(link, 'utf8')).toBe('replaced');
    expect(JSON.parse(fs.readFileSync(outside, 'utf8'))).toEqual({ a: 1 });

    // A dangling link is replaced, never used to create its target.
    const target = path.join(dir, 'hooks', 'post-checkout');
    const dangling = path.join(dir, 'proj', 'dangling');
    fs.symlinkSync(target, dangling);
    writeText(dangling, 'payload', { followSymlink: true });
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.lstatSync(dangling).isFile()).toBe(true);

    expect(codeOf(() => writeText(dir, 'x'))).toBe('NOT_A_FILE');
  });

  posixOnly('copyFile never writes through a symlink and keeps the source mode', () => {
    const dir = makeTempDir();
    const src = path.join(dir, 'helper.sh');
    fs.writeFileSync(src, 'echo hi\n');
    fs.chmodSync(src, 0o755);
    const victim = path.join(dir, 'zshrc');
    fs.writeFileSync(victim, 'secret\n');
    fs.chmodSync(victim, 0o600);
    const skill = path.join(dir, 'skill');
    fs.mkdirSync(skill);
    fs.symlinkSync(victim, path.join(skill, 'helper.sh'));
    expect(codeOf(() => copyFile(src, path.join(skill, 'helper.sh')))).toBe('UNSAFE_PATH');
    expect(fs.readFileSync(victim, 'utf8')).toBe('secret\n');
    expect(modeOf(victim)).toBe(0o600);

    const hook = path.join(dir, 'git-hooks', 'post-checkout');
    fs.symlinkSync(hook, path.join(skill, 'dangling.sh'));
    expect(codeOf(() => copyFile(src, path.join(skill, 'dangling.sh')))).toBe('UNSAFE_PATH');
    expect(fs.existsSync(hook)).toBe(false);

    const dest = path.join(skill, 'real.sh');
    expect(copyFile(src, dest)).toBe(true);
    expect(modeOf(dest)).toBe(0o755);
    expect(copyFile(src, dest)).toBe(false);
    fs.chmodSync(dest, 0o644);
    expect(copyFile(src, dest)).toBe(true);
    expect(modeOf(dest)).toBe(0o755);
  });

  posixOnly('safeResolveInside refuses symlinked components and unsafe relative paths', () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    fs.mkdirSync(path.join(root, '.claude', 'skills', 'spec'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.claude', 'skills', 'spec', 'sub'));
    fs.writeFileSync(path.join(outside, 'payload'), 'keep');
    fs.symlinkSync(path.join(outside, 'payload'), path.join(root, '.claude', 'skills', 'spec', 'leaf'));

    expect(safeResolveInside(root, '.claude/skills/spec/SKILL.md')).toBe(path.join(root, '.claude', 'skills', 'spec', 'SKILL.md'));
    expect(safeResolveInside(root, 'new/dir/file')).toBe(path.join(root, 'new', 'dir', 'file'));
    for (const bad of ['../x', 'a/../b', '/etc/passwd', '', 'a//b', './a', 'a\\b']) {
      expect(isSafeRelPath(bad)).toBe(false);
      expect(codeOf(() => safeResolveInside(root, bad))).toBe('UNSAFE_PATH');
    }
    expect(codeOf(() => safeResolveInside(root, '.claude/skills/spec/sub/notes.md'))).toBe('UNSAFE_PATH');
    expect(codeOf(() => safeResolveInside(root, '.claude/skills/spec/leaf'))).toBe('UNSAFE_PATH');
    expect(safeResolveInside(root, '.claude/skills/spec/leaf', { allowLeafSymlink: true })).toBe(path.join(root, '.claude', 'skills', 'spec', 'leaf'));

    const src = path.join(root, 'src.txt');
    fs.writeFileSync(src, 'content');
    expect(codeOf(() => writeTextInside(root, '.claude/skills/spec/sub/notes.md', 'x'))).toBe('UNSAFE_PATH');
    expect(codeOf(() => copyFileInside(root, '.claude/skills/spec/sub/payload', src))).toBe('UNSAFE_PATH');
    expect(codeOf(() => removeInside(root, '.claude/skills/spec/sub/payload'))).toBe('UNSAFE_PATH');
    expect(fs.readdirSync(outside)).toEqual(['payload']);
    expect(fs.readFileSync(path.join(outside, 'payload'), 'utf8')).toBe('keep');

    // A symlink leaf is removed itself; its target stays.
    expect(removeInside(root, '.claude/skills/spec/leaf')).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'payload'), 'utf8')).toBe('keep');
    expect(removeInside(root, '.claude/skills/spec/leaf')).toBe(false);

    expect(writeTextInside(root, '.claude/skills/spec/nested/a.md', 'a')).toBe(true);
    expect(copyFileInside(root, '.claude/skills/spec/nested/b.txt', src)).toBe(true);
    expect(removeInside(root, '.claude/skills/spec/nested')).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'spec', 'nested'))).toBe(false);
  });
});

describe('active flow names (G8)', () => {
  it('setActiveFlow refuses names that are not flow names', () => {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    for (const name of ['../x', 'Feature', '', 'config']) {
      expect(() => setActiveFlow(paths, name), name).toThrow(DflError);
    }
    expect(loadLocalConfig(paths).activeFlow).toBeUndefined();
  });

  it('getActiveFlowName ignores directories with invalid flow names', () => {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    fs.mkdirSync(path.join(paths.dfDir, 'Bad Name'), { recursive: true });
    fs.writeFileSync(path.join(paths.dfDir, 'Bad Name', 'flow.json'), '{}');
    // Exactly one valid flow: it is active by default.
    expect(getActiveFlowName(paths)).toBe('sample');
  });
});

describe('project lock heartbeat', () => {
  it('refreshes a held lock, so a long mutation is not taken over as abandoned', async () => {
    const paths = makeTempProject();
    const file = projectLockFile(paths);
    const release = await acquireProjectLock(paths, { staleMs: 200 });
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(file, old, old);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(200);
    await expect(acquireProjectLock(paths, { staleMs: 200, timeoutMs: 100 })).rejects.toMatchObject({ code: 'LOCKED' });
    release();
    expect(fs.existsSync(file)).toBe(false);

    // Without a heartbeat (the holder died or hangs) the lock is taken over once it is older than staleMs.
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: 'elsewhere', token: 'x', at: old.toISOString() }));
    fs.utimesSync(file, old, old);
    const again = await acquireProjectLock(paths, { staleMs: 200, timeoutMs: 100 });
    again();
    expect(fs.existsSync(file)).toBe(false);
  });
});
