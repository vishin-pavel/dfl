import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SKILL_TEMPLATE_FILE, defaultStepTemplate, loadFlow, writeFlowDefinition } from '../src/core/flow.js';
import { gotoStep, loadRuntimeState } from '../src/core/machine.js';
import { addStep, readStepTemplate, removeStep, setTransition, updateStep } from '../src/core/steps.js';
import type { FlowDefinition, FlowModel, ProjectPaths } from '../src/core/types.js';
import { cleanupTempDirs, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

afterEach(cleanupTempDirs);

function setup(def: FlowDefinition = sampleFlowDefinition()): ProjectPaths {
  const paths = makeTempProject();
  writeSampleFlow(paths, def);
  return paths;
}

const readDef = (paths: ProjectPaths): FlowDefinition =>
  JSON.parse(fs.readFileSync(paths.flowFile('sample'), 'utf8')) as FlowDefinition;
const keys = (model: FlowModel): string[] => Object.keys(model.def.machine.states);
const on = (model: FlowModel, id: string): unknown => model.def.machine.states[id]!.on;
const templateFile = (paths: ProjectPaths, id: string): string => path.join(paths.stepDir('sample', id), SKILL_TEMPLATE_FILE);

function expectDflError(fn: () => unknown, code: string): Error {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return error as Error;
  }
  throw new Error(`expected DflError ${code}`);
}

