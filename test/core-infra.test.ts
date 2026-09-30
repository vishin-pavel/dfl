import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getActiveFlowName, loadLocalConfig, loadProjectConfig, setActiveFlow } from '../src/core/config.js';
import { buildFlowModel, createFlow, deleteFlow, listFlows, loadFlow, orderStates } from '../src/core/flow.js';
import { removeManagedBlock, upsertManagedBlock } from '../src/core/gitignore.js';
import { isValidId, titleCase, toId } from '../src/core/ids.js';
import { findProjectRoot, packageRoot, projectPaths } from '../src/core/paths.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

afterEach(cleanupTempDirs);

describe('ids', () => {
  it('validates and converts ids', () => {
    expect(isValidId('plan-feature')).toBe(true);
    expect(isValidId('Plan')).toBe(false);
    expect(isValidId('a--b')).toBe(false);
    expect(titleCase('plan-feature')).toBe('Plan Feature');
    expect(toId('Plan Feature!')).toBe('plan-feature');
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
  it('orders states by BFS following NEXT first', () => {
    const def = sampleFlowDefinition();
    expect(orderStates(def.machine)).toEqual(['plan', 'build', 'review', 'done']);
    const model = buildFlowModel(def, '/x');
    expect(model.byId.get('build')!.incoming.map((t) => t.source)).toEqual(['plan', 'review']);
    expect(model.byId.get('done')!.final).toBe(true);
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
  });

  it('rejects reserved and invalid names', () => {
    const paths = projectPaths(makeTempDir());
    expect(() => createFlow(paths, 'config')).toThrow(/reserved/);
    expect(() => createFlow(paths, 'Bad Name')).toThrow(/Invalid flow name/);
  });
});
