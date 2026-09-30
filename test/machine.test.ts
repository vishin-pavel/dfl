import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFlow, writeFlowDefinition } from '../src/core/flow.js';
import {
  availableEvents,
  createFlowMachine,
  gotoStep,
  loadRuntimeState,
  renameStateInRuntime,
  resetFlow,
  saveRuntimeState,
  sendEvent,
} from '../src/core/machine.js';
import type { FlowModel, ProjectPaths, StateFile } from '../src/core/types.js';
import { cleanupTempDirs, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

afterEach(cleanupTempDirs);

function setup(): { paths: ProjectPaths; model: FlowModel } {
  const paths = makeTempProject();
  writeSampleFlow(paths);
  return { paths, model: loadFlow(paths, 'sample') };
}

const readState = (paths: ProjectPaths): StateFile => JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as StateFile;

function expectDflError(fn: () => unknown, code: string): Error & { code: string; hint?: string } {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return error as Error & { code: string; hint?: string };
  }
  throw new Error(`expected DflError ${code}`);
}

describe('createFlowMachine', () => {
  it('builds a machine from the plain JSON config and wraps xstate errors', () => {
    const def = sampleFlowDefinition();
    expect(createFlowMachine(def).id).toBe('sample');
    def.machine.states['plan']!.on = { NEXT: 'nowhere' };
    const error = expectDflError(() => createFlowMachine(def), 'INVALID_FLOW');
    expect(error.message).toContain('nowhere');
  });
});

describe('runtime state', () => {
  it('starts at the initial state without writing state.json', () => {
    const { paths, model } = setup();
    const state = loadRuntimeState(paths, model);
    expect(state).toMatchObject({ flow: 'sample', current: 'plan', done: false, history: [] });
    expect(state.repaired).toBeUndefined();
    expect(fs.existsSync(paths.stateFile)).toBe(false);
  });

  it('fires events, records history and completes the flow', () => {
    const { paths, model } = setup();
    const first = sendEvent(paths, model);
    expect(first).toMatchObject({ from: 'plan', to: 'build', event: 'NEXT', done: false });
    expect(sendEvent(paths, model, 'BACK').to).toBe('plan');
    sendEvent(paths, model);
    sendEvent(paths, model);
    const last = sendEvent(paths, model, 'NEXT', { from: 'review' });
    expect(last).toMatchObject({ from: 'review', to: 'done', done: true });

    const state = loadRuntimeState(paths, model);
    expect(state).toMatchObject({ current: 'done', done: true });
    expect(state.history.map((h) => `${h.from}>${h.to}:${h.event}`)).toEqual([
      'plan>build:NEXT',
      'build>plan:BACK',
      'plan>build:NEXT',
      'build>review:NEXT',
      'review>done:NEXT',
    ]);
    expect(Number.isNaN(Date.parse(state.updatedAt))).toBe(false);
    expect(state.updatedAt).toBe(state.history.at(-1)!.at);
    expect(readState(paths).flows['sample']!.current).toBe('done');
  });

  it('handles object-form transitions and self transitions', () => {
    const paths = makeTempProject();
    const def = sampleFlowDefinition();
    def.machine.states['build']!.on = { NEXT: 'review', RETRY: 'build' };
    writeSampleFlow(paths, def);
    const model = loadFlow(paths, 'sample');
    gotoStep(paths, model, 'review');
    expect(sendEvent(paths, model, 'CHANGES_REQUESTED').to).toBe('build');
    expect(sendEvent(paths, model, 'RETRY')).toMatchObject({ from: 'build', to: 'build', event: 'RETRY' });
  });

  it('rejects unknown events, events on a done flow and a stale `from`', () => {
    const { paths, model } = setup();
    const notAllowed = expectDflError(() => sendEvent(paths, model, 'APPROVE'), 'EVENT_NOT_ALLOWED');
    expect(notAllowed.hint).toContain('NEXT → build');
    expectDflError(() => sendEvent(paths, model, 'NEXT', { from: 'build' }), 'NOT_CURRENT');
    expectDflError(() => sendEvent(paths, model, 'NEXT', { from: 'missing' }), 'STEP_NOT_FOUND');
    gotoStep(paths, model, 'done');
    expectDflError(() => sendEvent(paths, model), 'FLOW_DONE');
    // Nothing but the GOTO was recorded.
    expect(loadRuntimeState(paths, model).history).toHaveLength(1);
  });

  it('goes to a step and resets, recording GOTO and RESET', () => {
    const { paths, model } = setup();
    expect(gotoStep(paths, model, 'review')).toMatchObject({ from: 'plan', to: 'review', event: 'GOTO', done: false });
    expect(gotoStep(paths, model, 'done').done).toBe(true);
    expectDflError(() => gotoStep(paths, model, 'nope'), 'STEP_NOT_FOUND');
    const reset = resetFlow(paths, model);
    expect(reset).toMatchObject({ current: 'plan', done: false });
    expect(reset.history.map((h) => h.event)).toEqual(['GOTO', 'GOTO', 'RESET']);
  });

  it('keeps other flows intact and caps history at 200 entries', () => {
    const paths = makeTempProject();
    writeSampleFlow(paths, sampleFlowDefinition('one'));
    writeSampleFlow(paths, sampleFlowDefinition('two'));
    const one = loadFlow(paths, 'one');
    const two = loadFlow(paths, 'two');
    sendEvent(paths, two);
    for (let i = 0; i < 110; i++) {
      sendEvent(paths, one);
      sendEvent(paths, one, 'BACK');
    }
    const file = readState(paths);
    expect(file.version).toBe(1);
    expect(file.flows['one']!.history).toHaveLength(200);
    expect(file.flows['one']!.history.at(-1)).toMatchObject({ from: 'build', to: 'plan', event: 'BACK' });
    expect(file.flows['two']).toMatchObject({ current: 'build' });
    expect(loadRuntimeState(paths, two).current).toBe('build');
  });

  it('repairs a state that no longer exists without writing it back', () => {
    const { paths, model } = setup();
    gotoStep(paths, model, 'review');
    const def = sampleFlowDefinition();
    delete def.machine.states['review'];
    def.machine.states['build']!.on = { NEXT: 'done' };
    writeFlowDefinition(paths, def);
    const edited = loadFlow(paths, 'sample');
    const state = loadRuntimeState(paths, edited);
    expect(state.current).toBe('plan');
    expect(state.repaired).toMatch(/"review" no longer exists/);
    expect(state.history).toHaveLength(1);
    expect(readState(paths).flows['sample']!.current).toBe('review');
    // Events fire from the repaired state and persist it.
    expect(sendEvent(paths, edited)).toMatchObject({ from: 'plan', to: 'build' });
  });

  it('tolerates a corrupt state.json', () => {
    const { paths, model } = setup();
    fs.writeFileSync(paths.stateFile, '{ not json');
    const state = loadRuntimeState(paths, model);
    expect(state.current).toBe('plan');
    expect(state.repaired).toContain('could not be parsed');
    sendEvent(paths, model);
    expect(readState(paths).flows['sample']!.current).toBe('build');
  });

  it('saves a state explicitly', () => {
    const { paths, model } = setup();
    const state = loadRuntimeState(paths, model);
    saveRuntimeState(paths, { ...state, current: 'review', updatedAt: '2026-09-30T10:00:00.000Z' });
    expect(readState(paths)).toEqual({
      version: 1,
      flows: { sample: { current: 'review', history: [], updatedAt: '2026-09-30T10:00:00.000Z' } },
    });
  });
});