describe('addStep', () => {
  it('appends after the last non-final step by default', () => {
    const paths = setup();
    const model = addStep(paths, 'sample', { id: 'ship-it', description: 'Ship it' });
    expect(keys(model)).toEqual(['plan', 'build', 'review', 'ship-it', 'done']);
    expect(on(model, 'review')).toEqual({
      NEXT: 'ship-it',
      CHANGES_REQUESTED: { target: 'build', description: 'Reviewer asked for changes' },
    });
    expect(model.def.machine.states['ship-it']).toEqual({ description: 'Ship it', meta: { title: 'Ship It' }, on: { NEXT: 'done' } });
    expect(model.steps.map((s) => s.id)).toEqual(['plan', 'build', 'review', 'ship-it', 'done']);
    expect(fs.readFileSync(templateFile(paths, 'ship-it'), 'utf8')).toBe(defaultStepTemplate({ title: 'Ship It', description: 'Ship it' }));
    expect(readDef(paths)).toEqual(model.def);
  });

  it('inserts after a step, taking over its event target', () => {
    const paths = setup();
    const model = addStep(paths, 'sample', { id: 'design', after: 'plan', title: 'Design', template: '# Design\n' });
    expect(keys(model)).toEqual(['plan', 'design', 'build', 'review', 'done']);
    expect(on(model, 'plan')).toEqual({ NEXT: 'design' });
    expect(on(model, 'design')).toEqual({ NEXT: 'build' });
    expect(readStepTemplate(paths, 'sample', 'design')).toBe('# Design\n');

    // Custom event: the anchor keeps its object form and description.
    const triage = addStep(paths, 'sample', { id: 'triage', after: 'review', event: 'CHANGES_REQUESTED', on: { SKIP: 'done' } });
    expect(on(triage, 'review')).toEqual({ NEXT: 'done', CHANGES_REQUESTED: { target: 'triage', description: 'Reviewer asked for changes' } });
    expect(on(triage, 'triage')).toEqual({ CHANGES_REQUESTED: 'build', SKIP: 'done' });
    expect(keys(triage)).toEqual(['plan', 'design', 'build', 'review', 'triage', 'done']);
  });

  it('inserts before a step, redirecting its incoming transitions and the initial state', () => {
    const paths = setup();
    let model = addStep(paths, 'sample', { id: 'spec', before: 'plan' });
    expect(model.initial).toBe('spec');
    expect(keys(model)).toEqual(['spec', 'plan', 'build', 'review', 'done']);
    expect(on(model, 'spec')).toEqual({ NEXT: 'plan' });

    model = addStep(paths, 'sample', { id: 'fix', before: 'build', event: 'CHANGES_REQUESTED' });
    expect(on(model, 'review')).toEqual({ NEXT: 'done', CHANGES_REQUESTED: { target: 'fix', description: 'Reviewer asked for changes' } });
    expect(on(model, 'plan')).toEqual({ NEXT: 'build' });
    expect(on(model, 'fix')).toEqual({ CHANGES_REQUESTED: 'build' });

    model = addStep(paths, 'sample', { id: 'release', before: 'done' });
    expect(on(model, 'review')).toMatchObject({ NEXT: 'release' });
    expect(on(model, 'release')).toEqual({ NEXT: 'done' });
    expect(keys(model)).toEqual(['spec', 'plan', 'fix', 'build', 'review', 'release', 'done']);
  });

  it('makes the first step of a flow without steps the initial state', () => {
    const def = sampleFlowDefinition();
    def.machine = { id: 'sample', initial: 'done', states: { done: { type: 'final' } } };
    const paths = setup(def);
    const model = addStep(paths, 'sample', { id: 'first' });
    expect(model.initial).toBe('first');
    expect(keys(model)).toEqual(['first', 'done']);
    expect(on(model, 'first')).toEqual({ NEXT: 'done' });
  });

  it('keeps an existing template unless one is given', () => {
    const paths = setup();
    fs.mkdirSync(paths.stepDir('sample', 'extra'), { recursive: true });
    fs.writeFileSync(templateFile(paths, 'extra'), 'mine');
    addStep(paths, 'sample', { id: 'extra' });
    expect(readStepTemplate(paths, 'sample', 'extra')).toBe('mine');
  });

  it('rejects bad input without writing anything', () => {
    const paths = setup();
    const before = fs.readFileSync(paths.flowFile('sample'), 'utf8');
    expectDflError(() => addStep(paths, 'sample', { id: 'build' }), 'STEP_EXISTS');
    expectDflError(() => addStep(paths, 'sample', { id: 'Bad Id' }), 'INVALID_NAME');
    expectDflError(() => addStep(paths, 'sample', { id: 'x', after: 'plan', before: 'build' }), 'INVALID_OPTIONS');
    expectDflError(() => addStep(paths, 'sample', { id: 'x', after: 'missing' }), 'STEP_NOT_FOUND');
    expectDflError(() => addStep(paths, 'sample', { id: 'x', before: 'missing' }), 'STEP_NOT_FOUND');
    expectDflError(() => addStep(paths, 'sample', { id: 'x', after: 'done' }), 'INVALID_POSITION');
    expectDflError(() => addStep(paths, 'sample', { id: 'x', on: { NEXT: 'nowhere' } }), 'INVALID_FLOW');
    expectDflError(() => addStep(paths, 'sample', { id: 'add-flow-step' }), 'INVALID_FLOW');
    expectDflError(() => addStep(paths, 'nope', { id: 'x' }), 'FLOW_NOT_FOUND');
    expect(fs.readFileSync(paths.flowFile('sample'), 'utf8')).toBe(before);
    expect(fs.existsSync(paths.stepDir('sample', 'x'))).toBe(false);
    expect(fs.existsSync(paths.stepDir('sample', 'add-flow-step'))).toBe(false);
  });
});

