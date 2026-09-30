import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SKILL_TEMPLATE_FILE, defaultStepTemplate, loadFlow, writeFlowDefinition } from '../src/core/flow.js';
import { gotoStep, loadRuntimeState } from '../src/core/machine.js';
import { addStep, readStepTemplate, removeStep, setTransition, updateStep } from '../src/core/steps.js';
import type { FlowDefinition, FlowModel, FlowStateNodeConfig, ProjectPaths, StateFile } from '../src/core/types.js';
import { validateDefinition } from '../src/core/validate.js';
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

  it('allows edits of an already invalid flow that add no error, and reports the remaining errors', () => {
    const def = sampleFlowDefinition();
    def.machine.states['plan']!.on = { NEXT: 'gone' };
    const paths = makeTempProject();
    writeFlowDefinition(paths, def);
    const model = setTransition(paths, 'sample', 'build', 'NEXT', 'done');
    expect(on(model, 'build')).toEqual({ NEXT: 'done', BACK: 'plan' });
    expect(model.remainingErrors.map((e) => e.message)).toEqual([expect.stringContaining('targets "gone"')]);
    // A new error is still refused, and only the new error is listed.
    const error = expectDflError(() => setTransition(paths, 'sample', 'build', 'NEXT', 'plan '), 'STEP_NOT_FOUND');
    expect(error.message).not.toContain('gone');
    const invalid = expectDflError(() => setTransition(paths, 'sample', 'build', 'GO*', 'review'), 'INVALID_FLOW');
    expect(invalid.message).toContain('wildcard');
    expect(invalid.message).not.toContain('gone');
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

/** A definition of `sample` with the given states (a final `done` is added unless present). */
function flowWith(initial: string, states: Record<string, FlowStateNodeConfig>): FlowDefinition {
  const def = sampleFlowDefinition();
  def.machine = { id: 'sample', initial, states: { ...states, ...(states['done'] ? {} : { done: { type: 'final' } }) } };
  return def;
}
const errorsOf = (model: FlowModel): string[] =>
  validateDefinition(model.def, 'sample')
    .filter((i) => i.level === 'error')
    .map((i) => i.message);
const flowText = (paths: ProjectPaths): string => fs.readFileSync(paths.flowFile('sample'), 'utf8');

describe('addStep default position (end of the NEXT path)', () => {
  it('goes after the step leading to the final state, not into a failure loop', () => {
    const paths = setup(
      flowWith('build', {
        build: { on: { NEXT: 'verify' } },
        verify: { on: { NEXT: 'done', FAILED: 'fix' } },
        fix: { on: { NEXT: 'verify' } },
      }),
    );
    const model = addStep(paths, 'sample', { id: 'ship' });
    expect(on(model, 'verify')).toEqual({ NEXT: 'ship', FAILED: 'fix' });
    expect(on(model, 'ship')).toEqual({ NEXT: 'done' });
    expect(on(model, 'fix')).toEqual({ NEXT: 'verify' });
    // Declared after the last non-final state, so it is listed last.
    expect(keys(model)).toEqual(['build', 'verify', 'fix', 'ship', 'done']);
    expect(model.placement).toEqual({ event: 'NEXT', after: 'verify', auto: true, initial: false, rewired: ['verify'] });
    expect(errorsOf(model)).toEqual([]);
  });

  it('does not attach to a side step that only has a FAILED transition', () => {
    const paths = setup(
      flowWith('make', {
        make: { on: { NEXT: 'check' } },
        check: { on: { NEXT: 'done', FAILED: 'fix-check' } },
        'fix-check': { on: { FAILED: 'make' } },
      }),
    );
    const model = addStep(paths, 'sample', { id: 'ship' });
    expect(on(model, 'check')).toEqual({ NEXT: 'ship', FAILED: 'fix-check' });
    expect(on(model, 'ship')).toEqual({ NEXT: 'done' });
    expect(on(model, 'fix-check')).toEqual({ FAILED: 'make' });
  });

  it('ignores unreachable steps', () => {
    const paths = setup(flowWith('a', { a: { on: { NEXT: 'c' } }, b: { on: { NEXT: 'c' } }, c: { on: { NEXT: 'done' } } }));
    const model = addStep(paths, 'sample', { id: 'z' });
    expect(on(model, 'c')).toEqual({ NEXT: 'z' });
    expect(on(model, 'z')).toEqual({ NEXT: 'done' });
    expect(on(model, 'b')).toEqual({ NEXT: 'c' });
  });

  it('falls back to the last reachable step on a NEXT cycle', () => {
    const paths = setup(flowWith('a', { a: { on: { NEXT: 'b' } }, b: { on: { NEXT: 'a', FINISH: 'done' } } }));
    const model = addStep(paths, 'sample', { id: 'x' });
    expect(on(model, 'b')).toEqual({ NEXT: 'x', FINISH: 'done' });
    expect(on(model, 'x')).toEqual({ NEXT: 'a' });
    expect(errorsOf(model)).toEqual([]);
  });

  it('gives the new step a way to the final state when the last step is a dead end', () => {
    const paths = setup(flowWith('a', { a: { on: { NEXT: 'b' } }, b: {} }));
    const model = addStep(paths, 'sample', { id: 'c' });
    expect(on(model, 'b')).toEqual({ NEXT: 'c' });
    expect(on(model, 'c')).toEqual({ NEXT: 'done' });
  });
});

describe('addStep before the initial step', () => {
  it('moves the initial step only for NEXT', () => {
    const paths = setup();
    const model = addStep(paths, 'sample', { id: 'clarify', before: 'plan', event: 'BACK' });
    expect(model.initial).toBe('plan');
    expect(on(model, 'build')).toEqual({ NEXT: 'review', BACK: 'clarify' });
    expect(on(model, 'clarify')).toEqual({ BACK: 'plan' });
    expect(on(model, 'plan')).toEqual({ NEXT: 'build' });
    expect(model.placement).toMatchObject({ before: 'plan', initial: false, rewired: ['build'] });
  });

  it('refuses an insert that no transition would lead to', () => {
    const paths = setup();
    const before = flowText(paths);
    const error = expectDflError(() => addStep(paths, 'sample', { id: 'x', before: 'plan', event: 'FOO' }), 'INVALID_POSITION');
    expect(error.message).toContain('no "FOO" transition leads to "plan"');
    const orphaned = setup(flowWith('a', { a: { on: { NEXT: 'done' } }, orphan: { on: { NEXT: 'done' } } }));
    expectDflError(() => addStep(orphaned, 'sample', { id: 'x', before: 'orphan' }), 'INVALID_POSITION');
    expect(flowText(paths)).toBe(before);
    expect(fs.existsSync(paths.stepDir('sample', 'x'))).toBe(false);
  });
});

describe('initial step and final states', () => {
  it('does not make a final state the initial step when the initial step is removed', () => {
    const paths = setup(flowWith('a', { a: { on: { NEXT: 'done', ALT: 'b' } }, b: { on: { NEXT: 'done' } } }));
    const model = removeStep(paths, 'sample', 'a');
    expect(model.initial).toBe('b');
    expect(model.initialMoved).toEqual({ from: 'a', to: 'b' });
    expect(keys(model)).toEqual(['b', 'done']);
    expect(loadRuntimeState(paths, model).done).toBe(false);
  });

  it('refuses a final state as the initial step', () => {
    const paths = setup();
    const before = flowText(paths);
    const error = expectDflError(() => updateStep(paths, 'sample', 'done', { initial: true }), 'FINAL_STEP');
    expect(error.message).toContain('cannot be the initial step');
    expect(flowText(paths)).toBe(before);
  });
});

describe('removeStep and the current step', () => {
  const current = (paths: ProjectPaths): ReturnType<typeof loadRuntimeState> => loadRuntimeState(paths, loadFlow(paths, 'sample'));

  it('moves the current step to the NEXT target and never resurrects the old id', () => {
    const paths = setup();
    gotoStep(paths, loadFlow(paths, 'sample'), 'build');
    const model = removeStep(paths, 'sample', 'build');
    expect(model.currentMoved).toEqual({ from: 'build', to: 'review' });
    const state = current(paths);
    expect(state.current).toBe('review');
    expect(state.repaired).toBeUndefined();
    expect(state.history.at(-1)).toMatchObject({ from: 'build', to: 'review', event: 'STEP_REMOVED' });

    addStep(paths, 'sample', { id: 'build', after: 'plan' });
    expect(current(paths).current).toBe('review');
  });

  it('leaves the position alone when another step is removed', () => {
    const paths = setup();
    gotoStep(paths, loadFlow(paths, 'sample'), 'review');
    const model = removeStep(paths, 'sample', 'plan');
    expect(model.currentMoved).toBeUndefined();
    expect(current(paths).current).toBe('review');
  });

  it('moves to the previous step when the NEXT target is final or missing', () => {
    const paths = setup();
    gotoStep(paths, loadFlow(paths, 'sample'), 'review');
    const model = removeStep(paths, 'sample', 'review');
    expect(model.currentMoved).toEqual({ from: 'review', to: 'build' });
    expect(current(paths)).toMatchObject({ current: 'build', done: false });

    const def = sampleFlowDefinition();
    def.machine.states['build']!.on = { APPROVE: 'review', BACK: 'plan' };
    const forced = setup(def);
    gotoStep(forced, loadFlow(forced, 'sample'), 'build');
    expect(removeStep(forced, 'sample', 'build', { force: true }).currentMoved).toEqual({ from: 'build', to: 'plan' });
    const state = current(forced);
    expect(state.current).toBe('plan');
    expect(state.repaired).toBeUndefined();
  });

  it('only touches the edited flow', () => {
    const paths = setup();
    writeSampleFlow(paths, sampleFlowDefinition('other'));
    gotoStep(paths, loadFlow(paths, 'sample'), 'build');
    gotoStep(paths, loadFlow(paths, 'other'), 'build');
    removeStep(paths, 'sample', 'build');
    const file = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as StateFile;
    expect(file.flows['sample']!.current).toBe('review');
    expect(file.flows['other']!.current).toBe('build');
  });
});

describe('removeStep reports rewired and dropped transitions', () => {
  it('lists rerouted transitions and the dropped self-loop', () => {
    const paths = setup();
    const model = removeStep(paths, 'sample', 'build');
    expect(model.rewired).toEqual([{ source: 'plan', event: 'NEXT', from: 'build', to: 'review' }]);
    expect(model.dropped).toEqual([
      { source: 'review', event: 'CHANGES_REQUESTED', target: 'build', description: 'Reviewer asked for changes', reason: 'self-loop' },
    ]);
  });

  it('lists transitions dropped by a forced removal', () => {
    const def = sampleFlowDefinition();
    def.machine.states['build']!.on = { APPROVE: 'review', BACK: 'plan' };
    const paths = setup(def);
    const model = removeStep(paths, 'sample', 'build', { force: true });
    expect(model.rewired).toEqual([]);
    expect(model.dropped).toEqual([
      { source: 'plan', event: 'NEXT', target: 'build', reason: 'no-next' },
      { source: 'review', event: 'CHANGES_REQUESTED', target: 'build', description: 'Reviewer asked for changes', reason: 'no-next' },
    ]);
  });
});

describe('unsupported (array) transitions', () => {
  function arrayFlow(): ProjectPaths {
    const def = sampleFlowDefinition();
    def.machine.states['plan']!.on = { NEXT: [{ target: 'build', guard: 'g' }, { target: 'done' }] as unknown as string };
    return setup(def);
  }

  it('refuses to insert after an array transition instead of mangling it', () => {
    const paths = arrayFlow();
    const before = flowText(paths);
    const error = expectDflError(() => addStep(paths, 'sample', { id: 'x', after: 'plan' }), 'INVALID_FLOW');
    expect(error.message).toContain('Transition "NEXT" of step "plan"');
    expectDflError(() => addStep(paths, 'sample', { id: 'x' }), 'INVALID_FLOW');
    expect(flowText(paths)).toBe(before);
    expect(fs.existsSync(paths.stepDir('sample', 'x'))).toBe(false);
  });

  it('replaces the array when the transition is set explicitly', () => {
    const paths = arrayFlow();
    const model = setTransition(paths, 'sample', 'plan', 'NEXT', 'build');
    expect(on(model, 'plan')).toEqual({ NEXT: 'build' });
    expect(model.remainingErrors).toEqual([]);

    const other = arrayFlow();
    const updated = updateStep(other, 'sample', 'plan', { on: { NEXT: 'build' } });
    expect(on(updated, 'plan')).toEqual({ NEXT: 'build' });
    expect(errorsOf(updated)).toEqual([]);
  });
});

describe('repairing a flow with several errors', () => {
  function brokenFlow(): ProjectPaths {
    const def = sampleFlowDefinition();
    def.machine.states['plan']!.on = { NEXT: 'ghost-a' };
    def.machine.states['review']!.on = { NEXT: 'ghost-b' };
    return setup(def);
  }

  it('accepts edits that fix one error at a time', () => {
    const paths = brokenFlow();
    const first = updateStep(paths, 'sample', 'plan', { on: { NEXT: 'build' } });
    expect(first.remainingErrors.map((e) => e.message)).toEqual([expect.stringContaining('targets "ghost-b"')]);
    expect(errorsOf(first)).toHaveLength(1);
    const second = updateStep(paths, 'sample', 'review', { on: { NEXT: 'done' } });
    expect(second.remainingErrors).toEqual([]);
    expect(errorsOf(second)).toEqual([]);
  });

  it('still refuses new errors and lists only those', () => {
    const paths = brokenFlow();
    const before = flowText(paths);
    const error = expectDflError(() => addStep(paths, 'sample', { id: 'add-flow-step', after: 'build' }), 'INVALID_FLOW');
    expect(error.message).toContain('collides with a built-in dfl skill');
    expect(error.message).not.toContain('ghost');
    expect(flowText(paths)).toBe(before);
  });

  it('accepts renames and unrelated removals', () => {
    const paths = brokenFlow();
    const renamed = updateStep(paths, 'sample', 'plan', { rename: 'plan-work' });
    expect(renamed.remainingErrors.map((e) => e.message)).toEqual([
      expect.stringContaining('step "plan-work" targets "ghost-a"'),
      expect.stringContaining('step "review" targets "ghost-b"'),
    ]);
    const removed = removeStep(paths, 'sample', 'build');
    expect(removed.remainingErrors).toHaveLength(2);
    expect(keys(removed)).toEqual(['plan-work', 'review', 'done']);
  });

  it('is not confused by errors whose text lists the states', () => {
    const def = sampleFlowDefinition();
    def.machine.initial = 'ghost';
    const paths = setup(def);
    const model = addStep(paths, 'sample', { id: 'extra', after: 'plan' });
    expect(model.remainingErrors.map((e) => e.message)).toEqual([expect.stringContaining('Initial step "ghost" does not exist')]);
  });
});

describe('templates must compile', () => {
  it('refuses a step whose template does not parse, writing nothing', () => {
    const paths = setup();
    const before = flowText(paths);
    const error = expectDflError(
      () => addStep(paths, 'sample', { id: 'helm-deploy', template: '# Deploy\n\nThe chart uses `{{ .Values.image.tag }}`.\n' }),
      'INVALID_TEMPLATE',
    );
    expect(error.message).toContain('steps/helm-deploy/SKILL.md.hbs, line 3');
    expectDflError(() => addStep(paths, 'sample', { id: 'x', template: '{{> no-such-partial}}' }), 'INVALID_TEMPLATE');
    expect(flowText(paths)).toBe(before);
    expect(fs.existsSync(paths.stepDir('sample', 'helm-deploy'))).toBe(false);
    expect(fs.existsSync(paths.stepDir('sample', 'x'))).toBe(false);
  });

  it('accepts flow partials and escaped braces', () => {
    const paths = setup();
    fs.mkdirSync(paths.partialsDir('sample'), { recursive: true });
    fs.writeFileSync(path.join(paths.partialsDir('sample'), 'mine.hbs'), 'mine');
    const model = addStep(paths, 'sample', { id: 'x', template: '# X\n\n\\{{ .Values.tag }}\n{{> mine}}\n{{> flow-context}}\n' });
    expect(model.byId.has('x')).toBe(true);
  });

  it('refuses a broken template on update, also with a rename', () => {
    const paths = setup();
    const before = flowText(paths);
    const original = readStepTemplate(paths, 'sample', 'build');
    expectDflError(() => updateStep(paths, 'sample', 'build', { template: '# Build\n\n{{#if vars.x}}unterminated\n' }), 'INVALID_TEMPLATE');
    expectDflError(() => updateStep(paths, 'sample', 'build', { rename: 'implement', template: '{{#each}}{{/if}}' }), 'INVALID_TEMPLATE');
    expect(flowText(paths)).toBe(before);
    expect(readStepTemplate(paths, 'sample', 'build')).toBe(original);
    expect(fs.existsSync(paths.stepDir('sample', 'implement'))).toBe(false);
  });
});

describe('transition descriptions', () => {
  it('adds a step with described transitions', () => {
    const paths = setup();
    const model = addStep(paths, 'sample', {
      id: 'qa-check',
      after: 'review',
      on: { FAILED: { target: 'build', description: '  QA checklist\n failed ' }, SKIP: { target: 'done' } },
    });
    expect(on(model, 'qa-check')).toEqual({ NEXT: 'done', FAILED: { target: 'build', description: 'QA checklist failed' }, SKIP: 'done' });
    expect(model.byId.get('qa-check')!.transitions.find((t) => t.event === 'FAILED')!.description).toBe('QA checklist failed');
  });

  it('sets, keeps and removes descriptions with updateStep', () => {
    const paths = setup();
    let model = updateStep(paths, 'sample', 'build', { on: { FAILED: { target: 'plan', description: 'Tests failed' } } });
    expect(on(model, 'build')).toEqual({ NEXT: 'review', BACK: 'plan', FAILED: { target: 'plan', description: 'Tests failed' } });
    model = updateStep(paths, 'sample', 'build', { on: { FAILED: 'review' } });
    expect(on(model, 'build')).toMatchObject({ FAILED: { target: 'review', description: 'Tests failed' } });
    model = updateStep(paths, 'sample', 'build', { on: { FAILED: { target: 'review', description: '' } } });
    expect(on(model, 'build')).toMatchObject({ FAILED: 'review' });
    model = updateStep(paths, 'sample', 'build', { on: { FAILED: null } });
    expect(on(model, 'build')).toEqual({ NEXT: 'review', BACK: 'plan' });
    expectDflError(() => updateStep(paths, 'sample', 'build', { on: { FAILED: { target: 42 } as unknown as string } }), 'INVALID_OPTIONS');
  });

  it('sets, keeps and removes descriptions with setTransition', () => {
    const paths = setup();
    let model = setTransition(paths, 'sample', 'review', 'CHANGES_REQUESTED', 'plan', 'Needs a new plan');
    expect(on(model, 'review')).toMatchObject({ CHANGES_REQUESTED: { target: 'plan', description: 'Needs a new plan' } });
    model = setTransition(paths, 'sample', 'review', 'CHANGES_REQUESTED', 'build');
    expect(on(model, 'review')).toMatchObject({ CHANGES_REQUESTED: { target: 'build', description: 'Needs a new plan' } });
    model = setTransition(paths, 'sample', 'review', 'CHANGES_REQUESTED', 'build', '');
    expect(on(model, 'review')).toMatchObject({ CHANGES_REQUESTED: 'build' });
    expectDflError(() => setTransition(paths, 'sample', 'review', 'CHANGES_REQUESTED', null, 'x'), 'INVALID_OPTIONS');
  });
});