describe('availableEvents', () => {
  it('lists outgoing transitions in declaration order', () => {
    const { model } = setup();
    expect(availableEvents(model, 'review')).toEqual([
      { event: 'NEXT', source: 'review', target: 'done', description: undefined },
      { event: 'CHANGES_REQUESTED', source: 'review', target: 'build', description: 'Reviewer asked for changes' },
    ]);
    expect(availableEvents(model, 'done')).toEqual([]);
    expectDflError(() => availableEvents(model, 'nope'), 'STEP_NOT_FOUND');
  });
});

describe('renameStateInRuntime', () => {
  it('renames current and history entries of one flow only', () => {
    const paths = makeTempProject();
    writeSampleFlow(paths, sampleFlowDefinition('one'));
    writeSampleFlow(paths, sampleFlowDefinition('two'));
    sendEvent(paths, loadFlow(paths, 'one'));
    sendEvent(paths, loadFlow(paths, 'two'));
    renameStateInRuntime(paths, 'one', 'build', 'implement');
    const file = readState(paths);
    expect(file.flows['one']!.current).toBe('implement');
    expect(file.flows['one']!.history[0]).toMatchObject({ from: 'plan', to: 'implement' });
    expect(file.flows['two']!.current).toBe('build');
  });

  it('is a no-op without a state file or entry', () => {
    const paths = makeTempProject();
    renameStateInRuntime(paths, 'sample', 'a', 'b');
    expect(fs.existsSync(paths.stateFile)).toBe(false);
  });
});