describe('updateStep', () => {
  it('updates metadata, template, transitions and the initial state', () => {
    const paths = setup();
    const model = updateStep(paths, 'sample', 'review', {
      title: 'Code review',
      description: 'Review the diff',
      template: '# Review\n',
      on: { NEXT: 'plan', CHANGES_REQUESTED: 'plan', ABORT: 'done' },
      initial: true,
    });
    const review = model.def.machine.states['review']!;
    expect(review.meta).toEqual({ title: 'Code review' });
    expect(review.description).toBe('Review the diff');
    expect(review.on).toEqual({
      NEXT: 'plan',
      CHANGES_REQUESTED: { target: 'plan', description: 'Reviewer asked for changes' },
      ABORT: 'done',
    });
    expect(model.initial).toBe('review');
    expect(readStepTemplate(paths, 'sample', 'review')).toBe('# Review\n');

    const removed = updateStep(paths, 'sample', 'build', { on: { NEXT: null, BACK: null } });
    expect(on(removed, 'build')).toBeUndefined();
  });

  it('renames a step everywhere', () => {
    const paths = setup();
    const model0 = loadFlow(paths, 'sample');
    gotoStep(paths, model0, 'build');
    fs.writeFileSync(path.join(paths.stepDir('sample', 'build'), 'notes.md.hbs'), 'notes');

    const model = updateStep(paths, 'sample', 'build', { rename: 'implement', title: 'Implement' });
    expect(keys(model)).toEqual(['plan', 'implement', 'review', 'done']);
    expect(on(model, 'plan')).toEqual({ NEXT: 'implement' });
    expect(on(model, 'review')).toEqual({ NEXT: 'done', CHANGES_REQUESTED: { target: 'implement', description: 'Reviewer asked for changes' } });
    expect(on(model, 'implement')).toEqual({ NEXT: 'review', BACK: 'plan' });
    expect(fs.existsSync(paths.stepDir('sample', 'build'))).toBe(false);
    expect(fs.readFileSync(path.join(paths.stepDir('sample', 'implement'), 'notes.md.hbs'), 'utf8')).toBe('notes');
    const state = loadRuntimeState(paths, model);
    expect(state.current).toBe('implement');
    expect(state.repaired).toBeUndefined();

    const renamedInitial = updateStep(paths, 'sample', 'plan', { rename: 'plan-work' });
    expect(renamedInitial.initial).toBe('plan-work');
    expect(on(renamedInitial, 'implement')).toEqual({ NEXT: 'review', BACK: 'plan-work' });
  });

  it('rejects invalid updates', () => {
    const paths = setup();
    expectDflError(() => updateStep(paths, 'sample', 'missing', { title: 'x' }), 'STEP_NOT_FOUND');
    expectDflError(() => updateStep(paths, 'sample', 'build', { rename: 'review' }), 'STEP_EXISTS');
    expectDflError(() => updateStep(paths, 'sample', 'build', { rename: 'Bad' }), 'INVALID_NAME');
    expectDflError(() => updateStep(paths, 'sample', 'build', { on: { NEXT: 'nowhere' } }), 'STEP_NOT_FOUND');
    expectDflError(() => updateStep(paths, 'sample', 'done', { template: 'x' }), 'FINAL_STEP');
    expectDflError(() => updateStep(paths, 'sample', 'done', { on: { NEXT: 'plan' } }), 'INVALID_FLOW');
    fs.mkdirSync(paths.stepDir('sample', 'stray'));
    expectDflError(() => updateStep(paths, 'sample', 'build', { rename: 'stray' }), 'STEP_EXISTS');
    expect(readDef(paths)).toEqual(sampleFlowDefinition());
    expect(fs.existsSync(paths.stepDir('sample', 'build'))).toBe(true);
  });
});

describe('removeStep', () => {
  it('rewires incoming transitions to the NEXT target and deletes the directory', () => {
    const paths = setup();
    const model = removeStep(paths, 'sample', 'build');
    expect(keys(model)).toEqual(['plan', 'review', 'done']);
    expect(on(model, 'plan')).toEqual({ NEXT: 'review' });
    // review —CHANGES_REQUESTED→ build would become a self-loop on review: dropped.
    expect(on(model, 'review')).toEqual({ NEXT: 'done' });
    expect(fs.existsSync(paths.stepDir('sample', 'build'))).toBe(false);
  });

  it('moves the initial state to the NEXT target', () => {
    const paths = setup();
    const model = removeStep(paths, 'sample', 'plan');
    expect(model.initial).toBe('build');
    expect(on(model, 'build')).toEqual({ NEXT: 'review' });
  });

  it('refuses to strand incoming transitions unless forced', () => {
    const def = sampleFlowDefinition();
    def.machine.states['build']!.on = { APPROVE: 'review', BACK: 'plan' };
    const paths = setup(def);
    const error = expectDflError(() => removeStep(paths, 'sample', 'build'), 'CANNOT_REWIRE');
    expect(error.message).toContain('plan —NEXT→ build');
    const model = removeStep(paths, 'sample', 'build', { force: true });
    expect(on(model, 'plan')).toBeUndefined();
    expect(on(model, 'review')).toEqual({ NEXT: 'done' });

    expectDflError(() => removeStep(paths, 'sample', 'done'), 'CANNOT_REWIRE');
    const forced = removeStep(paths, 'sample', 'done', { force: true });
    expect(on(forced, 'review')).toBeUndefined();
  });

  it('refuses to remove the last step', () => {
    const paths = setup();
    removeStep(paths, 'sample', 'plan');
    removeStep(paths, 'sample', 'build');
    expectDflError(() => removeStep(paths, 'sample', 'review'), 'LAST_STEP');
    expectDflError(() => removeStep(paths, 'sample', 'missing'), 'STEP_NOT_FOUND');
  });
});

describe('setTransition', () => {
  it('sets, retargets and removes transitions', () => {
    const paths = setup();
    let model = setTransition(paths, 'sample', 'plan', 'SKIP', 'review');
    expect(on(model, 'plan')).toEqual({ NEXT: 'build', SKIP: 'review' });
    model = setTransition(paths, 'sample', 'review', 'CHANGES_REQUESTED', 'plan');
    expect(on(model, 'review')).toMatchObject({ CHANGES_REQUESTED: { target: 'plan', description: 'Reviewer asked for changes' } });
    model = setTransition(paths, 'sample', 'build', 'BACK', null);
    expect(on(model, 'build')).toEqual({ NEXT: 'review' });
    expect(model.byId.get('build')!.transitions.map((t) => t.event)).toEqual(['NEXT']);
  });

  it('validates the step, target and result', () => {
    const paths = setup();
    expectDflError(() => setTransition(paths, 'sample', 'plan', 'NEXT', 'nowhere'), 'STEP_NOT_FOUND');
    expectDflError(() => setTransition(paths, 'sample', 'nope', 'NEXT', 'plan'), 'STEP_NOT_FOUND');
    expectDflError(() => setTransition(paths, 'sample', 'plan', 'MISSING', null), 'TRANSITION_NOT_FOUND');
    expectDflError(() => setTransition(paths, 'sample', 'done', 'NEXT', 'plan'), 'INVALID_FLOW');
    expectDflError(() => setTransition(paths, 'sample', 'plan', 'GO *', 'build'), 'INVALID_FLOW');
    expect(readDef(paths)).toEqual(sampleFlowDefinition());
  });

  it('refuses edits of a flow that is already invalid', () => {
    const def = sampleFlowDefinition();
    def.machine.states['plan']!.on = { NEXT: 'gone' };
    const paths = makeTempProject();
    writeFlowDefinition(paths, def);
    expectDflError(() => setTransition(paths, 'sample', 'build', 'NEXT', 'done'), 'INVALID_FLOW');
  });
});

describe('readStepTemplate', () => {
  it('returns the template or an empty string', () => {
    const paths = setup();
    expect(readStepTemplate(paths, 'sample', 'plan')).toContain('{{> flow-context}}');
    expect(readStepTemplate(paths, 'sample', 'done')).toBe('');
    expectDflError(() => readStepTemplate(paths, 'sample', '../plan'), 'INVALID_NAME');
  });
});
